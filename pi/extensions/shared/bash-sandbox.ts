import { SandboxManager, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import {
  createLocalBashOperations,
  getAgentDir,
  type BashOperations,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getAccessMode, type AccessMode } from "./access-state";
import { getInteractionMode } from "./interaction-mode";
import { notifyPiToolApproval } from "./notifications";

const localBash = createLocalBashOperations();
const sessionNetworkHosts = new Set<string>();
const sessionWriteRoots = new Set<string>();

let sandboxConfig: SandboxRuntimeConfig | undefined;
let sandboxError: string | undefined;
let sandboxTempDir: string | undefined;
let activeNetworkRequest: {
  command: string;
  cwd: string;
  ctx: ExtensionContext;
  mode: AccessMode;
  allowedHosts: Set<string>;
} | undefined;
let commandQueue: Promise<void> = Promise.resolve();
let networkPromptQueue: Promise<void> = Promise.resolve();

function approvalPayload(command: string, summary: string, mode: AccessMode, cwd: string): string {
  return JSON.stringify({
    kind: "pi_approval_preview",
    tool: "bash",
    mode,
    summary,
    request: summary,
    directory: cwd,
    preview_filetype: "sh",
    preview: command,
  });
}

function serializeCommand<T>(run: () => Promise<T>): Promise<T> {
  const current = commandQueue.then(run, run);
  commandQueue = current.then(() => undefined, () => undefined);
  return current;
}

function serializeNetworkPrompt<T>(run: () => Promise<T>): Promise<T> {
  const current = networkPromptQueue.then(run, run);
  networkPromptQueue = current.then(() => undefined, () => undefined);
  return current;
}

function canPrompt(ctx: ExtensionContext, mode: AccessMode): boolean {
  return (mode === "ask" || mode === "edit") && getInteractionMode(ctx) === "interactive";
}

async function chooseCapability(
  ctx: ExtensionContext,
  mode: AccessMode,
  command: string,
  summary: string,
  cwd: string,
): Promise<"once" | "session" | "deny"> {
  if (!canPrompt(ctx, mode)) return "deny";
  notifyPiToolApproval(ctx);
  const title = ctx.mode === "rpc"
    ? approvalPayload(command, summary, mode, cwd)
    : summary;
  const choice = await ctx.ui.select(title, ["Allow once", "Allow for session", "Deny"]);
  if (choice === "Allow once") return "once";
  if (choice === "Allow for session") return "session";
  return "deny";
}

function networkConfig(
  mode: AccessMode,
  commandHosts: Set<string> = new Set(),
): SandboxRuntimeConfig["network"] {
  const interactive = activeNetworkRequest && canPrompt(activeNetworkRequest.ctx, mode);
  return {
    allowedDomains: mode === "readonly" ? [] : [...new Set([...sessionNetworkHosts, ...commandHosts])],
    deniedDomains: [],
    strictAllowlist: mode === "readonly" || !interactive,
    allowLocalBinding: false,
  };
}

function updateNetworkConfig(
  mode: AccessMode,
  commandHosts: Set<string> = new Set(),
): void {
  if (!sandboxConfig || !SandboxManager.isSandboxingEnabled()) return;
  sandboxConfig = { ...sandboxConfig, network: networkConfig(mode, commandHosts) };
  SandboxManager.updateConfig(sandboxConfig);
}

async function approveNetwork({ host, port }: { host: string; port: number | undefined }): Promise<boolean> {
  return serializeNetworkPrompt(async () => {
    const request = activeNetworkRequest;
    if (!request || request.mode === "readonly") return false;

    const normalizedHost = host.toLowerCase();
    if (request.allowedHosts.has(normalizedHost) || sessionNetworkHosts.has(normalizedHost)) return true;

    const destination = port === undefined ? normalizedHost : `${normalizedHost}:${port}`;
    const decision = await chooseCapability(
      request.ctx,
      request.mode,
      request.command,
      `Allow network access to ${destination}?`,
      request.cwd,
    );
    if (decision === "deny") return false;
    request.allowedHosts.add(normalizedHost);
    if (decision === "session") sessionNetworkHosts.add(normalizedHost);
    updateNetworkConfig(request.mode, request.allowedHosts);
    return true;
  });
}

function credentialConfig(): NonNullable<SandboxRuntimeConfig["credentials"]> {
  const home = homedir();
  const agentDir = getAgentDir();
  const files = [
    join(agentDir, "auth.json"),
    join(agentDir, "bash-access.json"),
    join(agentDir, "history"),
    join(agentDir, "models-store.json"),
    join(agentDir, "pi-console-config.yaml"),
    join(agentDir, "sessions"),
    join(agentDir, "settings.json"),
    join(home, ".pi", "sessions"),
    join(home, ".aws"),
    join(home, ".config", "gcloud"),
    join(home, ".config", "gh"),
    join(home, ".docker", "config.json"),
    join(home, ".netrc"),
    join(home, ".npmrc"),
    join(home, ".ssh"),
  ].map((path) => ({ path, mode: "deny" as const }));
  const envVars = Object.keys(process.env)
    .filter((name) => /(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(name))
    .map((name) => ({ name, mode: "deny" as const }));
  return { files, envVars };
}

function systemReadPaths(): string[] {
  if (process.platform === "darwin") {
    return [
      "/bin",
      "/dev",
      "/Library",
      "/opt/homebrew",
      "/private/etc",
      "/private/var/db/timezone",
      "/sbin",
      "/System",
      "/usr",
    ];
  }
  return ["/bin", "/dev", "/etc", "/lib", "/lib64", "/nix/store", "/proc", "/sbin", "/usr"];
}

function filesystemConfig(cwd: string, workspaceWrite: boolean): SandboxRuntimeConfig["filesystem"] {
  return {
    denyRead: ["/"],
    allowRead: [...systemReadPaths(), cwd, ...(sandboxTempDir ? [sandboxTempDir] : [])],
    allowWrite: [
      ...(sandboxTempDir ? [sandboxTempDir] : []),
      ...(workspaceWrite ? [cwd] : []),
    ],
    denyWrite: ["/tmp/claude", "/private/tmp/claude", ...(workspaceWrite ? [] : [cwd])],
  };
}

async function waitForViolation(
  commandId: string,
  command: string,
  startedAt: Date,
  matches: (line: string) => boolean,
): Promise<boolean> {
  const store = SandboxManager.getSandboxViolationStore();
  const found = () => {
    const attributed = store.getViolationsForCommand(commandId);
    const sessionEvents = store.getViolations().filter((violation) =>
      violation.timestamp >= startedAt
      && (violation.command === command
        || violation.command === `export NO_PROXY= no_proxy=; ${command}`
        || violation.command === commandId));
    return [...attributed, ...sessionEvents].some((violation) => matches(violation.line));
  };
  if (found()) return true;
  for (let elapsed = 0; elapsed < 500; elapsed += 25) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
    if (found()) return true;
  }
  return false;
}

function waitForWriteViolation(commandId: string, command: string, startedAt: Date): Promise<boolean> {
  return waitForViolation(commandId, command, startedAt, (line) => process.platform === "linux"
    ? !line.includes("network-outbound")
    : /\bfile-write/.test(line));
}

function appendViolations(commandId: string, onData: (data: Buffer) => void): void {
  const annotation = SandboxManager.annotateStderrWithSandboxFailures(commandId, "");
  if (annotation.trim()) onData(Buffer.from(`\n${annotation.trim()}\n`, "utf8"));
}

async function runSandboxed(
  command: string,
  cwd: string,
  options: Parameters<BashOperations["exec"]>[2],
  ctx: ExtensionContext,
  mode: AccessMode,
  workspaceWrite: boolean,
  allowedHosts: Set<string>,
): Promise<{ exitCode: number | null; commandId: string; startedAt: Date; permissionDenied: boolean }> {
  if (!sandboxConfig || !SandboxManager.isSandboxingEnabled()) {
    throw new Error(`Sandbox unavailable: ${sandboxError ?? "not initialized"}. Switch to full mode to run unsandboxed.`);
  }

  const commandId = randomUUID();
  const startedAt = new Date();
  let wrappedCommand = false;
  activeNetworkRequest = { command, cwd, ctx, mode, allowedHosts };
  updateNetworkConfig(mode, allowedHosts);
  try {
    const previousTempDir = process.env.CLAUDE_CODE_TMPDIR;
    if (sandboxTempDir) process.env.CLAUDE_CODE_TMPDIR = sandboxTempDir;
    let wrapped: string;
    try {
      const proxyLocalNetwork = `export NO_PROXY= no_proxy=; ${command}`;
      wrapped = await SandboxManager.wrapWithSandbox(
        proxyLocalNetwork,
        undefined,
        { filesystem: filesystemConfig(cwd, workspaceWrite) },
        options.signal,
        { commandId, commandText: command },
      );
    } finally {
      if (previousTempDir === undefined) delete process.env.CLAUDE_CODE_TMPDIR;
      else process.env.CLAUDE_CODE_TMPDIR = previousTempDir;
    }
    wrappedCommand = true;
    const env = {
      ...options.env,
      ...(sandboxTempDir ? { TMPDIR: sandboxTempDir, TMP: sandboxTempDir, TEMP: sandboxTempDir } : {}),
    };
    // macOS does not report every default-policy write denial through its
    // asynchronous log stream. This fallback only decides whether to offer a
    // prompt; approval still retries inside the workspace-only write profile.
    let permissionDenied = false;
    const onData = (data: Buffer) => {
      if (/(?:operation not permitted|read-only file system)(?:\r?\n|$)/i.test(data.toString("utf8"))) {
        permissionDenied = true;
      }
      options.onData(data);
    };
    const result = await localBash.exec(wrapped, cwd, { ...options, env, onData });
    return { ...result, commandId, startedAt, permissionDenied };
  } finally {
    activeNetworkRequest = undefined;
    updateNetworkConfig("readonly");
    if (wrappedCommand) SandboxManager.cleanupAfterCommand();
  }
}

async function executeRestricted(
  command: string,
  cwd: string,
  options: Parameters<BashOperations["exec"]>[2],
  ctx: ExtensionContext,
): Promise<{ exitCode: number | null }> {
  const mode = getAccessMode();
  if (mode === "full") return localBash.exec(command, cwd, options);

  const canonicalCwd = resolve(cwd);
  let workspaceWrite = mode === "edit" || (mode === "ask" && sessionWriteRoots.has(canonicalCwd));
  const allowedHosts = new Set<string>();

  for (let attemptNumber = 0; attemptNumber < 2; attemptNumber++) {
    const attempt = await runSandboxed(command, canonicalCwd, options, ctx, mode, workspaceWrite, allowedHosts);
    if (attempt.exitCode === 0) return { exitCode: attempt.exitCode };

    if (mode === "ask" && !workspaceWrite
      && (attempt.permissionDenied
        || await waitForWriteViolation(attempt.commandId, command, attempt.startedAt))) {
      const decision = await chooseCapability(
        ctx,
        mode,
        command,
        `Allow workspace writes for this command in ${canonicalCwd}?`,
        canonicalCwd,
      );
      if (decision === "deny") {
        appendViolations(attempt.commandId, options.onData);
        return { exitCode: attempt.exitCode };
      }
      workspaceWrite = true;
      if (decision === "session") sessionWriteRoots.add(canonicalCwd);
      options.onData(Buffer.from("\n[Retrying with workspace write access]\n", "utf8"));
      continue;
    }

    appendViolations(attempt.commandId, options.onData);
    return { exitCode: attempt.exitCode };
  }

  throw new Error("Sandbox capability retry limit exceeded.");
}

export function createAccessControlledBashOperations(ctx: ExtensionContext): BashOperations {
  return {
    exec(command, cwd, options) {
      return serializeCommand(() => executeRestricted(command, cwd, options, ctx));
    },
  };
}

export async function initializeBashSandbox(ctx: ExtensionContext): Promise<void> {
  sessionNetworkHosts.clear();
  sessionWriteRoots.clear();
  sandboxError = undefined;
  sandboxConfig = undefined;

  try {
    if (SandboxManager.isSandboxingEnabled()) await SandboxManager.reset();
    if (sandboxTempDir && existsSync(sandboxTempDir)) rmSync(sandboxTempDir, { recursive: true, force: true });
    sandboxTempDir = undefined;
    if (process.platform !== "darwin" && process.platform !== "linux") {
      throw new Error(`unsupported platform ${process.platform}`);
    }
    sandboxTempDir = mkdtempSync(join(tmpdir(), "pi-console-sandbox-"));
    sandboxConfig = {
      network: networkConfig("readonly"),
      filesystem: filesystemConfig(resolve(ctx.cwd), false),
      credentials: credentialConfig(),
    };
    await SandboxManager.initialize(sandboxConfig, approveNetwork, true);
    if (process.platform === "darwin") {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
  } catch (error) {
    sandboxError = error instanceof Error ? error.message : String(error);
    sandboxConfig = undefined;
    if (SandboxManager.isSandboxingEnabled()) {
      try {
        await SandboxManager.reset();
      } catch {
        // The original initialization error is more useful to the user.
      }
    }
    ctx.ui.notify(`Access sandbox unavailable: ${sandboxError}. Restricted modes will fail closed.`, "error");
  }
}

export async function shutdownBashSandbox(): Promise<void> {
  await commandQueue;
  if (SandboxManager.isSandboxingEnabled()) await SandboxManager.reset();
  if (sandboxTempDir && existsSync(sandboxTempDir)) rmSync(sandboxTempDir, { recursive: true, force: true });
  sandboxTempDir = undefined;
  sandboxConfig = undefined;
  activeNetworkRequest = undefined;
}
