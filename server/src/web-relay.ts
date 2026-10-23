import type { Duplex } from "node:stream";
import type { RegisteredHost } from "../../pi/extensions/shared/read-host-registry.mjs";
import { LocalClient } from "./local-client.js";
import { identifier } from "./host-commands.js";
import { MAX_REQUEST, PROTOCOL, REMOTE_METHODS, records, RecordWriter } from "./local-protocol.js";
import { object } from "./pi-records.js";
import { defaultRoot } from "./service-paths.js";
import type { Channel } from "./session-catalog.js";

/** One browser, one upstream attachment. Never starts an owner or retries work. */
export async function webRelay(stream: Duplex, target: RegisteredHost, channel: Channel,
  onDetach: (detach: () => void) => void): Promise<void> {
  const writer = new RecordWriter(stream);
  const controller = new AbortController();
  let client: LocalClient | undefined;
  let handshaken = false;
  const stop = () => { controller.abort(); client?.close(); stream.destroy(); };
  onDetach(stop);
  stream.once("close", stop);
  const deadline = setTimeout(stop, 10000);
  const send = (value: unknown) => writer.send(value).catch((error) => { stop(); throw error; });
  const reject = (id: unknown, code: string, message: string) => send({ type: "response", id, success: false,
    error: { code, message, delivery: "not_sent" } });
  const pending = new Map<string, Promise<void>>();
  try {
    for await (const record of records(stream, MAX_REQUEST)) {
      if (!identifier(record.id) || typeof record.method !== "string" || !object(record.payload)
        || Object.keys(record).some((key) => !["id", "method", "payload"].includes(key))) throw new Error("Invalid relay request");
      if (!handshaken) {
        if (record.method !== "hello" || record.payload.version !== PROTOCOL || record.payload.channel !== channel
          || Object.keys(record.payload).some((key) => !["version", "channel"].includes(key))) {
          await reject(record.id, "unsupported_command", "Compatible protocol/channel handshake is required"); return;
        }
        try {
          const event = (event: Record<string, unknown>) => {
            if (handshaken) void send(event).then(() => { if (event.type === "disconnected") stop(); }, stop);
          };
          const opened = target.remote !== undefined
            ? await LocalClient.openRemote(target.remote, channel, event, controller.signal)
            : await LocalClient.open(target.root ?? defaultRoot(channel), channel, event, controller.signal);
          client = opened.client;
          const hello = opened.hello;
          if (stream.destroyed || controller.signal.aborted) return;
          if (hello.version !== PROTOCOL || hello.channel !== channel || typeof hello.hostId !== "string" || !hello.hostId
            || !Array.isArray(hello.capabilities)
            || !["snapshot", "updates", "control.acquire", "command.status"].every((cap) => (hello.capabilities as unknown[]).includes(cap))) {
            throw new Error("Incompatible service identity/protocol/channel/capabilities; no fallback");
          }
          if (target.hostId && hello.hostId !== target.hostId) {
            throw new Error("Endpoint service identity changed; confirm the replacement in Hosts before attaching. No mutation was sent.");
          }
          const { endpoint: _endpoint, remoteEndpoint: _remoteEndpoint, ...publicHello } = hello;
          await send({ type: "response", id: record.id, success: true, result: { ...publicHello,
            transport: "ws", capabilities: hello.capabilities.filter((cap) => cap !== "service.stop") } });
          handshaken = true;
          clearTimeout(deadline);
        } catch (error) {
          if (!stream.destroyed) await reject(record.id, "request_not_sent", error instanceof Error ? error.message : "Upstream handshake failed");
          return;
        }
        continue;
      }
      if (record.method === "hello" || !REMOTE_METHODS.has(record.method)) {
        await reject(record.id, "unsupported_command", "Method is not available on remote transport"); continue;
      }
      if (pending.size >= 32 || pending.has(record.id)) {
        await reject(record.id, "request_not_sent", "Relay request limit/conflict"); continue;
      }
      const request = client!.request(record.method, record.payload, record.id).then(
        (result) => send({ type: "response", id: record.id, success: true, result }),
        (error: unknown) => {
          const detail = object(error) ? error : {};
          return send({ type: "response", id: record.id, success: false, error: { ...detail,
            code: detail.code ?? "service_disconnected", message: error instanceof Error ? error.message : "Service request failed" } });
        });
      pending.set(record.id, request);
      void request.then(() => pending.delete(record.id as string), stop);
    }
  } finally {
    clearTimeout(deadline);
    stop();
    await Promise.allSettled(pending.values());
  }
}
