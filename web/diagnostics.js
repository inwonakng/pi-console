// Local, bounded diagnostics. Never pass messages, payloads, URLs or real IDs here.
const STORAGE_KEY = "pi-console.connection-diagnostics.v1";
const LIMIT = 300;
const MAX_STORED_LENGTH = 256 * 1024;
const integer = (value, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= 0 && value <= max;
const bool = value => typeof value === "boolean";
const choice = values => value => values.includes(value);
const methods = ["hello", "sessions.subscribe", "sessions", "host.command", "host.status", "service.restart", "service.restart.status",
  "snapshot", "command", "command.status", "resource.read", "session.read", "response.viewed", "grant", "heartbeat", "attach", "unknown"];
const causes = ["unspecified", "socket_closed", "socket_error", "connect_timeout", "handshake_failed", "invalid_record", "request_timeout",
  "send_failed", "host_identity_changed", "host_setup_failed", "host_registration_changed", "server_identity_refresh",
  "pagehide", "stream_changed", "session_reconnect", "session_disposed", "session_attach_failed"];
const serviceCodes = ["heartbeat_timeout", "handshake_timeout", "service_connection_error", "transport_error", "output_error",
  "discovery_error", "service_disconnected", "websocket_closed", "bridge_error", "attachment_closed", "ECONNRESET", "EPIPE", "unknown"];
const connection = { connection: integer, hostGroup: integer, role: choice(["host", "session", "unknown"]) };
const schemas = {
  page_load: { standalone: bool, online: bool, visibility: choice(["visible", "hidden", "unknown"]) },
  visibility: { visibility: choice(["visible", "hidden", "unknown"]) },
  focus: {}, blur: {}, online: {}, offline: {},
  pagehide: { persisted: bool }, pageshow: { persisted: bool },
  connect_start: connection, socket_open: connection, handshake_complete: connection, socket_error: connection,
  socket_close: { ...connection, code: value => integer(value, 4999), wasClean: bool, reason: choice(["empty", "omitted"]) },
  local_close: { ...connection, cause: choice(causes), pending: value => integer(value, 32) },
  request_timeout: { ...connection, method: choice(methods), pending: value => integer(value, 32) },
  service_disconnected: { ...connection, code: choice(serviceCodes) },
};
const started = performance.now();
// Random page identity only, unrelated to any host, session or installation.
const page = Array.from({ length: 2 }, () => Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, "0")).join("");
let nextConnection = 0;
let events = [];
let preferDownload = false;
function sanitize(record) {
  if (!record || typeof record !== "object" || typeof record.event !== "string" || !Object.hasOwn(schemas, record.event)
    || typeof record.utc !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(record.utc)
    || !Number.isFinite(Date.parse(record.utc)) || new Date(record.utc).toISOString() !== record.utc
    || typeof record.page !== "string" || !/^[a-f0-9]{16}$/.test(record.page) || !integer(record.elapsedMs)) return null;
  const clean = { event: record.event, utc: record.utc, page: record.page, elapsedMs: record.elapsedMs };
  for (const [key, valid] of Object.entries(schemas[record.event])) {
    if (!valid(record[key])) return null;
    clean[key] = record[key];
  }
  return clean;
}
try {
  const stored = sessionStorage.getItem(STORAGE_KEY);
  if (stored && stored.length <= MAX_STORED_LENGTH) {
    const restored = JSON.parse(stored);
    if (restored?.version === 1 && Array.isArray(restored.events)) events = restored.events.slice(-LIMIT).map(sanitize).filter(Boolean);
  }
} catch { /* Storage may be unavailable, full or malformed. Keep recording in memory. */ }
function persist() {
  try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, events })); }
  catch { /* Best effort; connection handling must not depend on storage. */ }
}
export function recordDiagnostic(event, fields = {}) {
  try {
    const record = sanitize({ ...fields, event, utc: new Date().toISOString(), page, elapsedMs: Math.max(0, Math.round(performance.now() - started)) });
    if (!record) return;
    events.push(record);
    if (events.length > LIMIT) events.splice(0, events.length - LIMIT);
    persist();
  } catch { /* Diagnostics must never interrupt connection handling. */ }
}
export function diagnosticConnection(role, hostGroup) {
  return { connection: ++nextConnection, role: ["host", "session"].includes(role) ? role : "unknown", hostGroup: integer(hostGroup) ? hostGroup : 0 };
}
export const diagnosticMethod = method => methods.includes(method) ? method : "unknown";
export const diagnosticCause = cause => causes.includes(cause) ? cause : "unspecified";
export const diagnosticServiceCode = code => serviceCodes.includes(code) ? code : "unknown";
export function clearDiagnostics() {
  events = [];
  try { sessionStorage.removeItem(STORAGE_KEY); }
  catch { return "Memory cleared; browser storage could not be cleared. New events will still be recorded."; }
  return "Diagnostics cleared. New events will still be recorded.";
}
export async function exportDiagnostics() {
  try {
    const contents = JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), events }, null, 2);
    const filename = "pi-console-diagnostics.json";
    if (!preferDownload && typeof File === "function" && typeof navigator.canShare === "function" && typeof navigator.share === "function") {
      const file = new File([contents], filename, { type: "application/json" });
      let canShare = false;
      try { canShare = navigator.canShare({ files: [file] }); } catch { /* Use download instead. */ }
      if (canShare) {
        try {
          await navigator.share({ files: [file] });
          return "Diagnostics shared.";
        } catch (error) {
          if (error?.name === "AbortError") return "Export cancelled.";
          // Download on the next click, while that new user gesture is still active.
          preferDownload = true;
          return "Sharing failed. Tap Export diagnostics again to download.";
        }
      }
    }
    const url = URL.createObjectURL(new Blob([contents], { type: "application/json" }));
    try {
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.append(link);
      try { link.click(); } finally { link.remove(); }
    } finally { setTimeout(() => URL.revokeObjectURL(url), 60000); }
    return "Diagnostics download requested.";
  } catch { return "Could not export diagnostics on this browser."; }
}
const visibility = () => ["visible", "hidden"].includes(document.visibilityState) ? document.visibilityState : "unknown";
try {
  recordDiagnostic("page_load", { standalone: navigator.standalone === true || window.matchMedia?.("(display-mode: standalone)").matches === true,
    online: navigator.onLine === true, visibility: visibility() });
  document.addEventListener("visibilitychange", () => recordDiagnostic("visibility", { visibility: visibility() }));
  for (const event of ["focus", "blur", "online", "offline"]) window.addEventListener(event, () => recordDiagnostic(event));
  for (const event of ["pagehide", "pageshow"]) window.addEventListener(event, value => recordDiagnostic(event, { persisted: value.persisted === true }));
} catch { /* Lifecycle diagnostics are optional in restricted browser environments. */ }
