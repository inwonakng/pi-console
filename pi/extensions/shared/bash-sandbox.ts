import { SandboxManager, getDefaultWritePaths, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { type BashOperations, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { managedBash } from "./managed-bash";
import { withRepositoryMutation, subagentProtectedRoots } from "./subagent-state";
import { childWorkspaceWriteBlock } from "./workspace-policy";
import { accessRevision, getAccessMode, getScratchDirectory, setScratchDirectory } from "./access-state";
import { loadExtensionSettings } from "./extension-settings";
import { baselineReadPaths, baselineWritePaths, canonicalPath, getGrantedScopes, hasPermission, pathInside, requestPermission, resolveToolPath, type PermissionAuthorization } from "./permissions";

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

const localBash = managedBash;
let sandboxConfig: SandboxRuntimeConfig | undefined;
let sandboxError: string | undefined;
let macosDenialMonitor = false;
let commandQueue: Promise<void> = Promise.resolve();
let commandNetworkAccess = false;
let commandUnixSocketPaths: string[] = [];

function networkConfig(): SandboxRuntimeConfig["network"] {
  return {
    allowedDomains: getGrantedScopes("network").filter((scope) => scope !== "*"),
    deniedDomains: [],
    // The runtime rejects an allowedDomains "*". Its callback checks the
    // command's upfront or session grant instead; it never prompts at runtime.
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
  const protectedRoots = subagentProtectedRoots();
  const allowWrite = [...new Set([...baselineWritePaths(cwd), ...writes].map(canonicalPath))]
    .filter((path) => !protectedRoots.some((root) => pathInside(root, path)));
  const allowRead = [...new Set([...baselineReadPaths(cwd), ...reads, ...allowWrite].map(canonicalPath))];
  return {
    denyRead: allowRead.includes("/") ? [] : ["/"],
    allowRead: allowRead.filter((path) => path !== "/"),
    allowWrite,
    // Suppress the runtime's implicit writable caches unless covered by an
    // actual write grant. These are enforcement carve-outs, not ungrantable paths.
    denyWrite: [...protectedRoots, ...getDefaultWritePaths().filter((path) => !path.startsWith("/dev/")).map(canonicalPath)
      .filter((path) => !allowWrite.some((allowed) => pathInside(allowed, path)))],
  };
}

async function collectViolations(commandId: string, filesystem: SandboxRuntimeConfig["filesystem"]): Promise<string[]> {
  // Only the optional macOS log reader needs a delivery delay. Proxy denials
  // are still collected when that reader is disabled.
  if (macosDenialMonitor) await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
  return [...new Set(SandboxManager.getSandboxViolationStore().getViolationsForCommand(commandId)
    .map((violation) => violation.line).filter((line) => {
      if (process.platform === "darwin") return /\b(?:file-(?:read|write)|network-)|^deny http-request\b/.test(line);
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
  const diagnostics = lines.slice(0, 20).join("\n");
  onData(Buffer.from(`\n[Access blocked; command may have partially executed]\n${diagnostics}\n`
    + "Files may already have been written. No automatic retry was performed. Inspect partial output and state before continuing.\n"
    + "For filesystem denials, request only the additional readPaths/writePaths that the operation needs. "
    + "For multiple files in the same task directory, request the smallest covering directory once instead of listing individual files. "
    + "Keep unrelated directories separate; use file-level requests for isolated files or when directory access would expose sensitive unrelated contents. "
    + "For a proxy network allowlist denial, request networkAccess=true on your continuation command; approval happens before it starts. "
    + "Network approval does not lift filesystem restrictions or fix DNS, TLS, or server errors. "
    + "For Unix-socket denials on macOS, request narrow unixSocketPaths (inspect $TMPDIR for temporary socket directories). "
    + "If the sandbox cannot support the operation, request unsandboxed=true for unrestricted approval: once, or for this session covering the exact command/CWD, any command from this CWD, or any command from any CWD. "
    + "Choose a continuation that does not duplicate completed work. Denied access is not task completion.\n", "utf8"));
}

async function runUnsandboxed(
  command: string,
  cwd: string,
  options: Parameters<BashOperations["exec"]>[2],
  ctx: ExtensionContext,
  onSessionGrant: () => void,
  assertAuthority: () => void,
): Promise<{ exitCode: number | null }> {
  assertAuthority();
  if (subagentProtectedRoots().length) throw new Error("Unsandboxed Bash is blocked while a child owns an unresolved contribution.");
  const authorization = await requestPermission(ctx, { kind: "unsandboxed", scope: command, cwd }, "bash",
    { text: command, filetype: "sh" }, onSessionGrant, true, { modelPreview: { text: command, filetype: "sh" } });
  await authorization.validate();
  assertAuthority();
  if (options.signal?.aborted) throw new Error("aborted");
  return withRepositoryMutation(["/"], [], () => localBash.exec(command, cwd, options));
}

async function runSandboxed(
  command: string,
  cwd: string,
  options: Parameters<BashOperations["exec"]>[2],
  ctx: ExtensionContext,
  filesystem: SandboxRuntimeConfig["filesystem"],
  networkAccess: boolean,
  unixSocketPaths: string[],
  authorizations: PermissionAuthorization[],
  assertAuthority: () => void,
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
      return await runUnsandboxed(command, cwd, options, ctx, onSessionGrant, assertAuthority);
    } finally {
      if (previousTempDir === undefined) delete process.env.CLAUDE_CODE_TMPDIR;
      else process.env.CLAUDE_CODE_TMPDIR = previousTempDir;
    }
    wrappedCommand = true;
    const env = { ...options.env,
      ...(scratch ? { TMPDIR: scratch, TMP: scratch, TEMP: scratch } : {}) };
    const report = async () => {
      // Command output can quote denial messages; only runtime diagnostics prove a block.
      const lines = await collectViolations(commandId, filesystem);
      if (lines.length) {
        reportBlockedCommand(lines, options.onData);
        onBlocked();
      }
    };
    try {
      // Preparation may await proxy/sandbox setup. Consume delegated one-use
      // authority only at the actual process boundary, never while prompting.
      assertAuthority();
      for (const authorization of authorizations) await authorization.validate();
      assertAuthority();
      if (options.signal?.aborted) throw new Error("aborted");
      const result = await withRepositoryMutation(filesystem.allowWrite, filesystem.denyWrite,
        () => localBash.exec(wrapped, cwd, { ...options, env }));
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
  const childBlock = childWorkspaceWriteBlock(ctx);
  if (childBlock) throw new Error(childBlock);
  const protectedRoots = JSON.stringify(subagentProtectedRoots());
  if (getAccessMode() === "full" && !subagentProtectedRoots().length) {
    return withRepositoryMutation(["/"], [], () => localBash.exec(command, cwd, options));
  }
  const root = canonicalPath(cwd);
  const revision = accessRevision();
  const baseline = () => JSON.stringify([baselineReadPaths(root).map(canonicalPath), baselineWritePaths(root).map(canonicalPath)]);
  const initialBaseline = baseline();
  const assertAuthority = () => {
    if (accessRevision() !== revision || baseline() !== initialBaseline || canonicalPath(cwd) !== root
      || JSON.stringify(subagentProtectedRoots()) !== protectedRoots || childWorkspaceWriteBlock(ctx)) {
      throw new Error("Command permission authority changed before execution. No command was started.");
    }
  };
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
    return runUnsandboxed(command, root, options, context, onSessionGrant, assertAuthority);
  }
  const preview = { text: command, filetype: "sh" };
  const authorizations: PermissionAuthorization[] = [];
  for (const scope of writes) {
    authorizations.push(await requestPermission(context, { kind: "write", scope }, "bash", preview, onSessionGrant, true, { modelPreview: preview }));
  }
  for (const scope of reads) {
    if (!writes.some((path) => pathInside(path, scope))) {
      authorizations.push(await requestPermission(context, { kind: "read", scope }, "bash", preview, onSessionGrant, true, { modelPreview: preview }));
    }
  }
  if (request.broadReadAccess) {
    authorizations.push(await requestPermission(context, { kind: "read", scope: "/" }, "bash", preview, onSessionGrant, false, { modelPreview: preview }));
    reads.push("/");
  }
  reads.push(...getGrantedScopes("read").filter((path) => !globShaped(path)));
  writes.push(...getGrantedScopes("write").filter((path) => !globShaped(path)));
  if (options.signal?.aborted) throw new Error("aborted");
  const filesystem = filesystemConfig(root, reads, writes);
  // The runtime's default write roots cannot be narrowed to an approved child
  // without a parent deny overriding that child. Offer the explicit fallback
  // before execution rather than silently widening or blocking the grant.
  if (filesystem.allowWrite.some((write) => filesystem.denyWrite.some((denied) => !subagentProtectedRoots().includes(denied) && pathInside(denied, write)))) {
    return runUnsandboxed(command, root, options, context, onSessionGrant, assertAuthority);
  }
  for (const scope of sockets) {
    authorizations.push(await requestPermission(context, { kind: "unix-socket", scope }, "bash", preview, onSessionGrant, true, { modelPreview: preview }));
  }
  sockets.push(...getGrantedScopes("unix-socket"));
  if (request.networkAccess) {
    authorizations.push(await requestPermission(context, { kind: "network", scope: "*" }, "bash", preview, onSessionGrant, true, { modelPreview: preview }));
  }
  if (options.signal?.aborted) throw new Error("aborted");
  const networkAccess = request.networkAccess === true || hasPermission({ kind: "network", scope: "*" }, root);
  return runSandboxed(command, root, options, context, filesystem, networkAccess,
    [...new Set(sockets)], authorizations, assertAuthority, onSessionGrant, onBlocked);
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
  const settings = loadExtensionSettings()["access-mode"];
  const prefix = resolveToolPath(settings?.["temp-dir-prefix"]
    ?? join(tmpdir(), "pi-console-sandbox-"), ctx.cwd);
  sandboxError = undefined;
  sandboxConfig = undefined;
  try {
    await shutdownBashSandbox();
    if (process.platform !== "darwin" && process.platform !== "linux") throw new Error(`unsupported platform ${process.platform}`);
    mkdirSync(dirname(prefix), { recursive: true });
    setScratchDirectory(canonicalPath(mkdtempSync(prefix)));
    sandboxConfig = { network: networkConfig(), filesystem: filesystemConfig(canonicalPath(ctx.cwd), [], []) };
    // The reader only supplies diagnostics; macOS enforces the profile without it.
    // Keep Linux monitoring unchanged and read this setting once per session.
    macosDenialMonitor = process.platform === "darwin" && settings?.["macos-denial-monitor"] === true;
    await SandboxManager.initialize(sandboxConfig, allowApprovedNetwork, process.platform !== "darwin" || macosDenialMonitor);
    if (macosDenialMonitor) await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  } catch (error) {
    sandboxError = error instanceof Error ? error.message : String(error);
    sandboxConfig = undefined;
    macosDenialMonitor = false;
    if (SandboxManager.isSandboxingEnabled()) {
      try { await SandboxManager.reset(); } catch { /* Keep the initialization error. */ }
    }
    ctx.ui.notify(`Sandbox unavailable: ${sandboxError}. Shell commands require unrestricted approval (once, or for this session covering the exact command/CWD, any command from this CWD, or any command from any CWD); readonly mode cannot grant it.`, "warning");
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
    macosDenialMonitor = false;
    commandNetworkAccess = false;
    commandUnixSocketPaths = [];
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
}
