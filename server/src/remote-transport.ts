import { createServer, type Server } from "node:http";
import { hostname, networkInterfaces } from "node:os";
import type { Duplex } from "node:stream";
import { WebSocketServer, createWebSocketStream } from "ws";
import { MAX_REQUEST } from "./local-protocol.js";

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
    connection: (stream: Duplex, onDetach: (detach: () => void) => void) => Promise<void>) {
    this.server = createServer({ maxHeaderSize: 8192, requestTimeout: 10000,
      headersTimeout: 10000, connectionsCheckingInterval: 1000 }, (_request, response) => {
      // No web UI yet, and HTTP never exposes local administration.
      response.writeHead(404, { Connection: "close" }); response.end();
    });
    // Remote capacity cannot consume the local IPC connection budget.
    this.server.maxConnections = 64;
    this.server.on("connection", (socket) => {
      socket.on("error", () => undefined);
      socket.setTimeout(15000, () => socket.destroy());
      this.sockets.add(socket); socket.once("close", () => this.sockets.delete(socket));
    });
    this.server.on("upgrade", (request, socket, head) => {
      // Refuse browser-origin connections until a browser interface is implemented.
      if (request.headers.origin !== undefined || request.url !== "/v1/stream" || this.peers.size >= 32) {
        socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); return;
      }
      this.websocket.handleUpgrade(request, socket, head, (ws) => {
        request.socket.setTimeout(0);
        const stream = createWebSocketStream(ws, { highWaterMark: 64 * 1024 });
        stream.on("error", () => undefined); ws.on("error", () => undefined);
        const peer = { detach: () => undefined as void };
        this.peers.set(stream, peer);
        void connection(stream, (detach) => { peer.detach = detach; })
          .catch(() => stream.destroy()).finally(() => { peer.detach(); this.peers.delete(stream); ws.terminate(); });
        // Detect dead connections, including half-open controllers. No reconnect/replay.
        let alive = true;
        ws.on("pong", () => { alive = true; });
        const ping = () => { if (!alive) { peer.detach(); stream.destroy(); ws.terminate(); } else { alive = false; ws.ping(); } };
        this.pings.add(ping); ws.once("close", () => { peer.detach(); this.pings.delete(ping); });
      });
    });
    this.timer = setInterval(() => { for (const ping of this.pings) ping(); }, 15000);
    this.timer.unref();
  }
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
