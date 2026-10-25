import { serviceUi } from "./service-ui";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { PERMISSION_HISTORY, permissionSnapshot } from "../../scripts/permission-history.mjs";
import { existsSync, lstatSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pathInside, resolveToolPath } from "./paths";
export { pathInside, resolveToolPath } from "./paths";
import { accessRevision, getAccessMode, getScratchDirectory, invalidateAccessAuthority, onAccessInvalidated } from "./access-state";
import { loadExtensionSettings } from "./extension-settings";
import { getInteractionMode } from "./interaction-mode";
import { notifyPiToolApproval } from "./notifications";

export type Permission = {
  kind: "read" | "write" | "network" | "tool" | "unix-socket";
  scope: string;
} | {
  kind: "unsandboxed";
  scope: string;
  cwd: string;
  // Individual requests and exact-command grants default to command matching.
  scopeType?: "command" | "directory" | "session";
};

export type PermissionPreview = { text: string; filetype: string };

export type PermissionAuthorization = { validate: () => Promise<void> };

export function permissionWasDenied(error: unknown): boolean {
  return !!error && typeof error === "object" && "permissionDecision" in error && error.permissionDecision === "denied";
}
export type PermissionAttempt = {
  permission: Permission;
  tool: string;
  preview: PermissionPreview;
  cwd: string;
  remember: boolean;
};
type PermissionRouter = (ctx: ExtensionContext, attempt: PermissionAttempt) => Promise<PermissionAuthorization>;

type Decision = "allowed" | "denied" | "cancelled";
type HistoryRuntime = {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  pending: Set<(reason: string) => void>;
};
const key = Symbol.for("pi-console.permissions");
type PermissionState = {
  grants: Permission[];
  queue: Promise<void>;
  lifetime: AbortController;
  history?: HistoryRuntime;
  router?: PermissionRouter;
  invalidationRegistered?: boolean;
};
const globals = globalThis as typeof globalThis & { [key]?: PermissionState };
const state = globals[key] ??= { grants: [], queue: Promise.resolve(), lifetime: new AbortController() };
const sessionGrants = state.grants;
// Register once even when Pi evaluates imports under separate extension roots.
if (!state.invalidationRegistered) {
  state.invalidationRegistered = true;
  onAccessInvalidated(() => { state.lifetime.abort(); state.lifetime = new AbortController(); });
}

export function registerPermissionRouter(router: PermissionRouter): void { state.router = router; }

export function validPermissionAttempt(value: unknown): value is PermissionAttempt {
  if (!value || typeof value !== "object") return false;
  const attempt = value as PermissionAttempt;
  if (typeof attempt.cwd !== "string" || canonicalPath(attempt.cwd) !== attempt.cwd
    || typeof attempt.tool !== "string" || !attempt.tool || typeof attempt.remember !== "boolean"
    || !attempt.preview || typeof attempt.preview.text !== "string" || typeof attempt.preview.filetype !== "string") return false;
  const permission = attempt.permission;
  if (!permission || typeof permission.scope !== "string" || !permission.scope) return false;
  switch (permission.kind) {
    case "read": case "write": case "unix-socket": return canonicalPath(permission.scope) === permission.scope;
    case "unsandboxed": return permission.cwd === attempt.cwd && (permission.scopeType === undefined || permission.scopeType === "command");
    case "network": case "tool": return true;
    default: return false;
  }
}

/** Audit entries are non-context data, never a source of permission grants. */
export function registerPermissionHistory(pi: ExtensionAPI): void {
  const close = () => {
    invalidateAccessAuthority();
    for (const cancel of state.history?.pending ?? []) cancel("Session runtime ended.");
    state.history = undefined;
  };
  const restore = (_event: unknown, ctx: ExtensionContext) => {
    close();
    state.history = { pi, ctx, pending: new Set() };
    const pending = new Set<string>();
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== PERMISSION_HISTORY) continue;
      const data = entry.data as { version?: unknown; id?: unknown; state?: unknown } | undefined;
      if (data?.version !== 1 || typeof data.id !== "string") continue;
      if (data.state === "pending") pending.add(data.id);
      else pending.delete(data.id);
    }
    for (const id of pending) pi.appendEntry(PERMISSION_HISTORY, {
      version: 1, id, state: "cancelled", answeredAt: new Date().toISOString(),
      reason: "Session resumed without a recorded permission decision.",
    });
    if (ctx.mode === "rpc") ctx.ui.setStatus(PERMISSION_HISTORY, JSON.stringify(permissionSnapshot(ctx.sessionManager.getBranch())));
  };
  pi.on("session_start", restore);
  pi.on("session_tree", restore);
  pi.on("session_shutdown", close);
}

function recordPermission(ctx: ExtensionContext, request: Record<string, unknown>): (state: Decision, choice?: string, reason?: string) => void {
  const runtime = state.history;
  if (!runtime || runtime.ctx.sessionManager !== ctx.sessionManager) return () => {};
  const id = randomUUID();
  let finished = false;
  const current = () => runtime === state.history;
  const finish = (state: Decision, choice?: string, reason?: string) => {
    if (finished) return;
    finished = true;
    runtime.pending.delete(cancel);
    // A branch replacement must not append an old answer to the new branch.
    if (!current() || !ctx.sessionManager.getBranch().some(entry => entry.type === "custom"
      && entry.customType === PERMISSION_HISTORY && (entry.data as { id?: unknown })?.id === id)) return;
    runtime.pi.appendEntry(PERMISSION_HISTORY, { version: 1, id, state, choice, reason, answeredAt: new Date().toISOString() });
  };
  const cancel = (reason: string) => finish("cancelled", undefined, reason);
  if (current()) {
    runtime.pi.appendEntry(PERMISSION_HISTORY, {
      ...request, version: 1, id, state: "pending", requestedAt: new Date().toISOString(),
    });
    runtime.pending.add(cancel);
  }
  return finish;
}

export function canonicalPath(path: string): string {
  const resolveLinks = (candidate: string, remainingLinks: number): string => {
    let current = resolve(candidate);
    const suffix: string[] = [];
    while (!existsSync(current)) {
      // existsSync follows symlinks: a dangling link must not be mistaken for
      // a new file inside the workspace when its target is actually outside.
      try {
        if (lstatSync(current).isSymbolicLink()) {
          if (remainingLinks === 0) throw new Error(`Too many symlinks while resolving ${path}`);
          return resolveLinks(resolve(dirname(current), readlinkSync(current), ...suffix), remainingLinks - 1);
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      }
      const parent = dirname(current);
      if (parent === current) throw new Error(`Cannot resolve path: ${path}`);
      suffix.unshift(basename(current));
      current = parent;
    }
    return resolve(realpathSync.native(current), ...suffix);
  };
  return resolveLinks(path, 40);
}

export function baselineReadPaths(cwd: string): string[] {
  const agentDir = getAgentDir();
  const system = process.platform === "darwin"
    ? ["/bin", "/dev", "/etc", "/Library", "/private/etc", "/private/var/db/timezone", "/sbin", "/System", "/usr"]
    : ["/bin", "/dev", "/etc", "/lib", "/lib64", "/nix/store", "/proc", "/sbin", "/usr"];
  return [cwd, ...system, "/opt", "/usr/lib/node_modules", "/usr/local/lib/node_modules",
    join(agentDir, "AGENTS.md"), join(agentDir, "agents"), join(agentDir, "prompts"), join(agentDir, "skills"),
    ...(loadExtensionSettings()["access-mode"]?.["read-paths"] ?? ["/"]).map((path) => resolveToolPath(path, cwd)),
    ...baselineWritePaths(cwd)];
}

export function baselineWritePaths(cwd: string): string[] {
  const configured = loadExtensionSettings()["access-mode"]?.["write-paths"] ?? ["/tmp"];
  const scratch = getScratchDirectory();
  if (scratch && canonicalPath(scratch) !== scratch) {
    throw new Error("Scratch directory no longer resolves to its generated path; start a new Pi session.");
  }
  return [
    ...(scratch ? [scratch] : []),
    ...(getAccessMode() === "readonly" ? [] : configured.map((path) => resolveToolPath(path, cwd))),
    ...(getAccessMode() === "edit" ? [cwd] : []),
  ];
}

export function getSessionGrants(): Permission[] {
  return sessionGrants.map((grant) => ({ ...grant }));
}

export function getGrantedScopes(kind: "read" | "write" | "network" | "unix-socket"): string[] {
  if (getAccessMode() === "readonly") return [];
  return sessionGrants.filter((grant) => grant.kind === kind || (kind === "read" && grant.kind === "write"))
    .filter((grant) => grant.kind === "network" || canonicalPath(grant.scope) === grant.scope)
    .map((grant) => grant.scope);
}

export function restorePermissionGrants(values: unknown): void {
  invalidateAccessAuthority();
  sessionGrants.length = 0;
  if (!Array.isArray(values)) return;
  for (const value of values) {
    if (typeof value !== "object" || value === null) continue;
    const { kind, scope } = value as Record<string, unknown>;
    if (typeof scope !== "string" || !scope) continue;
    if ((kind === "read" || kind === "write") && scope.startsWith("/")) {
      sessionGrants.push({ kind, scope: resolve(scope) });
    } else if (kind === "network" || kind === "tool") {
      sessionGrants.push({ kind, scope });
    }
    // Unsandboxed and Unix-socket grants live only in this process/session.
    // Never restore them from session history, including after a branch change.
  }
}

export function hasPermission(permission: Permission, cwd: string): boolean {
  const mode = getAccessMode();
  if (mode === "full") return true;
  const { kind } = permission;
  const scope = kind === "read" || kind === "write" || kind === "unix-socket"
    ? canonicalPath(permission.scope) : permission.scope;
  if (kind === "read" && baselineReadPaths(cwd).some((path) => pathInside(canonicalPath(path), scope))) return true;
  if (kind === "write" && baselineWritePaths(cwd).some((path) => pathInside(canonicalPath(path), scope))) return true;
  if (mode === "readonly") return false;
  return sessionGrants.some((grant) => {
    if (grant.kind !== kind && !(kind === "read" && grant.kind === "write")) return false;
    if (kind === "read" || kind === "write") return canonicalPath(grant.scope) === grant.scope && pathInside(grant.scope, scope);
    if (kind === "unix-socket") return canonicalPath(grant.scope) === grant.scope && pathInside(grant.scope, scope);
    if (permission.kind === "unsandboxed" && grant.kind === "unsandboxed") {
      const commandCwd = canonicalPath(cwd);
      if (permission.cwd !== commandCwd) return false;
      if (grant.scopeType === "session") return true;
      return grant.cwd === commandCwd && (grant.scopeType === "directory" || grant.scope === scope);
    }
    if (kind === "network") return grant.scope === "*" || grant.scope === scope || scope.startsWith(`${grant.scope}:`);
    return grant.scope === scope;
  });
}

function permissionSummary(permission: Permission): string {
  switch (permission.kind) {
    case "read": return `Allow reading ${permission.scope}? Directory approval includes descendants.`;
    case "write": return `Allow reading and writing ${permission.scope}? Directory approval includes descendants.`;
    case "network": return permission.scope === "*"
      ? "Allow outbound network access to any host, once or for this session? Commands can send data they can read, including inherited environment values. Filesystem restrictions and sandbox network safeguards remain in place."
      : `Allow network access to ${permission.scope}?`;
    case "tool": return `Allow running ${permission.scope}?`;
    case "unix-socket": return `Allow Unix-socket binding and connections at ${permission.scope}? Directory approval includes descendants and can expose local services. Filesystem and outbound-network restrictions remain in place.`;
    case "unsandboxed": return `Run this command outside the sandbox in ${permission.cwd}? Approval grants unrestricted host filesystem, environment, and network access, including child processes and future script modifications. Allow once, or remember this exact command/CWD, any command from this CWD, or any command from any CWD for this session. CWD limits which executions qualify, not what they can access. Normally sandboxed commands remain sandboxed. Session grants expire on session/branch replacement or process exit.`;
  }
}

export function requestPermission(
  ctx: ExtensionContext,
  permission: Permission,
  tool: string,
  preview: PermissionPreview | (() => PermissionPreview),
  onSessionGrant: () => void,
  remember = true,
  delegated?: { authorityCwd: string; provenance: Record<string, unknown> },
): Promise<PermissionAuthorization> {
  const requestedGeneration = accessRevision();
  const scopeLabel = permission.kind === "network" && permission.scope === "*"
    ? "outbound network access to any host" : permission.scope;
  const signal = ctx.signal ? AbortSignal.any([ctx.signal, state.lifetime.signal]) : state.lifetime.signal;
  const authorityCwd = delegated?.authorityCwd ?? ctx.cwd;
  const run = async () => {
    const assertCurrent = () => {
      if (accessRevision() !== requestedGeneration) throw new Error("Permission request cancelled because the active session or branch changed.");
      if (signal.aborted) throw new Error("aborted");
    };
    assertCurrent();
    const authorization = (allowOnce = false): PermissionAuthorization => ({ validate: async () => {
      assertCurrent();
      if (!allowOnce && !hasPermission(permission, authorityCwd)) throw new Error("Supporting permission is no longer effective");
      if (permission.kind === "read" || permission.kind === "write" || permission.kind === "unix-socket") {
        if (canonicalPath(permission.scope) !== permission.scope) throw new Error("Permission path changed before execution");
      }
    } });
    if (hasPermission(permission, authorityCwd)) return authorization();
    if (getAccessMode() === "readonly") throw new Error(`${permission.kind} access is blocked in readonly mode: ${scopeLabel}`);
    if (state.router && process.env.PI_SPAWN_WORKER_ID) {
      const contents = typeof preview === "function" ? preview() : preview;
      const routed = await state.router({ ...ctx, signal }, { permission, tool, preview: contents, cwd: canonicalPath(ctx.cwd), remember });
      assertCurrent();
      return { validate: async () => { assertCurrent(); await routed.validate(); assertCurrent(); } };
    }
    if (getInteractionMode(ctx) !== "interactive") {
      throw new Error(`${permission.kind} access requires approval, but interaction mode is noninteractive: ${scopeLabel}`);
    }
    const summary = permissionSummary(permission);
    const contents = typeof preview === "function" ? preview() : preview;
    const title = JSON.stringify({
      kind: "pi_approval_preview", notify: false, resumable: true, tool, mode: getAccessMode(), summary: scopeLabel,
      request: summary, directory: ctx.cwd,
      path: permission.kind === "read" || permission.kind === "write" || permission.kind === "unix-socket"
        ? permission.scope : undefined,
      preview_filetype: contents.filetype, preview: contents.text, provenance: delegated?.provenance,
    });
    notifyPiToolApproval(ctx);
    const sessionChoice = permission.kind === "unsandboxed"
      ? "Allow this command outside the sandbox for this session"
      : permission.kind === "network" ? "Allow network for this session" : "Allow for session";
    const sessionChoices = new Map<string, Permission>([[sessionChoice, { ...permission }]]);
    if (permission.kind === "unsandboxed") {
      sessionChoices.set("Allow any command outside the sandbox from this working directory for this session",
        { ...permission, scopeType: "directory" });
      sessionChoices.set("Allow any command outside the sandbox for this session",
        { ...permission, scopeType: "session" });
    }
    const choices = remember ? ["Allow once", ...sessionChoices.keys(), "Deny"] : ["Allow once", "Deny"];
    const finish = recordPermission(ctx, {
      tool, mode: getAccessMode(), scope: scopeLabel, request: summary, directory: ctx.cwd,
      preview: contents.text, previewFiletype: contents.filetype, options: choices, provenance: delegated?.provenance,
    });
    const cancel = () => finish("cancelled", undefined, "Permission request aborted.");
    signal.addEventListener("abort", cancel, { once: true });
    let choice: string | undefined;
    try {
      choice = await serviceUi(ctx).select(title, choices, { signal });
      assertCurrent();
      if (getAccessMode() === "readonly") throw new Error("Permission request cancelled because access mode changed to readonly.");
      const grant = remember && choice ? sessionChoices.get(choice) : undefined;
      if (choice !== "Allow once" && !grant) {
        const decision = choice === "Deny" ? "denied" : "cancelled";
        finish(decision, choice);
        throw Object.assign(new Error(`${permission.kind} access ${decision} by user: ${scopeLabel}`), { permissionDecision: decision });
      }
      if (grant) {
        sessionGrants.push(grant);
        if (grant.kind !== "unsandboxed" && grant.kind !== "unix-socket") onSessionGrant();
      }
      finish("allowed", choice);
      return authorization(choice === "Allow once");
    } catch (error) {
      finish("cancelled", choice, error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  };
  // All file-tool and network requests share the frontend's one active picker.
  const current = state.queue.then(run, run);
  state.queue = current.then(() => undefined, () => undefined);
  return current;
}
