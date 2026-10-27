import { ServiceClient, requestId } from "./client.js";
import { renderMarkdown } from "./markdown.js";
import { snapshotQuery, mergeSnapshot } from "./snapshot.js";
import { exportDiagnostics, clearDiagnostics, recordDiagnostic } from "./diagnostics.js";

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
const diagnosticHosts = new WeakMap();
let nextDiagnosticHost = 0;
function connectionDiagnostics(host, role) {
  if (!diagnosticHosts.has(host)) diagnosticHosts.set(host, ++nextDiagnosticHost);
  return { role, hostGroup: diagnosticHosts.get(host) };
}
function bindDiagnostics(panel) {
  const status = panel.querySelector('[data-id="diagnostics-status"]');
  panel.querySelector('[data-id="export-diagnostics"]').addEventListener("click", () => {
    void exportDiagnostics().then(message => { status.textContent = message; }).catch(() => {
      status.textContent = "Could not export diagnostics on this browser.";
    });
  });
  panel.querySelector('[data-id="clear-diagnostics"]').addEventListener("click", () => { status.textContent = clearDiagnostics(); });
}
bindDiagnostics($("overview-diagnostics"));
const sessionName = row => row?.name || row?.cwd?.split("/").filter(Boolean).pop() || "Untitled session";
const sessionKey = (hostId, sessionId) => `${hostId}/${sessionId}`;
const sessionRoute = (host, row) => `#sessions/${host.hello.hostId}/${row.id}`;
let hosts = [], conversations = new Map(), activeKey = null, activeScreen = "overview", connecting = false, generation = 0;
let controllerLabel = "webui";
let pageLeaving = false, recoveryTimer, recoveryRunning = false, recoveryCheck = false;
const recoveryState = () => ({ attempt: 0, due: 0, blocked: false });
const canRecover = () => !pageLeaving && !document.hidden && navigator.onLine !== false;
const registered = host => hosts.includes(host) && host.enabled !== false;
function recoveryFailed(state, client) {
  state.blocked = client?.recoveryBlocked === true;
  state.attempt = Math.min(10, state.attempt + 1);
  const delay = state.blocked ? 0 : Math.min(30000, 1000 * 2 ** Math.min(5, state.attempt - 1));
  state.due = Date.now() + delay;
  if (client) recordDiagnostic("recovery", { ...client.diagnostics, outcome: state.blocked ? "blocked" : "retry", attempt: state.attempt, delay });
}
function recoverySucceeded(state, client) {
  if (state.attempt) recordDiagnostic("recovery", { ...client.diagnostics, outcome: "recovered", attempt: state.attempt, delay: 0 });
  state.attempt = 0; state.due = 0; state.blocked = false;
}
function scheduleRecovery(check = false) {
  recoveryCheck ||= check;
  clearTimeout(recoveryTimer);
  recoveryTimer = null;
  if (!canRecover() || recoveryRunning) return;
  recoveryTimer = setTimeout(recoverConnections, check ? 100 : 1000);
}
async function recoverConnections() {
  recoveryTimer = null;
  if (!canRecover() || recoveryRunning) return;
  recoveryRunning = true;
  const check = recoveryCheck;
  recoveryCheck = false;
  try {
    await Promise.allSettled(hosts.filter(registered).map(async host => {
      const state = host.recovery;
      if (state.blocked || !canRecover()) return;
      if (!host.connected) {
        if (Date.now() >= state.due) await connectHost(host, true);
      } else if (check && !host.connecting) {
        const connection = host.client;
        try {
          await connection.probe();
          if (!canRecover() || !registered(host) || host.client !== connection || connection.closed) return;
          const summaries = await connection.request("sessions.subscribe");
          if (host.client === connection && registered(host) && !connection.closed) setSummaries(host, summaries);
        } catch {
          if (host.client === connection && connection.recoveryBlocked) state.blocked = true;
        }
      }
    }));
    if (canRecover()) await Promise.allSettled([...conversations.values()].map(conversation => conversation.recover(check)));
  } finally {
    recoveryRunning = false;
    scheduleRecovery(recoveryCheck);
  }
}
const expandedSubagents = new Set();
const sessionOrderStorage = `pi-console:${channel}:session-order`;
let sessionOrder = [];
try {
  const saved = JSON.parse(localStorage.getItem(sessionOrderStorage));
  if (Array.isArray(saved)) sessionOrder = [...new Set(saved.filter(key => typeof key === "string"))];
} catch { /* Storage may be unavailable; retain order for this page. */ }
let sessionDrag;
function saveSessionOrder() {
  try { localStorage.setItem(sessionOrderStorage, JSON.stringify(sessionOrder)); } catch { /* Keep the in-page order. */ }
}
function rememberSessions(host) {
  const known = new Set(sessionOrder);
  const added = host.sessions.map(row => sessionKey(host.hello.hostId, row.id)).filter(key => !known.has(key));
  if (added.length) { sessionOrder.push(...added); saveSessionOrder(); }
}
function moveSession(key, target, after) {
  const next = sessionOrder.filter(item => item !== key);
  const index = next.indexOf(target);
  if (index < 0 || key === target) return;
  next.splice(index + Number(after), 0, key);
  sessionOrder = next;
}
function bindSessionReorder(link, key, name) {
  link.setAttribute("aria-describedby", "reorder-help");
  link.title = "Drag the session row (press and hold on touch), or use up and down arrow keys";
  link.addEventListener("keydown", event => {
    if (!["ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    const keys = [...$("session-list").children].map(node => node.dataset.key);
    const adjacent = keys[keys.indexOf(key) + (event.key === "ArrowUp" ? -1 : 1)];
    if (!adjacent) return;
    moveSession(key, adjacent, event.key === "ArrowDown");
    saveSessionOrder(); renderOverview();
    [...$("session-list").children].find(node => node.dataset.key === key)?.querySelector(".session-row").focus();
    $("reorder-status").textContent = `${name} moved ${event.key === "ArrowUp" ? "up" : "down"}.`;
  });
}
function bindSessionDrag(heading, key) {
  const list = $("session-list");
  let holdTimer;
  const start = (point, touch) => {
    sessionDrag = { key, entry: heading.closest(".session-entry"), pointerId: point.pointerId,
      startX: point.clientX, startY: point.clientY, touch, active: !touch, initial: [...sessionOrder], moved: false };
    window.addEventListener("blur", cancel);
  };
  const lift = () => {
    const drag = sessionDrag;
    const rect = drag.entry.getBoundingClientRect();
    // Keep the real entry in the list as the drop gap and touch-event target.
    drag.preview = drag.entry.cloneNode(true);
    drag.preview.classList.add("session-drag-preview");
    drag.preview.setAttribute("aria-hidden", "true");
    drag.preview.inert = true;
    Object.assign(drag.preview.style, { left: `${rect.left + 8}px`, top: `${rect.top}px`, width: `${rect.width - 16}px` });
    document.body.append(drag.preview);
    drag.entry.classList.add("reordering");
    if (drag.touch) {
      try { navigator.vibrate?.(15); } catch { /* Haptics are optional; dragging must still work. */ }
    }
  };
  const move = point => {
    const drag = sessionDrag;
    const distance = Math.hypot(point.clientX - drag.startX, point.clientY - drag.startY);
    if (!drag.active) {
      if (distance > 8) finish(true);
      return;
    }
    if (!drag.moved && distance < 5) return;
    if (!drag.moved && !drag.touch) list.setPointerCapture(drag.pointerId);
    if (!drag.preview) lift();
    drag.moved = true;
    drag.preview.style.setProperty("--drag-x", `${point.clientX - drag.startX}px`);
    drag.preview.style.setProperty("--drag-y", `${point.clientY - drag.startY}px`);
    const overview = $("overview"), bounds = overview.getBoundingClientRect();
    if (point.clientY < bounds.top + 60) overview.scrollTop -= 16;
    else if (point.clientY > bounds.bottom - 60) overview.scrollTop += 16;
    const over = document.elementFromPoint(point.clientX, point.clientY)?.closest("#session-list > .session-entry");
    if (!over || over === drag.entry) return;
    const rect = over.getBoundingClientRect(), after = point.clientY > rect.top + rect.height / 2;
    moveSession(key, over.dataset.key, after);
    const before = after ? over.nextSibling : over;
    if (before !== drag.entry) over.parentElement.insertBefore(drag.entry, before);
  };
  const finish = (cancelled = false) => {
    const drag = sessionDrag;
    if (!drag) return;
    sessionDrag = null;
    clearTimeout(holdTimer);
    window.removeEventListener("blur", cancel);
    document.removeEventListener("pointermove", pointerMove);
    document.removeEventListener("pointerup", pointerFinish);
    document.removeEventListener("pointercancel", pointerFinish);
    list.removeEventListener("lostpointercapture", pointerFinish);
    document.removeEventListener("touchmove", touchMove);
    document.removeEventListener("touchend", touchFinish);
    document.removeEventListener("touchcancel", touchFinish);
    if (!drag.touch && list.hasPointerCapture(drag.pointerId)) list.releasePointerCapture(drag.pointerId);
    if (cancelled) sessionOrder = [...drag.initial, ...sessionOrder.filter(key => !drag.initial.includes(key))];
    if (drag.moved) saveSessionOrder();
    drag.entry.classList.remove("reordering");
    drag.preview?.remove();
    // Leave ordinary taps intact, including their original link target.
    if (!drag.moved && !(drag.touch && drag.active)) return;
    const suppressClick = event => { event.preventDefault(); event.stopImmediatePropagation(); };
    list.addEventListener("click", suppressClick, true);
    setTimeout(() => list.removeEventListener("click", suppressClick, true), 0);
    renderOverview();
    [...list.children].find(node => node.dataset.key === key)?.querySelector(".session-row").focus({ preventScroll: true });
  };
  const cancel = () => finish(true);
  const pointerMove = event => { if (event.pointerId === sessionDrag?.pointerId) move(event); };
  const pointerFinish = event => { if (event.pointerId === sessionDrag?.pointerId) finish(event.type !== "pointerup"); };
  const touchMove = event => {
    if (event.touches.length !== 1) { finish(true); return; }
    if (sessionDrag.active) event.preventDefault();
    move(event.touches[0]);
  };
  const touchFinish = event => {
    if (sessionDrag.active) event.preventDefault();
    finish(event.type === "touchcancel" || event.touches.length > 0);
  };
  heading.addEventListener("pointerdown", event => {
    if (event.pointerType === "touch" || event.button !== 0 || sessionDrag) return;
    start(event, false);
    document.addEventListener("pointermove", pointerMove);
    document.addEventListener("pointerup", pointerFinish);
    document.addEventListener("pointercancel", pointerFinish);
    list.addEventListener("lostpointercapture", pointerFinish);
  });
  heading.addEventListener("touchstart", event => {
    if (sessionDrag || event.touches.length !== 1) return;
    start(event.touches[0], true);
    // Keep native scrolling until a stationary press activates reordering.
    holdTimer = setTimeout(() => {
      sessionDrag.active = true;
      lift();
    }, 400);
    document.addEventListener("touchmove", touchMove, { passive: false });
    document.addEventListener("touchend", touchFinish, { passive: false });
    document.addEventListener("touchcancel", touchFinish, { passive: false });
  }, { passive: true });
  heading.addEventListener("contextmenu", event => { if (sessionDrag?.touch) event.preventDefault(); });
}
// Disconnecting a session keeps unsent text available in this page.
const stoppedPromptDrafts = new Map();
function sessionStatus(host, row, activity = row.live) {
  if (!host.connected || navigator.onLine === false) return "Unknown";
  if (!row.live) return "Stopped";
  return activity?.status || "Unknown";
}
function setStatus(node, status) {
  node.textContent = status === "Done" ? "✓ Done" : status;
  node.dataset.state = status;
}

function renderNotice(node, message) {
  node.replaceChildren(text("span", message, "notice-message"), button("Reload", () => location.reload()));
  node.hidden = !message;
}
function notice(message = "") {
  renderNotice($("notice"), message);
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
  if (!host.connected || navigator.onLine === false) throw new Error("Connect to this host while online first.");
  const envelope = { id: requestId(), serviceEpoch: host.hello.serviceEpoch, operation, payload };
  const connection = host.client;
  let receipt = receiptResult(await connection.request("host.command", envelope));
  receipt = await terminalReceipt(connection, "host.status", { serviceEpoch: envelope.serviceEpoch, commandId: envelope.id }, receipt);
  return receipt.result.sessionId;
}
function sameOwner(host, value) {
  return value?.hostId === host.hello.hostId && value?.serviceEpoch === host.hello.serviceEpoch && value?.channel === channel;
}
function setSummaries(host, value) {
  if (!sameOwner(host, value) || !Array.isArray(value.sessions)) {
    host.recovery.blocked = true;
    host.client.recoveryBlocked = true;
    host.client.close("Host identity changed. Review its registration and refresh hosts explicitly.", "host_identity_changed");
    return false;
  }
  host.sessions = value.sessions;
  rememberSessions(host);
  for (const conversation of conversations.values()) {
    if (conversation.identity === host.hello.hostId && (!conversation.host.connected || !hosts.includes(conversation.host))) conversation.rebind(host);
  }
  if (host.historyRows) host.historyRows = value.sessions.map(row => ({ ...host.historyRows.find(saved => saved.id === row.id), ...row, live: row.live }));
  renderOverview();
  if ($("history-dialog").open) renderHistory();
  renderScreens();
  return true;
}
function connectHost(host, automatic = false) {
  if (host.connectPromise) return host.connectPromise;
  if (!registered(host) || pageLeaving || (automatic && (!canRecover() || host.recovery.blocked || Date.now() < host.recovery.due))) return Promise.resolve();
  if (!automatic) host.recovery = recoveryState();
  const attempt = host.attempt = (host.attempt || 0) + 1;
  host.connecting = true;
  host.client?.close(undefined, "host_setup_failed");
  host.connected = false;
  const next = new ServiceClient(record => {
    if (host.client !== next || host.attempt !== attempt) return;
    if (record.type === "disconnected") {
      const wasConnected = host.connected;
      host.connected = false;
      host.error = record.message;
      if (wasConnected && registered(host) && !pageLeaving) recoveryFailed(host.recovery, next);
      renderOverview();
      renderScreens();
      if ($("history-dialog").open) renderHistory();
      scheduleRecovery();
    } else if (record.type === "summaries" && host.hello) setSummaries(host, record.result);
  }, connectionDiagnostics(host, "host"));
  host.client = next;
  const current = () => registered(host) && !pageLeaving && (!automatic || canRecover())
    && host.client === next && host.attempt === attempt && !next.closed;
  renderOverview();
  host.connectPromise = (async () => {
    try {
      const hello = await next.connect(channel, host.stream, host.hostId);
      if (!current()) { next.close(undefined, "host_setup_failed"); return; }
      // Remember identity for this page even when the registry has no saved pin.
      host.hostId = hello.hostId;
      host.hello = hello;
      const summaries = await next.request("sessions.subscribe");
      if (!current()) { next.close(undefined, "host_setup_failed"); return; }
      host.connected = true;
      if (!setSummaries(host, summaries)) return;
      host.error = "";
      recoverySucceeded(host.recovery, next);
      route();
    } catch (error) {
      if (host.client !== next || host.attempt !== attempt) return;
      host.connected = false; host.error = error.message;
      next.close(error.message, "host_setup_failed");
      if (registered(host) && !pageLeaving) recoveryFailed(host.recovery, next);
    } finally {
      if (host.attempt === attempt) host.connecting = false;
      host.connectPromise = null;
      renderOverview();
      scheduleRecovery();
    }
  })();
  return host.connectPromise;
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
      return { ...target, sessions: [], connected: false, connecting: false, recovery: recoveryState() };
    });
    for (const host of previous) {
      if (!hosts.includes(host) || host.enabled === false) {
        host.attempt = (host.attempt || 0) + 1;
        host.connecting = false;
        host.connected = false;
        host.recovery.blocked = true;
        host.client?.close("Host registration removed, disabled or changed.", "host_registration_changed");
        for (const conversation of conversations.values()) if (conversation.host === host) conversation.disconnect();
      }
    }
    renderHostOptions();
    await Promise.allSettled(hosts.map(async host => {
      if (!registered(host)) return;
      if (host.connected) {
        const connection = host.client;
        const value = await connection.request("sessions.subscribe");
        if (registered(host) && host.client === connection && !connection.closed) setSummaries(host, value);
      } else await connectHost(host);
    }));
  } finally { connecting = false; $("connect").disabled = false; renderOverview(); }
}
function restartMessage(receipt) {
  if (!receipt) return "No saved server restart outcome.";
  return `Server restart ${receipt.status} (${receipt.id}).${receipt.error ? " " + receipt.error.message : ""}${receipt.result ? " Build: " + receipt.result.buildId : ""}`;
}
async function lastRestart(host) {
  host.restartMessage = restartMessage(await host.client.request("service.restart.status"));
  renderOverview();
}
async function restartHost(host, force = false) {
  if (host.restarting || !host.connected) return;
  const connection = host.client, hello = host.hello;
  if (!confirm(`${force ? "Force restart" : "Restart"} server on ${host.alias} [${channel}]?\n${force ? "Interrupts owned work." : "Active work refuses."} Saved sessions stay stopped. Installation and frontend restart are separate.`)) return;
  if (!host.connected || host.client !== connection || host.hello.serviceEpoch !== hello.serviceEpoch) throw new Error("Host connection changed; select restart again.");
  const query = { id: requestId(), serviceEpoch: hello.serviceEpoch };
  host.restarting = true;
  host.restartMessage = `Restart requested (${query.id}). Waiting for its outcome.`;
  renderOverview();
  let forceOffered = false;
  try {
    try {
      await connection.request("service.restart", { ...query, hostId: hello.hostId, force, confirmed: true });
    } catch (error) {
      if (error.delivery === "rejected" || error.delivery === "not_sent") throw error;
      // Lost acknowledgement: query the original ID only. Never replay restart.
      host.restartMessage = `Acknowledgement lost. Checking restart ${query.id}; it was not replayed.`;
    }
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      await sleep(1000);
      if (!hosts.includes(host) || host.enabled === false) throw new Error("Host registration changed. Inspect its restart outcome before retrying.");
      if (!host.connected) await connectHost(host, true);
      if (!host.connected) continue;
      let receipt;
      try { receipt = await host.client.request("service.restart.status", query); }
      catch { continue; }
      if (!receipt || receipt.status === "accepted") continue;
      host.restartMessage = restartMessage(receipt);
      if (receipt.status === "failed") {
        forceOffered = !force && receipt.error?.code === "session_busy" && host.hello.serviceEpoch === hello.serviceEpoch;
        return;
      }
      if (receipt.status === "completed" && receipt.result?.serviceEpoch === host.hello.serviceEpoch
        && receipt.result.buildId === host.hello.buildId) {
        host.restartMessage += " Saved sessions stay stopped until explicitly resumed.";
        await connectAll();
        notice(`${host.alias}: ${host.restartMessage}`);
        return;
      }
      host.client.close("Refreshing the replacement server identity.", "server_identity_refresh");
    }
    throw new Error(`Restart ${query.id} is unconfirmed. Check Last restart or service.log before retrying. Restart was not replayed.`);
  } catch (error) {
    host.restartMessage = error.message;
    throw error;
  } finally {
    host.restarting = false;
    renderOverview();
    if (forceOffered && confirm(`${host.alias}: ${host.restartMessage}\nForce restart and interrupt owned work? History/workspaces are kept; sessions stay stopped.`)) {
      await restartHost(host, true);
    }
  }
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
      option.disabled = id === "create-host" && (!host.connected || navigator.onLine === false);
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
  const connected = visible.filter(host => host.connected && navigator.onLine !== false).length;
  renderHostOptions();
  $("connection-state").textContent = `${connected}/${visible.length} connected`;
  $("connection-state").className = connected ? "connected" : "";
  $("connect").textContent = hosts.length ? "Refresh hosts" : "Connect";
  $("new-session").disabled = !connected;
  const focusedRow = document.activeElement.closest("#session-list a")?.dataset.key;
  $("hosts").replaceChildren(...visible.map(host => {
    const node = text("div", "", "host-state");
    const state = host.enabled === false ? "Disabled" : navigator.onLine === false ? "Offline"
      : host.connected ? "Connected" : host.connecting ? "Connecting" : host.recovery.blocked ? "Needs review" : "Reconnecting";
    node.append(text("span", `${host.alias} / ${state}`));
    if (!host.connected && !host.connecting && host.enabled !== false) node.append(button("Reconnect", () => perform(() => connectHost(host)), navigator.onLine === false));
    if (host.hello?.capabilities.includes("service.restart")) {
      node.append(button(host.restarting ? "Restarting..." : "Restart server", () => perform(() => restartHost(host)), !host.connected || host.restarting || navigator.onLine === false));
      node.append(button("Last restart", () => perform(() => lastRestart(host)), !host.connected || navigator.onLine === false));
    }
    if (host.restartMessage) node.append(text("p", host.restartMessage, "host-message"));
    if (host.error) node.append(text("p", host.error, "host-error"));
    return node;
  }));
  if (sessionDrag) return;
  const ranks = new Map(sessionOrder.map((key, index) => [key, index]));
  const rows = filteredRows().sort((a, b) => ranks.get(sessionKey(a.host.hello.hostId, a.row.id)) - ranks.get(sessionKey(b.host.hello.hostId, b.row.id)));
  $("session-list").replaceChildren(...rows.map(({ host, row }) => {
    const key = sessionKey(host.hello.hostId, row.id);
    const link = text("a", "", "session-row");
    link.href = sessionRoute(host, row);
    link.dataset.key = key;
    link.draggable = false;
    link.setAttribute("aria-disabled", String(!host.connected || navigator.onLine === false));
    link.addEventListener("click", event => {
      event.preventDefault();
      if (host.connected && navigator.onLine !== false) navigate(link.hash);
    });
    const heading = text("div", "", "row-heading");
    const state = sessionStatus(host, row);
    const status = text("span", "", "status");
    setStatus(status, state);
    heading.append(text("span", sessionName(row), "row-title"), status);
    link.append(heading, text("span", `${host.alias} / ${row.live?.cwd || row.cwd}`, "row-directory"));
    const group = text("div", "", "session-entry");
    group.dataset.key = key;
    const headingRow = text("div", "", "session-entry-heading");
    bindSessionReorder(link, key, sessionName(row));
    headingRow.append(link);
    group.append(headingRow);
    bindSessionDrag(headingRow, key);
    const runs = host.connected ? (row.live?.subagentRuns || []).filter(run => run.status === "running") : [];
    if (!runs.length) return group;
    const details = text("details", "", "subagent-runs");
    details.open = expandedSubagents.has(key);
    details.addEventListener("toggle", () => {
      if (details.open) expandedSubagents.add(key); else expandedSubagents.delete(key);
    });
    details.append(text("summary", `${runs.length} active subagent${runs.length === 1 ? "" : "s"}`));
    for (const run of runs) details.append(text("p", workerLabel(run)));
    const inspect = text("a", "Inspect subagents and artifacts");
    inspect.href = sessionRoute(host, row);
    inspect.addEventListener("click", event => { event.preventDefault(); navigate(inspect.hash); });
    details.append(inspect);
    group.append(details);
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
    }), !host.connected || navigator.onLine === false || host.busy || Boolean(row.archived));
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
  $("cwd").setCustomValidity("");
  $("create-dialog").showModal();
  refreshDirectories();
}

let directoryTimer, directoryGeneration = 0, directorySelection = -1;
function clearDirectories() {
  clearTimeout(directoryTimer);
  directoryGeneration++;
  directorySelection = -1;
  $("cwd-suggestions").replaceChildren();
  $("cwd-suggestions").hidden = true;
  $("cwd").setAttribute("aria-expanded", "false");
  $("cwd").removeAttribute("aria-activedescendant");
  directoryStatus("");
}
function directoryStatus(message) {
  $("cwd-status").textContent = message;
  $("cwd-status").hidden = !message;
}
function selectDirectory(path) {
  $("cwd").value = path.endsWith("/") ? path : path + "/";
  $("cwd").setCustomValidity("");
  $("cwd").focus();
  refreshDirectories();
}
function renderDirectories(paths) {
  directorySelection = -1;
  $("cwd").removeAttribute("aria-activedescendant");
  $("cwd-suggestions").replaceChildren(...paths.map((path, index) => {
    const option = text("div", path, "directory-option");
    option.id = `cwd-option-${index}`;
    option.setAttribute("role", "option");
    option.setAttribute("aria-selected", "false");
    option.addEventListener("pointerdown", event => event.preventDefault());
    option.addEventListener("click", () => selectDirectory(path));
    return option;
  }));
  $("cwd-suggestions").hidden = !paths.length;
  $("cwd").setAttribute("aria-expanded", String(Boolean(paths.length)));
}
function refreshDirectories() {
  clearDirectories();
  if (!$("create-dialog").open) return;
  const host = hosts.find(host => host.key === $("create-host").value);
  if (!host?.connected || navigator.onLine === false) { directoryStatus("Connect to this host while online for suggestions."); return; }
  const value = $("cwd").value.trim();
  if (!value) {
    // Host summaries are already ordered by most recent session activity.
    const paths = [...new Set(host.sessions.map(row => row.cwd))].slice(0, 10);
    renderDirectories(paths);
    directoryStatus(paths.length ? "Recent directories" : "Type an absolute path or ~/ to browse directories.");
    return;
  }
  if (!value.startsWith("/") && value !== "~" && !value.startsWith("~/")) {
    directoryStatus("Use an absolute directory path or ~/ on the host.");
    return;
  }
  const generation = directoryGeneration, connection = host.client, epoch = host.hello.serviceEpoch;
  const current = () => generation === directoryGeneration && $("create-dialog").open
    && host.client === connection && host.hello.serviceEpoch === epoch;
  const slash = value.lastIndexOf("/");
  const parent = value === "~" ? "~" : value.slice(0, slash + 1);
  const prefix = value === "~" ? "" : value.slice(slash + 1);
  directoryTimer = setTimeout(async () => {
    const paths = [];
    let offset;
    directoryStatus("Loading directories...");
    try {
      do {
        const page = await connection.request("host.directories", { serviceEpoch: epoch, path: parent, ...(offset === undefined ? {} : { offset }) });
        if (!current()) return;
        paths.push(...page.entries.filter(path => path.slice(path.lastIndexOf("/") + 1).startsWith(prefix)));
        offset = page.nextOffset;
      } while (paths.length < 10 && offset !== null);
      renderDirectories(paths.slice(0, 10));
      directoryStatus(paths.length ? "" : "No matching directories.");
    } catch (error) {
      if (current()) directoryStatus(`Could not suggest directories: ${error.message}`);
    }
  }, 150);
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
        : "This session is stopped or unavailable. Open History to resume it explicitly.");
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
$("create-host").addEventListener("change", () => {
  $("cwd").value = "";
  $("cwd").setCustomValidity("");
  refreshDirectories();
});
$("create-dialog").addEventListener("close", clearDirectories);
$("create-form").addEventListener("submit", event => {
  event.preventDefault();
  const host = hosts.find(host => host.key === $("create-host").value);
  const cwd = $("cwd").value.trim();
  if (!cwd.startsWith("/") && cwd !== "~" && !cwd.startsWith("~/")) {
    $("cwd").setCustomValidity("Use an absolute directory path or ~/ on the host.");
    $("cwd").reportValidity();
    return;
  }
  const submit = $("create-form").querySelector('[type="submit"]');
  if (submit.disabled) return;
  submit.disabled = true;
  perform(async () => {
    try {
      if (!host?.connected || navigator.onLine === false) throw new Error("Connect to this host while online first.");
      const connection = host.client, epoch = host.hello.serviceEpoch;
      const path = cwd.startsWith("~")
        ? (await connection.request("host.directories", { serviceEpoch: epoch, path: cwd })).path : cwd;
      if (host.client !== connection || host.hello.serviceEpoch !== epoch) throw new Error("Host connection changed; create the session again.");
      const id = await hostCommand(host, "host.create", { cwd: path });
      setSummaries(host, await host.client.request("sessions.subscribe"));
      $("create-dialog").close();
      navigate(sessionRoute(host, { id }));
    } finally { submit.disabled = false; }
  });
});
$("cwd").addEventListener("input", () => { $("cwd").setCustomValidity(""); refreshDirectories(); });
$("cwd").addEventListener("focus", refreshDirectories);
$("cwd").addEventListener("blur", clearDirectories);
$("cwd").addEventListener("keydown", event => {
  if (event.isComposing) return;
  const options = [...$("cwd-suggestions").children];
  if (event.key === "Escape" && options.length) { event.preventDefault(); clearDirectories(); return; }
  if (["ArrowDown", "ArrowUp"].includes(event.key) && options.length) {
    event.preventDefault();
    directorySelection = directorySelection < 0 ? (event.key === "ArrowDown" ? 0 : options.length - 1)
      : (directorySelection + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
    options.forEach((option, index) => option.setAttribute("aria-selected", String(index === directorySelection)));
    const selected = options[directorySelection];
    $("cwd").setAttribute("aria-activedescendant", selected.id);
    selected.scrollIntoView({ block: "nearest" });
  } else if (event.key === "Enter" && directorySelection >= 0) {
    event.preventDefault();
    selectDirectory(options[directorySelection].textContent);
  }
});
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
function returnToPage() {
  refreshViewedStatus();
  scheduleRecovery(true);
}
window.addEventListener("focus", returnToPage);
document.addEventListener("visibilitychange", returnToPage);
window.addEventListener("online", returnToPage);
window.addEventListener("offline", () => { scheduleRecovery(); refreshViewedStatus(); });
window.addEventListener("hashchange", route);
window.addEventListener("popstate", route);
window.addEventListener("pagehide", event => {
  pageLeaving = true;
  scheduleRecovery();
  for (const host of hosts) {
    host.attempt = (host.attempt || 0) + 1;
    host.connecting = false;
    host.connected = false;
    host.client?.close(undefined, "pagehide");
  }
  for (const conversation of conversations.values()) {
    if (event.persisted) conversation.disconnect("Page suspended. Commands were not replayed.", "pagehide");
    else conversation.dispose("pagehide");
  }
});
window.addEventListener("pageshow", () => {
  pageLeaving = false;
  returnToPage();
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
  let reconnectPromise, reconnectingClient, connectionAttempt = 0, recoveryAllowed = true;
  const recovery = recoveryState();
  let streamSequence = 0, authoritySequence = 0, runtimeRevision = 0;
  let refreshTimer, refreshing = false, dirty = false;
  let transcriptKey = "", interactionKey = "";
  let following = true, savedScrollTop = 0;
  let viewedResponse, viewFrame;
  const transcriptEntries = new Map(), assistantGroups = new Map(), activityGroups = new Map();
  let currentActivity;
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
        if (sameContext(captured)) applySnapshot(await captured.client.request("snapshot", snapshotQuery(snapshot, hello)));
      });
    });
  }
  function notice(message = "") {
    renderNotice($("notice"), message);
  }
  function grantCurrent() {
    return connected && grant && owner?.controller?.attachmentId === attachment && owner.controller.grantId === grant.grantId;
  }
  function controlsCurrent() {
    return navigator.onLine !== false && !pageLeaving && registered(host) && host.connected && row.live && grantCurrent();
  }
  function context() { return { client, selectedId, attachment, runtimeRevision }; }
  function sameContext(captured) {
    return !disposed && connected && captured.client === client && !captured.client?.closed && captured.selectedId === selectedId
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
    let receipt;
    try { receipt = receiptResult(await connection.request("command", envelope)); }
    catch (error) {
      if (error.delivery === "uncertain") {
        $("command-status").textContent = `${operation}: outcome unknown (${envelope.id}). Not replayed; inspect before retrying.`;
        error.message += ` Command: ${envelope.id}. Inspect before resubmitting.`;
      }
      throw error;
    }
    if (operation.startsWith("control.")) {
      receipt = await terminalReceipt(connection, "command.status", { serviceEpoch: envelope.serviceEpoch, commandId: envelope.id }, receipt);
    }
    $("command-status").textContent = `${operation}: ${receipt.status} (${receipt.id})`;
    scheduleRefresh();
    return receipt;
  }
  function receive(record) {
    if (record.type === "disconnected") {
      const wasConnected = connected;
      connected = false;
      grant = null;
      attachment = null;
      clearTimeout(refreshTimer);
      refreshTimer = null;
      if (wasConnected && recoveryAllowed && registered(host) && !pageLeaving) recoveryFailed(recovery, client);
      // Mutation callers report uncertain delivery; recovery leaves their warnings intact.
      scheduleRecovery();
      if (snapshot) renderSession();
      else renderControls();
      renderOverview();

    } else if (record.type === "update" && record.update.sessionId === selectedId) {
      const update = record.update;
      if (update.serviceEpoch !== hello.serviceEpoch || update.sequence !== streamSequence + 1) {
        client.close("Session stream changed or skipped an update. Recovering a fresh read-only attachment.", "stream_changed");
        return;
      }
      streamSequence = update.sequence;
      let controlsChanged = false;
      if (update.closeFrontend && update.closeFrontend.attachmentId === attachment) {
        detachConversation(key);
        return;
      }
      // A snapshot can already include an update still waiting in the stream.
      if (update.sequence > authoritySequence) {
        authoritySequence = update.sequence;
        controlsChanged = runtimeRevision !== update.runtimeRevision || Boolean(update.owner);
        if (runtimeRevision !== update.runtimeRevision) grant = null;
        runtimeRevision = update.runtimeRevision;
        if (update.owner) owner = { ...update.owner, sequence: update.sequence };
        if (grant && !grantCurrent()) { grant = null; controlsChanged = true; }
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
      if (controlsChanged || update.command) {
        setStatus($("session-status"), displayStatus());
        renderControls();
      }
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
      const value = await captured.client.request("snapshot", snapshotQuery(snapshot, hello));
      if (sameContext(captured)) applySnapshot(value);
    } catch (error) { if (sameContext(captured)) notice(error.message); }
    finally { refreshing = false; if (dirty) scheduleRefresh(); }
  }
  function applySnapshot(value, fresh = false) {
    if (value.sessionId !== selectedId || value.serviceEpoch !== hello.serviceEpoch) return;
    if (!fresh && snapshot && value.serviceEpoch === snapshot.serviceEpoch && value.sequence < snapshot.sequence) return;
    value = mergeSnapshot(fresh ? null : snapshot, value);
    snapshot = value;
    if (value.sequence >= authoritySequence) {
      authoritySequence = value.sequence;
      if (runtimeRevision !== value.runtimeRevision) grant = null;
      runtimeRevision = value.runtimeRevision;
      owner = value;
    }
    if (grant && !grantCurrent()) grant = null;
    renderSession();
  }
  function renderControls() {
    const controlled = Boolean(controlsCurrent());
    $("reconnect").hidden = connected;
    $("reconnect").disabled = busy || Boolean(reconnectPromise) || !host.connected || !row.live || navigator.onLine === false;
    $("stop").disabled = !controlled || busy;
    $("control").textContent = controlled ? "Detach" : "Take control";
    $("control").disabled = navigator.onLine === false || !host.connected || !row.live || !connected || !snapshot || busy;
    $("controller").textContent = !host.connected || navigator.onLine === false ? "Unknown / read only" : !row.live ? "Stopped / read only"
      : !connected ? "Unknown / read only" : controlled ? "You control this session"
      : owner?.controller ? `Controlled by ${owner.controller.label}` : "Read only / no controller";
    const active = owner?.piState?.isStreaming || ["Working", "Compacting", "Retrying"].includes(owner?.status)
      || owner?.subagentRuns?.some(run => !run.quiescent);
    $("abort").hidden = !active;
    $("abort").disabled = !controlled || busy || !active;
    $("choose-directory").disabled = !host.connected || navigator.onLine === false;
    $("new-workspace").disabled = !host.connected || navigator.onLine === false;
    $("rename").disabled = !controlled || busy;
    const ready = owner?.phase === "ready";
    $("prompt").disabled = !controlled || !ready;
    $("send").disabled = !controlled || !ready || busy || !$("prompt").value.trim();
    $("composer-hint").textContent = navigator.onLine === false ? "Offline. Recovery resumes when online."
      : !row.live && host.connected ? "Session stopped. Resume it from History."
      : !host.connected || !connected ? host.recovery.blocked || recovery.blocked || !recoveryAllowed
        ? "Disconnected. Review the host registration or reconnect explicitly."
        : "Disconnected. Recovering while online and visible; commands are not replayed."
      : !controlled ? "Take control in Options to send a prompt."
      : !ready ? "Waiting for session setup." : owner?.status === "Working" || owner?.piState?.isStreaming ? "Prompts sent while working are queued." : "";
    renderSettings();
    renderWorkers();
    if (snapshot) renderInteractions();
  }
  const workerViews = new Map();
  let workersContext;
  function createWorkerView(worker, captured) {
    const details = text("details", "", "subagent-runs"), summary = text("summary", "");
    const info = text("div", ""), actions = text("div", "", "actions"), output = text("div", "");
    details.dataset.runId = worker.runId;
    details.append(summary, info, actions, output);
    const view = { details, summary, info, actions };
    let selection = 0;
    const current = ticket => !disposed && connected && sameContext(captured) && ticket === selection
      && workerViews.get(worker.runId) === view && details.isConnected;
    async function read(artifact, offset = 0, version) {
      if (!current(selection)) return;
      const ticket = ++selection;
      output.replaceChildren(text("p", "Loading artifact..."));
      try {
        const result = await captured.client.request("resource.read", { kind: "spawn", runId: worker.runId, artifact, offset, ...(version ? { version } : {}), runtimeRevision: captured.runtimeRevision });
        if (!current(ticket)) return;
        const page = result.data;
        output.replaceChildren(text("p", `${artifact}: bytes ${page.offset}..${page.offset + new TextEncoder().encode(page.text).length}/${page.size}`), text("pre", page.text));
        if (page.nextOffset != null) output.append(button("Next chunk", () => read(artifact, page.nextOffset, page.version)));
        output.append(button("Reload", () => read(artifact)));
      } catch (error) {
        if (current(ticket)) output.replaceChildren(text("p", error.message));
      }
    }
    for (const artifact of ["transcript", "result", "brief", "status", "agent_prompt", "patch"]) actions.append(button(artifact, () => read(artifact), !connected));
    return view;
  }
  function renderWorkers() {
    // Progress changes update metadata only. Artifact DOM, pagination closures
    // and in-flight reads belong to the worker within this attachment/runtime.
    if (!workersContext || !sameContext(workersContext)) {
      workerViews.clear();
      $("workers").replaceChildren();
      workersContext = context();
    }
    const runs = owner?.subagentRuns || [], ids = new Set(runs.map(worker => worker.runId));
    for (const [id, view] of workerViews) {
      if (!ids.has(id)) { workerViews.delete(id); view.details.remove(); }
    }
    $("workers-section").hidden = !runs.length;
    runs.forEach((worker, index) => {
      let view = workerViews.get(worker.runId);
      if (!view) {
        view = createWorkerView(worker, workersContext);
        workerViews.set(worker.runId, view);
      }
      view.summary.textContent = workerLabel(worker);
      const info = [text("p", `Worker: ${worker.runId}`)];
      if (worker.assignment) info.push(text("p", `Assignment: ${worker.assignment.id} / ${worker.assignment.outcome || "unknown"}`), text("p", worker.assignment.prompt || ""));
      for (const pending of worker.pendingRequests || []) info.push(text("p", `${pending.kind} to orchestrator: ${pending.id} / assignment ${pending.assignmentId} / ${pending.question || pending.tool || ""}`));
      if (worker.error || worker.cleanupError || worker.integrationReason) info.push(text("p", [worker.error, worker.cleanupError, worker.integrationReason].filter(Boolean).join("\n")));
      view.info.replaceChildren(...info);
      for (const action of view.actions.children) action.disabled = !connected;
      if ($("workers").children[index] !== view.details) $("workers").insertBefore(view.details, $("workers").children[index] || null);
    });
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
      const options = choices.map(([value, label]) => [value, label, false]);
      if (!choices.some(([choice]) => choice === value)) {
        options.unshift([value, id === "model" && currentModel ? `${currentModel.provider} / ${currentModel.id}` : value || "Unavailable", true]);
      }
      const signature = JSON.stringify(options);
      if (field.signature !== signature) {
        field.select.replaceChildren(...options.map(([value, label, disabled]) => {
          const option = new Option(label, value);
          option.disabled = disabled;
          return option;
        }));
        field.signature = signature;
      }
      field.select.value = value;
      field.select.disabled = !enabled || !choices.length || !hello?.capabilities.includes(field.operation) || Boolean(optionsLoad);
    }
    $("refresh-settings").disabled = navigator.onLine === false || !host.connected || !row.live || !connected || owner?.phase !== "ready" || Boolean(optionsLoad) || !hello?.capabilities.includes("session.read");
    $("settings-hint").textContent = navigator.onLine === false ? "Offline. Current settings cannot be checked."
      : !host.connected ? "Host unavailable. Current settings are unknown." : !row.live ? "Session stopped. Resume it from History."
      : optionsLoad ? "Loading model options..." : optionsError ? `${optionsError} Tap Refresh options to retry.`
      : !connected ? "Reconnect to read current settings." : owner?.phase !== "ready" ? "Waiting for session setup."
      : !controlsCurrent() ? "Take control to change settings." : "Changes apply to this session on the execution host.";
  }
  function displayStatus() {
    if (!host.connected || navigator.onLine === false) return "Unknown";
    if (!row.live) return "Stopped";
    if (!connected) return "Unknown";
    return sessionStatus(host, row, owner || row.live);
  }
  function renderSession() {
    const currentRow = host.sessions.find(item => item.id === selectedId) || row;
    $("session-title").textContent = snapshot.piState?.sessionName || sessionName(currentRow);
    $("options-title").textContent = $("session-title").textContent;
    $("session-directory").textContent = `${host.alias} / ${owner?.interactions.runtime?.cwd || currentRow.cwd || ""}`;
    if (host.connected && row.live && connected && owner?.error && $("notice").hidden) notice(owner.error);
    renderTranscript();
    scheduleViewedResponse();
    const state = displayStatus();
    setStatus($("session-status"), state);
    renderQueue();
    renderControls();
  }
  function scheduleViewedResponse() {
    if (viewFrame) return;
    viewFrame = requestAnimationFrame(() => {
      viewFrame = null;
      if (disposed || !controlsCurrent() || document.hidden || !document.hasFocus() || element.hidden || $("chat-screen").hidden
        || activeKey !== key || snapshot?.status !== "Done" || snapshot.runtimeRevision !== runtimeRevision
        || !snapshot.conversation.hydrated) return;
      const target = $("transcript");
      if (!target.clientHeight || target.scrollHeight - target.scrollTop - target.clientHeight > 1) return;
      const captured = context();
      const payload = { serviceEpoch: snapshot.serviceEpoch, runtimeRevision: snapshot.runtimeRevision,
        completionSeq: snapshot.completionSeq, controlToken: grant.token };
      const acknowledgement = JSON.stringify([attachment, payload]);
      if (viewedResponse === acknowledgement) return;
      viewedResponse = acknowledgement;
      captured.client.request("response.viewed", payload).then(() => {
        if (sameContext(captured)) scheduleRefresh();
      }).catch(() => {
        if (viewedResponse === acknowledgement) viewedResponse = null;
      });
    });
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
      .flatMap(node => node.classList.contains("activity-group") && node.open ? [node.firstElementChild, ...node.lastElementChild.children] : [node])
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
        : message.role === "assistant" && Array.isArray(message.content)
          && message.content.some((_, index) => transcriptEntries.has(`${partialKey}-block-${index}`)) ? partialKey
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
        return [{ key, message, tool: tool.result ? undefined : tool, execution: tool }];
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
    // Recognize skill reads by their call arguments, including nested live reads.
    // Keep one skill item and attach its recorded result instead of a second read row.
    const skillCalls = new Map(), skills = new Map();
    for (const { key, message, execution } of visible) {
      if (message.role === "assistant" && Array.isArray(message.content)) {
        message.content.forEach((block, index) => {
          if (block.type !== "toolCall") return;
          // Call IDs may be reused in later turns, including by ordinary reads.
          skillCalls.delete(block.id);
          const name = skillName(block.name, block.arguments);
          if (!name) return;
          const skill = { name, path: block.arguments.path, hasCall: true };
          skillCalls.set(block.id, skill);
          skills.set(`${key}-block-${index}`, skill);
        });
      } else if (message.role === "toolResult") {
        const id = message.toolCallId || execution?.toolCallId;
        const name = execution && skillName(execution.toolName, execution.args);
        const skill = skillCalls.get(id) || (name ? { name, path: execution.args.path } : undefined);
        if (!skill) continue;
        if (execution) Object.assign(skill, { result: execution.result || execution.partialResult, state: execution.state,
          isError: execution.isError || execution.result?.isError });
        else Object.assign(skill, { result: message, state: "completed", isError: message.isError });
        skills.set(key, skill);
      }
    }
    const entries = visible.flatMap(({ key, message, tool }) => {
      const assistant = ["assistant", "toolResult", "bashExecution"].includes(message.role)
        || message.role === "custom" && ["spawn_completion", "spawn_control_result"].includes(message.customType);
      const resultSkill = message.role === "toolResult" && skills.get(key);
      if (resultSkill?.hasCall) return [];
      // Split mixed assistant messages so text stays outside consecutive activity.
      const parts = message.role === "assistant" && Array.isArray(message.content)
        ? message.content.map((block, index) => ({ key: `${key}-block-${index}`, message: { ...message, content: [block] },
          activity: block.type !== "text", skill: skills.get(`${key}-block-${index}`) }))
        : [{ key, message, activity: assistant && message.role !== "assistant", skill: resultSkill }];
      return parts.filter(part => part.message.role !== "assistant" || part.message.content?.[0]?.type !== "text" || part.message.content[0].text).map(({ key, message, activity, skill }) => ({
        key, assistant, activity, isError: Boolean(skill?.isError || tool?.isError || message.isError),
        value: [tool || message, skill], render() {
          const article = text(assistant ? "div" : "article", "", assistant ? "assistant-part" : "message");
          article.dataset.role = message.role;
          if (skill) {
            const state = skill.isError ? "Skill read failed" : skill.state === "completed" ? "Using skill"
              : skill.state === "interrupted" ? "Skill read interrupted" : live ? "Loading skill" : "Skill read";
            const details = document.createElement("details");
            details.dataset.key = `skill-${key}`;
            details.dataset.kind = "skill";
            details.dataset.error = String(Boolean(skill.isError));
            details.append(text("summary", `${state}: ${skill.name}`), text("p", skill.path, "muted"));
            if (skill.result) details.append(...contentNodes(skill.result.content ?? skill.result.output ?? skill.result, key));
            if (skill.result?.errorMessage) details.append(text("p", skill.result.errorMessage));
            article.append(details);
          } else if (tool) {
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
            if (!assistant) article.append(text("div", messageLabel(message), "message-label"));
            article.append(...contentNodes(message.content ?? message.output ?? message.text ?? message, key));
            if (message.role !== "assistant" && message.errorMessage) article.append(text("p", message.errorMessage));
          }
          return article;
        },
      }));
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
    const roots = [], groups = new Map(), activities = new Map();
    let group, activity;
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
        group = activity = undefined;
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
      if (entry.activity) {
        if (!activity) {
          let node = activityGroups.get(entry.key);
          if (!node) {
            node = text("details", "", "activity-group");
            node.dataset.key = `activity-${entry.key}`;
            node.append(text("summary", "Activity"), text("div", "", "activity-content"));
            activityGroups.set(entry.key, node);
          }
          activity = { node, body: node.lastElementChild, count: 0, errors: 0 };
          activities.set(entry.key, activity);
          if (group.node.children[group.count] !== node) group.node.insertBefore(node, group.node.children[group.count] || null);
          group.count++;
        }
        if (activity.body.children[activity.count] !== cached.node) activity.body.insertBefore(cached.node, activity.body.children[activity.count] || null);
        activity.count++;
        if (entry.isError) activity.errors++;
      } else {
        activity = undefined;
        if (group.node.children[group.count] !== cached.node) group.node.insertBefore(cached.node, group.node.children[group.count] || null);
        group.count++;
      }
    });
    for (const [key, node] of activityGroups) {
      const activity = activities.get(key);
      if (!activity) { node.remove(); activityGroups.delete(key); }
      else {
        const label = `Activity / ${activity.count} item${activity.count === 1 ? "" : "s"}${activity.errors ? ` / ${activity.errors} error${activity.errors === 1 ? "" : "s"}` : ""}`;
        if (node.firstElementChild.textContent !== label) node.firstElementChild.textContent = label;
        node.dataset.error = String(Boolean(activity.errors));
        while (activity.body.children.length > activity.count) activity.body.lastChild.remove();
      }
    }
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
    updateActivityReturn();
  }
  function updateActivityReturn() {
    const target = $("transcript"), top = target.getBoundingClientRect().top;
    currentActivity = undefined;
    if (!element.hidden && !$("chat-screen").hidden) {
      for (const node of activityGroups.values()) {
        if (!node.open) continue;
        const bounds = node.getBoundingClientRect();
        if (bounds.top < top - 32 && bounds.bottom > top + 50) currentActivity = node;
      }
    }
    $("activity-return").hidden = !currentActivity;
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
    const origin = data.provenance;
    if (origin && typeof origin === "object" && typeof origin.workerId === "string") {
      for (const [name, value] of [["Worker", origin.workerId], ["Assignment", origin.assignmentId],
        ["Workspace", origin.workspaceId || "(none)"], ["Request ID", origin.requestId]]) {
        if (typeof value === "string") target.append(text("p", `${name}: ${value}`));
      }
    }
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
      const answerKey = `${hello.hostId}/${selectedId}/${hello.serviceEpoch}/${runtimeRevision}/${request.id}`;
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
    if (!sameContext(captured)) return;
    const value = await captured.client.request("grant");
    if (sameContext(captured)) {
      grant = value;
      if (!controlsCurrent()) scheduleRefresh();
      else scheduleViewedResponse();
    }
  }));
  bindDiagnostics($("connection-diagnostics"));
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
    scheduleViewedResponse();
  });
  $("activity-return").addEventListener("click", () => {
    if (!currentActivity?.isConnected) return;
    const target = $("transcript"), activity = currentActivity;
    const start = target.scrollTop + activity.getBoundingClientRect().top - target.getBoundingClientRect().top - 8;
    following = false;
    activity.open = false;
    target.scrollTop = start;
    savedScrollTop = target.scrollTop;
    activity.firstElementChild.focus({ preventScroll: true });
    $("latest").hidden = false;
    updateActivityReturn();
  });
  $("transcript").addEventListener("toggle", () => {
    updateActivityReturn();
  }, true);
  $("transcript").addEventListener("click", event => {
    if (event.target.closest("summary")) following = false;
  });
  $("transcript").addEventListener("keydown", event => {
    if (["Enter", " "].includes(event.key) && event.target.matches("summary")) following = false;
  });
  $("transcript").addEventListener("scroll", () => {
    if (element.hidden || $("chat-screen").hidden) return;
    const target = $("transcript");
    savedScrollTop = target.scrollTop;
    following = target.scrollHeight - target.scrollTop - target.clientHeight < 100;
    $("latest").hidden = following;
    updateActivityReturn();
    scheduleViewedResponse();
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
    updateActivityReturn();
    scheduleViewedResponse();
  });
  transcriptResize.observe($("transcript"));
  const heartbeat = setInterval(() => {
    scheduleViewedResponse();
    if (!canRecover() || !controlsCurrent()) return;
    const captured = context();
    const token = grant.token;
    client.request("heartbeat", { controlToken: token }).catch(error => {
      if (sameContext(captured) && grant?.token === token) { grant = null; notice(error.message); renderControls(); }
    });
  }, 5000);
  function reconnect(automatic = false) {
    if (reconnectPromise) return reconnectPromise;
    if (disposed || pageLeaving || connected || busy || !registered(host) || !host.connected
      || (automatic && (!canRecover() || !recoveryAllowed || recovery.blocked || host.recovery.blocked || !row.live))) return Promise.resolve();
    if (!automatic) { recoveryAllowed = true; recovery.blocked = false; recovery.due = 0; }
    const attempt = ++connectionAttempt, target = host, hostClient = host.client;
    const current = () => !disposed && !pageLeaving && connectionAttempt === attempt && host === target
      && registered(target) && host.connected && host.client === hostClient
      && (!automatic || (canRecover() && recoveryAllowed && !recovery.blocked && !host.recovery.blocked && row.live));
    reconnectPromise = (async () => {
      let next;
      try {
        const summaries = await hostClient.request("sessions.subscribe");
        if (!current() || !setSummaries(target, summaries) || !current()) return;
        const currentRow = target.sessions.find(item => item.id === selectedId);
        if (!currentRow?.live) {
          recoveryAllowed = false;
          if (!automatic) notice("This session is stopped. Open History to resume it explicitly.");
          return;
        }
        client?.close(undefined, "session_reconnect");
        next = new ServiceClient(record => { if (!disposed && connectionAttempt === attempt && client === next) receive(record); }, connectionDiagnostics(target, "session"));
        client = reconnectingClient = next;
        grant = null;
        attachment = null;
        const nextHello = await next.connect(channel, target.stream, identity);
        if (!current() || next.closed || !row.live) { next.close(undefined, "session_disposed"); return; }
        hello = nextHello;
        const value = await next.request("attach", { sessionId: selectedId, label: controllerLabel });
        if (!current() || next.closed || !row.live) { next.close(undefined, "session_disposed"); return; }
        attachment = value.attachmentId;
        streamSequence = value.snapshot.sequence;
        authoritySequence = 0;
        runtimeRevision = value.snapshot.runtimeRevision;
        owner = null;
        transcriptKey = interactionKey = optionsKey = "";
        optionsLoad = null;
        viewedResponse = null;
        connected = true;
        applySnapshot(value.snapshot, true);
        recoverySucceeded(recovery, next);
      } catch (error) {
        next?.close(error.message, "session_attach_failed");
        if (!current()) return;
        // Session disappearance is not permission to resume its saved history.
        if (["session_unavailable", "session_not_found"].includes(error.code)) recoveryAllowed = false;
        else recoveryFailed(recovery, next || hostClient);
        if (!automatic) notice(error.message);
      } finally {
        if (reconnectingClient === next) reconnectingClient = null;
        reconnectPromise = null;
        if (!disposed) renderControls();
        scheduleRecovery();
      }
    })();
    renderControls();
    return reconnectPromise;
  }
  async function recover(check) {
    if (disposed || !recoveryAllowed || !registered(host) || host.recovery.blocked || recovery.blocked || !canRecover() || !row.live) return;
    if (connected && host.connected && hello.serviceEpoch !== host.hello.serviceEpoch) client.close("Host service restarted. Recovering read only.", "stream_changed");
    if (!connected) {
      if (host.connected && Date.now() >= recovery.due) await reconnect(true);
    } else if (check) {
      const captured = context();
      try {
        await captured.client.probe();
        if (canRecover() && sameContext(captured)) scheduleRefresh();
      } catch {
        if (captured.client === client && captured.client.recoveryBlocked) recovery.blocked = true;
      }
    }
  }
  return {
    get host() { return host; },
    identity, id: selectedId, element, reconnect, recover,
    draft: () => $("prompt").value,
    viewed() { if (snapshot) renderSession(); },
    connected: () => connected,
    rebind(current) {
      if (disposed || host === current) return;
      ++connectionAttempt;
      connected = false; grant = null; attachment = null;
      clearTimeout(refreshTimer); refreshTimer = null;
      client?.close(undefined, "host_registration_changed");
      host = current;
      if (snapshot) renderSession();
    },
    disconnect(message = "Host registration removed, disabled or changed.", cause = "host_registration_changed") {
      ++connectionAttempt;
      if (cause !== "pagehide") recoveryAllowed = false;
      connected = false; grant = null; attachment = null;
      clearTimeout(refreshTimer); refreshTimer = null;
      client?.close(message, cause);
      if (!disposed) {
        if (cause !== "pagehide" && $("notice").hidden) notice(message);
        renderControls();
      }
    },
    syncRow(value) {
      row = value || { ...row, live: undefined };
      if (!row.live) {
        recoveryAllowed = false;
        if (reconnectPromise && !connected) {
          ++connectionAttempt;
          reconnectingClient?.close("Session stopped or unavailable. Resume it explicitly from History.", "session_attach_failed");
        }
        connected = false;
        grant = null;
        clearTimeout(refreshTimer);
        refreshTimer = null;
        // Keep established attachments subscribed for a targeted closeFrontend update.
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
    dispose(cause = "session_disposed") {
      disposed = true;
      ++connectionAttempt;
      recoveryAllowed = false;
      connected = false; grant = null; attachment = null;
      clearInterval(heartbeat); clearTimeout(refreshTimer);
      cancelAnimationFrame(viewFrame);
      transcriptResize.disconnect();
      client?.close(undefined, cause);
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

function skillName(toolName, args) {
  if (toolName !== "read" || typeof args?.path !== "string") return;
  const path = args.path.replaceAll("\\", "/");
  if (!/(^|\/)skills\//.test(path)) return;
  return /(?:^|\/)([^/]+)\/SKILL\.md$/.exec(path)?.[1] || /(?:^|\/)skills\/([^/]+)\.md$/.exec(path)?.[1];
}

function workerLabel(run) {
  const model = run.selectedModel ? `${run.selectedModel.provider}/${run.selectedModel.id}` : "model not confirmed";
  const state = run.readyForReview ? "ready for review" : run.execution || run.status;
  const pending = (run.pendingRequests || []).map(request => `${request.kind}: ${request.id}`).join(" / ");
  return [run.agent || run.role || "Subagent", model, state, run.writerOwned ? "contribution unresolved" : "",
    run.integration, run.assignment ? `${run.assignment.id} (${run.assignment.outcome})` : "", pending, run.progress].filter(Boolean).join(" / ");
}
function messageLabel(message) {
  const sender = message.role === "custom" && message.details?.sender;
  return sender && ["parent", "worker"].includes(sender.kind)
    ? `Agent (${sender.kind} ${sender.id}; not a user instruction)` : message.role;
}
// System prompt patches hold structured sections, not user-visible conversation text.
function visibleMessage(message) {
  if (message.role === "custom" && message.display === false) return false;
  if (message.role !== "system") return true;
  return typeof message.content === "string" ? Boolean(message.content.trim())
    : Array.isArray(message.content) && message.content.some(block => block.type === "text" && block.text?.trim());
}
