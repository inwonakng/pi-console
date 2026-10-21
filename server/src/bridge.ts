import { resolve } from "node:path";
import { LocalClient } from "./local-client.js";
import { MAX_REQUEST, records, RecordWriter } from "./local-protocol.js";
import { defaultRoot, requireNode } from "./service-paths.js";
import { identifier } from "./host-commands.js";
import { object } from "./pi-records.js";

/** JSONL stdio relay only: no owner, autostart, retry, control or queue state. */
async function main(): Promise<void> {
  requireNode();
  const args = process.argv.slice(2);
  let channel = "stable";
  let root: string | undefined, expectedHost: string | undefined;
  let remote: string | undefined, credentialFile: string | undefined, caFile: string | undefined;
  while (args.length) {
    const flag = args.shift(); const value = args.shift();
    if (!value) throw new Error("Missing bridge argument");
    if (flag === "--channel") channel = value;
    else if (flag === "--root") root = resolve(value);
    else if (flag === "--expected-host") expectedHost = value;
    else if (flag === "--remote") remote = value;
    else if (flag === "--credential-file") credentialFile = resolve(value);
    else if (flag === "--ca-file") caFile = resolve(value);
    else throw new Error("Unknown bridge option");
  }
  if (channel !== "stable" && channel !== "dev") throw new Error("Invalid channel");
  if (remote ? !credentialFile || root : credentialFile || caFile) throw new Error("Remote requires --credential-file, optional --ca-file, and no --root");
  const writer = new RecordWriter(process.stdout);
  let failure: Error | undefined;
  const output = async (record: unknown) => {
    try { await writer.send(record); }
    catch (error) { failure = error as Error; process.stdin.destroy(); client?.close(); }
  };
  let client: LocalClient | undefined;
  const event = (record: Record<string, unknown>) => {
    void output(record);
    if (record.type === "disconnected") { failure = new Error(String(record.message)); process.stdin.destroy(); }
  };
  const opened = remote
    ? await LocalClient.openRemote(remote, credentialFile!, channel, caFile, event)
    : await LocalClient.open(root ?? defaultRoot(channel), channel, event);
  client = opened.client;
  if (expectedHost && opened.hello.hostId !== expectedHost) {
    client.close();
    throw new Error("Endpoint service identity changed; confirm the replacement in Hosts before attaching. No mutation was sent.");
  }
  await output({ type: "hello", result: opened.hello });
  const pending = new Set<Promise<void>>();
  try {
    for await (const record of records(process.stdin, MAX_REQUEST)) {
      if (!identifier(record.id) || typeof record.method !== "string" || !object(record.payload)
        || Object.keys(record).some((key) => !["id", "method", "payload"].includes(key))) throw new Error("Invalid bridge request");
      if (pending.size >= 32) {
        await output({ type: "response", id: record.id, success: false,
          error: { code: "request_not_sent", message: "Bridge request limit exceeded", delivery: "not_sent" } });
        continue;
      }
      const request = client.request(record.method, record.payload, record.id).then(
        (result) => output({ type: "response", id: record.id, success: true, result }),
        (error) => output({ type: "response", id: record.id, success: false, error: { code: error.code ?? "disconnected", message: error.message,
          ...(error.delivery === "not_sent" ? { delivery: "not_sent" } : {}) } }));
      pending.add(request); void request.finally(() => pending.delete(request));
    }
  } finally { client.close(); }
  await Promise.all(pending);
  if (failure) throw failure;
}
void main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
