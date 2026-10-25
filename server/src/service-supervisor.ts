import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rmdir, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { privateDirectory, privateJson, syncDirectory } from "./catalog-storage.js";
import { object } from "./pi-records.js";
import { managementIdentity, selectedApplication } from "./service-paths.js";
import type { Channel } from "./session-catalog.js";

const exec = promisify(execFile);
type Startup = { version: 1; platform: "darwin" | "linux"; root: string; channel: Channel; owner: string;
  directory: string; label: string; node: string; application: string; args: string[]; environment: Record<string, string> };
const configPath = (root: string): string => join(root, "startup.json");
const xml = (s: string): string => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
// systemd specifiers and environment expansion must remain literal, including in paths.
const unitValue = (s: string): string => '"' + s.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%") + '"';
const unitArg = (s: string): string => unitValue(s.replaceAll("$", "$$"));
function definition(config: Startup, legacyWorkingDirectory = false): string {
  const argv = ["/usr/bin/env", "-i", ...Object.entries(config.environment).map(([key, value]) => `${key}=${value}`),
    config.node, join(config.application, "server/dist/cli.js"), "run", ...config.args];
  if (config.platform === "linux") {
    // WorkingDirectory is a raw path, not a quoted command argument. The trailing
    // slash preserves literal trailing whitespace/backslashes in the INI value.
    const workingDirectory = legacyWorkingDirectory ? unitValue(homedir()) : homedir().replaceAll("%", "%%") + "/";
    return `[Unit]\nDescription=pi-console ${config.channel} (${config.root.replaceAll("%", "%%")})\n\n[Service]\nType=exec\nExecStart=${argv.map(unitArg).join(" ")}\nWorkingDirectory=${workingDirectory}\nRestart=no\nKillMode=process\nTimeoutStopSec=infinity\nUMask=0077\n\n[Install]\nWantedBy=default.target\n`;
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${xml(config.label)}</string>\n<key>ProgramArguments</key><array>${argv.map((arg) => `<string>${xml(arg)}</string>`).join("")}</array>\n<key>WorkingDirectory</key><string>${xml(homedir())}</string>\n<key>RunAtLoad</key><true/>\n<key>KeepAlive</key><false/>\n<key>StandardOutPath</key><string>${xml(join(config.root, "service.log"))}</string>\n<key>StandardErrorPath</key><string>${xml(join(config.root, "service.log"))}</string>\n</dict></plist>\n`;
}
const definitionPath = (config: Startup): string => join(config.directory, config.label + (config.platform === "darwin" ? ".plist" : ".service"));
const domain = (): string => `gui/${process.getuid!()}`;
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === "ENOENT";

// Management holds the profile lock. Publish complete files only; a temporary
// file left by interruption is never a registration or a startup definition.
async function publish(path: string, text: string, replace = false): Promise<void> {
  const temporary = join(dirname(path), `.pi-console-startup-${randomUUID()}.tmp`);
  try {
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
    if (!replace) {
      try { await lstat(path); throw new Error(`Startup path already exists; refusing to replace: ${path}`); }
      catch (error) { if (!missing(error)) throw error; }
    }
    await rename(temporary, path);
    await syncDirectory(dirname(path));
  } finally {
    try { await unlink(temporary); } catch (error) { if (!missing(error)) throw error; }
  }
}

/** Serializes local management, not execution. A stale lock is never auto-removed. */
export async function managementLock(root: string): Promise<() => Promise<void>> {
  await privateDirectory(root);
  const path = join(root, "management.lock");
  for (let attempt = 0; ; attempt++) {
    try { await mkdir(path, { mode: 0o700 }); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (attempt >= 600) throw new Error(`Management is busy or its lock is stale: ${path}. Remove only after confirming no management command is running.`);
      await new Promise((done) => setTimeout(done, 100));
    }
  }
  return () => rmdir(path);
}

export class ServiceSupervisor {
  private constructor(readonly config: Startup) {}
  static async load(root: string, channel: Channel, appRoot: string, directory?: string): Promise<ServiceSupervisor | undefined> {
    let value: unknown;
    try { value = await privateJson(configPath(root), 64 * 1024); }
    catch (error) { if (missing(error)) return; throw error; }
    if (!object(value) || value.version !== 1 || value.root !== root || value.channel !== channel
      || !["darwin", "linux"].includes(String(value.platform)) || typeof value.owner !== "string"
      || typeof value.directory !== "string" || typeof value.label !== "string" || typeof value.node !== "string"
      || typeof value.application !== "string" || !Array.isArray(value.args) || !value.args.every((arg) => typeof arg === "string")
      || !object(value.environment) || !Object.values(value.environment).every((v) => typeof v === "string")) throw new Error("Invalid startup registration; leaving it untouched");
    if (value.owner !== await managementIdentity(appRoot, channel)) throw new Error("Startup registration belongs to another installation/checkout; refusing management");
    if (value.platform !== process.platform || directory && resolve(directory) !== value.directory) throw new Error("Startup registration platform/directory differs; refusing management");
    const supervisor = new ServiceSupervisor(value as Startup);
    await supervisor.assertDefinition(true);
    return supervisor;
  }
  static async create(options: { root: string; channel: Channel; appRoot: string; binary: string; directory?: string; path?: string; extraArgs: string[] }): Promise<ServiceSupervisor> {
    if (process.platform !== "darwin" && process.platform !== "linux") throw new Error("Startup supports macOS launchd and Linux user-systemd only");
    const application = await selectedApplication(options.appRoot);
    const directory = resolve(options.directory ?? (process.platform === "darwin" ? join(homedir(), "Library/LaunchAgents") : join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "systemd/user")));
    for (const value of [options.root, directory, application, options.binary, ...options.extraArgs]) {
      if (/[\0\r\n]/.test(value)) throw new Error("Supervisor paths/options must not contain NUL/newline characters");
    }
    const label = `dev.pi-console.${options.channel}.${createHash("sha256").update(options.root).digest("hex").slice(0, 16)}`;
    const environment: Record<string, string> = { HOME: homedir(), PATH: options.path ?? process.env.PATH ?? "/usr/bin:/bin", PI_BINARY: await realpath(options.binary) };
    for (const key of ["USER", "LOGNAME", "LANG", "LC_ALL", "TMPDIR", "XDG_CONFIG_HOME", "PI_CODING_AGENT_DIR"]) if (process.env[key]) environment[key] = process.env[key]!;
    if (Object.values(environment).some((v) => /[\0\r\n]/.test(v))) throw new Error("Service environment must not contain NUL/newline characters");
    const supervisor = new ServiceSupervisor({ version: 1, platform: process.platform, root: options.root, channel: options.channel,
      owner: await managementIdentity(options.appRoot, options.channel), directory, label, node: await realpath(process.execPath), application,
      args: ["--channel", options.channel, "--root", options.root, ...options.extraArgs], environment });
    await mkdir(directory, { recursive: true });
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.uid !== process.getuid?.() || stat.mode & 0o022) throw new Error("Supervisor directory must be owned by this user and not writable by others");
    // Refuse unrelated definitions before recording intent. Registration must be
    // durable first, so every published definition has an owned recovery record.
    try { await lstat(definitionPath(supervisor.config)); throw new Error("Supervisor definition already exists; refusing adoption"); }
    catch (error) { if (!missing(error)) throw error; }
    await publish(configPath(options.root), JSON.stringify(supervisor.config) + "\n");
    await supervisor.ensureDefinition();
    return supervisor;
  }
  private async ensureDefinition(): Promise<void> {
    if (!await this.assertDefinition(true)) await publish(definitionPath(this.config), definition(this.config));
  }
  /** Call with the management lock held, after verifying the loaded definition. */
  async repairDefinition(): Promise<void> {
    if (await this.assertDefinition(true) !== "legacy") return;
    await publish(definitionPath(this.config), definition(this.config), true);
    await exec("systemctl", ["--user", "daemon-reload"]);
  }
  private async assertDefinition(allowMissing = false): Promise<"current" | "legacy" | undefined> {
    const path = definitionPath(this.config);
    let file;
    try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if (allowMissing && missing(error)) return; throw error; }
    try {
      const stat = await file.stat();
      if (stat.isFile() && stat.nlink === 1 && stat.uid === process.getuid?.() && !(stat.mode & 0o022)) {
        const text = await file.readFile("utf8");
        if (text === definition(this.config)) return "current";
        // Accept only the exact previous renderer, never arbitrary unit edits.
        if (this.config.platform === "linux" && text === definition(this.config, true)) return "legacy";
      }
      throw new Error(`Supervisor definition was changed or is unowned; refusing: ${path}`);
    } finally { await file.close(); }
  }
  private async canonicalDefinition(path = definitionPath(this.config)): Promise<string> {
    try { return await realpath(path); }
    catch (error) {
      if (!missing(error)) throw error;
      // A completed disable or interrupted setup can leave only registration.
      return join(await realpath(dirname(path)), basename(path));
    }
  }
  async loaded(): Promise<boolean> {
    const { config } = this;
    if (config.platform === "darwin") {
      let stdout: string;
      try { ({ stdout } = await exec("launchctl", ["print", `${domain()}/${config.label}`])); }
      catch (error) {
        if (/Could not find service|service not found/i.test(String((error as { stderr?: string }).stderr))) return false;
        throw error;
      }
      const loadedPath = stdout.split("\n").map((line) => line.trim()).find((line) => line.startsWith("path = "))?.slice(7);
      if (!loadedPath || await this.canonicalDefinition(loadedPath) !== await this.canonicalDefinition()) throw new Error("Loaded launchd label belongs to another definition; refusing management");
      return true;
    }
    const { stdout } = await exec("systemctl", ["--user", "show", `${config.label}.service`, "--property=FragmentPath", "--value"]);
    if (!stdout.trim()) return false;
    if (await this.canonicalDefinition(stdout.trim()) !== await this.canonicalDefinition()) throw new Error("Loaded systemd unit belongs to another definition; refusing management");
    return true;
  }
  private async running(): Promise<boolean> {
    if (!await this.loaded()) return false;
    const { stdout } = this.config.platform === "darwin"
      ? await exec("launchctl", ["print", `${domain()}/${this.config.label}`])
      : await exec("systemctl", ["--user", "show", `${this.config.label}.service`, "--property=ActiveState", "--value"]);
    return this.config.platform === "darwin" ? /^\s*pid = \d+/m.test(stdout) : !["inactive", "failed"].includes(stdout.trim());
  }
  async assertStopped(): Promise<void> {
    if (await this.running()) throw new Error("Supervisor startup/shutdown is in progress without a reachable service; wait and retry explicitly. No service was interrupted.");
  }
  async waitStopped(): Promise<void> {
    for (let attempt = 0; attempt < 600; attempt++) {
      if (!await this.running()) return;
      await new Promise((done) => setTimeout(done, 100));
    }
    throw new Error("Supervisor still tracks the departing service process; refusing teardown/replacement");
  }
  /** Change listener arguments only after guarded shutdown, preserving the captured environment. */
  async configurePort(port?: number): Promise<void> {
    const args = this.config.args.filter((arg, index, all) => arg !== "--tls-config" && all[index - 1] !== "--tls-config"
      && (port === undefined || arg !== "--port" && all[index - 1] !== "--port"));
    if (port !== undefined) args.push("--port", String(port));
    if (JSON.stringify(args) === JSON.stringify(this.config.args)) return;
    const enabled = (await this.status()).enabled;
    await this.disable();
    this.config.args = args;
    await publish(configPath(this.config.root), JSON.stringify(this.config) + "\n");
    await this.ensureDefinition();
    if (enabled) await this.enable(false);
  }
  async start(): Promise<void> {
    await this.ensureDefinition();
    const { config } = this;
    if (config.platform === "darwin") {
      if (!await this.loaded()) await exec("launchctl", ["bootstrap", domain(), definitionPath(config)]);
      else await exec("launchctl", ["kickstart", `${domain()}/${config.label}`]); // no -k: never kill a running owner
    } else {
      await this.loaded();
      await exec("systemctl", ["--user", "link", definitionPath(config)]);
      await exec("systemctl", ["--user", "daemon-reload"]);
      await exec("systemctl", ["--user", "start", `${config.label}.service`]);
    }
  }
  async enable(start: boolean): Promise<void> {
    await this.ensureDefinition();
    await this.loaded();
    if (this.config.platform === "linux") {
      await exec("systemctl", ["--user", "enable", definitionPath(this.config)]);
      await exec("systemctl", ["--user", "daemon-reload"]);
    }
    // A live detached owner needs only future-login registration. Do not launch
    // a candidate which might outlive it and acquire its released claim later.
    if (start) await this.start();
  }
  /** Call only after guarded IPC shutdown and endpoint closure. Never use supervisor stop as a preflight. */
  async disable(): Promise<void> {
    await this.assertDefinition(true);
    await this.assertStopped();
    const { config } = this;
    if (config.platform === "darwin") {
      if (await this.loaded()) await exec("launchctl", ["bootout", `${domain()}/${config.label}`]);
    } else {
      await this.loaded();
      try { await exec("systemctl", ["--user", "disable", `${config.label}.service`]); }
      catch (error) {
        if (!/Failed to disable unit: Unit .* does not exist\./.test(String((error as { stderr?: string }).stderr))) throw error;
      }
    }
    if (await this.assertDefinition(true)) {
      await unlink(definitionPath(config));
      await syncDirectory(config.directory);
    }
    if (config.platform === "linux") await exec("systemctl", ["--user", "daemon-reload"]);
    await unlink(configPath(config.root));
    await syncDirectory(config.root);
  }
  async status(): Promise<Record<string, unknown>> {
    const definitionPresent = !!await this.assertDefinition(true);
    const loaded = await this.loaded();
    let enabled = definitionPresent && this.config.platform === "darwin" && (loaded || this.config.directory === join(homedir(), "Library/LaunchAgents"));
    if (definitionPresent && this.config.platform === "linux") {
      let output: string;
      try { output = (await exec("systemctl", ["--user", "is-enabled", `${this.config.label}.service`])).stdout.trim(); }
      catch (error) {
        output = String((error as { stdout?: string }).stdout ?? "").trim();
        if (!["disabled", "linked", "linked-runtime", "static", "indirect", "not-found", "masked", "masked-runtime"].includes(output)) throw error;
      }
      enabled = definitionPresent && ["enabled", "enabled-runtime"].includes(output);
    }
    return { registered: true, enabled, loaded, definitionPresent, supervisor: this.config.platform === "darwin" ? "launchd" : "user-systemd", definition: definitionPath(this.config), application: this.config.application };
  }
}
