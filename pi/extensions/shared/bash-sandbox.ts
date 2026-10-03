import { SandboxManager, getDefaultWritePaths, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { createLocalBashOperations, type BashOperations, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAccessMode } from "./access-state";
import { baselineReadPaths, canonicalPath, getGrantedScopes, pathInside, requestPermission, resolveToolPath } from "./permissions";

export type BashAccessRequest = {
  readPaths?: string[];
  writePaths?: string[];
  broadReadAccess?: boolean;
  workspaceWriteAccess?: boolean;
  networkAccess?: boolean;
  unsandboxed?: boolean;
};

const localBash = createLocalBashOperations();
let sandboxConfig: SandboxRuntimeConfig | undefined;
let sandboxError: string | undefined;
let sandboxTempDir: string | undefined;
let commandQueue: Promise<void> = Promise.resolve();
let commandNetworkAccess = false;

function networkConfig(): SandboxRuntimeConfig["network"] {
  return {
    allowedDomains: getGrantedScopes("network"),
    deniedDomains: [],
    // The runtime rejects an allowedDomains "*". Its callback checks the
    // command's upfront grant instead; it never asks for permission at runtime.
    strictAllowlist: !commandNetworkAccess || getAccessMode() === "readonly",
    allowLocalBinding: false,
  };
}

function updateNetworkConfig(): void {
  if (!sandboxConfig || !SandboxManager.isSandboxingEnabled()) return;
  sandboxConfig = { ...sandboxConfig, network: networkConfig() };
  SandboxManager.updateConfig(sandboxConfig);
}

async function allowApprovedNetwork(): Promise<boolean> {
  return commandNetworkAccess && getAccessMode() !== "readonly";
}

function filesystemConfig(cwd: string, reads: string[], writes: string[]): SandboxRuntimeConfig["filesystem"] {
  const allowWrite = [...new Set([...(sandboxTempDir ? [sandboxTempDir] : []), ...writes])];
  return {
    denyRead: [...reads, ...writes].includes("/") ? [] : ["/"],
    allowRead: [...new Set([...baselineReadPaths(cwd).map(canonicalPath), ...(sandboxTempDir ? [sandboxTempDir] : []),
      ...reads, ...writes])].filter((path) => path !== "/"),
    allowWrite,
    // Suppress the runtime's implicit writable caches unless covered by an
    // actual write grant. These are enforcement carve-outs, not ungrantable paths.
    denyWrite: getDefaultWritePaths().filter((path) => !path.startsWith("/dev/")).map(canonicalPath)
      .filter((path) => !allowWrite.some((allowed) => pathInside(allowed, path))),
  };
}

async function collectViolations(commandId: string, filesystem: SandboxRuntimeConfig["filesystem"]): Promise<string[]> {
  // macOS diagnostics arrive asynchronously, including for commands that exit zero.
  if (process.platform === "darwin") await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
  return [...new Set(SandboxManager.getSandboxViolationStore().getViolationsForCommand(commandId)
    .map((violation) => violation.line).filter((line) => {
      if (process.platform === "darwin") return /\b(?:file-(?:read|write)|network-)/.test(line);
      // Linux's observer uses the initial profile rather than the per-command
      // grants. Do not report granted writes as denied merely from that hint.
      const attempted = /^deny \S+ (\/.*)$/.exec(line)?.[1];
      if (!attempted) return true;
      const path = canonicalPath(attempted);
      return filesystem.denyWrite.some((denied) => pathInside(denied, path))
        || !filesystem.allowWrite.some((allowed) => pathInside(allowed, path));
    }))];
}

function reportBlockedCommand(lines: string[], onData: (data: Buffer) => void): void {
  const diagnostics = lines.length ? lines.slice(0, 20).join("\n") : "Permission-denied output detected; operation and path could not be determined.";
  onData(Buffer.from(`\n[Access blocked; command may have partially executed]\n${diagnostics}\n`
    + "Files may already have been written. No automatic retry was performed. Inspect partial output and state before continuing.\n"
    + "For filesystem denials, declare readPaths/writePaths for the needed paths, or broadReadAccess=true for unknown reads. "
    + "For a proxy network allowlist denial, request networkAccess=true on your continuation command; approval happens before it starts. "
    + "Network approval does not lift filesystem restrictions or fix DNS, TLS, or server errors. "
    + "If the sandbox cannot support the operation, request unsandboxed=true for explicitly approved, unrestricted access for one command. "
    + "Choose a continuation that does not duplicate completed work. Denied access is not task completion.\n", "utf8"));
}

async function runUnsandboxed(
  command: string,
  cwd: string,
  options: Parameters<BashOperations["exec"]>[2],
  ctx: ExtensionContext,
  onSessionGrant: () => void,
): Promise<{ exitCode: number | null }> {
  await requestPermission(ctx, { kind: "unsandboxed", scope: command }, "bash",
    { text: command, filetype: "sh" }, onSessionGrant, false);
  if (options.signal?.aborted) throw new Error("aborted");
  return localBash.exec(command, cwd, options);
}

async function runSandboxed(
  command: string,
  cwd: string,
  options: Parameters<BashOperations["exec"]>[2],
  ctx: ExtensionContext,
  filesystem: SandboxRuntimeConfig["filesystem"],
  networkAccess: boolean,
  onSessionGrant: () => void,
  onBlocked: () => void,
): Promise<{ exitCode: number | null }> {
  const commandId = randomUUID();
  let wrappedCommand = false;
  commandNetworkAccess = networkAccess;
  try {
    updateNetworkConfig();
    const previousTempDir = process.env.CLAUDE_CODE_TMPDIR;
    if (sandboxTempDir) process.env.CLAUDE_CODE_TMPDIR = sandboxTempDir;
    let wrapped: string;
    try {
      wrapped = await SandboxManager.wrapWithSandbox(`export NO_PROXY= no_proxy=; ${command}`, undefined,
        { filesystem }, options.signal, { commandId, commandText: command });
    } catch (error) {
      if (options.signal?.aborted) throw new Error("aborted");
      // Preparation failed before any process was started. It is safe to offer
      // the explicit one-command fallback here, but never after partial execution.
      commandNetworkAccess = false;
      updateNetworkConfig();
      options.onData(Buffer.from(`Sandbox could not prepare this command: ${error instanceof Error ? error.message : String(error)}. No command was started.\n`));
      return await runUnsandboxed(command, cwd, options, ctx, onSessionGrant);
    } finally {
      if (previousTempDir === undefined) delete process.env.CLAUDE_CODE_TMPDIR;
      else process.env.CLAUDE_CODE_TMPDIR = previousTempDir;
    }
    wrappedCommand = true;
    const env = { ...options.env,
      ...(sandboxTempDir ? { TMPDIR: sandboxTempDir, TMP: sandboxTempDir, TEMP: sandboxTempDir } : {}) };
    let permissionDenied = false;
    let outputTail = "";
    const onData = (data: Buffer) => {
      const text = outputTail + data.toString("utf8");
      if (/operation not permitted|permission denied|read-only file system/i.test(text)) permissionDenied = true;
      outputTail = text.slice(-4096);
      options.onData(data);
    };
    const report = async () => {
      const lines = await collectViolations(commandId, filesystem);
      if (permissionDenied || lines.length) {
        reportBlockedCommand(lines, options.onData);
        onBlocked();
      }
    };
    try {
      const result = await localBash.exec(wrapped, cwd, { ...options, env, onData });
      await report();
      return result;
    } catch (error) {
      // The built-in tool retains streamed output for aborts and timeouts.
      await report();
      throw error;
    }
  } finally {
    commandNetworkAccess = false;
    try {
      updateNetworkConfig();
    } finally {
      if (wrappedCommand) SandboxManager.cleanupAfterCommand();
    }
  }
}

async function executeRestricted(
  command: string,
  cwd: string,
  options: Parameters<BashOperations["exec"]>[2],
  ctx: ExtensionContext,
  request: BashAccessRequest,
  onSessionGrant: () => void,
  onBlocked: () => void,
): Promise<{ exitCode: number | null }> {
  if (getAccessMode() === "full") return localBash.exec(command, cwd, options);
  const root = canonicalPath(cwd);
  const context = { ...ctx, cwd: root, signal: options.signal ?? ctx.signal };
  const paths = (values: string[] = []) => [...new Set(values.map((path) => canonicalPath(resolveToolPath(path, root))))];
  const reads = paths(request.readPaths);
  const writes = paths([...(request.writePaths ?? []), ...(request.workspaceWriteAccess ? [root] : [])]);
  const globShaped = (path: string) => /[*?\[\]]/.test(path);
  if (request.unsandboxed || !sandboxConfig || !SandboxManager.isSandboxingEnabled()
    || [...baselineReadPaths(root), ...reads, ...writes].some(globShaped)) {
    return runUnsandboxed(command, root, options, context, onSessionGrant);
  }
  const preview = { text: command, filetype: "sh" };
  for (const scope of writes) {
    await requestPermission(context, { kind: "write", scope }, "bash", preview, onSessionGrant);
  }
  for (const scope of reads) {
    if (!writes.some((path) => pathInside(path, scope))) {
      await requestPermission(context, { kind: "read", scope }, "bash", preview, onSessionGrant);
    }
  }
  if (request.broadReadAccess) {
    await requestPermission(context, { kind: "read", scope: "/" }, "bash", preview, onSessionGrant, false);
    reads.push("/");
  }
  reads.push(...getGrantedScopes("read").filter((path) => !globShaped(path)));
  writes.push(...getGrantedScopes("write").filter((path) => !globShaped(path)));
  if (getAccessMode() === "edit") writes.push(root);
  if (options.signal?.aborted) throw new Error("aborted");
  const filesystem = filesystemConfig(root, reads, writes);
  // The runtime's default write roots cannot be narrowed to an approved child
  // without a parent deny overriding that child. Offer the explicit fallback
  // before execution rather than silently widening or blocking the grant.
  if (writes.some((write) => filesystem.denyWrite.some((denied) => pathInside(denied, write)))) {
    return runUnsandboxed(command, root, options, context, onSessionGrant);
  }
  if (request.networkAccess) {
    await requestPermission(context, { kind: "network", scope: "*" }, "bash", preview, onSessionGrant, false);
  }
  if (options.signal?.aborted) throw new Error("aborted");
  return runSandboxed(command, root, options, context, filesystem, request.networkAccess === true, onSessionGrant, onBlocked);
}

export function createAccessControlledBashOperations(
  ctx: ExtensionContext,
  request: BashAccessRequest = {},
  onSessionGrant: () => void = () => {},
  onBlocked: () => void = () => {},
): BashOperations {
  return {
    exec(command, cwd, options) {
      const run = () => executeRestricted(command, cwd, options, ctx, request, onSessionGrant, onBlocked);
      const current = commandQueue.then(run, run);
      commandQueue = current.then(() => undefined, () => undefined);
      return current;
    },
  };
}

export async function initializeBashSandbox(ctx: ExtensionContext): Promise<void> {
  sandboxError = undefined;
  sandboxConfig = undefined;
  try {
    if (SandboxManager.isSandboxingEnabled()) await SandboxManager.reset();
    if (sandboxTempDir && existsSync(sandboxTempDir)) rmSync(sandboxTempDir, { recursive: true, force: true });
    sandboxTempDir = undefined;
    if (process.platform !== "darwin" && process.platform !== "linux") throw new Error(`unsupported platform ${process.platform}`);
    sandboxTempDir = canonicalPath(mkdtempSync(join(tmpdir(), "pi-console-sandbox-")));
    sandboxConfig = { network: networkConfig(), filesystem: filesystemConfig(canonicalPath(ctx.cwd), [], []) };
    await SandboxManager.initialize(sandboxConfig, allowApprovedNetwork, true);
    if (process.platform === "darwin") await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  } catch (error) {
    sandboxError = error instanceof Error ? error.message : String(error);
    sandboxConfig = undefined;
    if (SandboxManager.isSandboxingEnabled()) {
      try { await SandboxManager.reset(); } catch { /* Keep the initialization error. */ }
    }
    ctx.ui.notify(`Sandbox unavailable: ${sandboxError}. Shell commands require explicit one-command unrestricted approval; readonly mode cannot grant it.`, "warning");
  }
}

export async function shutdownBashSandbox(): Promise<void> {
  await commandQueue;
  if (SandboxManager.isSandboxingEnabled()) await SandboxManager.reset();
  if (sandboxTempDir && existsSync(sandboxTempDir)) rmSync(sandboxTempDir, { recursive: true, force: true });
  sandboxTempDir = undefined;
  sandboxConfig = undefined;
  commandNetworkAccess = false;
}
