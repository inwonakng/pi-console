import { SandboxManager, getDefaultWritePaths, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { createLocalBashOperations, type BashOperations, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getAccessMode, getScratchDirectory, setScratchDirectory } from "./access-state";
import { loadExtensionSettings } from "./extension-settings";
import { baselineReadPaths, baselineWritePaths, canonicalPath, getGrantedScopes, pathInside, requestPermission, resolveToolPath } from "./permissions";

export type BashAccessRequest = {
  readPaths?: string[];
  writePaths?: string[];
  broadReadAccess?: boolean;
  workspaceWriteAccess?: boolean;
  networkAccess?: boolean;
  unixSocketPaths?: string[];
  unsandboxed?: boolean;
};

// The runtime advertises localhost, but macOS Python name resolution can emit
// a sandbox denial even when the proxy connection succeeds. Use numeric IPv4
// loopback while preserving the runtime's proxy credentials and ports. Its
// wrapped command runs in Bash, so parameter substitution needs no subprocess.
const sandboxEnvironment = [
  "HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy",
  "GRPC_PROXY", "grpc_proxy", "FTP_PROXY", "ftp_proxy", "RSYNC_PROXY",
  "DOCKER_HTTP_PROXY", "DOCKER_HTTPS_PROXY", "GIT_SSH_COMMAND",
].map((name) => `export ${name}="\${${name}//localhost:/127.0.0.1:}";`).join(" ")
  + " export CLOUDSDK_PROXY_ADDRESS=127.0.0.1 NO_PROXY= no_proxy=;";

const localBash = createLocalBashOperations();
let sandboxConfig: SandboxRuntimeConfig | undefined;
let sandboxError: string | undefined;
let commandQueue: Promise<void> = Promise.resolve();
let commandNetworkAccess = false;
let commandUnixSocketPaths: string[] = [];

function networkConfig(): SandboxRuntimeConfig["network"] {
  return {
    allowedDomains: getGrantedScopes("network"),
    deniedDomains: [],
    // The runtime rejects an allowedDomains "*". Its callback checks the
    // command's upfront grant instead; it never asks for permission at runtime.
    strictAllowlist: !commandNetworkAccess || getAccessMode() === "readonly",
    allowLocalBinding: false,
    allowUnixSockets: getAccessMode() === "readonly" ? [] : commandUnixSocketPaths,
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
  const allowWrite = [...new Set([...baselineWritePaths(cwd), ...writes].map(canonicalPath))];
  const allowRead = [...new Set([...baselineReadPaths(cwd), ...reads, ...allowWrite].map(canonicalPath))];
  return {
    denyRead: allowRead.includes("/") ? [] : ["/"],
    allowRead: allowRead.filter((path) => path !== "/"),
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
    + "For filesystem denials, request only the specific readPaths/writePaths that the operation needs. "
    + "For a proxy network allowlist denial, request networkAccess=true on your continuation command; approval happens before it starts. "
    + "Network approval does not lift filesystem restrictions or fix DNS, TLS, or server errors. "
    + "For Unix-socket denials on macOS, request narrow unixSocketPaths (inspect $TMPDIR for temporary socket directories). "
    + "If the sandbox cannot support the operation, request unsandboxed=true for explicit unrestricted approval, once or for this exact command/CWD during the session. "
    + "Choose a continuation that does not duplicate completed work. Denied access is not task completion.\n", "utf8"));
}

async function runUnsandboxed(
  command: string,
  cwd: string,
  options: Parameters<BashOperations["exec"]>[2],
  ctx: ExtensionContext,
  onSessionGrant: () => void,
): Promise<{ exitCode: number | null }> {
  await requestPermission(ctx, { kind: "unsandboxed", scope: command, cwd }, "bash",
    { text: command, filetype: "sh" }, onSessionGrant);
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
  unixSocketPaths: string[],
  onSessionGrant: () => void,
  onBlocked: () => void,
): Promise<{ exitCode: number | null }> {
  const commandId = randomUUID();
  const scratch = getScratchDirectory();
  let wrappedCommand = false;
  commandNetworkAccess = networkAccess;
  commandUnixSocketPaths = unixSocketPaths;
  try {
    updateNetworkConfig();
    const previousTempDir = process.env.CLAUDE_CODE_TMPDIR;
    if (scratch) process.env.CLAUDE_CODE_TMPDIR = scratch;
    let wrapped: string;
    try {
      wrapped = await SandboxManager.wrapWithSandbox(`${sandboxEnvironment} ${command}`, undefined,
        { filesystem }, options.signal, { commandId, commandText: command });
    } catch (error) {
      if (options.signal?.aborted) throw new Error("aborted");
      // Preparation failed before any process was started. It is safe to offer
      // the explicit one-command fallback here, but never after partial execution.
      commandNetworkAccess = false;
      commandUnixSocketPaths = [];
      updateNetworkConfig();
      options.onData(Buffer.from(`Sandbox could not prepare this command: ${error instanceof Error ? error.message : String(error)}. No command was started.\n`));
      return await runUnsandboxed(command, cwd, options, ctx, onSessionGrant);
    } finally {
      if (previousTempDir === undefined) delete process.env.CLAUDE_CODE_TMPDIR;
      else process.env.CLAUDE_CODE_TMPDIR = previousTempDir;
    }
    wrappedCommand = true;
    const env = { ...options.env,
      ...(scratch ? { TMPDIR: scratch, TMP: scratch, TEMP: scratch } : {}) };
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
    commandUnixSocketPaths = [];
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
  const sockets = paths(request.unixSocketPaths);
  // Validate the configured policy before considering an unrestricted fallback.
  const baselinePaths = baselineReadPaths(root);
  const globShaped = (path: string) => /[*?\[\]]/.test(path);
  if (!request.unsandboxed && sockets.length) {
    if (process.platform !== "darwin") {
      throw new Error("Path-scoped unixSocketPaths require macOS; this sandbox runtime cannot enforce them on this platform. No command was started. Consider explicit unsandboxed approval instead.");
    }
    if (sockets.some(globShaped)) throw new Error("unixSocketPaths must be literal paths without sandbox wildcard characters. No command was started.");
  }
  if (request.unsandboxed || !sandboxConfig || !SandboxManager.isSandboxingEnabled()
    || [...baselinePaths, ...reads, ...writes].some(globShaped)) {
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
  if (options.signal?.aborted) throw new Error("aborted");
  const filesystem = filesystemConfig(root, reads, writes);
  // The runtime's default write roots cannot be narrowed to an approved child
  // without a parent deny overriding that child. Offer the explicit fallback
  // before execution rather than silently widening or blocking the grant.
  if (filesystem.allowWrite.some((write) => filesystem.denyWrite.some((denied) => pathInside(denied, write)))) {
    return runUnsandboxed(command, root, options, context, onSessionGrant);
  }
  for (const scope of sockets) {
    await requestPermission(context, { kind: "unix-socket", scope }, "bash", preview, onSessionGrant);
  }
  sockets.push(...getGrantedScopes("unix-socket"));
  if (request.networkAccess) {
    await requestPermission(context, { kind: "network", scope: "*" }, "bash", preview, onSessionGrant, false);
  }
  if (options.signal?.aborted) throw new Error("aborted");
  return runSandboxed(command, root, options, context, filesystem, request.networkAccess === true,
    [...new Set(sockets)], onSessionGrant, onBlocked);
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
  const prefix = resolveToolPath(loadExtensionSettings()["access-mode"]?.["temp-dir-prefix"]
    ?? join(tmpdir(), "pi-console-sandbox-"), ctx.cwd);
  sandboxError = undefined;
  sandboxConfig = undefined;
  try {
    await shutdownBashSandbox();
    if (process.platform !== "darwin" && process.platform !== "linux") throw new Error(`unsupported platform ${process.platform}`);
    mkdirSync(dirname(prefix), { recursive: true });
    setScratchDirectory(canonicalPath(mkdtempSync(prefix)));
    sandboxConfig = { network: networkConfig(), filesystem: filesystemConfig(canonicalPath(ctx.cwd), [], []) };
    await SandboxManager.initialize(sandboxConfig, allowApprovedNetwork, true);
    if (process.platform === "darwin") await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  } catch (error) {
    sandboxError = error instanceof Error ? error.message : String(error);
    sandboxConfig = undefined;
    if (SandboxManager.isSandboxingEnabled()) {
      try { await SandboxManager.reset(); } catch { /* Keep the initialization error. */ }
    }
    ctx.ui.notify(`Sandbox unavailable: ${sandboxError}. Shell commands require explicit unrestricted approval (once or for the exact command/CWD during this session); readonly mode cannot grant it.`, "warning");
  }
}

export async function shutdownBashSandbox(): Promise<void> {
  await commandQueue;
  try {
    if (SandboxManager.isSandboxingEnabled()) await SandboxManager.reset();
  } finally {
    const scratch = getScratchDirectory();
    setScratchDirectory(undefined);
    sandboxConfig = undefined;
    commandNetworkAccess = false;
    commandUnixSocketPaths = [];
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
}
