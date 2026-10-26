// Diagnostics contain categories and random transport IDs only, never protocol records.
const codes = new Set(["heartbeat_timeout", "handshake_timeout", "service_connection_error", "transport_error", "output_error",
  "discovery_error", "service_disconnected", "websocket_closed", "bridge_error", "attachment_closed", "request_limit",
  "transport_closed", "input_error", "request_not_sent", "service_error", "ECONNRESET", "EPIPE", "ECONNREFUSED",
  "ETIMEDOUT", "ECONNABORTED", "ENOTFOUND", "EAI_AGAIN", "ERR_STREAM_DESTROYED", "ERR_STREAM_PREMATURE_CLOSE",
  "ERR_STREAM_WRITE_AFTER_END", "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH", "WS_ERR_INVALID_UTF8"]);
export function diagnosticCode(error: unknown): string {
  try {
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    return typeof code === "string" && codes.has(code) ? code : "unknown";
  } catch { return "unknown"; }
}
export function diagnosticUUID(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
export type DiagnosticCause = "tcp_idle_timeout" | "upgrade_failed" | "socket_error" | "stream_error" | "websocket_error"
  | "peer_close" | "stream_close" | "stream_end" | "heartbeat_timeout" | "handler_rejected" | "handler_complete"
  | "handler_cleanup" | "listener_shutdown" | "service_disconnect" | "disconnect_deadline" | "disconnect_write_failed"
  | "disconnect_sent" | "connection_cleanup" | "service_shutdown" | "admission_rejected" | "relay_detach"
  | "relay_stream_close" | "relay_handshake_timeout" | "relay_write_failed" | "relay_upstream_disconnected"
  | "relay_handshake_failed" | "relay_reader_finished" | "relay_reader_failed" | "relay_request_failed";
type Event = "open" | "error" | "close" | "end" | "handler_complete" | "handler_rejected" | "destroy" | "terminate"
  | "disconnect" | "relay_stop" | "relay_open" | "relay_handshake" | "relay_handshake_failed" | "relay_request_failed";
export function serviceDiagnostic(event: "start" | "ready" | "failure" | "startup_failed" | "shutdown_requested" | "shutdown_started"
  | "shutdown_refused" | "shutdown_failed" | "shutdown_complete" | "signal" | "finish" | "stopped" | "listener_shutdown",
  fields: { code?: string; signal?: "SIGTERM" | "SIGINT" } = {}): void {
  try { console.error(JSON.stringify({ type: "service_diagnostic", timestamp: new Date().toISOString(), pid: process.pid, event,
    ...(fields.code ? { code: diagnosticCode({ code: fields.code }) } : {}), ...(fields.signal ? { signal: fields.signal } : {}) })); }
  catch { /* Logging must not affect service lifetime. */ }
}
export class ConnectionDiagnostics {
  private firstCause: DiagnosticCause | null = null;
  private firstSource: "observed" | "server" | null = null;
  private lastPing: number | null = null;
  private lastPong: number | null = null;
  private pingCount = 0;
  private pongCount = 0;
  constructor(readonly connectionId: string, private readonly transport: "ws" | "local" | "tcp") {}
  ping(): void { this.lastPing = Date.now(); this.pingCount++; }
  pong(): void { this.lastPong = Date.now(); this.pongCount++; }
  observed(cause: DiagnosticCause): void { this.firstCause ??= cause; this.firstSource ??= "observed"; }
  action(event: Event, cause: DiagnosticCause, error?: unknown): void {
    this.firstCause ??= cause; this.firstSource ??= "server";
    this.log(event, { cause, ...(error === undefined ? {} : { code: diagnosticCode(error) }) });
  }
  log(event: Event, fields: { cause?: DiagnosticCause; code?: string; closeCode?: number; reason?: "empty" | "omitted";
    upstreamConnectionId?: string } = {}): void {
    try {
      const now = Date.now();
      console.error(JSON.stringify({ type: "connection_diagnostic", timestamp: new Date(now).toISOString(), pid: process.pid,
        connectionId: this.connectionId, transport: this.transport, event, firstCause: this.firstCause, firstSource: this.firstSource,
        lastPingAt: this.lastPing === null ? null : new Date(this.lastPing).toISOString(),
        lastPongAt: this.lastPong === null ? null : new Date(this.lastPong).toISOString(),
        lastPingAgeMs: this.lastPing === null ? null : Math.max(0, now - this.lastPing),
        lastPongAgeMs: this.lastPong === null ? null : Math.max(0, now - this.lastPong), pingCount: this.pingCount, pongCount: this.pongCount,
        ...(fields.cause === undefined ? {} : { cause: fields.cause }),
        ...(fields.code === undefined ? {} : { code: diagnosticCode({ code: fields.code }) }),
        ...(typeof fields.closeCode === "number" && Number.isInteger(fields.closeCode) && fields.closeCode >= 0 && fields.closeCode <= 4999
          ? { closeCode: fields.closeCode } : {}),
        ...(["empty", "omitted"].includes(fields.reason ?? "") ? { reason: fields.reason } : {}),
        ...(diagnosticUUID(fields.upstreamConnectionId) ? { upstreamConnectionId: fields.upstreamConnectionId } : {}) }));
    } catch { /* Logging must not affect teardown. */ }
  }
}
