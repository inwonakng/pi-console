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
let hosts = [], conversations = new Map(), activeKey = null, activeScreen = "overview", connecting = false, generation = 0;
let controllerLabel = "webui";
const completionStates = new Map(), expandedSubagents = new Set();
// Disconnecting a session keeps unsent text available in this page.
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
  for (const conversation of conversations.values()) {
    if (conversation.identity === host.hello.hostId && (!conversation.host.connected || !hosts.includes(conversation.host))) conversation.rebind(host);
  }
  if (host.historyRows) host.historyRows = value.sessions.map(row => ({ ...host.historyRows.find(saved => saved.id === row.id), ...row, live: row.live }));
  renderOverview();
  if ($("history-dialog").open) renderHistory();
  renderScreens();
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
      renderScreens();
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
        for (const conversation of conversations.values()) if (conversation.host === host) conversation.disconnect();
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
        const old = conversations.get(sessionKey(host.hello.hostId, row.id));
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
  const conversation = conversations.get(activeKey);
  const host = conversation ? uniqueHosts().find(host => host.connected && hostIdentity(host) === conversation.identity)
    : uniqueHosts().find(host => host.connected);
  if (!host) { notice("Connect to an execution host first."); return; }
  $("create-host").value = host.key;
  $("cwd").value = inWorkspace ? conversation?.cwd() || "" : "";
  $("create-dialog").showModal();
}
function renderScreens() {
  for (const [key, conversation] of conversations) {
    conversation.setScreen(key === activeKey, activeScreen === "options");
    conversation.syncRow(conversation.host.sessions.find(row => row.id === conversation.id));
  }
  $("overview").hidden = Boolean(activeKey);
}
function navigate(hash, replace = false) {
  if (location.hash !== hash) {
    history[replace ? "replaceState" : "pushState"]({ back: replace ? null : location.hash }, "", hash || location.pathname + location.search);
  }
  route();
}
function backTo(hash) {
  if (history.state?.back === hash) history.back();
  else navigate(hash, true);
}
function route() {
  const match = /^#sessions\/([\w-]{1,128})\/([\w-]{1,128})(\/options)?$/.exec(location.hash);
  const previousKey = activeKey, previousScreen = activeScreen;
  if (!match) {
    // Keep old single-host bookmarks usable, without implicitly resuming history.
    const legacy = /^#sessions\/([\w-]{1,128})$/.exec(location.hash);
    const local = hosts.find(host => host.key === "local" && host.connected);
    if (legacy && local) { navigate(sessionRoute(local, { id: legacy[1] }), true); return; }
    activeKey = null; activeScreen = "overview";
    renderScreens();
    if (previousKey) {
      ([...$("session-list").querySelectorAll("a")].find(link => link.dataset.key === previousKey) || $("overview")).focus({ preventScroll: true });
    }
    return;
  }
  const key = sessionKey(match[1], match[2]);
  let conversation = conversations.get(key);
  if (!conversation) {
    const host = hosts.find(host => host.connected && host.hello.hostId === match[1]);
    const row = host?.sessions.find(row => row.id === match[2]);
    if (!host || !row?.live) {
      activeKey = null; activeScreen = "overview"; renderScreens();
      if (!connecting) notice(!host ? "This host is unavailable. Reconnect it from Overview."
        : "This session is inactive or unavailable. Open History to resume it explicitly.");
      return;
    }
    conversation = createConversation(host, row);
    conversations.set(key, conversation);
    $("panels").append(conversation.element);
    void conversation.reconnect();
  }
  activeKey = key;
  activeScreen = match[3] ? "options" : "conversation";
  renderScreens();
  if (previousKey !== key || previousScreen !== activeScreen) conversation.show();
  renderOverview();
}
function detachConversation(key) {
  const conversation = conversations.get(key);
  if (!conversation) return;
  if (conversation.draft()) stoppedPromptDrafts.set(key, conversation.draft());
  conversation.dispose();
  conversation.element.remove(); conversations.delete(key);
  if (activeKey === key) navigate("", true);
  renderScreens(); renderOverview();
}

// Safari keeps the layout viewport tall while the software keyboard is open.
// Follow keyboard panning, but keep the shell inside the layout viewport when
// rotation leaves a stale visual-viewport offset. innerHeight can shrink with the
// keyboard, so use the root clientHeight for the layout viewport bounds.
function fitViewport() {
  const viewport = window.visualViewport;
  if (!viewport || viewport.scale !== 1) return;
  const layoutHeight = document.documentElement.clientHeight;
  const height = Math.min(viewport.height, layoutHeight);
  const top = Math.max(0, Math.min(viewport.offsetTop, layoutHeight - height));
  document.documentElement.style.setProperty("--viewport-height", `${height}px`);
  document.documentElement.style.setProperty("--viewport-top", `${top}px`);
  // Treat a large viewport reduction as a keyboard, rather than browser chrome.
  document.documentElement.classList.toggle("keyboard-open", layoutHeight - height > 150);
}
let viewportFrame;
function scheduleViewportFit() {
  cancelAnimationFrame(viewportFrame);
  viewportFrame = requestAnimationFrame(fitViewport);
}
window.visualViewport?.addEventListener("resize", scheduleViewportFit);
window.visualViewport?.addEventListener("scroll", scheduleViewportFit);
window.addEventListener("resize", scheduleViewportFit);
window.addEventListener("pageshow", scheduleViewportFit);
window.screen.orientation?.addEventListener("change", scheduleViewportFit);
fitViewport();

let viewportDiagnosticsTimer;
function toggleViewportDiagnostics() {
  const existing = $("viewport-diagnostics");
  if (existing) {
    clearInterval(viewportDiagnosticsTimer);
    existing.remove();
    return;
  }
  const panel = text("pre");
  panel.id = "viewport-diagnostics";
  panel.setAttribute("aria-label", "Layout diagnostics");
  document.body.append(panel);
  const update = () => {
    const viewport = window.visualViewport;
    const prompt = document.querySelector('.conversation:not([hidden]) .chat-screen:not([hidden]) [data-id="prompt"]');
    const bounds = node => {
      if (!node) return "-";
      const rect = node.getBoundingClientRect();
      return `${Math.round(rect.top)}..${Math.round(rect.bottom)}`;
    };
    const scrolls = [];
    for (let node = prompt; node; node = node.parentElement) {
      if (node.scrollTop) scrolls.push(`${node.dataset.id || node.id || node.tagName}=${Math.round(node.scrollTop)}`);
    }
    const mode = navigator.standalone || matchMedia("(display-mode: standalone)").matches ? "home-screen" : "browser";
    const shell = getComputedStyle(document.body);
    // Read geometry only: never include prompt text, session data or host details.
    panel.textContent = [
      `Layout diagnostics v1 (${mode})`,
      `visual top/height: ${viewport ? `${Math.round(viewport.offsetTop)} / ${Math.round(viewport.height)}` : "unavailable"}`,
      `scale: ${viewport?.scale ?? "-"} | inner/doc height: ${innerHeight}/${document.documentElement.clientHeight}`,
      `window scrollY: ${Math.round(scrollY)} | visual pageTop: ${viewport ? Math.round(viewport.pageTop) : "-"}`,
      `shell CSS top/height: ${shell.top} / ${shell.height}`,
      `body bounds: ${bounds(document.body)}`,
      `chat bounds: ${bounds(prompt?.closest(".chat-screen"))}`,
      `composer bounds: ${bounds(prompt?.closest(".composer"))}`,
      `input bounds: ${bounds(prompt)}`,
      `focus: ${document.activeElement?.dataset.id || document.activeElement?.tagName}`,
      `ancestor scrollTop: ${scrolls.join(", ") || "all zero"}`,
      "Toggle in Options. Screenshot with keyboard open.",
    ].join("\n");
    // Keep the readout visible even if the app shell has been panned offscreen.
    panel.style.top = `${Math.max(0, viewport?.offsetTop ?? 0) + 6}px`;
  };
  update();
  viewportDiagnosticsTimer = setInterval(update, 100);
}

$("refresh-app").addEventListener("click", () => location.reload());
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
  conversations.get(activeKey)?.viewed();
  renderOverview(); renderScreens();
}
window.addEventListener("focus", refreshViewedStatus);
document.addEventListener("visibilitychange", refreshViewedStatus);
window.addEventListener("hashchange", route);
window.addEventListener("popstate", route);
window.addEventListener("pagehide", event => {
  for (const host of hosts) host.client?.close();
  for (const conversation of conversations.values()) {
    if (event.persisted) conversation.disconnect("Page suspended. Reconnect explicitly to continue.");
    else conversation.dispose();
  }
});
window.addEventListener("pageshow", event => {
  if (event.persisted) notice("Page restored. Refresh hosts, then reconnect sessions from Options. Commands were not replayed.");
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
  $("options-title").textContent = sessionName(row);
  let client, hello, snapshot, attachment, grant, owner;
  let busy = false, connected = false, disposed = false;
  let streamSequence = 0, authoritySequence = 0, runtimeRevision = 0;
  let refreshTimer, refreshing = false, dirty = false;
  let transcriptKey = "", interactionKey = "";
  let following = true, savedScrollTop = 0;
  const transcriptEntries = new Map(), assistantGroups = new Map();
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
        detachConversation(key);
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
    $("control").textContent = controlled ? "Detach" : "Take control";
    $("control").disabled = !host.connected || !row.live || !connected || !snapshot || busy;
    $("controller").textContent = !host.connected ? "Unknown / read only" : !row.live ? "Inactive / read only"
      : !connected ? "Unknown / read only" : controlled ? "You control this session"
      : owner?.controller ? `Controlled by ${owner.controller.label}` : "Read only / no controller";
    $("abort").hidden = !snapshot?.conversation.execution.running;
    $("abort").disabled = !controlled || busy || !snapshot?.conversation.execution.running;
    $("choose-directory").disabled = !host.connected;
    $("new-workspace").disabled = !host.connected;
    $("rename").disabled = !controlled || busy;
    const ready = owner?.phase === "ready";
    $("prompt").disabled = !controlled || !ready;
    $("send").disabled = !controlled || !ready || busy || !$("prompt").value.trim();
    $("composer-hint").textContent = !host.connected || !connected ? "Disconnected. Open Options to reconnect."
      : !row.live ? "Session inactive. Resume it from History." : !controlled ? "Take control in Options to send a prompt."
      : !ready ? "Waiting for session setup." : snapshot?.conversation.execution.running ? "Prompts sent while working are queued." : "";
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
      if (!element.hidden && !$("options-screen").hidden) void loadSettings();
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
    $("options-title").textContent = $("session-title").textContent;
    $("session-directory").textContent = `${host.alias} / ${owner?.interactions.runtime?.cwd || currentRow.cwd || ""}`;
    if (host.connected && row.live && connected && owner?.error) notice(owner.error);
    renderTranscript();
    if (connected) sessionStatus(host, row, snapshot, false, true);
    const state = displayStatus();
    setStatus($("session-status"), state);
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
      if (block.type === "thinking") {
        const details = blockDetails("Thinking", block.thinking, `${prefix}-thinking-${index}`, markdown);
        details.dataset.kind = block.type;
        return details;
      }
      if (block.type === "toolCall") {
        const details = blockDetails(block.name, block.arguments, `${prefix}-call-${block.id}`);
        details.dataset.kind = block.type;
        return details;
      }
      if (block.type === "image") return text("p", "[Image attachment]", "muted");
      return blockDetails(block.type || "Content", block, `${prefix}-${index}`);
    });
  }
  function renderTranscript() {
    if (element.hidden || $("chat-screen").hidden) return;
    const conversation = snapshot.conversation;
    const live = Boolean(host.connected && row.live && connected);
    const key = JSON.stringify([conversation, live]);
    if (key === transcriptKey) return;
    transcriptKey = key;
    const target = $("transcript"), container = $("messages");
    const scrollTop = target.scrollTop;
    const top = target.getBoundingClientRect().top;
    const anchor = [...container.children].flatMap(node => node.dataset.role === "assistant" ? [...node.children].slice(1) : [node])
      .find(node => node.getBoundingClientRect().bottom > top);
    const anchorTop = anchor?.getBoundingClientRect().top;
    const diagnostics = conversation.diagnostics || [];
    const diagnosticMessages = items => items.map(item => ({ key: `diagnostic-${item.id}`, message: { role: "error", content: item.message } }));
    const keys = conversation.messageKeys || [];
    const toolAnchors = new Map();
    const history = diagnosticMessages(diagnostics.filter(item => item.assistantTimestamp == null
      && item.afterMessage == null && !conversation.omittedMessages));
    conversation.messages.forEach((message, index) => {
      const anchor = keys[index];
      const unique = anchor && keys.indexOf(anchor) === keys.lastIndexOf(anchor);
      if (message.role === "assistant" && Array.isArray(message.content)) {
        for (const block of message.content) {
          if (block.type === "toolCall") toolAnchors.set(block.id, anchor);
        }
      }
      const partialKey = `partial-${message.timestamp}`;
      const toolAnchor = toolAnchors.get(message.toolCallId);
      const entryKey = message.role === "toolResult" && toolAnchor ? `tool-${toolAnchor}-${message.toolCallId}`
        : message.role === "assistant" && transcriptEntries.has(partialKey) ? partialKey
        : unique ? `message-${anchor}` : `message-index-${conversation.omittedMessages + index}`;
      history.push({ key: entryKey, message, anchor: unique ? anchor : undefined });
      if (unique) {
        history.push(...diagnosticMessages(diagnostics.filter(item => item.assistantTimestamp == null && item.afterMessage === anchor)));
      }
    });
    if (conversation.partialAssistant) {
      const partial = conversation.partialAssistant.message;
      history.push({ key: `partial-${partial.timestamp}`, message: partial }, ...diagnosticMessages(diagnostics.filter(item => item.assistantTimestamp != null
        && item.assistantTimestamp === partial.timestamp)));
    }
    // Keep live executions beside their owner, including completed records until
    // the corresponding history result arrives. Reuse its key and expanded DOM.
    const historyKeys = new Set(history.map(entry => entry.key));
    const messages = history.flatMap(entry => {
      const tools = live ? conversation.tools.filter(tool => tool.messageKey ? entry.anchor === tool.messageKey
        : entry.message.role === "assistant" && Array.isArray(entry.message.content)
          && entry.message.content.some(block => block.type === "toolCall" && block.id === tool.toolCallId)) : [];
      return [entry, ...tools.flatMap(tool => {
        const key = `tool-${tool.messageKey || entry.anchor}-${tool.toolCallId}`;
        if (historyKeys.has(key)) return [];
        const message = tool.result ? { ...tool.result, role: "toolResult", toolName: tool.toolName,
          toolCallId: tool.toolCallId, isError: tool.isError || tool.result.isError } : { role: "toolResult" };
        return [{ key, message, tool: tool.result ? undefined : tool }];
      })];
    });
    const supersededErrors = new Set();
    let retryError;
    for (const { key, message } of messages) {
      if (message.role === "assistant" && message.stopReason !== "aborted" && (message.stopReason === "error" || message.errorMessage)) {
        if (retryError) supersededErrors.add(retryError);
        retryError = key;
      } else retryError = undefined;
    }
    const visible = [];
    for (const entry of messages) {
      const { key, message } = entry;
      if (!visibleMessage(message)) continue;
      // Empty streaming responses should not create an assistant heading yet.
      if (message.role !== "assistant" || !Array.isArray(message.content) || message.content.some(block =>
        block.type === "text" ? Boolean(block.text) : block.type === "thinking" ? Boolean(block.thinking) : true)) visible.push(entry);
      if (message.role === "assistant" && !supersededErrors.has(key)
        && (message.stopReason === "error" || message.stopReason === "aborted" || message.errorMessage)) {
        visible.push({ key: `error-${key}`, message: {
          role: message.stopReason === "aborted" ? "aborted" : "error",
          content: message.errorMessage || (message.stopReason === "aborted" ? "Response aborted." : "Model request failed."),
        } });
      }
    }
    const entries = visible.map(({ key, message, tool }) => {
      const assistant = ["assistant", "toolResult", "bashExecution"].includes(message.role)
        || message.role === "custom" && ["spawn_completion", "spawn_control_result"].includes(message.customType);
      return { key, assistant, value: tool || message, render() {
        const article = text(assistant ? "div" : "article", "", assistant ? "assistant-part" : "message");
        article.dataset.role = message.role;
        if (tool) {
          const details = blockDetails(`${tool.toolName} / ${tool.state}`, tool.partialResult || tool.args, `output-${key}`);
          details.className = "tool-output";
          details.dataset.error = String(Boolean(tool.isError));
          article.append(details);
        } else if (message.role === "toolResult") {
          const details = document.createElement("details");
          details.className = "tool-output";
          details.dataset.key = `output-${key}`;
          details.dataset.error = String(Boolean(message.isError));
          details.append(text("summary", `${message.toolName || "Tool"} / ${message.isError ? "error" : "output"}`));
          details.append(...contentNodes(message.content ?? message.output ?? message.text ?? message, key, false));
          if (message.errorMessage) details.append(text("p", message.errorMessage));
          article.append(details);
        } else {
          if (!assistant) article.append(text("div", message.role, "message-label"));
          article.append(...contentNodes(message.content ?? message.output ?? message.text ?? message, key));
          if (message.role !== "assistant" && message.errorMessage) article.append(text("p", message.errorMessage));
        }
        return article;
      } };
    });
    if (conversation.omittedMessages) entries.unshift({ key: "omitted", value: conversation.omittedMessages,
      render: () => text("p", `${conversation.omittedMessages} older messages are outside this snapshot.`, "muted") });
    if (!entries.length) entries.push({ key: "empty", value: conversation.hydrated,
      render: () => text("p", conversation.hydrated ? "No messages yet. Write your first prompt below." : "Loading conversation...", "empty") });
    const retained = new Set(entries.map(entry => entry.key));
    for (const [key, entry] of transcriptEntries) {
      if (!retained.has(key)) { entry.node.remove(); transcriptEntries.delete(key); }
    }
    // Match Neovim's assistant_block_open: tool activity and later assistant
    // messages share one heading until a visible standalone message or error.
    const roots = [], groups = new Map();
    let group;
    entries.forEach(entry => {
      const signature = JSON.stringify(entry.value);
      let cached = transcriptEntries.get(entry.key);
      if (!cached) {
        cached = { node: entry.render(), signature };
        transcriptEntries.set(entry.key, cached);
      } else if (cached.signature !== signature) {
        cached.node = updateContent(cached.node, entry.render());
        cached.signature = signature;
      }
      if (!entry.assistant) {
        group = undefined;
        roots.push(cached.node);
        return;
      }
      if (!group) {
        let node = assistantGroups.get(entry.key);
        if (!node) {
          node = text("article", "", "message");
          node.dataset.role = "assistant";
          node.append(text("div", "Pi", "message-label"));
          assistantGroups.set(entry.key, node);
        }
        group = { node, count: 1 };
        groups.set(entry.key, group);
        roots.push(node);
      }
      if (group.node.children[group.count] !== cached.node) group.node.insertBefore(cached.node, group.node.children[group.count] || null);
      group.count++;
    });
    for (const [key, node] of assistantGroups) {
      const group = groups.get(key);
      if (!group) { node.remove(); assistantGroups.delete(key); }
      else while (node.children.length > group.count) node.lastChild.remove();
    }
    roots.forEach((node, index) => {
      if (container.children[index] !== node) container.insertBefore(node, container.children[index] || null);
    });
    if (following) target.scrollTop = target.scrollHeight;
    else if (anchor?.isConnected) target.scrollTop += anchor.getBoundingClientRect().top - anchorTop;
    else target.scrollTop = scrollTop;
    savedScrollTop = target.scrollTop;
    $("latest").hidden = following;
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
    if (following && !element.hidden && !$("chat-screen").hidden) $("transcript").scrollTop = $("transcript").scrollHeight;
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
    if (controlsCurrent()) {
      await command("control.release");
      if (sameContext(captured)) grant = null;
      return;
    }
    const takeover = Boolean(owner?.controller);
    if (takeover && !confirm(`Take control from ${owner.controller.label}?`)) return;
    await command(takeover ? "control.takeover" : "control.acquire", takeover ? { confirmed: true } : {});
    const value = await client.request("grant");
    if (sameContext(captured)) { grant = value; if (!controlsCurrent()) scheduleRefresh(); }
  }));
  $("layout-diagnostics").addEventListener("click", toggleViewportDiagnostics);
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
        resizePrompt();
      }
    });
  });
  function resizePrompt() {
    if (element.hidden || $("chat-screen").hidden) return;
    const prompt = $("prompt");
    prompt.style.height = "auto";
    prompt.style.height = `${prompt.scrollHeight + 2}px`;
    if (following) $("transcript").scrollTop = $("transcript").scrollHeight;
  }
  $("prompt").addEventListener("input", () => { resizePrompt(); renderControls(); });
  $("new-workspace").addEventListener("click", () => showCreate(true));
  $("choose-directory").addEventListener("click", () => showCreate());
  $("back").addEventListener("click", () => backTo(""));
  $("options").addEventListener("click", () => navigate(`${sessionRoute(host, row)}/options`));
  $("options-back").addEventListener("click", () => backTo(sessionRoute(host, row)));
  $("detach").addEventListener("click", () => detachConversation(key));
  $("stop").addEventListener("click", () => {
    if (confirm('Stop "' + sessionName(row) + '" on ' + host.alias + '? Active work will be interrupted; history is preserved.')) {
      run(() => command("session.kill", { confirmed: true }));
    }
  });
  $("reconnect").addEventListener("click", () => { void reconnect(); });
  $("latest").addEventListener("click", () => {
    following = true;
    $("transcript").scrollTop = $("transcript").scrollHeight;
    $("latest").hidden = true;
  });
  $("transcript").addEventListener("scroll", () => {
    if (element.hidden || $("chat-screen").hidden) return;
    const target = $("transcript");
    savedScrollTop = target.scrollTop;
    following = target.scrollHeight - target.scrollTop - target.clientHeight < 100;
    $("latest").hidden = following;
  });
  let promptWidth = 0;
  const transcriptResize = new ResizeObserver(() => {
    if (element.hidden || $("chat-screen").hidden) return;
    if (promptWidth !== $("prompt").clientWidth) {
      promptWidth = $("prompt").clientWidth;
      resizePrompt();
    }
    if (following) $("transcript").scrollTop = $("transcript").scrollHeight;
    $("latest").hidden = following;
  });
  transcriptResize.observe($("transcript"));
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
    identity, id: selectedId, element, reconnect,
    draft: () => $("prompt").value,
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
    setScreen(visible, options) {
      const chat = $("chat-screen"), settings = $("options-screen");
      const wasChat = !element.hidden && !chat.hidden;
      const showChat = visible && !options;
      if (wasChat && !showChat) savedScrollTop = $("transcript").scrollTop;
      element.hidden = !visible;
      chat.hidden = options;
      settings.hidden = !options;
      if (!wasChat && showChat) {
        $("transcript").scrollTop = savedScrollTop;
        resizePrompt();
        if (snapshot) renderSession();
        if (following) $("transcript").scrollTop = $("transcript").scrollHeight;
      }
    },
    show() {
      if (snapshot) renderSession();
      (activeScreen === "options" ? $("options-screen") : $("chat-screen")).focus({ preventScroll: true });
    },
    dispose() {
      disposed = true;
      clearInterval(heartbeat); clearTimeout(refreshTimer);
      transcriptResize.disconnect();
      client?.close();
    },
  };
}

// Update streaming content in place, retaining selection and expanded details in
// unchanged blocks instead of replacing the transcript on every snapshot.
function updateContent(current, next) {
  if (current.nodeType !== next.nodeType || current.nodeName !== next.nodeName
    || current.nodeType === Node.ELEMENT_NODE && current.dataset.key !== next.dataset.key) {
    current.replaceWith(next);
    return next;
  }
  if (current.nodeType === Node.TEXT_NODE) {
    if (current.data !== next.data) current.data = next.data;
    return current;
  }
  if (current.nodeType !== Node.ELEMENT_NODE) return current;
  for (const attribute of [...current.attributes]) {
    if (current.tagName === "DETAILS" && attribute.name === "open") continue;
    if (!next.hasAttribute(attribute.name)) current.removeAttribute(attribute.name);
  }
  for (const attribute of next.attributes) {
    if (current.getAttribute(attribute.name) !== attribute.value) current.setAttribute(attribute.name, attribute.value);
  }
  const children = [...next.childNodes];
  children.forEach((child, index) => {
    if (current.childNodes[index]) updateContent(current.childNodes[index], child);
    else current.append(child);
  });
  while (current.childNodes.length > children.length) current.lastChild.remove();
  return current;
}

// System prompt patches hold structured sections, not user-visible conversation text.
function visibleMessage(message) {
  if (message.role === "custom" && message.display === false) return false;
  if (message.role !== "system") return true;
  return typeof message.content === "string" ? Boolean(message.content.trim())
    : Array.isArray(message.content) && message.content.some(block => block.type === "text" && block.text?.trim());
}
