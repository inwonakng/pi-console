import { ServiceClient, requestId } from "./client.js";
import { renderMarkdown } from "./markdown.js";

const $ = id => document.getElementById(id);
const channel = document.documentElement.dataset.piChannel;
$("channel").textContent = channel;
const text = (tag, value, className) => {
  const node = document.createElement(tag);
  node.textContent = value ?? "";
  if (className) node.className = className;
  return node;
};
const button = (label, action, disabled = false) => {
  const node = text("button", label);
  node.type = "button";
  node.disabled = disabled;
  node.addEventListener("click", action);
  return node;
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const sessionName = row => row?.name || row?.cwd?.split("/").filter(Boolean).pop() || "Untitled session";
const sessionKey = (hostId, sessionId) => `${hostId}/${sessionId}`;
const sessionRoute = (host, row) => `#sessions/${host.hello.hostId}/${row.id}`;
let hosts = [], tabs = new Map(), activeKey = null, connecting = false, generation = 0;
let controllerLabel = "webui";
const completionStates = new Map(), expandedSubagents = new Set();
// Automatic controller-tab closure keeps unsent text available in this page.
const stoppedPromptDrafts = new Map();
function sessionStatus(host, row, activity = row.live, resetSeen = false, viewed = false) {
  if (!host.connected) return "Unknown";
  const key = sessionKey(host.hello.hostId, row.id);
  if (!row.live) { completionStates.delete(key); return "Inactive"; }
  if (!activity) return "Unknown";
  const epoch = host.hello.serviceEpoch;
  const viewedCompletion = viewed ? activity.completionSeq || 0 : 0;
  let previous = completionStates.get(key);
  if (previous?.epoch === epoch && (activity.runtimeRevision < previous.activity.runtimeRevision
    || activity.runtimeRevision === previous.activity.runtimeRevision && activity.sequence < previous.activity.sequence)) {
    activity = previous.activity;
  }
  const completion = activity.completionSeq || 0;
  if (resetSeen || !previous || previous.epoch !== epoch || previous.activity.runtimeRevision !== activity.runtimeRevision) {
    previous = { epoch, activity, seen: completion };
    completionStates.set(key, previous);
  }
  previous.activity = activity;
  if (key === activeKey && !document.hidden && document.hasFocus()) previous.seen = Math.max(previous.seen, viewedCompletion);
  return activity.status === "Idle" && activity.turnOutcome === "completed" && completion > previous.seen ? "Done" : activity.status;
}
function setStatus(node, status) {
  node.textContent = status === "Done" ? "✓ Done" : status;
  node.dataset.state = status;
}

function notice(message = "") {
  $("notice").textContent = message;
  $("notice").hidden = !message;
}
async function perform(action) {
  notice();
  try { await action(); } catch (error) { notice(error.message); }
}
function receiptResult(receipt) {
  if (receipt.status === "failed" || receipt.status === "uncertain") {
    throw new Error(`${receipt.error?.message || receipt.status}. Command: ${receipt.id}. Inspect before resubmitting.`);
  }
  return receipt;
}
async function terminalReceipt(connection, method, payload, receipt) {
  for (let attempt = 0; receipt.status === "accepted" && attempt < 60; attempt++) {
    await sleep(500);
    if (connection.closed) throw new Error(`Disconnected. Inspect command ${receipt.id} before trying again.`);
    receipt = receiptResult(await connection.request(method, payload));
  }
  if (receipt.status !== "completed") throw new Error(`Command ${receipt.id} is still pending. Inspect its outcome before trying again.`);
  return receipt;
}
async function hostCommand(host, operation, payload) {
  if (!host.connected) throw new Error("Connect to this host first.");
  const envelope = { id: requestId(), serviceEpoch: host.hello.serviceEpoch, operation, payload };
  const connection = host.client;
  let receipt = receiptResult(await connection.request("host.command", envelope));
  receipt = await terminalReceipt(connection, "host.status", { serviceEpoch: envelope.serviceEpoch, commandId: envelope.id }, receipt);
  return receipt.result.sessionId;
}
function sameOwner(host, value) {
  return value.hostId === host.hello.hostId && value.serviceEpoch === host.hello.serviceEpoch && value.channel === channel;
}
function setSummaries(host, value) {
  if (!sameOwner(host, value) || !Array.isArray(value.sessions)) {
    host.client.close("Host identity changed. Reconnect explicitly."); return;
  }
  host.sessions = value.sessions;
  for (const row of host.sessions) sessionStatus(host, row);
  for (const tab of tabs.values()) {
    if (tab.identity === host.hello.hostId && (!tab.host.connected || !hosts.includes(tab.host))) tab.rebind(host);
  }
  if (host.historyRows) host.historyRows = value.sessions.map(row => ({ ...host.historyRows.find(saved => saved.id === row.id), ...row, live: row.live }));
  renderOverview();
  if ($("history-dialog").open) renderHistory();
  renderTabs();
}
async function connectHost(host) {
  if (host.connecting || host.enabled === false) return;
  host.connecting = true;
  host.error = "";
  const next = new ServiceClient(record => {
    if (host.client !== next) return;
    if (record.type === "disconnected") {
      host.connected = false;
      host.error = record.message;
      renderOverview();
      renderTabs();
      if ($("history-dialog").open) renderHistory();
    } else if (record.type === "summaries" && host.hello) setSummaries(host, record.result);
  });
  host.client = next;
  renderOverview();
  try {
    host.hello = await next.connect(channel, host.stream, host.hostId);
    // Remember identity for this page even when the registry has no saved pin.
    host.hostId = host.hello.hostId;
    host.connected = true;
    setSummaries(host, await next.request("sessions.subscribe"));
    route();
  } catch (error) { host.connected = false; host.error = error.message; next.close(error.message); }
  finally { host.connecting = false; renderOverview(); }
}
async function connectAll() {
  if (connecting) return;
  connecting = true;
  const current = ++generation;
  $("connect").disabled = true;
  try {
    const response = await fetch("/v1/hosts", { cache: "no-store" });
    if (!response.ok) throw new Error(`Could not read registered hosts (${response.status}).`);
    const registry = await response.json();
    if (registry.channel !== channel || !Array.isArray(registry.hosts)) throw new Error("Invalid host registry or channel.");
    if (current !== generation) return;
    controllerLabel = registry.clientAddress ? `webui@${registry.clientAddress}` : "webui";
    const previous = hosts;
    hosts = registry.hosts.map(target => {
      const existing = previous.find(host => host.key === target.key && host.stream === target.stream
        && (!target.hostId || !host.hostId || target.hostId === host.hostId));
      if (existing) {
        existing.alias = target.alias;
        existing.enabled = target.enabled;
        return existing;
      }
      return { ...target, sessions: [], connected: false, connecting: false };
    });
    for (const host of previous) {
      if (!hosts.includes(host) || host.enabled === false) {
        host.client?.close("Host registration removed, disabled or changed.");
        for (const tab of tabs.values()) if (tab.host === host) tab.disconnect();
      }
    }
    renderHostOptions();
    await Promise.allSettled(hosts.map(async host => {
      if (host.connected) setSummaries(host, await host.client.request("sessions.subscribe"));
      else await connectHost(host);
    }));
  } finally { connecting = false; $("connect").disabled = false; renderOverview(); }
}
function hostIdentity(host) { return host.hello?.hostId || host.key; }
function uniqueHosts() {
  const result = new Map();
  for (const host of hosts) {
    const key = hostIdentity(host), previous = result.get(key);
    if (!previous || !previous.connected && host.connected) result.set(key, host);
  }
  return [...result.values()];
}
function renderHostOptions() {
  for (const id of ["host-filter", "history-host", "create-host"]) {
    const select = $(id), value = select.value;
    const selected = hosts.find(host => host.key === value);
    const visible = uniqueHosts();
    const replacement = selected && visible.find(host => hostIdentity(host) === hostIdentity(selected));
    const choices = id === "create-host" ? [] : [new Option("All hosts", "")];
    for (const host of visible) {
      const option = new Option(host.alias, host.key);
      option.disabled = id === "create-host" && !host.connected;
      choices.push(option);
    }
    if (select.options.length !== choices.length || choices.some((option, index) => {
      const existing = select.options[index];
      return existing.value !== option.value || existing.text !== option.text || existing.disabled !== option.disabled;
    })) select.replaceChildren(...choices);
    const nextValue = replacement?.key || value;
    if (choices.some(option => option.value === nextValue && !option.disabled)) select.value = nextValue;
  }
}
function filteredRows(historyView = false) {
  const query = $(historyView ? "history-search" : "search").value.toLowerCase();
  const filter = $(historyView ? "history-host" : "host-filter").value;
  const sources = filter ? hosts.filter(host => host.key === filter) : uniqueHosts();
  return sources.flatMap(host => (historyView ? host.historyRows || host.sessions : host.sessions).filter(row => (historyView || row.live)
    && `${sessionName(row)} ${row.cwd} ${host.alias}`.toLowerCase().includes(query)).map(row => ({ host, row })));
}
function renderOverview() {
  const visible = uniqueHosts();
  const connected = visible.filter(host => host.connected).length;
  renderHostOptions();
  $("connection-state").textContent = `${connected}/${visible.length} connected`;
  $("connection-state").className = connected ? "connected" : "";
  $("connect").textContent = hosts.length ? "Refresh hosts" : "Connect";
  $("new-session").disabled = !connected;
  const focusedRow = document.activeElement.closest("#session-list a")?.dataset.key;
  $("hosts").replaceChildren(...visible.map(host => {
    const node = text("div", "", "host-state");
    const state = host.connected ? "Connected" : host.connecting ? "Connecting" : host.enabled === false ? "Disabled" : "Disconnected";
    node.append(text("span", `${host.alias} / ${state}`));
    if (!host.connected && !host.connecting && host.enabled !== false) node.append(button("Reconnect", () => perform(() => connectHost(host))));
    if (host.error) node.append(text("p", host.error, "host-error"));
    return node;
  }));
  const rows = filteredRows();
  $("session-count").textContent = rows.length;
  $("session-list").replaceChildren(...rows.map(({ host, row }) => {
    const key = sessionKey(host.hello.hostId, row.id);
    const link = text("a", "", "session-row");
    link.href = sessionRoute(host, row);
    link.dataset.key = key;
    link.setAttribute("aria-disabled", String(!host.connected));
    link.addEventListener("click", event => {
      event.preventDefault();
      if (host.connected) navigate(link.hash);
    });
    const heading = text("div", "", "row-heading");
    const state = sessionStatus(host, row);
    const status = text("span", "", "status");
    setStatus(status, state);
    heading.append(text("span", sessionName(row), "row-title"), status);
    link.append(heading, text("span", `${host.alias} / ${row.live?.cwd || row.cwd}`, "row-directory"));
    if (tabs.has(key)) link.append(text("span", "Tab open", "row-open"));
    const runs = host.connected ? row.live?.subagentRuns || [] : [];
    if (!runs.length) return link;
    const group = text("div", "", "session-entry"), details = text("details", "", "subagent-runs");
    details.open = expandedSubagents.has(key);
    details.addEventListener("toggle", () => {
      if (details.open) expandedSubagents.add(key); else expandedSubagents.delete(key);
    });
    details.append(text("summary", `${runs.length} running subagent${runs.length === 1 ? "" : "s"}`));
    for (const run of runs) details.append(text("p", `${run.agent || run.role || "Subagent"}${run.progress ? " / " + run.progress : ""}`));
    group.append(link, details);
    return group;
  }));
  if (!rows.length) $("session-list").append(text("p", "No open sessions match. Start a new session or open History to resume a stopped one.", "empty"));
  if (focusedRow) [...$("session-list").querySelectorAll("a")].find(link => link.dataset.key === focusedRow)?.focus({ preventScroll: true });
}
function renderHistory() {
  $("history-list").replaceChildren(...filteredRows(true).map(({ host, row }) => {
    const node = text("div", "", "history-row");
    const description = text("div", "", "history-description");
    description.append(text("div", sessionName(row)), text("div", `${host.alias} / ${row.cwd} / ${sessionStatus(host, row)}${row.archived ? " / archived" : ""}`, "row-directory"));
    const open = button(row.live ? "Open" : "Resume", () => perform(async () => {
      if (host.busy) return;
      host.busy = true;
      renderHistory();
      try {
        if (!row.live) {
          if (!confirm(`Resume "${sessionName(row)}" on ${host.alias}?`)) return;
          await hostCommand(host, "host.resume", { sessionId: row.id });
          setSummaries(host, await host.client.request("sessions.subscribe"));
        }
        $("history-dialog").close();
        const old = tabs.get(sessionKey(host.hello.hostId, row.id));
        if (old && !old.connected()) await old.reconnect();
        navigate(sessionRoute(host, row));
      } finally { host.busy = false; renderHistory(); }
    }), !host.connected || host.busy || Boolean(row.archived));
    node.append(description, open);
    return node;
  }));
  if (!$("history-list").children.length) $("history-list").append(text("p", "No matching history on the connected hosts.", "empty"));
}
function showHistory() {
  renderHostOptions(); renderHistory();
  $("history-dialog").showModal();
  void perform(async () => {
    await Promise.all(uniqueHosts().filter(host => host.connected).map(async host => {
      const connection = host.client;
      const result = await connection.request("sessions");
      if (host.client !== connection || result.serviceEpoch !== host.hello.serviceEpoch) return;
      host.historyRows = result.sessions;
    }));
    renderHistory();
  });
}
function showCreate(inWorkspace = false) {
  renderHostOptions();
  const tab = tabs.get(activeKey);
  const host = tab ? uniqueHosts().find(host => host.connected && hostIdentity(host) === tab.identity)
    : uniqueHosts().find(host => host.connected);
  if (!host) { notice("Connect to an execution host first."); return; }
  $("create-host").value = host.key;
  $("cwd").value = inWorkspace ? tab?.cwd() || "" : "";
  $("create-dialog").showModal();
}
const mobileTabs = window.matchMedia("(max-width: 700px)");
function setTabsExpanded(expanded, restoreFocus = false) {
  $("tab-switcher").setAttribute("aria-expanded", String(expanded));
  if (restoreFocus) $("tab-switcher").focus({ preventScroll: true });
}
$("tab-switcher").addEventListener("click", () => {
  setTabsExpanded($("tab-switcher").getAttribute("aria-expanded") !== "true");
});
$("tabs").addEventListener("click", event => {
  if (mobileTabs.matches && event.target.closest("a")) setTabsExpanded(false, true);
});
document.addEventListener("pointerdown", event => {
  if (!$("tabs").contains(event.target)) setTabsExpanded(false);
});
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && $("tab-switcher").getAttribute("aria-expanded") === "true") {
    event.preventDefault();
    setTabsExpanded(false, true);
  }
});
$("tabs").addEventListener("focusout", event => {
  if (event.relatedTarget && !$("tabs").contains(event.relatedTarget)) setTabsExpanded(false);
  // A breakpoint can hide the focused control before the media change event.
  else if (!event.relatedTarget && mobileTabs.matches && $("conversation-tabs").contains(event.target)
    && getComputedStyle($("conversation-tabs")).display === "none") $("tab-switcher").focus({ preventScroll: true });
  else if (!event.relatedTarget && !mobileTabs.matches && event.target === $("tab-switcher")) {
    (tabs.get(activeKey)?.link || $("overview-tab")).focus({ preventScroll: true });
  }
});
mobileTabs.addEventListener("change", () => setTabsExpanded(false));
function renderTabs() {
  $("overview-tab").setAttribute("aria-current", activeKey ? "false" : "page");
  $("tab-switcher").textContent = `Open tabs (${tabs.size})`;
  $("empty-tabs").hidden = tabs.size > 0;
  for (const [key, tab] of tabs) {
    const row = tab.host.sessions.find(row => row.id === tab.id);
    tab.syncRow(row);
    tab.tabTitle.textContent = sessionName(row || tab.row);
    tab.tabHost.textContent = tab.host.alias;
    tab.link.setAttribute("aria-current", key === activeKey ? "page" : "false");
    setStatus(tab.statusBadge, tab.status());
    tab.closeButton.setAttribute("aria-label", `Close tab: ${sessionName(row || tab.row)}`);
    tab.element.hidden = key !== activeKey;
  }
  $("overview").hidden = Boolean(activeKey);
}
function navigate(hash) {
  if (location.hash === hash || (!hash && !location.hash)) route();
  else location.hash = hash;
}
function route() {
  const match = /^#sessions\/([\w-]{1,128})\/([\w-]{1,128})$/.exec(location.hash);
  if (!match) {
    // Keep old single-host bookmarks usable, without implicitly resuming history.
    const legacy = /^#sessions\/([\w-]{1,128})$/.exec(location.hash);
    const local = hosts.find(host => host.key === "local" && host.connected);
    if (legacy && local) { navigate(sessionRoute(local, { id: legacy[1] })); return; }
    activeKey = null; renderTabs(); return;
  }
  const key = sessionKey(match[1], match[2]);
  let tab = tabs.get(key);
  if (!tab) {
    const host = hosts.find(host => host.connected && host.hello.hostId === match[1]);
    if (!host) { if (!connecting) notice("This host is unavailable. Reconnect it from Overview."); return; }
    const row = host.sessions.find(row => row.id === match[2]);
    if (!row?.live) { notice("This session is inactive or unavailable. Open History to resume it explicitly."); return; }
    tab = createConversation(host, row);
    tabs.set(key, tab);
    $("panels").append(tab.element);
    $("conversation-tabs").append(tab.tabElement);
    void tab.reconnect();
  }
  const changed = activeKey !== key;
  activeKey = key;
  renderTabs();
  if (changed) tab.show();
  renderOverview();
}
function closeTab(key) {
  const tab = tabs.get(key);
  if (!tab) return;
  const nextLink = (tab.tabElement.nextElementSibling || tab.tabElement.previousElementSibling)?.querySelector("a");
  tab.dispose();
  tab.element.remove(); tab.tabElement.remove(); tabs.delete(key);
  if (activeKey === key) navigate("");
  renderTabs(); renderOverview();
  if (mobileTabs.matches && $("tab-switcher").getAttribute("aria-expanded") === "true") {
    (nextLink || $("tab-switcher")).focus({ preventScroll: true });
  } else if (!activeKey) $("overview-tab").focus();
}

$("connection-form").addEventListener("submit", event => { event.preventDefault(); perform(connectAll); });
$("new-session").addEventListener("click", () => showCreate());
$("cancel-create").addEventListener("click", () => $("create-dialog").close());
$("create-host").addEventListener("change", () => { $("cwd").value = ""; });
$("create-form").addEventListener("submit", event => {
  event.preventDefault();
  const host = hosts.find(host => host.key === $("create-host").value);
  const cwd = $("cwd").value.trim();
  if (!cwd.startsWith("/")) { $("cwd").setCustomValidity("Use an absolute directory path on the host."); $("cwd").reportValidity(); return; }
  const submit = $("create-form").querySelector('[type="submit"]');
  if (submit.disabled) return;
  submit.disabled = true;
  perform(async () => {
    try {
      const id = await hostCommand(host, "host.create", { cwd });
      setSummaries(host, await host.client.request("sessions.subscribe"));
      $("create-dialog").close();
      navigate(sessionRoute(host, { id }));
    } finally { submit.disabled = false; }
  });
});
$("cwd").addEventListener("input", () => $("cwd").setCustomValidity(""));
$("search").addEventListener("input", renderOverview);
$("host-filter").addEventListener("change", renderOverview);
$("history").addEventListener("click", showHistory);
$("close-history").addEventListener("click", () => $("history-dialog").close());
$("history-search").addEventListener("input", renderHistory);
$("history-host").addEventListener("change", renderHistory);
function refreshViewedStatus() {
  tabs.get(activeKey)?.viewed();
  renderOverview(); renderTabs();
}
window.addEventListener("focus", refreshViewedStatus);
document.addEventListener("visibilitychange", refreshViewedStatus);
window.addEventListener("hashchange", route);
window.addEventListener("pagehide", event => {
  for (const host of hosts) host.client?.close();
  for (const tab of tabs.values()) {
    if (event.persisted) tab.disconnect("Page suspended. Reconnect explicitly to continue.");
    else tab.dispose();
  }
});
window.addEventListener("pageshow", event => {
  if (event.persisted) notice("Page restored. Refresh hosts, then reconnect conversation tabs explicitly. Commands were not replayed.");
});
void perform(connectAll);

function createConversation(host, row) {
  const element = document.getElementById("conversation-template").content.firstElementChild.cloneNode(true);
  const panelId = "session-" + requestId();
  element.id = panelId;
  const $ = id => element.querySelector('[data-id="' + id + '"]');
  $("prompt").id = panelId + "-prompt";
  $("prompt-label").htmlFor = $("prompt").id;
  $("session-title").textContent = sessionName(row);
  $("session-directory").textContent = host.alias + " / " + row.cwd;
  const selectedId = row.id;
  const identity = host.hello.hostId;
  const key = sessionKey(identity, selectedId);
  $("prompt").value = stoppedPromptDrafts.get(key) || "";
  stoppedPromptDrafts.delete(key);
  const tabElement = text("div", "", "conversation-tab");
  const link = text("a");
  const tabTitle = text("span", sessionName(row), "tab-title");
  const tabHost = text("span", host.alias, "tab-host");
  link.append(tabTitle, text("span", " / ", "tab-separator"), tabHost);
  link.href = sessionRoute(host, row);
  link.setAttribute("aria-controls", panelId);
  link.addEventListener("click", event => { event.preventDefault(); navigate(link.hash); });
  const closeButton = button("x", () => closeTab(key));
  const statusBadge = text("span", "", "status");
  tabElement.append(link, statusBadge, closeButton);
  let client, hello, snapshot, attachment, grant, owner;
  let busy = false, connected = false, disposed = false;
  let streamSequence = 0, authoritySequence = 0, runtimeRevision = 0;
  let refreshTimer, refreshing = false, dirty = false;
  let transcriptKey = "", interactionKey = "";
  const answerDrafts = new Map(), submittedAnswers = new Set();
  const settingFields = new Map();
  let models = [], thinkingLevels = [], optionsKey = "", optionsLoad = null, optionsError = "";
  for (const [id, label, operation, choices] of [
    ["model", "Model", "model.set", []],
    ["thinking", "Thinking level", "thinking.set", []],
    ["access", "Access mode", "access.set", [["readonly", "Read only"], ["ask", "Ask"], ["edit", "Edit"], ["full", "Full access"]]],
    ["integration", "Workspace integration", "integration.set", [["ask", "Ask"], ["allowed", "Allowed"]]],
    ["notifications", "Host notifications", "notifications.set", [["true", "On"], ["false", "Off"]]],
  ]) {
    const labelNode = text("label", label);
    const select = document.createElement("select");
    select.id = `${panelId}-${id}`;
    labelNode.htmlFor = select.id;
    labelNode.append(select);
    $("settings-fields").append(labelNode);
    settingFields.set(id, { select, operation, choices });
    select.addEventListener("change", () => {
      const value = select.value;
      const payload = id === "model" ? { provider: JSON.parse(value)[0], modelId: JSON.parse(value)[1] }
        : id === "thinking" ? { level: value } : id === "notifications" ? { enabled: value === "true" } : { mode: value };
      run(async () => {
        const captured = context();
        const receipt = await command(operation, payload);
        await terminalReceipt(captured.client, "command.status", { serviceEpoch: hello.serviceEpoch, commandId: receipt.id }, receipt);
        if (sameContext(captured)) applySnapshot(await captured.client.request("snapshot"));
      });
    });
  }
  function notice(message = "") {
    $("notice").textContent = message;
    $("notice").hidden = !message;
  }
  function controlsCurrent() {
    return host.connected && row.live && connected && grant && owner?.controller?.attachmentId === attachment
      && owner.controller.grantId === grant.grantId;
  }
  function context() { return { client, selectedId, attachment, runtimeRevision }; }
  function sameContext(captured) {
    return captured.client === client && captured.selectedId === selectedId
      && captured.attachment === attachment && captured.runtimeRevision === runtimeRevision;
  }
  async function run(action) {
    if (busy) return;
    busy = true;
    notice();
    renderControls();
    try { await action(); }
    catch (error) { notice(error.message); }
    finally { busy = false; renderControls(); }
  }
  async function command(operation, payload = {}) {
    if (!snapshot || !connected) throw new Error("Select a live session first");
    const envelope = { version: 1, id: requestId(), sessionId: selectedId,
      serviceEpoch: hello.serviceEpoch, runtimeRevision, operation, payload };
    if (operation !== "control.acquire" && operation !== "control.takeover") {
      if (!controlsCurrent()) throw new Error("Take control before changing this session");
      envelope.controlToken = grant.token;
    }
    const connection = client;
    $("command-status").textContent = `${operation}: sending (${envelope.id})`;
    let receipt = receiptResult(await connection.request("command", envelope));
    if (operation.startsWith("control.")) {
      receipt = await terminalReceipt(connection, "command.status", { serviceEpoch: envelope.serviceEpoch, commandId: envelope.id }, receipt);
    }
    $("command-status").textContent = `${operation}: ${receipt.status} (${receipt.id})`;
    scheduleRefresh();
    return receipt;
  }
  function receive(record) {
    if (record.type === "disconnected") {
      connected = false;
      grant = null;
      clearTimeout(refreshTimer);
      refreshTimer = null;
      notice(record.message);
      if (snapshot) renderSession();
      else renderControls();
      renderOverview();

    } else if (record.type === "update" && record.update.sessionId === selectedId) {
      const update = record.update;
      if (update.serviceEpoch !== hello.serviceEpoch || update.sequence !== streamSequence + 1) {
        client.close("Session stream changed or skipped an update. Reconnect for a fresh snapshot.");
        return;
      }
      streamSequence = update.sequence;
      if (update.closeFrontend && update.closeFrontend.attachmentId === attachment) {
        if ($("prompt").value) stoppedPromptDrafts.set(key, $("prompt").value);
        closeTab(key);
        return;
      }
      // A snapshot can already include an update still waiting in the stream.
      if (update.sequence > authoritySequence) {
        authoritySequence = update.sequence;
        if (runtimeRevision !== update.runtimeRevision) grant = null;
        runtimeRevision = update.runtimeRevision;
        if (update.owner) owner = { ...update.owner, sequence: update.sequence };
        if (grant && !controlsCurrent()) grant = null;
      }
      if (update.command) {
        const receipt = update.command;
        $("command-status").textContent = `${receipt.operation}: ${receipt.status} (${receipt.id})`;
        if (receipt.status === "failed" || receipt.status === "uncertain") {
          notice(`${receipt.error?.message || receipt.status}. Command: ${receipt.id}. Inspect before resubmitting.`);
        }
      }
      // Read a coalesced owner snapshot instead of duplicating its conversation reducer.
      // Live frontend effects are deliberately not executed by this first draft.
      renderControls();
      scheduleRefresh();
    }
  }
  function scheduleRefresh() {
    dirty = true;
    if (refreshTimer || refreshing || !host.connected || !row.live || !connected || !selectedId) return;
    refreshTimer = setTimeout(refresh, 100);
  }
  async function refresh() {
    refreshTimer = null;
    if (!host.connected || !row.live || !connected || !selectedId || refreshing) return;
    const captured = context();
    refreshing = true;
    dirty = false;
    try {
      const value = await captured.client.request("snapshot");
      if (sameContext(captured)) applySnapshot(value);
    } catch (error) { if (sameContext(captured)) notice(error.message); }
    finally { refreshing = false; if (dirty) scheduleRefresh(); }
  }
  function applySnapshot(value, resetSeen = false) {
    if (value.sessionId !== selectedId || value.serviceEpoch !== hello.serviceEpoch) return;
    snapshot = value;
    if (value.sequence >= authoritySequence) {
      authoritySequence = value.sequence;
      if (runtimeRevision !== value.runtimeRevision) grant = null;
      runtimeRevision = value.runtimeRevision;
      owner = value;
    }
    if (grant && !controlsCurrent()) grant = null;
    sessionStatus(host, row, value, resetSeen);
    renderSession();
    renderOverview();
  }
  function renderControls() {
    const controlled = Boolean(controlsCurrent());
    $("reconnect").hidden = connected;
    $("reconnect").disabled = busy || !host.connected || !row.live;
    $("stop").disabled = !controlled || busy;
    $("control").disabled = !host.connected || !row.live || !connected || !snapshot || busy;
    $("control").textContent = controlled ? "Release control" : owner?.controller ? "Take over" : "Take control";
    $("controller").textContent = !host.connected ? "Unknown / read only" : !row.live ? "Inactive / read only"
      : !connected ? "Unknown / read only" : controlled ? "You control this session"
      : owner?.controller ? `Controlled by ${owner.controller.label}` : "Read only / no controller";
    $("abort").disabled = !controlled || busy || !snapshot?.conversation.execution.running;
    $("rename").disabled = !controlled || busy;
    const ready = owner?.phase === "ready";
    $("prompt").disabled = !controlled || !ready;
    $("send").disabled = !controlled || !ready || busy || !$("prompt").value.trim();
    $("composer-hint").textContent = !controlled ? "Take control to send a prompt." : !ready ? "Waiting for session setup."
      : snapshot?.conversation.execution.running ? "Prompts sent while working are queued." : "Tap Send when your prompt is ready.";
    renderSettings();
    if (snapshot) renderInteractions();
  }
  function settingsKey() {
    const model = snapshot?.piState?.model;
    return JSON.stringify([attachment, runtimeRevision, model?.provider, model?.id]);
  }
  async function loadSettings() {
    if (!host.connected || !row.live || !connected || owner?.phase !== "ready" || !hello.capabilities.includes("session.read")) return;
    const captured = context(), key = settingsKey();
    if (optionsLoad?.key === key) return;
    const load = optionsLoad = { key };
    optionsKey = key;
    optionsError = "";
    models = []; thinkingLevels = [];
    renderSettings();
    try {
      const results = await Promise.allSettled(["models", "thinking"].map(kind => captured.client.request("session.read", { kind, runtimeRevision: captured.runtimeRevision })));
      if (!sameContext(captured) || settingsKey() !== key || optionsLoad !== load) return;
      if (results[0].status === "fulfilled") models = results[0].value.data.models;
      if (results[1].status === "fulfilled") thinkingLevels = results[1].value.data.levels;
      optionsError = results.filter(result => result.status === "rejected").map(result => result.reason.message).join(" ");
    } finally {
      if (optionsLoad === load) { optionsLoad = null; renderSettings(); }
    }
  }
  function renderSettings() {
    const state = snapshot?.piState;
    const statuses = snapshot?.conversation.statuses || {};
    const key = settingsKey();
    const currentModel = state?.model;
    const modelValue = currentModel ? JSON.stringify([currentModel.provider, currentModel.id]) : "";
    $("settings-model").textContent = currentModel ? `${currentModel.provider} / ${currentModel.id}` : "";
    if (optionsKey !== key) {
      models = []; thinkingLevels = []; optionsError = "";
      if ($("settings").open) void loadSettings();
    }
    const values = {
      model: modelValue, thinking: state?.thinkingLevel,
      access: statuses["pi-access-mode"]?.match(/^Mode: (\w+)$/)?.[1],
      integration: statuses["pi-integration-mode"]?.match(/^Integration: (\w+)$/)?.[1],
      notifications: statuses["pi-notifications"] === "notify on" ? "true" : statuses["pi-notifications"] === "notify off" ? "false" : "",
    };
    const enabled = Boolean(controlsCurrent()) && owner?.phase === "ready" && !busy;
    for (const [id, field] of settingFields) {
      const choices = id === "model" ? models.map(model => [JSON.stringify([model.provider, model.id]), `${model.provider} / ${model.id}`])
        : id === "thinking" ? thinkingLevels.map(level => [level, level]) : field.choices;
      const value = values[id] ?? "";
      const options = choices.map(([value, label]) => new Option(label, value));
      if (!choices.some(([choice]) => choice === value)) {
        const current = new Option(id === "model" && currentModel ? `${currentModel.provider} / ${currentModel.id}` : value || "Unavailable", value);
        current.disabled = true;
        options.unshift(current);
      }
      const signature = JSON.stringify(options.map(option => [option.value, option.text, option.disabled]));
      if (field.signature !== signature) { field.select.replaceChildren(...options); field.signature = signature; }
      field.select.value = value;
      field.select.disabled = !enabled || !choices.length || !hello?.capabilities.includes(field.operation) || Boolean(optionsLoad);
    }
    $("refresh-settings").disabled = !host.connected || !row.live || !connected || owner?.phase !== "ready" || Boolean(optionsLoad) || !hello?.capabilities.includes("session.read");
    $("settings-hint").textContent = !host.connected ? "Host unavailable. Current settings are unknown." : !row.live ? "Session inactive. Resume it from History."
      : optionsLoad ? "Loading model options..." : optionsError ? `${optionsError} Tap Refresh options to retry.`
      : !connected ? "Reconnect to read current settings." : owner?.phase !== "ready" ? "Waiting for session setup."
      : !controlsCurrent() ? "Take control to change settings." : "Changes apply to this session on the execution host.";
  }
  function displayStatus() {
    if (!host.connected) return "Unknown";
    if (!row.live) return "Inactive";
    if (!connected) return "Unknown";
    return sessionStatus(host, row, owner || row.live);
  }
  function renderSession() {
    const currentRow = host.sessions.find(item => item.id === selectedId) || row;
    $("session-title").textContent = snapshot.piState?.sessionName || sessionName(currentRow);
    $("session-directory").textContent = `${host.alias} / ${owner?.interactions.runtime?.cwd || currentRow.cwd || ""}`;
    if (host.connected && row.live && connected && owner?.error) notice(owner.error);
    renderTranscript();
    if (connected) sessionStatus(host, row, snapshot, false, true);
    const state = displayStatus();
    setStatus($("session-status"), state);
    setStatus(statusBadge, state);
    renderQueue();
    renderControls();
  }
  function blockDetails(label, value, key, markdown = false) {
    const details = document.createElement("details");
    details.dataset.key = key;
    details.append(text("summary", label), markdown ? renderMarkdown(value) : text("pre", typeof value === "string" ? value : JSON.stringify(value, null, 2)));
    return details;
  }
  function contentNodes(content, prefix, markdown = true) {
    const messageText = value => markdown ? renderMarkdown(value) : text("div", value, "message-text");
    if (typeof content === "string") return [messageText(content)];
    if (!Array.isArray(content)) return [text("pre", JSON.stringify(content, null, 2))];
    return content.map((block, index) => {
      if (block.type === "text") return messageText(block.text);
      if (block.type === "thinking") return blockDetails("Thinking", block.thinking, `${prefix}-thinking-${index}`, markdown);
      if (block.type === "toolCall") return blockDetails(block.name, block.arguments, `${prefix}-call-${block.id}`);
      if (block.type === "image") return text("p", "[Image attachment]", "muted");
      return blockDetails(block.type || "Content", block, `${prefix}-${index}`);
    });
  }
  function renderTranscript() {
    if (element.hidden) return;
    const conversation = snapshot.conversation;
    const live = Boolean(host.connected && row.live && connected);
    const key = JSON.stringify([conversation, live]);
    if (key === transcriptKey) return;
    transcriptKey = key;
    const target = $("transcript");
    const follow = target.scrollHeight - target.scrollTop - target.clientHeight < 100;
    const scrollTop = target.scrollTop;
    const expanded = new Set([...target.querySelectorAll("details[open]")].map(node => node.dataset.key));
    const diagnostics = conversation.diagnostics || [];
    const diagnosticMessages = items => items.map(item => ({ role: "error", content: item.message }));
    const keys = conversation.messageKeys || [];
    const messages = diagnosticMessages(diagnostics.filter(item => item.assistantTimestamp == null
      && item.afterMessage == null && !conversation.omittedMessages));
    conversation.messages.forEach((message, index) => {
      messages.push(message);
      const anchor = keys[index];
      if (anchor && keys.indexOf(anchor) === keys.lastIndexOf(anchor)) {
        messages.push(...diagnosticMessages(diagnostics.filter(item => item.assistantTimestamp == null && item.afterMessage === anchor)));
      }
    });
    if (conversation.partialAssistant) {
      const partial = conversation.partialAssistant.message;
      messages.push(partial, ...diagnosticMessages(diagnostics.filter(item => item.assistantTimestamp != null
        && item.assistantTimestamp === partial.timestamp)));
    }
    const nodes = messages.filter(visibleMessage).map((message, index) => {
      const article = text("article", "", "message");
      article.dataset.role = message.role;
      if (message.role === "toolResult") {
        const details = document.createElement("details");
        details.className = "tool-output";
        details.dataset.key = `tool-${message.toolCallId || index}`;
        details.append(text("summary", `${message.toolName || "Tool"} / ${message.isError ? "error" : "output"}`));
        details.append(...contentNodes(message.content ?? message.output ?? message.text ?? message, String(index), false));
        if (message.errorMessage) details.append(text("p", message.errorMessage));
        article.append(details);
      } else {
        article.append(text("div", message.role === "assistant" ? "Pi" : message.role, "message-label"));
        article.append(...contentNodes(message.content ?? message.output ?? message.text ?? message, String(index)));
        if (message.errorMessage) article.append(text("p", message.errorMessage));
      }
      return article;
    });
    if (conversation.omittedMessages) nodes.unshift(text("p", `${conversation.omittedMessages} older messages are outside this snapshot.`, "muted"));
    for (const tool of conversation.tools.filter(tool => live && tool.state === "running")) {
      const details = blockDetails(`${tool.toolName} / running`, tool.partialResult || tool.args, `tool-${tool.toolCallId}`);
      details.className = "tool-output";
      nodes.push(details);
    }
    if (!nodes.length) nodes.push(text("p", conversation.hydrated ? "No messages yet. Write your first prompt below." : "Loading conversation...", "empty"));
    target.replaceChildren(...nodes);
    for (const details of target.querySelectorAll("details")) details.open = expanded.has(details.dataset.key);
    target.scrollTop = follow ? target.scrollHeight : scrollTop;
    $("latest").hidden = follow;
  }
  function dialogDescription(title) {
    // Bundled dialogs put their preview and runtime tag inside a JSON title.
    for (let depth = 0; depth < 4; depth++) {
      let value;
      try { value = JSON.parse(title); } catch { break; }
      if (!value || typeof value !== "object" || Array.isArray(value)) break;
      if (["pi_service_dialog", "pi_side_dialog"].includes(value.kind)) { title = value.title; continue; }
      if (["pi_input", "pi_confirmation", "pi_compact_select", "pi_approval_preview"].includes(value.kind)) return value;
      break;
    }
    return { title };
  }
  function appendDialog(target, title, heading = false) {
    const data = dialogDescription(title);
    const label = data.prompt || data.request || data.title || data.summary;
    if (label) target.append(text(heading ? "h3" : "p", label));
    for (const key of ["tool", "summary", "path", "directory", "mode"]) {
      if (typeof data[key] === "string" && data[key] !== label) target.append(text("p", `${key}: ${data[key]}`));
    }
    if (typeof data.preview === "string") target.append(text("pre", data.preview));
    for (const [choice, preview] of Object.entries(data.previews || {})) {
      if (typeof preview === "string") target.append(blockDetails(`Preview: ${choice}`, preview, choice));
    }
  }
  function renderInteractions() {
    const pending = host.connected && row.live && connected ? owner?.interactions.pending || [] : [];
    const enabled = Boolean(controlsCurrent()) && !busy;
    const key = JSON.stringify([pending, enabled, runtimeRevision]);
    if (key === interactionKey) return;
    interactionKey = key;
    $("interactions").hidden = !pending.length;
    $("interaction-summary").textContent = `Questions and approvals (${pending.length})`;
    const target = $("interaction-list");
    target.replaceChildren(...pending.map(item => {
      const request = item.request;
      const captured = context();
      const answerKey = `${hello.hostId}/${selectedId}/${runtimeRevision}/${request.id}`;
      const form = document.createElement("form");
      const fieldset = document.createElement("fieldset");
      fieldset.disabled = !enabled || item.submitted || submittedAnswers.has(answerKey);
      fieldset.append(text("legend", request.method === "confirm" ? "Approval" : "Question"));
      appendDialog(fieldset, request.title, true);
      if (request.message) appendDialog(fieldset, request.message);
      if (item.tag?.deadline) fieldset.append(text("p", `Expires: ${new Date(item.tag.deadline).toLocaleString()}`));
      const answers = text("div", "", "answers");
      const answer = response => run(async () => {
        if (!sameContext(captured)) throw new Error("Session changed; review the current question");
        if (item.tag?.deadline && Date.now() >= item.tag.deadline) throw new Error("This question has expired");
        if (submittedAnswers.has(answerKey)) throw new Error("Answer already sent. Inspect its outcome before trying again.");
        submittedAnswers.add(answerKey);
        interactionKey = "";
        try {
          await command(response ? "interaction.respond" : "interaction.cancel", response
            ? { requestId: request.id, answer: response } : { requestId: request.id });
        } catch (error) {
          if (["rejected", "not_sent"].includes(error.delivery)) submittedAnswers.delete(answerKey);
          throw error;
        }
      });
      const respond = response => answer(response);
      if (request.method === "confirm") {
        answers.append(button("Approve", () => respond({ confirmed: true })), button("Deny", () => respond({ confirmed: false })));
      } else if (request.method === "select") {
        for (const option of request.options) answers.append(button(option, () => respond({ value: option })));
      } else {
        const input = document.createElement(request.method === "editor" ? "textarea" : "input");
        input.id = `${panelId}-answer-${request.id}`;
        input.value = answerDrafts.get(answerKey) ?? request.prefill ?? "";
        input.addEventListener("input", () => answerDrafts.set(answerKey, input.value));
        input.placeholder = request.placeholder || "Your answer";
        const label = text("label", "Answer");
        label.htmlFor = input.id;
        fieldset.append(label, input);
        const submit = text("button", "Send answer");
        submit.type = "submit";
        answers.append(submit);
        form.addEventListener("submit", event => { event.preventDefault(); respond({ value: input.value }); });
      }
      answers.append(button("Cancel question", () => answer(null)));
      fieldset.append(answers);
      form.append(fieldset);
      return form;
    }));
  }
  function renderQueue() {
    const accepted = snapshot.acceptedQueue?.items || [];
    const native = snapshot.conversation.queue;
    const queued = host.connected && row.live && connected ? [...accepted.map(item => ({ text: item.text, label: `Queued / ${item.status}` })),
      ...native.steering.map(value => ({ text: value, label: "Steering" })), ...native.followUp.map(value => ({ text: value, label: "Follow-up" }))] : [];
    $("queue-panel").hidden = !queued.length;
    $("queue-summary").textContent = `Queued prompts (${queued.length})`;
    $("queue").replaceChildren(...queued.map(item => {
      const node = text("div", "", "queue-item");
      node.append(text("span", item.label, "muted"), text("p", item.text));
      return node;
    }));
  }

  $("control").addEventListener("click", () => run(async () => {
    const captured = context();
    if (controlsCurrent()) { await command("control.release"); if (sameContext(captured)) grant = null; }
    else {
      const takeover = Boolean(owner?.controller);
      if (takeover && !confirm(`Take control from ${owner.controller.label}?`)) return;
      await command(takeover ? "control.takeover" : "control.acquire", takeover ? { confirmed: true } : {});
      const value = await client.request("grant");
      if (sameContext(captured)) { grant = value; if (!controlsCurrent()) scheduleRefresh(); }
    }
  }));
  $("settings").addEventListener("toggle", () => { if ($("settings").open) renderSettings(); });
  $("refresh-settings").addEventListener("click", () => { void loadSettings(); });
  $("abort").addEventListener("click", () => run(() => command("turn.abort")));
  $("rename").addEventListener("click", () => {
    const title = prompt("Session title", $("session-title").textContent);
    if (title?.trim()) run(() => command("session.rename", { title: title.trim() }));
  });
  $("composer").addEventListener("submit", event => {
    event.preventDefault();
    const value = $("prompt").value;
    if (!value.trim()) return;
    if (value.trimStart().startsWith("/")) { notice("Slash commands are not supported here. Send a regular prompt."); return; }
    run(async () => {
      const captured = context();
      const receipt = await command("prompt.submit", { text: value });
      if (sameContext(captured) && ["accepted", "completed"].includes(receipt.status) && $("prompt").value === value) {
        $("prompt").value = "";
      }
    });
  });
  $("prompt").addEventListener("input", renderControls);
  $("new-workspace").addEventListener("click", () => showCreate(true));
  $("session-actions").addEventListener("click", event => {
    if (event.target.closest("button")) $("session-actions").open = false;
  });
  $("stop").addEventListener("click", () => {
    if (confirm('Stop "' + sessionName(row) + '" on ' + host.alias + '? Active work will be interrupted; history is preserved.')) {
      run(() => command("session.kill", { confirmed: true }));
    }
  });
  $("reconnect").addEventListener("click", () => { void reconnect(); });
  $("latest").addEventListener("click", () => { $("transcript").scrollTop = $("transcript").scrollHeight; $("latest").hidden = true; });
  $("transcript").addEventListener("scroll", () => {
    const target = $("transcript");
    $("latest").hidden = target.scrollHeight - target.scrollTop - target.clientHeight < 100;
  });
  const heartbeat = setInterval(() => {
    if (!controlsCurrent()) return;
    const captured = context();
    const token = grant.token;
    client.request("heartbeat", { controlToken: token }).catch(error => {
      if (sameContext(captured) && grant?.token === token) { grant = null; notice(error.message); renderControls(); }
    });
  }, 5000);
  async function reconnect() {
    if (disposed || connected || busy) return;
    await run(async () => {
      if (!host.connected) throw new Error("Reconnect the execution host from Overview first.");
      const summaries = await host.client.request("sessions.subscribe");
      setSummaries(host, summaries);
      if (disposed) return;
      const currentRow = host.sessions.find(item => item.id === selectedId);
      if (!currentRow?.live) throw new Error("This session is inactive. Open History to resume it explicitly.");
      client?.close();
      const next = new ServiceClient(record => { if (!disposed && client === next) receive(record); });
      client = next;
      grant = null;
      hello = await next.connect(channel, host.stream, host.hello.hostId);
      if (disposed) { next.close(); return; }
      connected = true;
      try {
        const value = await next.request("attach", { sessionId: selectedId, label: controllerLabel });
        attachment = value.attachmentId;
        streamSequence = value.snapshot.sequence;
        authoritySequence = 0;
        runtimeRevision = value.snapshot.runtimeRevision;
        transcriptKey = interactionKey = "";
        applySnapshot(value.snapshot, true);
      } catch (error) { next.close(error.message); throw error; }
    });
  }
  return {
    get host() { return host; },
    get row() { return row; },
    identity, id: selectedId, element, tabElement, link, tabTitle, tabHost, statusBadge, closeButton, reconnect,
    status: displayStatus,
    viewed() { if (snapshot) renderSession(); },
    connected: () => connected,
    rebind(current) { host = current; if (snapshot) renderSession(); },
    disconnect(message = "Host registration removed, disabled or changed.") { client?.close(message); },
    syncRow(value) {
      row = value || { ...row, live: undefined };
      if (!row.live) {
        connected = false;
        grant = null;
        clearTimeout(refreshTimer);
        refreshTimer = null;
        // Keep the attachment subscribed for a targeted closeFrontend update.
      }
      if (snapshot) renderSession();
      else { setStatus($("session-status"), displayStatus()); renderControls(); }
    },
    cwd: () => owner?.interactions.runtime?.cwd || row.cwd,
    show() { if (snapshot) renderSession(); element.focus({ preventScroll: true }); },
    dispose() {
      disposed = true;
      clearInterval(heartbeat); clearTimeout(refreshTimer);
      client?.close();
    },
  };
}

// System prompt patches hold structured sections, not user-visible conversation text.
function visibleMessage(message) {
  if (message.role === "custom" && message.display === false) return false;
  if (message.role !== "system") return true;
  return typeof message.content === "string" ? Boolean(message.content.trim())
    : Array.isArray(message.content) && message.content.some(block => block.type === "text" && block.text?.trim());
}
