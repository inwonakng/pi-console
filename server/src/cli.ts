import { spawn } from "node:child_process";
import { open, realpath } from "node:fs/promises";
import { resolve, join, isAbsolute } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { HostOwner } from "./host-owner.js";
import { privateDirectory, privateJson } from "./catalog-storage.js";
import { object } from "./pi-records.js";
import { LocalClient } from "./local-client.js";
import { runService } from "./local-service.js";
import { applicationRoot, defaultRoot, requireNode, serviceBuild } from "./service-paths.js";
import type { Channel } from "./session-catalog.js";

process.umask(0o077);
async function main(): Promise<void> {
  requireNode();
  const args = process.argv.slice(2);
  const action = args.shift();
  const flags = new Map<string, string>();
  let force = false;
  while (args.length) {
    const key = args.shift()!;
    if (key === "--force") { force = true; continue; }
    if (!["--channel", "--root", "--binary", "--app-root", "--cwd", "--session", "--id", "--provider", "--model"].includes(key) || !args.length || flags.has(key)) throw new Error(`Invalid service argument: ${key}`);
    flags.set(key, args.shift()!);
  }
  const channel = flags.get("--channel") ?? process.env.PI_CONSOLE_CHANNEL ?? "stable";
  if (channel !== "stable" && channel !== "dev") throw new Error("Channel must be stable or dev");
  const root = resolve(flags.get("--root") ?? defaultRoot(channel));
  const binary = flags.get("--binary") ?? process.env.PI_BINARY;
  const options = { root, channel: channel as Channel, binary: binary ?? "", appRoot: await realpath(flags.get("--app-root") ?? applicationRoot()),
    provider: flags.get("--provider") ?? process.env.PI_PROVIDER, model: flags.get("--model") ?? process.env.PI_MODEL };
  const assertManagementOwner = (hello: Record<string, unknown>): void => {
    if (channel === "dev" && hello.appRoot !== options.appRoot) throw new Error(`Dev profile belongs to another checkout (${String(hello.appRoot)}); refusing management from ${options.appRoot}. Use a separate --root or that checkout. Explicit compatible frontend attachment remains allowed.`);
  };
  if (action === "reconcile") {
    if (channel === "dev") {
      const claim = await privateJson(join(root, "owner.lock"), 16384);
      if (!object(claim)) throw new Error("Invalid recovery claim");
      assertManagementOwner(claim);
    }
    await HostOwner.reconcile({ root, channel });
    console.log("Reconciled known managed work. No worker started or command replayed; start the service, inspect saved data, then explicitly resume."); return;
  }
  if (action === "run") {
    if (!binary || !isAbsolute(binary)) throw new Error("server run/start requires an explicit absolute --binary Pi path (or PI_BINARY)");
    await runService(options); return;
  }
  if (action === "start" || action === "restart") {
    if (!binary || !isAbsolute(binary)) throw new Error("server start/restart requires an explicit absolute --binary Pi path (or PI_BINARY)");
    if (action === "restart") {
      const { client, hello } = await LocalClient.open(root, channel);
      try { assertManagementOwner(hello); await client.request("service.stop", { serviceEpoch: hello.serviceEpoch, force }); }
      finally { client.close(); }
      // Wait for the old endpoint to close; never signal a PID from a file.
    } else {
      try {
        const { client, hello } = await LocalClient.open(root, channel);
        client.close(); assertManagementOwner(hello); console.log(JSON.stringify({ ...hello, existing: true, selectedBuildId: await serviceBuild() })); return;
      } catch (error) { if (!(error instanceof Error) || !["ENOENT", "ECONNREFUSED"].includes(String((error as NodeJS.ErrnoException).code))) throw error; }
    }
    await privateDirectory(root);
    const log = await open(join(root, "service.log"), "a", 0o600);
    const argv = [fileURLToPath(import.meta.url), "run", "--channel", channel, "--root", root, "--binary", binary,
      "--app-root", options.appRoot];
    if (options.provider) argv.push("--provider", options.provider);
    if (options.model) argv.push("--model", options.model);
    const child = spawn(process.execPath, argv, { detached: true, cwd: options.appRoot, stdio: ["ignore", log.fd, log.fd], env: process.env });
    let spawnError: Error | undefined;
    child.on("error", (error) => { spawnError = error; });
    child.unref(); await log.close();
    // Startup may hash large pinned installations. This is a startup diagnostic
    // bound, not a mutation retry policy. Racing candidates observe the winner.
    for (let n = 0; n < 600; n++) {
      if (spawnError) throw spawnError;
      try {
        const { client, hello } = await LocalClient.open(root, channel);
        client.close(); assertManagementOwner(hello); console.log(JSON.stringify(hello)); return;
      } catch (error) { if (!(error instanceof Error) || !["ENOENT", "ECONNREFUSED"].includes(String((error as NodeJS.ErrnoException).code))) throw error; }
      await delay(100);
    }
    throw new Error(`Service did not become ready; inspect ${join(root, "service.log")}. Existing claims require explicit reconcile, never automatic removal.`);
  }
  if (!["status", "stop", "create", "resume", "list"].includes(action ?? "")) throw new Error("Usage: pi-console server {run|start|status|stop|restart|reconcile|list|create|resume} [--channel stable|dev] [--root PATH] [--binary ABSOLUTE_PI] [--force] [--cwd PATH|--session ID] [--id COMMAND_ID]");
  const { client, hello } = await LocalClient.open(root, channel);
  try {
    let result: unknown;
    if (action === "stop") { assertManagementOwner(hello); result = await client.request("service.stop", { serviceEpoch: hello.serviceEpoch, force }); }
    else if (action === "create" || action === "resume") result = await client.request("host.command", { id: flags.get("--id") ?? randomUUID(),
      serviceEpoch: hello.serviceEpoch, operation: `host.${action}`, payload: action === "create" ? { cwd: resolve(flags.get("--cwd") ?? process.cwd()) } : { sessionId: flags.get("--session") } });
    else {
      result = await client.request("sessions");
      if (action === "status") result = { ...hello, state: result, selectedBuildId: await serviceBuild(), restartRequired: hello.buildId !== await serviceBuild(),
        stopNotice: "Normal stop saves/stops idle sessions; active work refuses unless --force is intentional." };
    }
    console.log(JSON.stringify(result));
  } finally { client.close(); }
}
void main().catch((error) => {
  console.error(error);
  // A failed owner cleanup must terminate, not leave a fenced-but-listening
  // process alive. Claims/SQLite remain; supervisors observe owner death.
  if (process.argv[2] === "run") process.exit(1);
  process.exitCode = 1;
});
