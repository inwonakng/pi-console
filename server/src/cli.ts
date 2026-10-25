import { spawn } from "node:child_process";
import { checkPi } from "../../pi/scripts/check-pi.mjs";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { resolve, join, isAbsolute, basename, dirname } from "node:path";
import { listenerPort } from "./remote-transport.js";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { HostOwner } from "./host-owner.js";
import { privateJson } from "./catalog-storage.js";
import { object } from "./pi-records.js";
import { LocalClient } from "./local-client.js";
import { runService } from "./local-service.js";
import { applicationRoot, defaultRoot, managementIdentity, requireNode, serviceBuild } from "./service-paths.js";
import { managementLock, ServiceSupervisor } from "./service-supervisor.js";
import type { Channel } from "./session-catalog.js";

process.umask(0o077);

function terminalText(text: string, style: string, stream: NodeJS.WriteStream): string {
  return stream.isTTY && process.env.TERM !== "dumb" && !process.env.NO_COLOR
    ? `\x1b[${style}m${text}\x1b[0m` : text;
}

async function reportStarted(hello: Record<string, unknown>, alreadyRunning = false): Promise<void> {
  if (!object(hello.network) || typeof hello.network.port !== "number") throw new Error("Service did not report a listener port");
  const selectedBuildId = await serviceBuild();
  const url = `http://localhost:${listenerPort(hello.network.port)}`;
  const version = typeof hello.appRoot === "string" && basename(dirname(hello.appRoot)) === "versions"
    ? basename(hello.appRoot) : String(hello.buildId);
  const message = alreadyRunning ? "Server is already running." : "Server started successfully.";
  const styledVersion = version.replace(/\b[a-f0-9]{40,64}\b/, (hash) => terminalText(hash, "1", process.stdout));
  console.log(terminalText(message, "32", process.stdout));
  console.log(`  Version: ${styledVersion}`);
  console.log(`  URL:     ${terminalText(url, "36", process.stdout)}`);
  if (hello.buildId !== selectedBuildId) {
    console.error(terminalText("Warning: running build differs from the selected build. Use server restart to apply it.", "33", process.stderr));
  }
}

async function main(): Promise<void> {
  requireNode();
  const args = process.argv.slice(2);
  const action = args.shift();
  const flags = new Map<string, string>();
  let force = false;
  while (args.length) {
    const key = args.shift()!;
    if (key === "--force") { force = true; continue; }
    // Old OS startup definitions can still contain this flag until re-registration.
    if (action === "run" && key === "--tls-config" && args.length) {
      args.shift(); console.error("Ignoring obsolete --tls-config; serving HTTP without credentials on the default port unless --port is set."); continue;
    }
    if (!["--channel", "--root", "--binary", "--app-root", "--cwd", "--session", "--id", "--provider", "--model", "--port", "--supervisor-dir", "--path"].includes(key) || !args.length || flags.has(key)) throw new Error(`Invalid service argument: ${key}`);
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
    throw new Error("Service lock remains without a reachable service. Inspect startup/cleanup and explicitly reconcile if appropriate; no supervisor teardown or automatic recovery occurred.");
  };
  const privateLog = async () => {
    const file = await open(join(root, "service.log"), constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || stat.mode & 0o077) {
      await file.close(); throw new Error("service.log must be a private same-user regular file (0600)");
    }
    return file;
  };
  const port = listenerPort(flags.get("--port"));
  const extraArgs: string[] = [];
  if (flags.has("--port")) extraArgs.push("--port", String(port));
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
    if (!binary || !isAbsolute(binary)) throw new Error("Pi >=1.3.0 is required to run a local server. Install Pi and provide an absolute --binary path (or PI_BINARY).");
    await runService({ ...options, port }); return;
  }
  if (["start", "stop", "restart", "enable", "disable"].includes(action ?? "")) {
    await managementIdentity(options.appRoot, channel);
    const unlock = await managementLock(root);
    try {
      let supervisor = await ServiceSupervisor.load(root, channel, options.appRoot, flags.get("--supervisor-dir"));
      if (supervisor) await supervisor.loaded();
      const existing = await connect();
      let startupExit: string | undefined;
      if (existing) {
        try {
          await assertManagementOwner(existing.hello);
          if (existing.hello.stopping) throw new Error("Service is stopping; wait for closure and retry explicitly");
          if (action === "restart" && !supervisor && !flags.has("--port") && object(existing.hello.network)
            && typeof existing.hello.network.port === "number") extraArgs.push("--port", String(listenerPort(existing.hello.network.port)));
        }
        catch (error) { existing.client.close(); throw error; }
      }
      // Check start configuration before stopping a healthy owner.
      if ((action === "enable" || action === "restart" || action === "start" && !existing) && !supervisor) {
        try {
          if (!binary || !isAbsolute(binary)) throw new Error("Pi >=1.3.0 is required to start a local server. Install Pi and provide an absolute --binary path (or PI_BINARY).");
          checkPi(binary);
        } catch (error) { existing?.client.close(); throw error; }
      }
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
        if (!existing) await supervisor!.configurePort(flags.has("--port") ? port : undefined);
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
            if (view.hello.serviceEpoch !== existing.hello.serviceEpoch) throw new Error("Service instance changed during shutdown; refusing further management");
            await delay(100);
          }
          if (!closed) throw new Error("Old service endpoint remains; refusing supervisor teardown/replacement");
          await supervisor?.waitStopped();
        } else await supervisor?.assertStopped();
        await requireNoClaim();
        if (action === "disable") await supervisor?.disable();
        if (action !== "restart") {
          const message = action === "disable" ? "Server shut down successfully; startup disabled."
            : existing ? "Server shut down successfully." : "Server is already stopped.";
          console.log(terminalText(message, "32", process.stdout)); return;
        }
      } else if (existing) {
        existing.client.close();
        await reportStarted(existing.hello, true); return;
      }
      if (action !== "enable") {
        await requireNoClaim();
        if (supervisor) {
          await (await privateLog()).close();
          await supervisor.configurePort(flags.has("--port") ? port : undefined);
          await supervisor.start();
        }
        else {
          const log = await privateLog();
          try {
            const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "run", "--channel", channel, "--root", root, "--binary", binary!, "--app-root", options.appRoot, ...extraArgs],
              { detached: true, cwd: options.appRoot, stdio: ["ignore", log.fd, log.fd], env: process.env });
            child.once("exit", (code, signal) => { startupExit = `code ${code}, signal ${signal}`; });
            await new Promise<void>((done, fail) => { child.once("spawn", done); child.once("error", fail); });
            child.unref();
          } finally { await log.close(); }
        }
      }
      for (let n = 0; n < 600; n++) {
        if (startupExit) throw new Error(`Service exited during startup (${startupExit}); inspect ${join(root, "service.log")}`);
        const view = await connect(true);
        if (view) {
          view.client.close(); await assertManagementOwner(view.hello);
          if (view.hello.stopping) throw new Error("Discovered service is stopping; no replacement started");
          await reportStarted(view.hello, action === "enable" && !!existing); return;
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
  if (!["create", "resume", "list"].includes(action ?? "")) throw new Error("Usage: pi-console server {run|start|status|stop|restart|enable|disable|reconcile|list|create|resume} [--channel stable|dev] [--root PATH] [--binary ABSOLUTE_PI] [--port PORT] [--force] [--cwd PATH|--session ID] [--id COMMAND_ID]");
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
