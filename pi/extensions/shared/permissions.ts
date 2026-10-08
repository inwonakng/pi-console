import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, lstatSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pathInside, resolveToolPath } from "./paths";
export { pathInside, resolveToolPath } from "./paths";
import { getAccessMode, getScratchDirectory } from "./access-state";
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
};

export type PermissionPreview = { text: string; filetype: string };

const sessionGrants: Permission[] = [];
let approvalQueue: Promise<void> = Promise.resolve();
let generation = 0;
let approvalLifetime = new AbortController();

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
  generation++;
  approvalLifetime.abort();
  approvalLifetime = new AbortController();
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
    if (kind === "read" || kind === "write") return pathInside(grant.scope, scope);
    if (kind === "unix-socket") return canonicalPath(grant.scope) === grant.scope && pathInside(grant.scope, scope);
    if (permission.kind === "unsandboxed" && grant.kind === "unsandboxed") {
      return grant.scope === scope && grant.cwd === permission.cwd && grant.cwd === canonicalPath(cwd);
    }
    if (kind === "network") return grant.scope === scope || scope.startsWith(`${grant.scope}:`);
    return grant.scope === scope;
  });
}

function permissionSummary(permission: Permission): string {
  switch (permission.kind) {
    case "read": return `Allow reading ${permission.scope}? Directory approval includes descendants.`;
    case "write": return `Allow reading and writing ${permission.scope}? Directory approval includes descendants.`;
    case "network": return permission.scope === "*"
      ? "Allow outbound network access to any host for this command only? The command can send data it can read, including inherited environment values. Filesystem restrictions and sandbox network safeguards remain in place."
      : `Allow network access to ${permission.scope}?`;
    case "tool": return `Allow running ${permission.scope}?`;
    case "unix-socket": return `Allow Unix-socket binding and connections at ${permission.scope}? Directory approval includes descendants and can expose local services. Filesystem and outbound-network restrictions remain in place.`;
    case "unsandboxed": return `Run this exact command outside the sandbox in ${permission.cwd}? Approval grants unrestricted host filesystem, environment, and network access, including child processes. Session approval includes future script modifications, but not different command text or working directories.`;
  }
}

export function requestPermission(
  ctx: ExtensionContext,
  permission: Permission,
  tool: string,
  preview: PermissionPreview | (() => PermissionPreview),
  onSessionGrant: () => void,
  remember = true,
): Promise<void> {
  const requestedGeneration = generation;
  const scopeLabel = permission.kind === "network" && permission.scope === "*"
    ? "outbound network access to any host (this command only)" : permission.scope;
  const signal = ctx.signal ? AbortSignal.any([ctx.signal, approvalLifetime.signal]) : approvalLifetime.signal;
  const run = async () => {
    const assertCurrent = () => {
      if (generation !== requestedGeneration) throw new Error("Permission request cancelled because the active session or branch changed.");
      if (signal.aborted) throw new Error("aborted");
    };
    assertCurrent();
    if (hasPermission(permission, ctx.cwd)) return;
    if (getAccessMode() === "readonly") throw new Error(`${permission.kind} access is blocked in readonly mode: ${scopeLabel}`);
    if (getInteractionMode(ctx) !== "interactive") {
      throw new Error(`${permission.kind} access requires approval, but interaction mode is noninteractive: ${scopeLabel}`);
    }
    const canRemember = remember && !(permission.kind === "network" && permission.scope === "*");
    const summary = permissionSummary(permission);
    const contents = typeof preview === "function" ? preview() : preview;
    const title = ctx.mode === "rpc" ? JSON.stringify({
      kind: "pi_approval_preview", tool, mode: getAccessMode(), summary: scopeLabel,
      request: summary, directory: ctx.cwd,
      path: permission.kind === "read" || permission.kind === "write" || permission.kind === "unix-socket"
        ? permission.scope : undefined,
      preview_filetype: contents.filetype, preview: contents.text,
    }) : `${summary}\n${contents.text}`;
    notifyPiToolApproval(ctx);
    const sessionChoice = permission.kind === "unsandboxed"
      ? "Allow this command outside the sandbox for this session" : "Allow for session";
    const choices = canRemember ? ["Allow once", sessionChoice, "Deny"] : ["Allow once", "Deny"];
    const choice = await ctx.ui.select(title, choices, { signal });
    assertCurrent();
    if (getAccessMode() === "readonly") throw new Error("Permission request cancelled because access mode changed to readonly.");
    if (choice !== "Allow once" && !(canRemember && choice === sessionChoice)) {
      throw new Error(`${permission.kind} access denied by user: ${scopeLabel}`);
    }
    if (choice === sessionChoice) {
      sessionGrants.push({ ...permission });
      if (permission.kind !== "unsandboxed" && permission.kind !== "unix-socket") onSessionGrant();
    }
  };
  // All file-tool and network requests share the frontend's one active picker.
  const current = approvalQueue.then(run, run);
  approvalQueue = current.then(() => undefined, () => undefined);
  return current;
}
