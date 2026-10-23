import { connect } from "node:net";
import type { Duplex } from "node:stream";
import { lstat, readFile } from "node:fs/promises";
import { WebSocket, createWebSocketStream } from "ws";
import { privateJson } from "./catalog-storage.js";
import { credential } from "./device-credentials.js";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { endpoint } from "./local-service.js";
import { MAX_RESPONSE, PROTOCOL, records, RecordWriter } from "./local-protocol.js";
import type { Channel } from "./session-catalog.js";
import { object } from "./pi-records.js";

export class LocalClient {
  private readonly pending = new Map<string, { resolve: (result: unknown) => void; reject: (error: Error) => void }>();
  private readonly writer: RecordWriter;
  private disconnected = false;
  private constructor(private readonly socket: Duplex, private readonly event: (record: Record<string, unknown>) => void) {
    this.writer = new RecordWriter(socket);
    socket.on("error", () => undefined);
    void this.read().catch((error) => this.failed(error)).finally(() => this.failed(Object.assign(new Error("Service disconnected; accepted mutations were not replayed. Reconnect and inspect command status."), { code: "service_disconnected" })));
  }
  static async open(root: string, channel: Channel, event: (record: Record<string, unknown>) => void = () => undefined): Promise<{ client: LocalClient; hello: Record<string, unknown> }> {
    const path = endpoint(root);
    const directory = await lstat(dirname(path));
    const socketStat = await lstat(path);
    if (!directory.isDirectory() || directory.uid !== process.getuid?.() || (directory.mode & 0o077)
      || !socketStat.isSocket() || socketStat.uid !== process.getuid?.() || (socketStat.mode & 0o077)) throw new Error("Endpoint must be a private same-user Unix socket in a 0700 directory");
    const socket = connect(path);
    await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
    const client = new LocalClient(socket, event);
    try {
      const hello = await client.request("hello", { version: PROTOCOL, channel });
      if (!object(hello) || hello.version !== PROTOCOL || hello.channel !== channel || !Array.isArray(hello.capabilities)) throw new Error("Incompatible service handshake");
      return { client, hello };
    } catch (error) { client.close(); throw error; }
  }
  static async openRemote(endpoint: string, credentialFile: string, channel: Channel, caFile?: string,
    event: (record: Record<string, unknown>) => void = () => undefined): Promise<{ client: LocalClient; hello: Record<string, unknown> }> {
    let url: URL;
    try { url = new URL(endpoint); } catch { throw new Error("Invalid remote HTTPS endpoint"); }
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("Remote endpoint must be an HTTPS origin without credentials, path, query or fragment");
    const device = credential(await privateJson(credentialFile, 16384));
    if (device.channel !== channel) throw new Error("Device credential channel does not match the selected channel");
    const origin = url.origin;
    url.protocol = "wss:"; url.pathname = "/v1/stream";
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${device.deviceId}.${device.secret}` },
      ca: caFile ? await readFile(caFile) : undefined, rejectUnauthorized: true,
      followRedirects: false, handshakeTimeout: 10000, perMessageDeflate: false, maxPayload: MAX_RESPONSE,
      allowSynchronousEvents: false });
    ws.on("error", () => undefined);
    try {
      await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    } catch (error) { ws.terminate(); throw error; }
    const client = new LocalClient(createWebSocketStream(ws, { highWaterMark: 64 * 1024 }), event);
    const deadline = setTimeout(() => client.close(), 10000);
    try {
      const hello = await client.request("hello", { version: PROTOCOL, channel });
      if (!object(hello) || hello.version !== PROTOCOL || hello.channel !== channel || hello.hostId !== device.hostId
        || hello.deviceId !== device.deviceId || hello.transport !== "wss" || !Array.isArray(hello.capabilities)
        || !["snapshot", "updates", "control.acquire", "command.status"].every((c) => (hello.capabilities as unknown[]).includes(c))) throw new Error("Incompatible remote service identity/protocol/channel/capabilities; no fallback");
      return { client, hello: { ...hello, remoteEndpoint: origin } };
    } catch (error) { client.close(); throw error; }
    finally { clearTimeout(deadline); }
  }
  request(method: string, payload: unknown = {}, id: string = randomUUID()): Promise<unknown> {
    if (this.socket.destroyed || this.pending.size >= 32 || this.pending.has(id)) return Promise.reject(Object.assign(
      new Error("Connection closed or request limit/conflict"), { code: "request_not_sent", delivery: "not_sent" }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      void this.writer.send({ id, method, payload }).catch((error) => this.failed(error));
    });
  }
  close(): void { this.disconnected = true; this.socket.destroy(); }
  private async read(): Promise<void> {
    for await (const record of records(this.socket, MAX_RESPONSE)) {
      if (record.type !== "response") { this.event(record); continue; }
      const request = typeof record.id === "string" && this.pending.get(record.id);
      if (!request) throw new Error("Uncorrelated service response");
      this.pending.delete(record.id as string);
      if (record.success === true) request.resolve(record.result);
      else request.reject(Object.assign(new Error(object(record.error) ? String(record.error.message) : "Service request failed"),
        { code: object(record.error) ? record.error.code : "service_error" }));
    }
  }
  private failed(error: Error): void {
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
    if (!this.socket.destroyed) this.socket.destroy();
    if (!this.disconnected) { this.disconnected = true; this.event({ type: "disconnected", message: error.message }); }
  }
}
