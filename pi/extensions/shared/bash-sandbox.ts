import { type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { type BashOperations, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createManagedBash, type ManagedBashHooks } from "./managed-bash";
import { LinuxSessionNetwork } from "../../scripts/linux-session-network.mjs";
import { shutdownBashJobs } from "./bash-jobs";
import { withRepositoryMutation, subagentProtectedRoots } from "./subagent-state";
import { childWorkspaceWriteBlock } from "./workspace-policy";
import { accessGeneration, accessRuntimeGeneration, getAccessMode, getScratchDirectory, setScratchDirectory } from "./access-state";
import { loadExtensionSettings } from "./extension-settings";
import { admitPermissionSnapshot, assertPermissionSnapshot, capturePermissionSnapshot, baselineReadPaths, baselineWritePaths, canonicalPath, getGrantedScopes, hasPermission, pathInside, requestPermission, resolveToolPath, type PermissionAuthorization, type PermissionSnapshot } from "./permissions";

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
  + (process.platform === "linux"
    ? " export CLOUDSDK_PROXY_ADDRESS=127.0.0.1 NO_PROXY=localhost,127.0.0.1,::1 no_proxy=localhost,127.0.0.1,::1;"
    : " export CLOUDSDK_PROXY_ADDRESS=127.0.0.1 NO_PROXY= no_proxy=;");

export type BashLifetime = { signal: AbortSignal; hooks: ManagedBashHooks };
type ExecutionOptions = Parameters<BashOperations["exec"]>[2] & { lifetime?: BashLifetime };
type FilesystemPolicy = Omit<SandboxRuntimeConfig["filesystem"], "denyRead" | "allowRead" | "allowWrite" | "denyWrite"> & {
  denyRead: string[]; allowRead: string[]; allowWrite: string[]; denyWrite: string[];
};
type SandboxRuntime = typeof import("@anthropic-ai/sandbox-runtime");
type ExecutionLease = { unresolved: boolean };
type BashState = {
  admission: Promise<void>;
  preparation: Promise<void>;
  leases: Set<ExecutionLease>;
  changed: Set<() => void>;
  config?: SandboxRuntimeConfig;
  runtime?: SandboxRuntime;
  macosDenialMonitor: boolean;
  network?: LinuxSessionNetwork;
};
// Cache-disabled extension entrypoints must share admission, preparation AND
// lifetime ownership. A preparation mutex is not an execution-idle barrier.
const STATE_KEY = Symbol.for("pi.agent.extensions.bash-state");
const globalObject = globalThis as typeof globalThis & { [STATE_KEY]?: BashState };
const state = globalObject[STATE_KEY] ??= {
  admission: Promise.resolve(), preparation: Promise.resolve(), leases: new Set(), changed: new Set(), macosDenialMonitor: false,
};

function manager(): SandboxRuntime["SandboxManager"] { return state.runtime!.SandboxManager; }

function enqueueAdmission<T>(operation: () => T | Promise<T>): Promise<T> {
  const current = state.admission.then(operation);
  state.admission = current.then(() => undefined, () => undefined);
  return current;
}

function withPreparation<T>(operation: () => T | Promise<T>): Promise<T> {
  const current = state.preparation.then(operation);
  state.preparation = current.then(() => undefined, () => undefined);
  return current;
}

/** Start under the preparation lock too: managedBash snapshots process.env
 * synchronously, and must not inherit another wrap's temporary environment. */
async function launchManaged(
  command: string, cwd: string, options: ExecutionOptions,
  assertAuthority: () => void,
  authorize: () => void | Promise<void> = () => {},
): Promise<{ exitCode: number | null }> {
  const { execution } = await withPreparation(async () => {
    await authorize();
    // No await may separate this final revision/path check from process start.
    assertAuthority();
    if (options.signal?.aborted) throw new Error("aborted");
    // Do not return the execution promise directly: the mutex ends at start,
    // while the execution lease and repository mutation last through cleanup.
    const executionOptions = options.lifetime ? { ...options, signal: options.lifetime.signal } : options;
    return { execution: createManagedBash(options.lifetime?.hooks).exec(command, cwd, executionOptions) };
  });
  return execution;
}

function managedUnresolved(error: unknown): boolean {
  return !!error && typeof error === "object" && "managedUnresolved" in error && error.managedUnresolved === true;
}

async function withExecutionLease<T>(operation: () => Promise<T>): Promise<T> {
  const lease = await enqueueAdmission(() => {
    const lease = { unresolved: false };
    state.leases.add(lease);
    return lease;
  });
  try { return await operation(); }
  catch (error) { lease.unresolved = managedUnresolved(error); throw error; }
  finally {
    if (!lease.unresolved) state.leases.delete(lease);
    for (const notify of state.changed) notify();
  }
}

function networkConfig(): SandboxRuntimeConfig["network"] {
  return {
    // Never put grants in shared proxy policy. Only launch registrations may
    // widen this default deny, and no runtime ask callback can widen it.
    allowedDomains: [], deniedDomains: [], strictAllowlist: false,
    allowLocalBinding: false, allowUnixSockets: [],
  };
}

function filesystemConfig(cwd: string, reads: string[], writes: string[]): FilesystemPolicy {
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
    denyWrite: [...protectedRoots, ...state.runtime!.getDefaultWritePaths().filter((path) => !path.startsWith("/dev/")).map(canonicalPath)
      .filter((path) => !allowWrite.some((allowed) => pathInside(allowed, path)))],
  };
}

async function collectViolations(violations: Set<string>, filesystem: FilesystemPolicy): Promise<string[]> {
  // Only the optional macOS log reader needs a delivery delay. Proxy denials
  // are still collected when that reader is disabled.
  if (state.macosDenialMonitor) await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
  return [...violations].filter((line) => {
    if (process.platform === "darwin") return /\b(?:file-(?:read|write)|network-)|^deny http-request\b/.test(line);
    // Linux's observer uses the initial profile rather than the per-command
    // grants. Do not report granted writes as denied merely from that hint.
    const attempted = /^deny \S+ (\/.*)$/.exec(line)?.[1];
    if (!attempted) return true;
    const path = canonicalPath(attempted);
    return filesystem.denyWrite.some((denied) => pathInside(denied, path))
      || !filesystem.allowWrite.some((allowed) => pathInside(allowed, path));
  });
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
  options: ExecutionOptions,
  ctx: ExtensionContext,
  onSessionGrant: () => void,
  assertAuthority: () => void,
  sealAuthority: () => void,
  admit: () => Promise<void>,
): Promise<{ exitCode: number | null }> {
  assertAuthority();
  if (subagentProtectedRoots().length) throw new Error("Unsandboxed Bash is blocked while a child owns an unresolved contribution.");
  const authorization = await requestPermission(ctx, { kind: "unsandboxed", scope: command, cwd }, "bash",
    { text: command, filetype: "sh" }, onSessionGrant, true, { modelPreview: { text: command, filetype: "sh" } });
  sealAuthority();
  return withRepositoryMutation(["/"], [], () => launchManaged(command, cwd, options, assertAuthority, async () => {
    await authorization.validate();
    assertAuthority();
    await admit();
  }));
}

async function runSandboxed(
  command: string,
  cwd: string,
  options: ExecutionOptions,
  ctx: ExtensionContext,
  filesystem: FilesystemPolicy,
  allowedDomains: string[],
  unixSocketPaths: string[],
  authorizations: PermissionAuthorization[],
  assertAuthority: () => void,
  sealAuthority: () => void,
  admit: () => Promise<void>,
  onSessionGrant: () => void,
  onBlocked: () => void,
): Promise<{ exitCode: number | null }> {
  const commandId = randomBytes(16).toString("base64url");
  const encodedCommand = Buffer.from(commandId).toString("base64");
  const scratch = getScratchDirectory();
  let wrappedCommand = false;
  let unresolved = false;
  let registered = false;
  const violations = new Set<string>();
  // Subscribe before wrapping: another command can evict this command's first
  // denial from the shared last-100 tail long before this execution finishes.
  const unsubscribe = manager().getSandboxViolationStore().subscribe((events) => {
    for (const event of events) if (event.encodedCommand === encodedCommand) violations.add(event.line);
  });
  const release = () => {
    unsubscribe();
    if (registered) { manager().unregisterCommandNetworkLists(commandId); registered = false; }
  };
  try {
    const prepared = await withPreparation(async () => {
      assertAuthority();
      state.network?.assertAlive();
      if (options.signal?.aborted) throw new Error("aborted");
      manager().registerCommandNetworkLists(commandId, { allowedDomains });
      registered = true;
      const previousTempDir = process.env.CLAUDE_CODE_TMPDIR;
      const previousConfig = state.config!;
      if (scratch) process.env.CLAUDE_CODE_TMPDIR = scratch;
      try {
        // macOS reads socket rules from manager state, not the per-wrap
        // override. Save/set/wrap/restore atomically with scratch env changes.
        if (process.platform === "darwin") manager().updateConfig({ ...previousConfig,
          network: { ...previousConfig.network, allowUnixSockets: [...unixSocketPaths] } });
        try {
          const config = { filesystem, ...(state.network ? { linuxSessionNetwork: state.network.namespace } : {}) };
          const wrapped = await manager().wrapWithSandbox(`${sandboxEnvironment} ${command}`, undefined,
            config, options.signal, { commandId, commandText: command });
          wrappedCommand = true;
          return { wrapped };
        } catch (error) { return { error }; }
      } finally {
        if (previousTempDir === undefined) delete process.env.CLAUDE_CODE_TMPDIR;
        else process.env.CLAUDE_CODE_TMPDIR = previousTempDir;
        if (process.platform === "darwin") manager().updateConfig(previousConfig);
      }
    });
    if ("error" in prepared) {
      release();
      assertAuthority();
      if (options.signal?.aborted) throw new Error("aborted");
      // A failed wrap unwinds its own count. No process has started; only here
      // may we offer the explicit unrestricted fallback.
      const error = prepared.error;
      options.onData(Buffer.from(`Sandbox could not prepare this command: ${error instanceof Error ? error.message : String(error)}. No command was started.\n`));
      return await runUnsandboxed(command, cwd, options, ctx, onSessionGrant, assertAuthority, sealAuthority, admit);
    }
    const wrapped = prepared.wrapped;
    const env = { ...options.env,
      ...(scratch ? { TMPDIR: scratch, TMP: scratch, TEMP: scratch } : {}) };
    const report = async () => {
      // Command output can quote denial messages; only runtime diagnostics prove a block.
      const lines = await collectViolations(violations, filesystem);
      if (lines.length) {
        reportBlockedCommand(lines, options.onData);
        onBlocked();
      }
    };
    try {
      // Preparation may await proxy/sandbox setup. Consume delegated one-use
      // authority only at the actual process boundary, never while prompting.
      const result = await launchManaged(wrapped, cwd, { ...options, env }, () => {
        assertAuthority();
        state.network?.assertAlive();
      }, async () => {
        assertAuthority();
        for (const authorization of authorizations) await authorization.validate();
        await admit();
      });
      await report();
      return result;
    } catch (error) {
      // Never let reporting mask unresolved managed ownership.
      try { await report(); } finally { throw error; }
    }
  } catch (error) {
    unresolved = managedUnresolved(error);
    throw error;
  } finally {
    // Keep registration, diagnostics, mount points and the execution lease if
    // descendant cleanup could not be proven. A reset is not reconciliation.
    if (!unresolved) {
      try { if (wrappedCommand) manager().cleanupAfterCommand(); }
      catch (error) {
        throw Object.assign(new Error(`Bash sandbox cleanup remains unresolved: ${error instanceof Error ? error.message : String(error)}`), { managedUnresolved: true });
      }
      release();
    }
  }
}

async function executeRestricted(
  command: string,
  cwd: string,
  options: ExecutionOptions,
  ctx: ExtensionContext,
  request: BashAccessRequest,
  onSessionGrant: () => void,
  onBlocked: () => void,
): Promise<{ exitCode: number | null }> {
  const childBlock = childWorkspaceWriteBlock(ctx);
  if (childBlock) throw new Error(childBlock);
  const protectedRoots = JSON.stringify(subagentProtectedRoots());
  const root = canonicalPath(cwd);
  const generation = accessGeneration();
  const runtimeGeneration = accessRuntimeGeneration();
  let snapshot: PermissionSnapshot | undefined;
  let policyPaths: string[] = [];
  let parentAdmitted = false;
  const baseline = () => JSON.stringify([baselineReadPaths(root).map(canonicalPath), baselineWritePaths(root).map(canonicalPath)]);
  const initialBaseline = baseline();
  const assertAuthority = () => {
    if ((!parentAdmitted && (accessGeneration() !== generation || baseline() !== initialBaseline))
      || accessRuntimeGeneration() !== runtimeGeneration || canonicalPath(cwd) !== root
      || policyPaths.some(path => canonicalPath(path) !== path)
      || JSON.stringify(subagentProtectedRoots()) !== protectedRoots || childWorkspaceWriteBlock(ctx)) {
      throw new Error("Command permission authority changed before execution. No command was started.");
    }
    if (snapshot && !parentAdmitted) assertPermissionSnapshot(snapshot);
  };
  const context = { ...ctx, cwd: root, signal: options.signal ?? ctx.signal };
  const sealAuthority = () => {
    // A fallback may have obtained its own new session grant. Refresh only
    // after approval; epoch/path checks still reject a changed mode/runtime.
    snapshot = undefined;
    assertAuthority();
    snapshot = capturePermissionSnapshot();
  };
  const admit = async () => {
    assertAuthority();
    parentAdmitted = await admitPermissionSnapshot(context, snapshot!);
  };
  if (getAccessMode() === "full" && !subagentProtectedRoots().length) {
    sealAuthority();
    return withRepositoryMutation(["/"], [], () => launchManaged(command, cwd, options, assertAuthority, admit));
  }
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
  if (request.unsandboxed || !state.config || !manager().isSandboxingEnabled()
    || [...baselinePaths, ...reads, ...writes].some(globShaped)) {
    return runUnsandboxed(command, root, options, context, onSessionGrant, assertAuthority, sealAuthority, admit);
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
  for (const scope of sockets) {
    authorizations.push(await requestPermission(context, { kind: "unix-socket", scope }, "bash", preview, onSessionGrant, true, { modelPreview: preview }));
  }
  if (request.networkAccess) {
    authorizations.push(await requestPermission(context, { kind: "network", scope: "*" }, "bash", preview, onSessionGrant, true, { modelPreview: preview }));
  }
  if (options.signal?.aborted) throw new Error("aborted");
  reads.push(...getGrantedScopes("read").filter((path) => !globShaped(path)));
  writes.push(...getGrantedScopes("write").filter((path) => !globShaped(path)));
  sockets.push(...getGrantedScopes("unix-socket"));
  const filesystem = filesystemConfig(root, reads, writes);
  // The runtime's implicit roots cannot be narrowed to an approved child.
  if (filesystem.allowWrite.some((write) => filesystem.denyWrite.some((denied) => !subagentProtectedRoots().includes(denied) && pathInside(denied, write)))) {
    return runUnsandboxed(command, root, options, context, onSessionGrant, assertAuthority, sealAuthority, admit);
  }
  // Copy effective authority once. Later session grants or mode changes must
  // not alter this execution's proxy registration or filesystem/socket rules.
  const allowedDomains = getAccessMode() === "readonly" ? []
    : request.networkAccess === true || hasPermission({ kind: "network", scope: "*" }, root)
      ? ["*"] : [...getGrantedScopes("network")];
  // Recheck the frozen policy's paths even after parent admission. Implicit
  // session grants have no individual authorization handle to catch retargeting.
  policyPaths = [...filesystem.allowRead, ...filesystem.allowWrite, ...filesystem.denyRead, ...filesystem.denyWrite, ...sockets];
  // All approvals precede the immutable snapshot and preparation lock. A grant
  // made by this launch does not invalidate its own approval; later changes
  // during preparation must reject/revalidate rather than widen the policy.
  sealAuthority();
  // Writer exclusion includes preparation, asynchronous diagnostics and sandbox
  // cleanup, not just process execution. Cleanup uncertainty retains this scope.
  return withRepositoryMutation(filesystem.allowWrite, filesystem.denyWrite,
    () => runSandboxed(command, root, options, context, filesystem, allowedDomains,
      [...new Set(sockets)], authorizations, assertAuthority, sealAuthority, admit, onSessionGrant, onBlocked));
}

/** Fence new admission while waiting for execution AND descendant cleanup. */
export function withBashIdle<T>(operation: () => T | Promise<T>): Promise<T> {
  return enqueueAdmission(async () => {
    while (state.leases.size) {
      if ([...state.leases].some((lease) => lease.unresolved)) {
        throw new Error("Bash managed cleanup remains unresolved; sandbox reset and host inspection are blocked.");
      }
      await new Promise<void>((resolve) => {
        const changed = () => { state.changed.delete(changed); resolve(); };
        state.changed.add(changed);
      });
    }
    return operation();
  });
}

export function createAccessControlledBashOperations(
  ctx: ExtensionContext,
  request: BashAccessRequest = {},
  onSessionGrant: () => void = () => {},
  onBlocked: () => void = () => {},
  lifetime?: BashLifetime,
): BashOperations {
  return {
    exec(command, cwd, options) {
      return withExecutionLease(() => executeRestricted(command, cwd, { ...options, lifetime }, ctx, request, onSessionGrant, onBlocked));
    },
  };
}

export async function initializeBashSandbox(ctx: ExtensionContext): Promise<void> {
  const settings = loadExtensionSettings()["access-mode"];
  const prefix = resolveToolPath(settings?.["temp-dir-prefix"]
    ?? join(tmpdir(), "pi-console-sandbox-"), ctx.cwd);
  // Let an unresolved idle barrier reject outside the fallback handler. It is
  // not safe to reset that manager, remove its scratch, or claim it unavailable.
  await withBashIdle(async () => {
    await resetIdleSandbox();
    try {
      // Check the actual Pi runtime, including custom PI_BINARY launchers.
      const [major, minor] = process.versions.node.split(".").map(Number);
      if (major < 22 || major === 22 && minor < 12) throw new Error("The Bash sandbox requires Pi to run on Node >=22.12.0 (including custom PI_BINARY launchers)");
      const { patchSandboxRuntime } = await import("../../scripts/patch-sandbox-runtime.mjs");
      patchSandboxRuntime(undefined, true);
      // Load only after the actual runtime check, so an incompatible dependency
      // cannot obscure the actionable version error with a module-load failure.
      state.runtime ??= await import("@anthropic-ai/sandbox-runtime");
      if (process.platform !== "darwin" && process.platform !== "linux") throw new Error(`unsupported platform ${process.platform}`);
      mkdirSync(dirname(prefix), { recursive: true });
      setScratchDirectory(canonicalPath(mkdtempSync(prefix)));
      state.config = { network: networkConfig(), filesystem: filesystemConfig(canonicalPath(ctx.cwd), [], []) };
      // The initial-policy filesystem monitor is diagnostic, not enforcement.
      state.macosDenialMonitor = process.platform === "darwin" && settings?.["macos-denial-monitor"] === true;
      await manager().initialize(state.config, undefined, process.platform !== "darwin" || state.macosDenialMonitor);
      if (process.platform === "linux") {
        if (!await manager().waitForNetworkInitialization()) throw new Error("Sandbox proxy initialization failed");
        try {
          state.network = await LinuxSessionNetwork.start(manager().getLinuxHttpSocketPath(), manager().getLinuxSocksSocketPath());
        } catch (error) {
          // Retain a failed-start owner too if its managed cleanup is unresolved.
          if (error instanceof Error && "network" in error && error.network instanceof LinuxSessionNetwork) state.network = error.network;
          throw error;
        }
      }
      if (state.macosDenialMonitor) await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    } catch (error) {
      const sandboxError = error instanceof Error ? error.message : String(error);
      await resetIdleSandbox();
      ctx.ui.notify(`Sandbox unavailable: ${sandboxError}. Shell commands require unrestricted approval (once, or for this session covering the exact command/CWD, any command from this CWD, or any command from any CWD); readonly mode cannot grant it.`, "warning");
    }
  });
}

/** Caller holds the true-idle barrier, never just the preparation mutex. */
async function resetIdleSandbox(): Promise<void> {
  // Workloads are already quiescent. Stop their shared bridges before resetting
  // the host-side proxy sockets; retain ownership if cleanup cannot be proved.
  await state.network?.close();
  state.network = undefined;
  if (state.runtime?.SandboxManager.isSandboxingEnabled()) await state.runtime.SandboxManager.reset();
  const scratch = getScratchDirectory();
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  setScratchDirectory(undefined);
  state.config = undefined;
  state.macosDenialMonitor = false;
}

export async function shutdownBashSandbox(): Promise<void> {
  // Final job metadata and descendant cleanup precede reset. Uncertainty retains resources.
  await shutdownBashJobs();
  await withBashIdle(resetIdleSandbox);
}
