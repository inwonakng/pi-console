import { createServer, type Server } from "node:https";
import { readFile } from "node:fs/promises";
import { X509Certificate } from "node:crypto";
import { createSecureContext } from "node:tls";
import type { Duplex } from "node:stream";
import { WebSocketServer, createWebSocketStream } from "ws";
import { privateJson } from "./catalog-storage.js";
import { object } from "./pi-records.js";
import { MAX_REQUEST } from "./local-protocol.js";
import type { DeviceCredentials } from "./device-credentials.js";

export type TlsListenerOptions = { bind: string; port: number; cert: Buffer; key: Buffer };
export async function tlsListenerOptions(path: string): Promise<TlsListenerOptions> {
  const config = await privateJson(path, 16384);
  if (!object(config) || typeof config.bind !== "string" || !config.bind || !Number.isInteger(config.port)
    || (config.port as number) < 1 || (config.port as number) > 65535 || typeof config.certFile !== "string" || typeof config.keyFile !== "string"
    || Object.keys(config).some((key) => !["bind", "port", "certFile", "keyFile"].includes(key))) throw new Error("TLS config requires bind, port, certFile and keyFile");
  const cert = await readFile(config.certFile), key = await readFile(config.keyFile);
  const leaf = new X509Certificate(cert);
  if (Date.parse(leaf.validFrom) > Date.now() || Date.parse(leaf.validTo) <= Date.now()) throw new Error("TLS server certificate is not currently valid");
  // Checks the PEM/key pair before acquiring ownership or opening any listener.
  createSecureContext({ cert, key, minVersion: "TLSv1.2" });
  return { bind: config.bind, port: config.port as number, cert, key };
}

/** Separate authenticated remote entrypoint. Never routes HTTP to local-admin IPC. */
export class RemoteListener {
  private readonly server: Server;
  private readonly websocket = new WebSocketServer({ noServer: true, maxPayload: MAX_REQUEST,
    perMessageDeflate: false, allowSynchronousEvents: false, clientTracking: true });
  private readonly peers = new Map<Duplex, { deviceId: string; detach: () => void }>();
  private readonly sockets = new Set<Duplex>();
  private readonly timer: NodeJS.Timeout;
  constructor(private readonly options: TlsListenerOptions, private readonly credentials: DeviceCredentials,
    connection: (stream: Duplex, deviceId: string, onDetach: (detach: () => void) => void) => Promise<void>) {
    this.server = createServer({ cert: options.cert, key: options.key, minVersion: "TLSv1.2", handshakeTimeout: 10000, maxHeaderSize: 8192,
      requestTimeout: 10000, headersTimeout: 10000, connectionsCheckingInterval: 1000 }, (request, response) => {
      // No anonymous health/metadata, browser CORS, proxy or HTTP administration.
      const authenticated = !request.headers.origin && credentials.authenticate(request.headers.authorization);
      response.writeHead(authenticated ? 404 : 401, { Connection: "close" }); response.end();
    });
    // Remote capacity cannot consume the local IPC connection budget.
    this.server.maxConnections = 64;
    this.server.on("connection", (socket) => {
      socket.on("error", () => undefined);
      this.sockets.add(socket); socket.once("close", () => this.sockets.delete(socket));
    });
    this.server.on("secureConnection", (socket) => {
      socket.on("error", () => undefined);
      socket.setTimeout(15000, () => socket.destroy());
    });
    this.server.on("upgrade", (request, socket, head) => {
      const deviceId = credentials.authenticate(request.headers.authorization);
      if (!deviceId || request.headers.origin !== undefined || request.url !== "/v1/stream" || this.peers.size >= 32) {
        socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); return;
      }
      this.websocket.handleUpgrade(request, socket, head, (ws) => {
        request.socket.setTimeout(0);
        const stream = createWebSocketStream(ws, { highWaterMark: 64 * 1024 });
        stream.on("error", () => undefined); ws.on("error", () => undefined);
        const peer = { deviceId, detach: () => undefined as void };
        this.peers.set(stream, peer);
        void connection(stream, deviceId, (detach) => { peer.detach = detach; })
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
  revoke(deviceId: string): void {
    for (const [stream, peer] of this.peers) if (peer.deviceId === deviceId) { peer.detach(); stream.destroy(); }
  }
  async listen(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.options.port, this.options.bind, () => { this.server.off("error", reject); resolve(); });
    });
  }
  close(): void {
    clearInterval(this.timer);
    for (const [stream, peer] of this.peers) { peer.detach(); stream.destroy(); }
    for (const socket of this.sockets) socket.destroy();
    this.websocket.close(); this.server.close();
  }
}
