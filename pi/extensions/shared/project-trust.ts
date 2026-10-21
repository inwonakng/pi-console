import { serviceUi } from "./service-ui";
import {
  getAgentDir, hasTrustRequiringProjectResources, ProjectTrustStore, SettingsManager,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { loadWorkspace, pathInside, sameSessionFile, workspaceForContext } from "./workspace";

type AppliedTrust = { trusted: boolean; error?: string };
type TrustState = {
  sessionFile?: string;
  destination?: { cwd: string; sessionFile?: string };
  applied: Map<string, AppliedTrust>;
  ready: boolean;
  forkDecision?: { cwd: string; trusted: boolean };
};
const key = Symbol.for("pi-console.project-trust");
const globals = globalThis as typeof globalThis & { [key]?: TrustState };
export const trustState = globals[key] ??= { applied: new Map(), ready: false };

export function frontendTrust(): boolean {
  // Flag values are not installed until after project_trust. Inspect only our
  // explicit frontend flag here; unlike an environment marker it cannot leak
  // into Pi processes launched by tools or subagents.
  return process.argv.includes("--pi-console-trust-ui");
}

export function projectTrustReady(): boolean {
  return !frontendTrust() || trustState.ready;
}

export function canonical(path: string): string {
  let ancestor = resolve(path);
  const suffix: string[] = [];
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) return resolve(path);
    suffix.unshift(basename(ancestor));
    ancestor = parent;
  }
  return resolve(realpathSync(ancestor), ...suffix);
}

export function trustSessionFile(): string | undefined {
  return trustState.destination?.sessionFile ?? trustState.sessionFile
    ?? (process.env.PI_CONSOLE_SESSION_FILE || undefined);
}

// Reuse Pi's locked, canonical-path store for conversation metadata too. A
// separate store per session avoids read/modify/write races between frontends.
function conversationStore(sessionFile: string): ProjectTrustStore {
  const id = createHash("sha256").update(canonical(sessionFile)).digest("hex");
  return new ProjectTrustStore(join(getAgentDir(), "pi-console", "session-trust", id));
}

export function trustScope(cwd: string, sessionFile?: string): { cwd: string; sessionFile?: string } {
  cwd = canonical(cwd);
  let record = workspaceForContext(cwd, sessionFile);
  if (!record) return { cwd, sessionFile };
  const owned = record.kind === "task"
    ? !!sessionFile && sameSessionFile(record.sourceSessionFile, sessionFile)
    : (!!sessionFile && sameSessionFile(record.targetSessionFile, sessionFile))
      || process.env.PI_WORKSPACE_ID === record.id;
  // Merely living under workspace storage or sharing a Git repository is not authority.
  if (!owned) return { cwd, sessionFile };
  const visited = new Set<string>();
  while (record) {
    if (visited.has(record.id)) throw new Error("Cyclic workspace trust ancestry");
    visited.add(record.id);
    cwd = canonical(record.destinationCwd);
    sessionFile = record.sourceSessionFile;
    if (!record.parentWorkspaceId) break;
    const parent = loadWorkspace(record.parentWorkspaceId);
    if (!parent?.retained || !pathInside(parent.worktreePath, cwd)
      || !sameSessionFile(parent.kind === "task" ? parent.sourceSessionFile : parent.targetSessionFile, sessionFile)) {
      throw new Error("Invalid workspace trust ancestry");
    }
    record = parent;
  }
  return { cwd, sessionFile };
}

export function conversationTrust(cwd: string, sessionFile?: string): boolean | undefined {
  const scope = trustScope(cwd, sessionFile);
  if (!scope.sessionFile) return undefined;
  const entry = conversationStore(scope.sessionFile).getEntry(scope.cwd);
  // Unlike permanent parent-folder approval, a conversation choice is exact.
  return entry?.path === canonical(scope.cwd) ? entry.decision : undefined;
}

export function saveConversationTrust(cwd: string, sessionFile: string, trusted: boolean): void {
  conversationStore(sessionFile).set(cwd, trusted);
}

export function resolveProjectTrust(cwd: string, sessionFile?: string): boolean | undefined {
  if (!hasTrustRequiringProjectResources(cwd)) return true;
  const scope = trustScope(cwd, sessionFile);
  const temporary = conversationTrust(cwd, sessionFile);
  if (temporary !== undefined) return temporary;
  const saved = new ProjectTrustStore(getAgentDir()).get(scope.cwd);
  if (saved !== null) return saved;
  const settings = SettingsManager.create(scope.cwd, getAgentDir(), { projectTrusted: false });
  const errors = settings.drainErrors();
  if (errors.length) throw new Error(errors.map(({ error }) => error.message).join("\n"));
  const policy = settings.getDefaultProjectTrust();
  return policy === "always" ? true : policy === "never" ? false : undefined;
}

export async function chooseProjectTrust(ctx: ExtensionContext, cwd: string, sessionFile?: string): Promise<boolean> {
  const existing = resolveProjectTrust(cwd, sessionFile);
  if (existing !== undefined) return existing;
  if (!ctx.hasUI) return false;
  const scope = trustScope(cwd, sessionFile);
  const parent = dirname(scope.cwd);
  const choices = ["Trust"];
  if (parent !== scope.cwd) choices.push(`Trust parent folder (${parent})`);
  choices.push("Trust (this conversation only)", "Do not trust", "Do not trust (this conversation only)");
  const selected = await serviceUi(ctx).select(
    `Trust project folder?\n${scope.cwd}${canonical(cwd) !== scope.cwd ? `\nWorkspace: ${cwd}` : ""}`
      + "\n\nThis allows Pi to load project settings and resources, install missing project packages, and execute project extensions."
      + "\nManaged workspaces inherit this project's decision. Conversation-only decisions survive restarts in pi-console.",
    choices,
  );
  const store = new ProjectTrustStore(getAgentDir());
  if (selected === "Trust") store.set(scope.cwd, true);
  else if (selected === "Do not trust") store.set(scope.cwd, false);
  else if (selected === `Trust parent folder (${parent})`) {
    store.setMany([{ path: parent, decision: true }, { path: scope.cwd, decision: null }]);
  } else {
    if (!scope.sessionFile) throw new Error("Conversation trust requires a session filename");
    saveConversationTrust(scope.cwd, scope.sessionFile, selected === "Trust (this conversation only)");
  }
  return resolveProjectTrust(cwd, sessionFile) ?? false;
}

// Our workspace/history routes know the actual cwdOverride before Pi emits its
// session_before_switch event (which otherwise only identifies the session file).
export async function prepareProjectTrust(ctx: ExtensionContext, cwd: string): Promise<void> {
  if (!frontendTrust()) return;
  await chooseProjectTrust(ctx, cwd, ctx.sessionManager.getSessionFile());
  trustState.destination = { cwd: canonical(cwd), sessionFile: ctx.sessionManager.getSessionFile() };
}

export function sessionHeaderCwd(sessionFile: string, fallback: string): string {
  if (!existsSync(sessionFile)) return fallback;
  for (const line of readFileSync(sessionFile, "utf8").split("\n")) {
    let record: unknown;
    try { record = JSON.parse(line); } catch { continue; }
    if (!record) continue;
    if (typeof record !== "object" || !("type" in record) || record.type !== "session"
      || !("id" in record) || typeof record.id !== "string") throw new Error("Invalid session header");
    return "cwd" in record && typeof record.cwd === "string" ? resolve(fallback, record.cwd) : fallback;
  }
  return fallback;
}
