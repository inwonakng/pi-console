import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { hostname, networkInterfaces } from "node:os";
import { join, resolve } from "node:path";
import type { Duplex } from "node:stream";
import { WebSocketServer, createWebSocketStream } from "ws";
import { MAX_REQUEST } from "./local-protocol.js";
import { readHostRegistry, type RegisteredHost } from "../../pi/extensions/shared/read-host-registry.mjs";
import { webRelay } from "./web-relay.js";
import type { Channel } from "./session-catalog.js";
import { defaultRoot } from "./service-paths.js";

export const DEFAULT_PORT = 8443;
export function listenerPort(value: string | number = DEFAULT_PORT): number {
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
  private readonly peers = new Map<Duplex, { detach: () => void }>();
  private readonly sockets = new Set<Duplex>();
  private readonly timer: NodeJS.Timeout;
  constructor(private readonly port: number,
    connection: (stream: Duplex, onDetach: (detach: () => void) => void) => Promise<void>,
    web?: { root: string; serviceRoot: string; channel: Channel; hostId: string; allowedOrigins?: readonly string[] }) {
    // Load the fixed asset set at startup; never resolve request paths on disk.
    const assets = new Map<string, { body: Buffer; type: string }>();
    if (web) {
      for (const [path, file, type] of [
        ["/", "index.html", "text/html; charset=utf-8"],
        ["/app.js", "app.js", "text/javascript; charset=utf-8"],
        ["/client.js", "client.js", "text/javascript; charset=utf-8"],
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
    this.server = createServer({ maxHeaderSize: 8192, requestTimeout: 10000,
      headersTimeout: 10000, connectionsCheckingInterval: 1000 }, (request, response) => {
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
        "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
      });
      response.end(request.method === "HEAD" ? undefined : asset.body);
    });
    // Remote capacity cannot consume the local IPC connection budget.
    this.server.maxConnections = 64;
    this.server.on("connection", (socket) => {
      socket.on("error", () => undefined);
      socket.setTimeout(15000, () => socket.destroy());
      this.sockets.add(socket); socket.once("close", () => this.sockets.delete(socket));
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
      if (origin !== undefined && (!web || origin !== `http://${request.headers.host}` && !web.allowedOrigins?.includes(origin))
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
        const stream = createWebSocketStream(ws, { highWaterMark: 64 * 1024 });
        stream.on("error", () => undefined); ws.on("error", () => undefined);
        const peer = { detach: () => undefined as void };
        this.peers.set(stream, peer);
        const connected = target && web
          ? webRelay(stream, target, web.channel, (detach) => { peer.detach = detach; })
          : connection(stream, (detach) => { peer.detach = detach; });
        void connected
          .catch(() => stream.destroy()).finally(() => { peer.detach(); this.peers.delete(stream); ws.terminate(); });
        // Detect dead connections, including half-open controllers. No reconnect/replay.
        let alive = true;
        ws.on("pong", () => { alive = true; });
        const ping = () => { if (!alive) { peer.detach(); stream.destroy(); ws.terminate(); } else { alive = false; ws.ping(); } };
        this.pings.add(ping); ws.once("close", () => { peer.detach(); this.pings.delete(ping); });
      }); } catch { release(); socket.destroy(); }
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
    clearInterval(this.timer);
    for (const [stream, peer] of this.peers) { peer.detach(); stream.destroy(); }
    for (const socket of this.sockets) socket.destroy();
    this.websocket.close(); this.server.close();
  }
}
