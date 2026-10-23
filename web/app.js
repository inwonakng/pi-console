import { ServiceClient, requestId } from "./client.js";

const $ = id => document.getElementById(id);
const channel = document.documentElement.dataset.piChannel;
$("channel").textContent = channel === "stable" || channel === "dev" ? channel : "Unknown channel";
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
let client, hello, snapshot, attachment, grant;
let sessions = [], selectedId = null, busy = false, connected = false;
let streamSequence = 0, authoritySequence = 0, runtimeRevision = 0, owner;
let refreshTimer, refreshing = false, dirty = false;
let transcriptKey = "", interactionKey = "";
const drafts = new Map();
const answerDrafts = new Map();
const submittedAnswers = new Set();

function notice(message = "") {
  $("notice").textContent = message;
  $("notice").hidden = !message;
}
function controlsCurrent() {
  return connected && grant && owner?.controller?.attachmentId === attachment
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
  finally { busy = false; renderControls(); route(); }
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
    if (connection !== client || !connected) throw new Error(`Disconnected. Inspect command ${receipt.id} before trying again.`);
    receipt = receiptResult(await connection.request(method, payload));
  }
  if (receipt.status !== "completed") throw new Error(`Command ${receipt.id} is still pending. Inspect its outcome before trying again.`);
  return receipt;
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
async function hostCommand(operation, payload) {
  const connection = client;
  const envelope = { id: requestId(), serviceEpoch: hello.serviceEpoch, operation, payload };
  let receipt = receiptResult(await connection.request("host.command", envelope));
  // Observe the same admitted command; never retry it under a new ID.
  receipt = await terminalReceipt(connection, "host.status", { serviceEpoch: envelope.serviceEpoch, commandId: envelope.id }, receipt);
  return receipt.result.sessionId;
}
function receive(record) {
  if (record.type === "disconnected") {
    connected = false;
    grant = null;
    clearTimeout(refreshTimer);
    refreshTimer = null;
    $("connection-state").textContent = "Disconnected";
    $("connection-state").className = "";
    $("connect").textContent = "Reconnect";
    notice(record.message);
    renderControls();
  } else if (record.type === "summaries") {
    setSummaries(record.result);
  } else if (record.type === "update" && record.update.sessionId === selectedId) {
    const update = record.update;
    if (update.serviceEpoch !== hello.serviceEpoch || update.sequence !== streamSequence + 1) {
      client.close("Session stream changed or skipped an update. Reconnect for a fresh snapshot.");
      return;
    }
    streamSequence = update.sequence;
    // A snapshot can already include an update still waiting in the stream.
    if (update.sequence > authoritySequence) {
      authoritySequence = update.sequence;
      if (runtimeRevision !== update.runtimeRevision) grant = null;
      runtimeRevision = update.runtimeRevision;
      if (update.owner) owner = update.owner;
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
function setSummaries(value) {
  if (value.serviceEpoch !== hello.serviceEpoch || value.hostId !== hello.hostId || value.channel !== hello.channel) {
    client.close("Host identity changed. Reconnect explicitly.");
    return;
  }
  sessions = value.sessions;
  renderList();
}
function scheduleRefresh() {
  dirty = true;
  if (refreshTimer || refreshing || !connected || !selectedId) return;
  refreshTimer = setTimeout(refresh, 100);
}
async function refresh() {
  refreshTimer = null;
  if (!connected || !selectedId || refreshing) return;
  const captured = context();
  refreshing = true;
  dirty = false;
  try {
    const value = await captured.client.request("snapshot");
    if (sameContext(captured)) applySnapshot(value);
  } catch (error) { if (sameContext(captured)) notice(error.message); }
  finally { refreshing = false; if (dirty) scheduleRefresh(); }
}
function applySnapshot(value) {
  if (value.sessionId !== selectedId || value.serviceEpoch !== hello.serviceEpoch) return;
  snapshot = value;
  if (value.sequence >= authoritySequence) {
    authoritySequence = value.sequence;
    if (runtimeRevision !== value.runtimeRevision) grant = null;
    runtimeRevision = value.runtimeRevision;
    owner = value;
  }
  if (grant && !controlsCurrent()) grant = null;
  renderSession();
}
async function attach(id) {
  const row = sessions.find(row => row.id === id);
  if (!row) throw new Error("Session not found on this host");
  if (selectedId) drafts.set(selectedId, $("prompt").value);
  if (!row.live) await hostCommand("host.resume", { sessionId: id });
  const value = await client.request("attach", { sessionId: id, label: "Web browser" });
  selectedId = id;
  attachment = value.attachmentId;
  grant = null;
  streamSequence = value.snapshot.sequence;
  authoritySequence = 0;
  owner = null;
  runtimeRevision = value.snapshot.runtimeRevision;
  transcriptKey = interactionKey = "";
  $("prompt").value = drafts.get(id) || "";
  $("command-status").textContent = "";
  applySnapshot(value.snapshot);
  renderList();
  document.body.classList.add("session-open");
}
function route() {
  const match = /^#sessions\/([\w-]{1,128})$/.exec(location.hash);
  if (!match) { document.body.classList.remove("session-open"); return; }
  if (!connected || busy) return;
  if (selectedId === match[1]) document.body.classList.add("session-open");
  else {
    // On failure, stop retrying this route until the user selects it again.
    const id = match[1];
    run(async () => {
      try { await attach(id); }
      catch (error) { history.replaceState(null, "", "#"); throw error; }
    });
  }
}
function sessionName(row) { return row?.name || row?.cwd?.split("/").filter(Boolean).pop() || "Untitled session"; }
function renderList() {
  const query = $("search").value.toLowerCase();
  const rows = sessions.filter(row => `${row.name || ""} ${row.cwd}`.toLowerCase().includes(query));
  $("session-count").textContent = sessions.length;
  $("session-list").replaceChildren(...rows.map(row => {
    const link = document.createElement("a");
    link.href = `#sessions/${row.id}`;
    link.className = "session-row";
    if (row.id === selectedId) link.setAttribute("aria-current", "page");
    link.addEventListener("click", event => {
      if (busy || !connected) { event.preventDefault(); return; }
      if (location.hash === link.hash) route();
    });
    const heading = text("div", "", "row-heading");
    const status = text("span", row.live?.status || "Saved", "status");
    status.dataset.state = row.live?.status || "Saved";
    heading.append(text("span", sessionName(row), "row-title"), status);
    link.append(heading, text("span", row.live?.cwd || row.cwd, "row-directory"));
    return link;
  }));
  if (!rows.length) $("session-list").append(text("p", query ? "No matching sessions." : "No sessions yet. Start one with + New.", "empty"));
}
function renderControls() {
  const controlled = Boolean(controlsCurrent());
  $("connect").disabled = busy;
  $("new-session").disabled = !connected || busy;
  $("control").disabled = !connected || !snapshot || busy;
  $("control").textContent = controlled ? "Release control" : owner?.controller ? "Take over" : "Take control";
  $("controller").textContent = !connected ? "Disconnected / read only" : controlled ? "You control this session"
    : owner?.controller ? `Controlled by ${owner.controller.label}` : "Read only / no controller";
  $("abort").disabled = !controlled || busy || !snapshot?.conversation.execution.running;
  $("rename").disabled = !controlled || busy;
  const ready = owner?.phase === "ready";
  $("prompt").disabled = !controlled || !ready;
  $("send").disabled = !controlled || !ready || busy || !$("prompt").value.trim();
  $("composer-hint").textContent = !controlled ? "Take control to send a prompt." : !ready ? "Waiting for session setup."
    : snapshot?.conversation.execution.running ? "Prompts sent while working are queued." : "Ctrl/Cmd+Enter to send. Enter adds a line.";
  if (snapshot) renderInteractions();
}
function renderSession() {
  $("welcome").hidden = true;
  $("session").hidden = false;
  const row = sessions.find(row => row.id === selectedId);
  $("session-title").textContent = snapshot.piState?.sessionName || sessionName(row);
  $("session-directory").textContent = owner?.interactions.runtime?.cwd || row?.cwd || "";
  const state = owner?.error ? "Error" : owner?.interactions.pending.length ? "Waiting"
    : snapshot.conversation.execution.running ? "Working" : owner?.phase === "ready" ? "Idle" : owner?.phase || "Starting";
  $("session-status").textContent = state;
  $("session-status").dataset.state = state;
  if (owner?.error) notice(owner.error);
  renderTranscript();
  renderQueue();
  renderControls();
}
function blockDetails(label, value, key) {
  const details = document.createElement("details");
  details.dataset.key = key;
  details.append(text("summary", label), text("pre", typeof value === "string" ? value : JSON.stringify(value, null, 2)));
  return details;
}
function contentNodes(content, prefix) {
  if (typeof content === "string") return [text("div", content, "message-text")];
  if (!Array.isArray(content)) return [text("pre", JSON.stringify(content, null, 2))];
  return content.map((block, index) => {
    if (block.type === "text") return text("div", block.text, "message-text");
    if (block.type === "thinking") return blockDetails("Thinking", block.thinking, `${prefix}-thinking-${index}`);
    if (block.type === "toolCall") return blockDetails(block.name, block.arguments, `${prefix}-call-${block.id}`);
    if (block.type === "image") return text("p", "[Image attachment]", "muted");
    return blockDetails(block.type || "Content", block, `${prefix}-${index}`);
  });
}
function renderTranscript() {
  const conversation = snapshot.conversation;
  const key = JSON.stringify(conversation);
  if (key === transcriptKey) return;
  transcriptKey = key;
  const target = $("transcript");
  const follow = target.scrollHeight - target.scrollTop - target.clientHeight < 100;
  const scrollTop = target.scrollTop;
  const expanded = new Set([...target.querySelectorAll("details[open]")].map(node => node.dataset.key));
  const messages = [...conversation.messages];
  if (conversation.partialAssistant) messages.push(conversation.partialAssistant.message);
  const nodes = messages.map((message, index) => {
    const article = text("article", "", "message");
    article.dataset.role = message.role;
    article.append(text("div", message.role === "assistant" ? "Pi" : message.role === "toolResult" ? message.toolName || "Tool result" : message.role, "message-label"));
    article.append(...contentNodes(message.content ?? message.output ?? message.text ?? message, String(index)));
    if (message.errorMessage) article.append(text("p", message.errorMessage));
    return article;
  });
  if (conversation.omittedMessages) nodes.unshift(text("p", `${conversation.omittedMessages} older messages are outside this snapshot.`, "muted"));
  for (const tool of conversation.tools.filter(tool => tool.state === "running")) {
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
  const pending = owner?.interactions.pending || [];
  const enabled = Boolean(controlsCurrent()) && !busy;
  const key = JSON.stringify([pending, enabled, runtimeRevision]);
  if (key === interactionKey) return;
  interactionKey = key;
  const target = $("interactions");
  target.hidden = !pending.length;
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
      input.id = `answer-${request.id}`;
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
  const queued = [...accepted.map(item => ({ text: item.text, label: `Queued / ${item.status}` })),
    ...native.steering.map(value => ({ text: value, label: "Steering" })), ...native.followUp.map(value => ({ text: value, label: "Follow-up" }))];
  $("queue-panel").hidden = !queued.length;
  $("queue-summary").textContent = `Queued prompts (${queued.length})`;
  $("queue").replaceChildren(...queued.map(item => {
    const node = text("div", "", "queue-item");
    node.append(text("span", item.label, "muted"), text("p", item.text));
    return node;
  }));
}

$("connection-form").addEventListener("submit", event => {
  event.preventDefault();
  run(async () => {
    if (connected) { client.close(); return; }
    if (channel !== "stable" && channel !== "dev") throw new Error("Missing or invalid server channel. Reload the page from the pi-console server.");
    const next = new ServiceClient(record => { if (client === next) receive(record); });
    client = next;
    hello = null;
    grant = null;
    snapshot = owner = null;
    attachment = selectedId = null;
    $("session").hidden = true;
    $("welcome").hidden = false;
    $("connection-state").textContent = "Connecting...";
    hello = await next.connect(channel);
    connected = true;
    notice();
    $("connection-state").textContent = "Connected";
    $("connection-state").className = "connected";
    $("connect").textContent = "Disconnect";
    $("host-info").textContent = `${hello.channel} / ${hello.hostId}`;
    setSummaries(await next.request("sessions.subscribe"));
  });
});
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
      drafts.delete(selectedId);
    }
  });
});
$("prompt").addEventListener("input", () => { if (selectedId) drafts.set(selectedId, $("prompt").value); renderControls(); });
$("prompt").addEventListener("keydown", event => {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.isComposing) {
    event.preventDefault();
    if (!$("send").disabled) $("composer").requestSubmit();
  }
});
$("new-session").addEventListener("click", () => { $("cwd").value = owner?.interactions.runtime?.cwd || ""; $("create-dialog").showModal(); $("cwd").focus(); });
$("cancel-create").addEventListener("click", () => $("create-dialog").close());
$("create-form").addEventListener("submit", event => {
  event.preventDefault();
  const cwd = $("cwd").value.trim();
  if (!cwd.startsWith("/")) { $("cwd").setCustomValidity("Use an absolute directory path on the host."); $("cwd").reportValidity(); return; }
  $("create-dialog").close();
  run(async () => {
    const id = await hostCommand("host.create", { cwd });
    setSummaries(await client.request("sessions.subscribe"));
    history.pushState(null, "", `#sessions/${id}`);
  });
});
$("cwd").addEventListener("input", () => $("cwd").setCustomValidity(""));
$("search").addEventListener("input", renderList);
$("back").addEventListener("click", () => { location.hash = ""; $("search").focus(); });
$("latest").addEventListener("click", () => { $("transcript").scrollTop = $("transcript").scrollHeight; $("latest").hidden = true; });
$("transcript").addEventListener("scroll", () => {
  const target = $("transcript");
  $("latest").hidden = target.scrollHeight - target.scrollTop - target.clientHeight < 100;
});
window.addEventListener("hashchange", route);
setInterval(() => {
  if (!controlsCurrent()) return;
  const captured = context();
  const token = grant.token;
  client.request("heartbeat", { controlToken: token }).catch(error => {
    if (sameContext(captured) && grant?.token === token) { grant = null; notice(error.message); renderControls(); }
  });
}, 5000);
window.addEventListener("pagehide", () => client?.close());
// No reconnect/replay after a dropped connection. The user reconnects explicitly.
$("connection-form").requestSubmit();
