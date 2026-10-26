// Browser adapter for the existing LF-delimited service protocol. Authentication
// and permission to upgrade a browser connection belong to the host listener.
import { diagnosticConnection, diagnosticMethod, diagnosticCause, diagnosticServiceCode, recordDiagnostic } from "./diagnostics.js";

export function requestId() {
  // randomUUID() is unavailable on non-local HTTP origins; getRandomValues works.
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("");
}

export class ServiceClient {
  constructor(onEvent, diagnostics = {}) {
    this.onEvent = onEvent;
    this.diagnostics = diagnosticConnection(diagnostics.role, diagnostics.hostGroup);
    this.pending = new Map();
    this.socket = null;
    this.closed = false;
    this.recoveryBlocked = false;
  }

  connect(channel, path = "/v1/stream", expectedHostId) {
    if (this.closed) return Promise.reject(new Error("Connection closed"));
    if (this.connecting) return this.connecting;
    return this.connecting = this.open(channel, path, expectedHostId);
  }

  async open(channel, path, expectedHostId) {
    const url = new URL(path, location.href);
    if (url.origin !== location.origin || !/^\/v1\/(?:stream|hosts\/[\w-]+\/stream)$/.test(url.pathname) || url.search || url.hash) {
      this.recoveryBlocked = true;
      throw new Error("Invalid same-origin host stream");
    }
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    recordDiagnostic("connect_start", this.diagnostics);
    const socket = this.socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    let buffer = "";
    const decoder = new TextDecoder("utf-8", { fatal: true });
    socket.addEventListener("message", event => {
      if (this.closed || this.socket !== socket) return;
      try {
        buffer += typeof event.data === "string" ? event.data : decoder.decode(event.data, { stream: true });
        if (buffer.length > 80 * 1024 * 1024) throw new Error("Service response is too large");
        let newline;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const record = JSON.parse(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
          if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("Invalid service record");
          if (record.type === "response") {
            const pending = this.pending.get(record.id);
            if (!pending) throw new Error("Uncorrelated service response");
            clearTimeout(pending.timer);
            this.pending.delete(record.id);
            if (record.success === true) pending.resolve(record.result);
            else pending.reject(Object.assign(new Error(record.error?.message || "Service request failed"), {
              code: record.error?.code,
              delivery: record.error?.delivery || (record.error?.code === "service_disconnected" ? "uncertain" : "rejected"),
            }));
          } else {
            if (record.type === "disconnected") recordDiagnostic("service_disconnected", { ...this.diagnostics, code: diagnosticServiceCode(record.code) });
            // Preserve response/event ordering when several records share a frame.
            queueMicrotask(() => {
              if (this.closed || this.socket !== socket) return;
              if (record.type === "disconnected") this.close(record.message, "socket_closed");
              else this.onEvent(record);
            });
          }
        }
      } catch (error) {
        this.recoveryBlocked = true;
        this.close(error.message, "invalid_record");
      }
    });
    socket.addEventListener("close", event => {
      recordDiagnostic("socket_close", { ...this.diagnostics, code: event.code, wasClean: event.wasClean, reason: event.reason ? "omitted" : "empty" });
      this.close("Disconnected. Commands were not replayed; inspect the session before sending again.", "socket_closed");
    });
    socket.addEventListener("error", () => {
      recordDiagnostic("socket_error", this.diagnostics);
      this.close("Connection failed. Recovery will retry while online and visible.", "socket_error");
    });
    const deadline = setTimeout(() => this.close("Connection timed out", "connect_timeout"), 10000);
    try {
      await new Promise((resolve, reject) => {
        // close() must settle this even when a browser delays CONNECTING's close event.
        this.rejectOpening = reject;
        socket.addEventListener("open", () => {
          if (this.closed) return;
          recordDiagnostic("socket_open", this.diagnostics);
          this.rejectOpening = null;
          resolve();
        }, { once: true });
      });
      const hello = await this.request("hello", { version: 1, channel });
      if (!hello || hello.version !== 1 || hello.channel !== channel || !Array.isArray(hello.capabilities)
        || !["snapshot", "updates", "sessions.subscribe", "control.acquire"].every(value => hello.capabilities.includes(value))) {
        this.recoveryBlocked = true;
        throw new Error("Incompatible host protocol or channel. Refresh its registration explicitly.");
      }
      if (expectedHostId && hello.hostId !== expectedHostId) {
        this.recoveryBlocked = true;
        throw new Error("Host identity changed. Review its registration in pi-console Hosts before reconnecting.");
      }
      this.hello = hello;
      recordDiagnostic("server_connection", { ...this.diagnostics, serverConnectionId: hello.connectionId });
      recordDiagnostic("handshake_complete", this.diagnostics);
      return hello;
    } catch (error) {
      if (error.code === "unsupported_command") this.recoveryBlocked = true;
      this.close(error.message, "handshake_failed");
      throw error;
    } finally { clearTimeout(deadline); this.rejectOpening = null; }
  }

  request(method, payload = {}, timeout = 30000) {
    if (this.closed || this.socket?.readyState !== WebSocket.OPEN || this.pending.size >= 32) {
      return Promise.reject(Object.assign(new Error("Not connected or too many pending requests"), { delivery: "not_sent" }));
    }
    const id = requestId();
    const record = JSON.stringify({ id, method, payload }) + "\n";
    if (new TextEncoder().encode(record).length > 2 * 1024 * 1024) return Promise.reject(Object.assign(new Error("Request is too large"), { delivery: "not_sent" }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        recordDiagnostic("request_timeout", { ...this.diagnostics, method: diagnosticMethod(method), pending: this.pending.size });
        this.close("Lost connection to the server. Your last action may still have gone through. Commands were not replayed; inspect before trying again.", method === "health" ? "probe_timeout" : "request_timeout");
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.socket.send(record); }
      catch (error) { this.close(error.message, "send_failed"); }
    });
  }

  probe() {
    if (this.probing) return this.probing;
    this.probing = (async () => {
      try {
        const value = await this.request("health", {}, 4000);
        if (value.channel !== this.hello.channel) {
          this.recoveryBlocked = true;
          throw new Error("Host channel changed. Refresh its registration explicitly.");
        }
        if (value.serviceEpoch !== this.hello.serviceEpoch || value.buildId !== this.hello.buildId || !Array.isArray(value.sessions)) {
          throw new Error("Host service changed. Refreshing its connection.");
        }
        return value;
      } catch (error) {
        recordDiagnostic("probe_failed", { ...this.diagnostics, outcome: this.recoveryBlocked ? "blocked" : this.closed ? "closed" : "changed" });
        this.close(error.message, "probe_failed");
        throw error;
      } finally { this.probing = null; }
    })();
    return this.probing;
  }

  close(message = "Disconnected", cause = "unspecified") {
    if (this.closed) return;
    recordDiagnostic("local_close", { ...this.diagnostics, cause: diagnosticCause(cause), pending: this.pending.size });
    this.closed = true;
    this.rejectOpening?.(new Error(message));
    this.rejectOpening = null;
    try { this.socket?.close(); } catch { /* A CONNECTING socket may reject close(). Still settle all work. */ }
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(Object.assign(new Error(message), { delivery: "uncertain" }));
    }
    this.pending.clear();
    this.onEvent({ type: "disconnected", message });
  }
}
