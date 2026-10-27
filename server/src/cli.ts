import { lstat, realpath } from "node:fs/promises";
import { manageService, type ManagementAction } from "./service-management.js";
import { resolve, join, isAbsolute, basename, dirname } from "node:path";
import { listenerPort } from "./remote-transport.js";
import { randomUUID } from "node:crypto";
import { HostOwner } from "./host-owner.js";
import { privateJson } from "./catalog-storage.js";
import { object } from "./pi-records.js";
import { LocalClient } from "./local-client.js";
import { runService } from "./local-service.js";
import { applicationRoot, defaultRoot, managementIdentity, requireNode, serviceBuild } from "./service-paths.js";
import { ServiceSupervisor } from "./service-supervisor.js";
import type { Channel } from "./session-catalog.js";

process.umask(0o077);

function terminalText(text: string, style: string, stream: NodeJS.WriteStream): string {
  return stream.isTTY && process.env.TERM !== "dumb" && !process.env.NO_COLOR
    ? `\x1b[${style}m${text}\x1b[0m` : text;
}

function row(label: string, value: string, style?: string): void {
  console.log(`  ${terminalText(label.padEnd(12), "2", process.stdout)} ${style ? terminalText(value, style, process.stdout) : value}`);
}

function displayVersion(hello: Record<string, unknown>): string {
  const version = typeof hello.appRoot === "string" && basename(dirname(hello.appRoot)) === "versions"
    ? basename(hello.appRoot) : String(hello.buildId ?? "Unknown");
  return version.replace(/\b[a-f0-9]{40,64}\b/g, (hash) => hash.slice(0, 12));
}

function reportStartup(startup: Record<string, unknown>): void {
  const manager = startup.supervisor === "launchd" ? "launchd" : startup.supervisor === "user-systemd" ? "user systemd" : undefined;
  const description = startup.enabled ? `Enabled (at login${manager ? ` via ${manager}` : ""})`
    : startup.registered ? `Disabled (${startup.definitionPresent ? "registration retained" : "startup file missing"})` : "Disabled";
  row("Startup", description, startup.enabled ? "32" : "33");
}

function reportStatus(status: Record<string, unknown>, root: string): void {
  console.log(terminalText(`pi-console ${status.channel}`, "1", process.stdout));
  row("Server", status.running ? status.stopping ? "Stopping" : "Running" : status.claimPresent ? "Unreachable (owner lock remains)" : "Stopped",
    status.running && !status.stopping ? "32" : "33");
  reportStartup(object(status.startup) ? status.startup : { enabled: false });
  row("Version", displayVersion(status.running ? status : { buildId: status.selectedBuildId }));
  if (status.running && object(status.state) && Array.isArray(status.state.sessions)) {
    const sessions = status.state.sessions.filter(object);
    const live = sessions.filter((session) => object(session.live));
    row("Sessions", `${live.length} loaded, ${sessions.length - live.length} saved`);
    const activity = new Map<string, number>();
    for (const session of live) {
      const label = String((session.live as Record<string, unknown>).status ?? "Unknown");
      activity.set(label, (activity.get(label) ?? 0) + 1);
    }
    if (activity.size) row("Activity", [...activity].map(([label, count]) => `${count} ${label.toLowerCase()}`).join(", "));
  }
  if (status.running && object(status.network)) {
    console.log();
    row("URL", `http://localhost:${status.network.port}`, "36");
    if (Array.isArray(status.network.urls)) {
      for (const url of status.network.urls) if (typeof url === "string" && !/^http:\/\/(localhost|127\.[\d.]+):/.test(url)) row("Network", url, "36");
    }
    row("Listening", `${status.network.bind}:${status.network.port}`);
    row("Access", "Unauthenticated HTTP; use a trusted network", "33");
  }
  console.log();
  row("Profile", root);
  row("Log", join(root, "service.log"));
  if (object(status.startup) && typeof status.startup.definition === "string") row("Startup file", status.startup.definition);
  if (status.restartRequired) {
    console.log();
    console.log(terminalText("Selected build differs. Run server restart to apply it (active work blocks restart).", "33", process.stdout));
  }
  if (status.claimPresent) {
    console.log();
    console.log(terminalText("Inspect the service log and remaining processes before using server reconcile. No recovery was attempted.", "33", process.stdout));
  }
}

async function reportStarted(hello: Record<string, unknown>, alreadyRunning = false, startup?: Record<string, unknown>): Promise<void> {
  if (!object(hello.network) || typeof hello.network.port !== "number") throw new Error("Service did not report a listener port");
  const selectedBuildId = await serviceBuild();
  const url = `http://localhost:${listenerPort(hello.network.port)}`;
  const message = startup ? startup.enabled ? "Login startup enabled." : "Startup registration saved; login startup is not enabled."
    : alreadyRunning ? "Server is already running." : "Server started successfully.";
  console.log(terminalText(message, startup && !startup.enabled ? "33" : "32", process.stdout));
  if (startup) row("Server", alreadyRunning ? "Already running (not restarted)" : "Started", "32");
  row("Version", displayVersion(hello));
  row("URL", url, "36");
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
  let json = false;
  let startupBinary: string | undefined;
  while (args.length) {
    const key = args.shift()!;
    if (key === "--force") { force = true; continue; }
    if (key === "--json" && action === "status" && !json) { json = true; continue; }
    // Existing startup definitions pinned Pi in argv. New definitions use the
    // captured environment; retain run-only decoding so updates still boot.
    if (action === "run" && key === "--binary" && args.length && startupBinary === undefined) {
      startupBinary = args.shift(); continue;
    }
    // Old OS startup definitions can still contain this flag until re-registration.
    if (action === "run" && key === "--tls-config" && args.length) {
      args.shift(); console.error("Ignoring obsolete --tls-config; serving HTTP without credentials on the default port unless --port is set."); continue;
    }
    if (!["--channel", "--root", "--app-root", "--cwd", "--session", "--id", "--provider", "--model", "--port", "--supervisor-dir", "--path"].includes(key) || !args.length || flags.has(key)) throw new Error(`Invalid service argument: ${key}`);
    flags.set(key, args.shift()!);
  }
  const channel = flags.get("--channel") ?? process.env.PI_CONSOLE_CHANNEL ?? "stable";
  if (channel !== "stable" && channel !== "dev") throw new Error("Channel must be stable or dev");
  const root = resolve(flags.get("--root") ?? defaultRoot(channel));
  const binary = startupBinary ?? process.env.PI_BINARY;
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
  const port = listenerPort(flags.get("--port"), channel);
  if (action === "reconcile") {
    const claim = await privateJson(join(root, "owner.lock"), 16384);
    if (!object(claim)) throw new Error("Invalid recovery claim");
    await assertManagementOwner(claim);
    await HostOwner.reconcile({ root, channel });
    console.log("Reconciled known managed work. No worker started or command replayed; start the service, inspect saved data, then explicitly resume."); return;
  }
  if (action === "run") {
    await managementIdentity(options.appRoot, channel);
    if (!binary || !isAbsolute(binary)) throw new Error("Pi >=1.3.0 is required to run a local server. Install Pi and make sure pi is available on PATH.");
    await runService({ ...options, port }); return;
  }
  if (["start", "stop", "restart", "enable", "disable"].includes(action ?? "")) {
    const result = await manageService(action as ManagementAction, options, { force,
      port: flags.has("--port") ? port : undefined, supervisorDirectory: flags.get("--supervisor-dir"), path: flags.get("--path") });
    if (result.hello) await reportStarted(result.hello, result.alreadyRunning, result.startup);
    else if (result.message) console.log(terminalText(result.message, "22;32", process.stdout));
    return;
  }
  if (action === "status") {
    const supervisor = await ServiceSupervisor.load(root, channel, options.appRoot, flags.get("--supervisor-dir"));
    const selectedBuildId = await serviceBuild();
    const view = await connect();
    if (!view) {
      let claimPresent = false;
      try { await lstat(join(root, "owner.lock")); claimPresent = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const status = { running: false, channel, endpoint: join(root, "service.sock"), selectedBuildId, claimPresent, startup: supervisor ? await supervisor.status() : { enabled: false } };
      if (json) console.log(JSON.stringify(status)); else reportStatus(status, root);
      return;
    }
    try {
      const status = { ...view.hello, running: true, state: await view.client.request("sessions"), selectedBuildId,
        restartRequired: view.hello.buildId !== selectedBuildId, startup: supervisor ? await supervisor.status() : { enabled: false },
        stopNotice: "Normal stop suspends idle sessions for frontend reconnect; active work refuses unless --force is intentional." };
      if (json) console.log(JSON.stringify(status)); else reportStatus(status, root);
    }
    finally { view.client.close(); }
    return;
  }
  if (!["create", "resume", "list"].includes(action ?? "")) throw new Error("Usage: pi-console server {run|start|status|stop|restart|enable|disable|reconcile|list|create|resume} [--channel stable|dev] [--root PATH] [--port PORT] [--force] [--cwd PATH|--session ID] [--id COMMAND_ID]");
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
