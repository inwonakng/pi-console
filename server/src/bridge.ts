import { resolve } from "node:path";
import { LocalClient } from "./local-client.js";
import { BridgeControl } from "./bridge-control.js";
import { MAX_REQUEST, records, RecordWriter, type RecordWriteOptions } from "./local-protocol.js";
import { defaultRoot, requireNode } from "./service-paths.js";
import { identifier } from "./host-commands.js";
import { object } from "./pi-records.js";

/** Stdio relay with connection-bound lease renewal; never acquires or replays work. */
async function main(): Promise<void> {
  requireNode();
  const args = process.argv.slice(2);
  let channel = "stable";
  let root: string | undefined, expectedHost: string | undefined;
  let remote: string | undefined;
  while (args.length) {
    const flag = args.shift(); const value = args.shift();
    if (!value) throw new Error("Missing bridge argument");
    if (flag === "--channel") channel = value;
    else if (flag === "--root") root = resolve(value);
    else if (flag === "--expected-host") expectedHost = value;
    else if (flag === "--remote") remote = value;
    else throw new Error("Unknown bridge option");
  }
  if (channel !== "stable" && channel !== "dev") throw new Error("Invalid channel");
  if (remote && root) throw new Error("Remote attachment cannot use --root");
  const writer = new RecordWriter(process.stdout);
  writer.chunks = true;
  const abort = new AbortController();
  let failure: Error | undefined, client: LocalClient | undefined, control: BridgeControl | undefined;
  let closed = false, diagnosticSent = false;
  const shutdown = (error?: Error) => {
    if (closed) return;
    closed = true;
    failure = error;
    if (error && !diagnosticSent) {
      diagnosticSent = true;
      void writer.send({ type: "disconnected", code: "bridge_error", message: error.message }).catch(() => undefined);
    }
    clearInterval(parentWatch);
    control?.reset(error?.message ?? "Frontend disconnected");
    abort.abort(); client?.close(); process.stdin.destroy();
    // Give an available UI a chance to receive the reason, but never wait for it.
    setTimeout(() => {
      process.stdout.destroy();
      // Node can retain queued pipe writes even after destroy() on stdio.
      process.exit(failure ? 1 : 0);
    }, 100);
  };
  const output = (record: unknown, options: RecordWriteOptions = {}): void => {
    void writer.send(record, options).catch((error: Error) => shutdown(error));
  };
  const frontendPid = process.ppid;
  // EOF may be hidden by backpressure. Reparenting also detects a dead frontend
  // without relying on Lua shutdown hooks or accepting a reused parent PID.
  const parentWatch = setInterval(() => {
    try {
      if (process.ppid !== frontendPid) throw new Error("Frontend process exited");
      process.kill(frontendPid, 0);
    } catch { shutdown(new Error("Frontend process exited")); }
  }, 1000);
  process.stdin.once("end", () => shutdown());
  process.stdin.once("close", () => shutdown());
  process.stdout.once("error", (error) => shutdown(error));
  process.stdout.once("close", () => shutdown());
  process.once("SIGTERM", () => shutdown());
  process.once("SIGINT", () => shutdown());
  const event = (record: Record<string, unknown>) => {
    if (closed) return;
    if (record.type === "update") control?.update(record.update);
    if (record.type === "disconnected") {
      diagnosticSent = true;
      control?.reset(String(record.message));
    }
    output(record);
    if (record.type === "disconnected") shutdown(new Error(String(record.message)));
  };
  let ready = false, queuedBytes = 0, generation = 0;
  const queued: Record<string, unknown>[] = [];
  const pending = new Set<Promise<void>>();
  const relay = (record: Record<string, unknown>) => {
    if (closed) return;
    if (!identifier(record.id) || typeof record.method !== "string" || !object(record.payload)
      || Object.keys(record).some((key) => !["id", "method", "payload"].includes(key))) throw new Error("Invalid bridge request");
    if (!ready) {
      queuedBytes += Buffer.byteLength(JSON.stringify(record));
      if (queued.length >= 30 || queuedBytes > MAX_REQUEST) throw new Error("Bridge handshake input budget exceeded");
      queued.push(record); return;
    }
    if (pending.size >= 30) {
      output({ type: "response", id: record.id, success: false,
        error: { code: "request_not_sent", message: "Bridge request limit exceeded", delivery: "not_sent" } });
      return;
    }
    const { id, method, payload } = record;
    if (method === "attach" || method === "window.open" || method === "detach") generation = control!.reset();
    const captured = generation;
    const request = client!.request(method, payload, id).then(
      (result) => {
        if (closed) return;
        if (method === "attach" || method === "window.open") control!.attached(result, captured);
        else if (method === "snapshot") control!.snapshot(result, captured);
        else if (method === "grant" && !control!.holdsGrant(result, captured)) result = null;
        output({ type: "response", id, success: true, result }, { ordered: method === "attach" });
      },
      (error) => {
        if (!closed) output({ type: "response", id, success: false, error: { code: error.code ?? "disconnected", message: error.message,
          ...(error.delivery === "not_sent" ? { delivery: "not_sent" } : {}) } });
      });
    pending.add(request);
    void request.finally(() => pending.delete(request)).catch((error: Error) => shutdown(error));
  };
  // Consume stdin during connection initialization too. EOF cancels the handshake;
  // requests received before hello are bounded and never dispatched prematurely.
  const input = (async () => {
    try { for await (const record of records(process.stdin, MAX_REQUEST)) relay(record); }
    catch (error) { if (!closed) shutdown(error instanceof Error ? error : new Error(String(error))); }
    finally { shutdown(); }
  })();
  try {
    const opened = remote
      ? await LocalClient.openRemote(remote, channel, event, abort.signal)
      : await LocalClient.open(root ?? defaultRoot(channel), channel, event, abort.signal);
    client = opened.client;
    if (closed) { client.close(); return; }
    control = new BridgeControl(client, output, () => writer.queuedBytes);
    if (expectedHost && opened.hello.hostId !== expectedHost) {
      throw new Error("Endpoint service identity changed; confirm the replacement in Hosts before attaching. No mutation was sent.");
    }
    output({ type: "hello", result: opened.hello });
    ready = true;
    for (const record of queued) relay(record);
    queued.length = 0;
    await input;
  } catch (error) {
    if (!closed) shutdown(error instanceof Error ? error : new Error(String(error)));
  } finally { shutdown(failure); }
  if (failure) throw failure;
}
void main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
