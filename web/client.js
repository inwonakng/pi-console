// Browser adapter for the existing LF-delimited service protocol. Authentication
// and permission to upgrade a browser connection belong to the host listener.
export function requestId() {
  // randomUUID() is unavailable on non-local HTTP origins; getRandomValues works.
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("");
}

export class ServiceClient {
  constructor(onEvent) {
    this.onEvent = onEvent;
    this.pending = new Map();
    this.measuring = 0;
    this.socket = null;
    this.closed = false;
  }

  async connect(channel, path = "/v1/stream", expectedHostId, timing) {
    const url = new URL(path, location.href);
    if (url.origin !== location.origin || !/^\/v1\/(?:stream|hosts\/[\w-]+\/stream)$/.test(url.pathname) || url.search || url.hash) {
      throw new Error("Invalid same-origin host stream");
    }
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const started = timing ? performance.now() : 0;
    const socket = this.socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    let buffer = "";
    const decoder = new TextDecoder("utf-8", { fatal: true });
    socket.addEventListener("message", event => {
      try {
        buffer += typeof event.data === "string" ? event.data : decoder.decode(event.data, { stream: true });
        if (buffer.length > 80 * 1024 * 1024) throw new Error("Service response is too large");
        let newline;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const parseStarted = this.measuring ? performance.now() : 0;
          const line = buffer.slice(0, newline);
          const record = JSON.parse(line);
          const parsed = this.measuring ? performance.now() : 0;
          buffer = buffer.slice(newline + 1);
          if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("Invalid service record");
          if (record.type === "response") {
            const pending = this.pending.get(record.id);
            if (!pending) throw new Error("Uncorrelated service response");
            clearTimeout(pending.timer);
            this.pending.delete(record.id);
            if (pending.timing) {
              this.measuring--;
              Object.assign(pending.timing, { elapsedMs: parsed - pending.started, parseMs: parsed - parseStarted,
                bytes: new TextEncoder().encode(line).length + 1 });
            }
            if (record.success === true) pending.resolve(record.result);
            else pending.reject(Object.assign(new Error(record.error?.message || "Service request failed"), {
              code: record.error?.code,
              delivery: record.error?.delivery || (record.error?.code === "service_disconnected" ? "uncertain" : "rejected"),
            }));
          } else {
            // Preserve response/event ordering when several records share a frame.
            queueMicrotask(() => { if (!this.closed) this.onEvent(record); });
          }
        }
      } catch (error) { this.close(error.message); }
    });
    socket.addEventListener("close", () => this.close("Disconnected. Commands were not replayed; inspect the session before sending again."));
    socket.addEventListener("error", () => this.close("Connection failed. Check the host's browser connection setup, then reconnect."));
    const deadline = setTimeout(() => this.close("Connection timed out"), 10000);
    try {
      await new Promise((resolve, reject) => {
        socket.addEventListener("open", resolve, { once: true });
        socket.addEventListener("close", () => reject(new Error("Could not connect to the host")), { once: true });
      });
      if (timing) timing.socketMs = performance.now() - started;
      const hello = await this.request("hello", { version: 1, channel }, timing ? (timing.hello = {}) : undefined);
      if (hello.version !== 1 || hello.channel !== channel || !Array.isArray(hello.capabilities)
        || !["snapshot", "updates", "sessions.subscribe", "control.acquire"].every(value => hello.capabilities.includes(value))) {
        throw new Error("Incompatible host protocol or channel");
      }
      if (expectedHostId && hello.hostId !== expectedHostId) throw new Error("Host identity changed. Review its registration in pi-console Hosts before reconnecting.");
      return hello;
    } catch (error) { this.close(error.message); throw error; }
    finally { clearTimeout(deadline); }
  }

  // The optional timing target stays in the browser; it is never sent to the service.
  request(method, payload = {}, timing) {
    if (this.closed || this.socket?.readyState !== WebSocket.OPEN || this.pending.size >= 32) {
      return Promise.reject(Object.assign(new Error("Not connected or too many pending requests"), { delivery: "not_sent" }));
    }
    const id = requestId();
    const record = JSON.stringify({ id, method, payload }) + "\n";
    if (new TextEncoder().encode(record).length > 2 * 1024 * 1024) return Promise.reject(Object.assign(new Error("Request is too large"), { delivery: "not_sent" }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.close("Lost connection to the server. Your last action may still have gone through. Reconnect and check before trying again."), 30000);
      if (timing) this.measuring++;
      this.pending.set(id, { resolve, reject, timer, timing, started: timing ? performance.now() : 0 });
      try { this.socket.send(record); }
      catch (error) { this.close(error.message); }
    });
  }

  close(message = "Disconnected") {
    if (this.closed) return;
    this.closed = true;
    this.socket?.close();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
    }
    this.pending.clear();
    this.measuring = 0;
    this.onEvent({ type: "disconnected", message });
  }
}
