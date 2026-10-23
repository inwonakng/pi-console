import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, realpath, unlink } from "node:fs/promises";
import { resolve, join, isAbsolute, dirname } from "node:path";
import { tlsListenerOptions } from "./remote-transport.js";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { HostOwner } from "./host-owner.js";
import { privateDirectory, privateJson } from "./catalog-storage.js";
import { object } from "./pi-records.js";
import { LocalClient } from "./local-client.js";
import { runService } from "./local-service.js";
import { applicationRoot, defaultRoot, managementIdentity, requireNode, serviceBuild } from "./service-paths.js";
import { managementLock, ServiceSupervisor } from "./service-supervisor.js";
import type { Channel } from "./session-catalog.js";

process.umask(0o077);
async function main(): Promise<void> {
  requireNode();
  const args = process.argv.slice(2);
  const action = args.shift();
  const credentialAction = action === "credentials" ? args.shift() : undefined;
  const flags = new Map<string, string>();
  let force = false;
  while (args.length) {
    const key = args.shift()!;
    if (key === "--force") { force = true; continue; }
    if (!["--channel", "--root", "--binary", "--app-root", "--cwd", "--session", "--id", "--provider", "--model", "--tls-config", "--label", "--output", "--device", "--supervisor-dir", "--path"].includes(key) || !args.length || flags.has(key)) throw new Error(`Invalid service argument: ${key}`);
    flags.set(key, args.shift()!);
  }
  const channel = flags.get("--channel") ?? process.env.PI_CONSOLE_CHANNEL ?? "stable";
  if (channel !== "stable" && channel !== "dev") throw new Error("Channel must be stable or dev");
  const root = resolve(flags.get("--root") ?? defaultRoot(channel));
  const binary = flags.get("--binary") ?? process.env.PI_BINARY;
  const options = { root, channel: channel as Channel, binary: binary ?? "", appRoot: await realpath(flags.get("--app-root") ?? applicationRoot()),
    provider: flags.get("--provider") ?? process.env.PI_PROVIDER, model: flags.get("--model") ?? process.env.PI_MODEL };
  const assertManagementOwner = async (hello: Record<string, unknown>): Promise<void> => {
    const selected = await managementIdentity(options.appRoot, channel);
    const running = typeof hello.appRoot === "string" ? await managementIdentity(hello.appRoot, channel) : undefined;
    if (running !== selected) throw new Error(`Profile belongs to another installation/checkout (${running}); refusing management from ${selected}. Use a separate --root or its launcher. Explicit compatible frontend attachment remains allowed.`);
  };
  const connect = async (allowDisconnect = false): Promise<Awaited<ReturnType<typeof LocalClient.open>> | undefined> => {
    try { return await LocalClient.open(root, channel); }
    catch (error) {
      const code = String((error as NodeJS.ErrnoException).code);
      if (["ENOENT", "ECONNREFUSED"].includes(code) || allowDisconnect && ["service_disconnected", "ECONNRESET", "EPIPE"].includes(code)) return;
      throw error;
    }
  };
  const requireNoClaim = async (): Promise<void> => {
    try { await lstat(join(root, "owner.lock")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    throw new Error("Owner claim remains without a reachable service. Inspect startup/cleanup and explicitly reconcile if appropriate; no supervisor teardown or automatic recovery occurred.");
  };
  const privateLog = async () => {
    const file = await open(join(root, "service.log"), constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || stat.mode & 0o077) {
      await file.close(); throw new Error("service.log must be a private same-user regular file (0600)");
    }
    return file;
  };
  const extraArgs: string[] = [];
  if (flags.has("--tls-config")) extraArgs.push("--tls-config", resolve(flags.get("--tls-config")!));
  if (options.provider) extraArgs.push("--provider", options.provider);
  if (options.model) extraArgs.push("--model", options.model);
  if (action === "reconcile") {
    const claim = await privateJson(join(root, "owner.lock"), 16384);
    if (!object(claim)) throw new Error("Invalid recovery claim");
    await assertManagementOwner(claim);
    await HostOwner.reconcile({ root, channel });
    console.log("Reconciled known managed work. No worker started or command replayed; start the service, inspect saved data, then explicitly resume."); return;
  }
  if (action === "run") {
    await managementIdentity(options.appRoot, channel);
    if (!binary || !isAbsolute(binary)) throw new Error("server run/start requires an explicit absolute --binary Pi path (or PI_BINARY)");
    const tls = flags.has("--tls-config") ? await tlsListenerOptions(resolve(flags.get("--tls-config")!)) : undefined;
    await runService({ ...options, tls }); return;
  }
  if (["start", "stop", "restart", "enable", "disable"].includes(action ?? "")) {
    await managementIdentity(options.appRoot, channel);
    const unlock = await managementLock(root);
    try {
      let supervisor = await ServiceSupervisor.load(root, channel, options.appRoot, flags.get("--supervisor-dir"));
      if (supervisor) await supervisor.loaded();
      const existing = await connect();
      if (existing) {
        try {
          await assertManagementOwner(existing.hello);
          if (existing.hello.stopping) throw new Error("Service is stopping; wait for closure and retry explicitly");
        }
        catch (error) { existing.client.close(); throw error; }
      }
      // Check start configuration before stopping a healthy owner.
      if ((action === "enable" || action === "restart" || action === "start" && !existing) && !supervisor
        && (!binary || !isAbsolute(binary))) { existing?.client.close(); throw new Error("Startup requires an explicit absolute --binary Pi path (or PI_BINARY)"); }
      // A retained claim is ownership even when no endpoint is reachable. Fence
      // registration as well as launch; never let another checkout claim startup.
      if (action === "enable" && !existing) await requireNoClaim();
      if (action === "enable" && !supervisor) {
        existing?.client.close();
        await (await privateLog()).close();
        supervisor = await ServiceSupervisor.create({ ...options, binary: binary!, directory: flags.get("--supervisor-dir"), path: flags.get("--path"), extraArgs });
        await supervisor.enable(!existing);
      } else if (action === "enable") {
        existing?.client.close();
        await supervisor!.enable(!existing);
      } else if (action === "stop" || action === "restart" || action === "disable") {
        if (existing) {
          try { await existing.client.request("service.stop", { serviceEpoch: existing.hello.serviceEpoch, force }); }
          finally { existing.client.close(); }
          // Do not mistake the old listener for the replacement during restart.
          let closed = false;
          for (let n = 0; n < 600; n++) {
            let view: Awaited<ReturnType<typeof connect>>;
            try { view = await connect(); }
            catch (error) {
              if (!["service_disconnected", "ECONNRESET", "EPIPE"].includes(String((error as NodeJS.ErrnoException).code))) throw error;
              await delay(100); continue;
            }
            if (!view) { closed = true; break; }
            view.client.close();
            if (view.hello.serviceEpoch !== existing.hello.serviceEpoch) throw new Error("Owner changed during shutdown; refusing further management");
            await delay(100);
          }
          if (!closed) throw new Error("Old service endpoint remains; refusing supervisor teardown/replacement");
          await supervisor?.waitStopped();
        } else await supervisor?.assertStopped();
        await requireNoClaim();
        if (action === "disable") await supervisor?.disable();
        if (action !== "restart") { console.log(JSON.stringify({ running: false, enabled: action === "disable" ? false : !!supervisor, notice: "Live sessions suspended for frontend reconnect; history, workspaces and credentials retained." })); return; }
      } else if (existing) {
        existing.client.close();
        const selectedBuildId = await serviceBuild();
        console.log(JSON.stringify({ ...existing.hello, existing: true, selectedBuildId, restartRequired: existing.hello.buildId !== selectedBuildId })); return;
      }
      if (action !== "enable") {
        await requireNoClaim();
        if (supervisor) { await (await privateLog()).close(); await supervisor.start(); }
        else {
          const log = await privateLog();
          try {
            const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "run", "--channel", channel, "--root", root, "--binary", binary!, "--app-root", options.appRoot, ...extraArgs],
              { detached: true, cwd: options.appRoot, stdio: ["ignore", log.fd, log.fd], env: process.env });
            await new Promise<void>((done, fail) => { child.once("spawn", done); child.once("error", fail); });
            child.unref();
          } finally { await log.close(); }
        }
      }
      for (let n = 0; n < 600; n++) {
        const view = await connect(true);
        if (view) {
          view.client.close(); await assertManagementOwner(view.hello);
          if (view.hello.stopping) throw new Error("Discovered service is stopping; no replacement started");
          const selectedBuildId = await serviceBuild();
          console.log(JSON.stringify({ ...view.hello, selectedBuildId, restartRequired: view.hello.buildId !== selectedBuildId, startup: supervisor ? await supervisor.status() : { enabled: false } })); return;
        }
        await delay(100);
      }
      throw new Error(`Service did not become ready; inspect ${join(root, "service.log")}. Existing claims require explicit reconcile, never automatic removal.`);
    } finally { await unlock(); }
  }
  if (action === "status") {
    const supervisor = await ServiceSupervisor.load(root, channel, options.appRoot, flags.get("--supervisor-dir"));
    const selectedBuildId = await serviceBuild();
    const view = await connect();
    if (!view) {
      let claimPresent = false;
      try { await lstat(join(root, "owner.lock")); claimPresent = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      console.log(JSON.stringify({ running: false, channel, endpoint: join(root, "service.sock"), selectedBuildId, claimPresent, startup: supervisor ? await supervisor.status() : { enabled: false } })); return;
    }
    try { console.log(JSON.stringify({ ...view.hello, running: true, state: await view.client.request("sessions"), selectedBuildId,
      restartRequired: view.hello.buildId !== selectedBuildId, startup: supervisor ? await supervisor.status() : { enabled: false },
      stopNotice: "Normal stop suspends idle sessions for frontend reconnect; active work refuses unless --force is intentional." })); }
    finally { view.client.close(); }
    return;
  }
  if (action === "credentials") {
    const { client, hello } = await LocalClient.open(root, channel);
    try {
      await assertManagementOwner(hello);
      if (credentialAction === "list") console.log(JSON.stringify(await client.request("credentials.list")));
      else if (credentialAction === "revoke") {
        if (!flags.has("--device")) throw new Error("Credential revocation requires --device ID");
        await client.request("credentials.revoke", { deviceId: flags.get("--device") });
        console.log("Device revoked; its connections and grants are closed. Accepted work continues.");
      } else if (credentialAction === "issue") {
        if (!flags.has("--label") || !flags.has("--output")) throw new Error("Credential issuance requires --label NAME --output PRIVATE_FILE");
        const output = resolve(flags.get("--output")!);
        await privateDirectory(dirname(output));
        const file = await open(output, "wx", 0o600);
        let issued = false;
        try {
          const result = await client.request("credentials.issue", { label: flags.get("--label") });
          await file.writeFile(JSON.stringify(result) + "\n"); await file.sync(); issued = true;
        } finally { await file.close(); if (!issued) await unlink(output); }
        console.log("Device credential saved privately. Transfer it out of band; never paste it into arguments or transcripts.");
      } else throw new Error("Usage: server credentials {issue --label NAME --output PRIVATE_FILE|list|revoke --device ID}");
    } finally { client.close(); }
    return;
  }
  if (!["create", "resume", "list"].includes(action ?? "")) throw new Error("Usage: pi-console server {run|start|status|stop|restart|enable|disable|reconcile|list|create|resume|credentials} [--channel stable|dev] [--root PATH] [--binary ABSOLUTE_PI] [--tls-config PRIVATE_FILE] [--force] [--cwd PATH|--session ID] [--id COMMAND_ID]");
  const { client, hello } = await LocalClient.open(root, channel);
  try {
    let result: unknown;
    if (action === "create" || action === "resume") result = await client.request("host.command", { id: flags.get("--id") ?? randomUUID(),
      serviceEpoch: hello.serviceEpoch, operation: `host.${action}`, payload: action === "create" ? { cwd: resolve(flags.get("--cwd") ?? process.cwd()) } : { sessionId: flags.get("--session") } });
    else {
      result = await client.request("sessions");
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
