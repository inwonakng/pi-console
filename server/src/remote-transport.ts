import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { hostname, networkInterfaces } from "node:os";
import { join, resolve } from "node:path";
import type { Duplex } from "node:stream";
import { WebSocketServer, createWebSocketStream } from "ws";
import { MAX_REQUEST } from "./local-protocol.js";
import { readHostRegistry, type RegisteredHost } from "../../pi/extensions/shared/read-host-registry.mjs";
import { webRelay } from "./web-relay.js";
import type { WebPushNotifications } from "./web-push.js";
import type { Channel } from "./session-catalog.js";
import { defaultRoot } from "./service-paths.js";
import { ConnectionDiagnostics, diagnosticCode, serviceDiagnostic } from "./connection-diagnostics.js";

export function listenerPort(value?: string | number, channel: Channel = "stable"): number {
  value ??= channel === "stable" ? 8444 : 8443;
  if (!/^\d+$/.test(String(value)) || !Number.isInteger(Number(value)) || Number(value) < 1 || Number(value) > 65535) {
    throw new Error("Port must be an integer between 1 and 65535");
  }
  return Number(value);
}
export function listenerAddresses(port: number): { bind: string; port: number; urls: string[] } {
  const hosts = new Set([hostname()]);
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) if (address.family === "IPv4") hosts.add(address.address);
  }
  return { bind: "0.0.0.0", port, urls: [...hosts].map((host) => `http://${host}:${port}`) };
}

/** Trusted-network entrypoint. Local administration remains on private IPC. */
export class RemoteListener {
  private readonly server: Server;
  private readonly websocket = new WebSocketServer({ noServer: true, maxPayload: MAX_REQUEST,
    perMessageDeflate: false, allowSynchronousEvents: false, clientTracking: true });
  private readonly peers = new Map<Duplex, { detach: (error?: Error) => void; diagnostics: ConnectionDiagnostics }>();
  private readonly sockets = new Map<Duplex, ConnectionDiagnostics>();
  private readonly timer: NodeJS.Timeout;
  constructor(private readonly port: number,
    connection: (stream: Duplex, onDetach: (detach: (error?: Error) => void) => void, connectionId: string,
      diagnostics: ConnectionDiagnostics) => Promise<void>,
    web?: { root: string; serviceRoot: string; channel: Channel; hostId: string; allowedOrigins?: readonly string[];
      push?: WebPushNotifications }) {
    // Load the fixed asset set at startup; never resolve request paths on disk.
    const assets = new Map<string, { body: Buffer; type: string }>();
    if (web) {
      for (const [path, file, type] of [
        ["/", "index.html", "text/html; charset=utf-8"],
        ["/app.js", "app.js", "text/javascript; charset=utf-8"],
        ["/notifications.js", "notifications.js", "text/javascript; charset=utf-8"],
        ["/sw.js", "sw.js", "text/javascript; charset=utf-8"],
        ["/manifest.webmanifest", "manifest.webmanifest", "application/manifest+json"],
        ["/client.js", "client.js", "text/javascript; charset=utf-8"],
        ["/diagnostics.js", "diagnostics.js", "text/javascript; charset=utf-8"],
        ["/snapshot.js", "snapshot.js", "text/javascript; charset=utf-8"],
        ["/markdown.js", "markdown.js", "text/javascript; charset=utf-8"],
        ["/vendor/marked.js", "vendor/marked.js", "text/javascript; charset=utf-8"],
        ["/style.css", "style.css", "text/css; charset=utf-8"],
        ["/logo.svg", "logo.svg", "image/svg+xml"],
        ["/apple-touch-icon.png", "apple-touch-icon.png", "image/png"],
      ]) {
        let body = readFileSync(join(web.root, file));
        if (path === "/") body = Buffer.from(body.toString("utf8").replace("{{PI_CONSOLE_CHANNEL}}", web.channel));
        assets.set(path, { body, type });
      }
    }
    const allowedOrigin = (origin: string | undefined, host: string | undefined) => origin !== undefined
      && (origin === `http://${host}` || web?.allowedOrigins?.includes(origin) === true);
    this.server = createServer({ maxHeaderSize: 8192, requestTimeout: 10000,
      headersTimeout: 10000, connectionsCheckingInterval: 1000 }, (request, response) => {
      if (web?.push && ["/v1/push", "/v1/push/status", "/v1/push/subscription"].includes(request.url ?? "")) {
        const origin = allowedOrigin(request.headers.origin, request.headers.host) ? request.headers.origin : undefined;
        void web.push.handle(request, response, origin).catch(() => {
          if (!response.headersSent) response.writeHead(503, { "Cache-Control": "no-store", Connection: "close" });
          response.end();
        });
        return;
      }
      if (web && request.url === "/v1/hosts") {
        if (request.method !== "GET") {
          response.writeHead(405, { Allow: "GET", Connection: "close" }); response.end(); return;
        }
        try {
          const hosts = [{ key: "local", alias: "localhost", enabled: true, hostId: web.hostId, stream: "/v1/stream" },
            ...readHostRegistry(web.channel).filter((host) => host.remote !== undefined
              || resolve(host.root ?? defaultRoot(web.channel)) !== resolve(web.serviceRoot))
              .map(({ key, alias, enabled, hostId }) =>
              ({ key, alias, enabled, hostId, stream: `/v1/hosts/${key}/stream` }))];
          const clientAddress = request.socket.remoteAddress?.replace(/^::ffff:/, "");
          const body = JSON.stringify({ channel: web.channel, hosts, clientAddress });
          response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body),
            "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
          response.end(body);
        } catch {
          response.writeHead(503, { "Cache-Control": "no-store", Connection: "close" }); response.end();
        }
        return;
      }
      const asset = assets.get(request.url?.split("?", 1)[0] ?? "");
      if (!asset) { response.writeHead(404, { Connection: "close" }); response.end(); return; }
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.writeHead(405, { Allow: "GET, HEAD", Connection: "close" }); response.end(); return;
      }
      response.writeHead(200, {
        "Content-Type": asset.type, "Content-Length": asset.body.length,
        "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; worker-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
      });
      response.end(request.method === "HEAD" ? undefined : asset.body);
    });
    // Remote capacity cannot consume the local IPC connection budget.
    this.server.maxConnections = 64;
    this.server.on("connection", (socket) => {
      const diagnostics = new ConnectionDiagnostics(randomUUID(), "tcp");
      socket.on("error", (error) => {
        const current = this.sockets.get(socket) ?? diagnostics;
        current.observed("socket_error"); current.log("error", { cause: "socket_error", code: diagnosticCode(error) });
      });
      socket.setTimeout(15000, () => {
        (this.sockets.get(socket) ?? diagnostics).action("destroy", "tcp_idle_timeout"); socket.destroy();
      });
      this.sockets.set(socket, diagnostics); socket.once("close", () => this.sockets.delete(socket));
    });
    this.server.on("upgrade", (request, socket, head) => {
      // Non-browser clients retain trusted-network access. Browser clients must
      // come from this HTTP origin or an explicitly configured dashboard origin,
      // and only when the web frontend is enabled. Proxy headers are not trusted.
      const origin = request.headers.origin;
      let target: RegisteredHost | undefined;
      const relayKey = /^\/v1\/hosts\/(host-[a-f0-9]{64})\/stream$/.exec(request.url ?? "")?.[1];
      if (web && relayKey) {
        try { target = readHostRegistry(web.channel).find((host) => host.key === relayKey && host.enabled); }
        catch { /* Invalid or inaccessible configuration fails closed. */ }
      }
      if (origin !== undefined && (!web || !allowedOrigin(origin, request.headers.host))
        || request.url !== "/v1/stream" && !target || this.peers.size + this.upgrading >= 32) {
        socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); return;
      }
      // Reserve admission before any upstream handshake can suspend.
      this.upgrading++;
      let reserved = true;
      const release = () => { if (reserved) { reserved = false; this.upgrading--; } };
      socket.once("close", release);
      try { this.websocket.handleUpgrade(request, socket, head, (ws) => {
        release(); socket.off("close", release);
        request.socket.setTimeout(0);
        const connectionId = randomUUID();
        const diagnostics = new ConnectionDiagnostics(connectionId, "ws");
        this.sockets.set(socket, diagnostics);
        diagnostics.log("open");
        // Observe the transport before stream cleanup can finish the handler.
        ws.once("close", (code, reason) => {
          diagnostics.observed("peer_close"); diagnostics.log("close", { closeCode: code, reason: reason.length ? "omitted" : "empty" });
        });
        const stream = createWebSocketStream(ws, { highWaterMark: 64 * 1024 });
        stream.on("error", (error) => {
          diagnostics.observed("stream_error"); diagnostics.log("error", { cause: "stream_error", code: diagnosticCode(error) });
        });
        ws.on("error", (error) => {
          diagnostics.observed("websocket_error"); diagnostics.log("error", { cause: "websocket_error", code: diagnosticCode(error) });
        });
        stream.once("end", () => { diagnostics.observed("stream_end"); diagnostics.log("end", { cause: "stream_end" }); });
        stream.once("close", () => { diagnostics.observed("stream_close"); diagnostics.log("close", { cause: "stream_close" }); });
        const peer = { detach: (_error?: Error) => undefined as void, diagnostics };
        this.peers.set(stream, peer);
        const connected = target && web
          ? webRelay(stream, target, web.channel, (detach) => { peer.detach = detach; }, diagnostics)
          : connection(stream, (detach) => { peer.detach = detach; }, connectionId, diagnostics);
        let rejected = false;
        void connected
          .catch((error) => { rejected = true; diagnostics.action("handler_rejected", "handler_rejected", error);
            diagnostics.action("destroy", "handler_rejected"); stream.destroy(); })
          .finally(() => {
            if (!rejected) diagnostics.log("handler_complete", { cause: "handler_complete" });
            peer.detach(); this.peers.delete(stream);
            if (stream.destroyed) diagnostics.observed("stream_close");
            diagnostics.action("terminate", "handler_cleanup"); ws.terminate(); });
        // Detect dead connections, including half-open controllers. No reconnect/replay.
        let alive = true;
        ws.on("pong", () => { alive = true; diagnostics.pong(); });
        const ping = () => {
          if (!alive) {
            const error = Object.assign(new Error("WebSocket heartbeat expired: no pong within 15 seconds"), { code: "heartbeat_timeout" });
            diagnostics.action("disconnect", "heartbeat_timeout", error);
            peer.detach(error); diagnostics.action("destroy", "heartbeat_timeout"); stream.destroy();
            diagnostics.action("terminate", "heartbeat_timeout"); ws.terminate();
          } else { alive = false; diagnostics.ping(); ws.ping(); }
        };
        this.pings.add(ping); ws.once("close", () => { peer.detach(); this.pings.delete(ping); });
      }); } catch (error) { release();
        this.sockets.get(socket)?.action("destroy", "upgrade_failed", error); socket.destroy(); }
    });
    this.timer = setInterval(() => { for (const ping of this.pings) ping(); }, 15000);
    this.timer.unref();
  }
  private upgrading = 0;
  private readonly pings = new Set<() => void>();
  async listen(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.port, "0.0.0.0", () => { this.server.off("error", reject); resolve(); });
    });
  }
  close(): void {
    serviceDiagnostic("listener_shutdown");
    clearInterval(this.timer);
    for (const [stream, peer] of this.peers) {
      peer.diagnostics.action("destroy", "listener_shutdown"); peer.detach(); stream.destroy();
    }
    for (const [socket, diagnostics] of this.sockets) { diagnostics.action("destroy", "listener_shutdown"); socket.destroy(); }
    this.websocket.close(); this.server.close();
  }
}
