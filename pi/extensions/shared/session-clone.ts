import { serviceUi } from "./service-ui";
import { CURRENT_SESSION_VERSION, SessionManager, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { conversationTrust, projectTrustReady, saveConversationTrust, trustScope } from "./project-trust";
import { readSessionRecords, writeJsonlFile } from "./session-deletion";
import { hasRunningSubagents, subagentHistoryBlockReason } from "./subagent-state";
import { getExpectedWorkspaceMissing, getPendingWorkspaceId, workspaceForContext } from "./workspace";
import { locationForEntry } from "./workspace-navigation";

function assertCloneAllowed(ctx: ExtensionCommandContext, entryId: string, isRuntimeActive: () => boolean): string {
  if (!isRuntimeActive()) throw new Error("The session runtime changed; clone cancelled.");
  const sessionFile = ctx.sessionManager.getSessionFile();
  if (!sessionFile || !existsSync(sessionFile)) throw new Error("Cloning history requires a persisted session.");
  if (!ctx.sessionManager.getEntry(entryId)) throw new Error(`Unknown session entry: ${entryId}`);
  const blocked = subagentHistoryBlockReason();
  if (blocked) throw new Error(blocked);
  if (!ctx.isIdle() || hasRunningSubagents()) {
    throw new Error("Wait for Pi and its subagents to finish before cloning session history.");
  }
  if (!projectTrustReady()) throw new Error("Resolve project trust before cloning session history.");
  if (getPendingWorkspaceId() !== undefined || getExpectedWorkspaceMissing() !== undefined) {
    throw new Error("Resolve the pending or unavailable workspace before cloning session history.");
  }
  if (workspaceForContext(ctx.cwd, sessionFile)) {
    throw new Error("A workspace belongs to one conversation. Return to the origin checkout before cloning.");
  }
  return sessionFile;
}

function sanitizeRecords(records: { type?: unknown; customType?: unknown; data?: unknown }[]): void {
  for (const record of records) {
    if (record.type !== "custom") continue;
    // Keep these entries (and their IDs) as inert history: compactions and
    // context edits can refer to them, but they must not restore live authority.
    if (record.customType === "pi-workspace-location") record.customType = "pi-cloned-workspace-location";
    else if (record.customType === "pi-workspace-cursor") record.customType = "pi-cloned-workspace-cursor";
    else if (record.customType === "pi-side-conversation") record.customType = "pi-cloned-side-conversation";
    else if (record.customType === "pi-console-settings") {
      const data = record.data;
      if (!data || typeof data !== "object" || !("name" in data) || data.name !== "access") continue;
      const value = "value" in data ? data.value : undefined;
      if (!value || typeof value !== "object") continue;
      // Current permissions and both legacy grant formats live under data.value.
      const access = value as Record<string, unknown>;
      delete access.permissions;
      delete access.grants;
      delete access.readPaths;
    }
  }
}

/** Clone the selected path, inclusive, without switching or branching the live runtime.
 * This copies a transcript, not a checkout or the external file-rollback history.
 */
export async function cloneThroughEntry(
  ctx: ExtensionCommandContext,
  entryId: string,
  isRuntimeActive: () => boolean,
): Promise<{ sessionFile: string; cwd: string } | undefined> {
  const sourceFile = assertCloneAllowed(ctx, entryId, isRuntimeActive);
  const sourceLeaf = ctx.sessionManager.getLeafId();
  const { cwd } = locationForEntry(ctx, null);
  if (workspaceForContext(cwd, sourceFile)) {
    throw new Error("The original checkout is a managed workspace; cloning there is not supported.");
  }
  const decision = conversationTrust(cwd, sourceFile);
  const scope = trustScope(cwd, sourceFile);
  if (decision !== undefined) {
    if (!ctx.hasUI) return undefined;
    const approved = await serviceUi(ctx).confirm(
      JSON.stringify({ kind: "pi_confirmation", prompt: "Copy conversation-only project trust to the clone?", notify: false }),
      `The new conversation will start ${decision ? "trusted" : "untrusted"} for this project and its managed workspaces.`);
    if (!approved) return undefined;
  }

  // A dialog can outlive the runtime or allow work/navigation to start. All
  // checks precede the synchronous detached copy; the original is never mutated.
  const currentFile = assertCloneAllowed(ctx, entryId, isRuntimeActive);
  if (currentFile !== sourceFile || ctx.sessionManager.getLeafId() !== sourceLeaf) {
    throw new Error("The active session or branch changed; clone cancelled.");
  }
  if (locationForEntry(ctx, null).cwd !== cwd
    || conversationTrust(cwd, sourceFile) !== decision
    || trustScope(cwd, sourceFile).cwd !== scope.cwd) {
    throw new Error("The project location or trust decision changed; clone cancelled.");
  }
  const sourceRecords = readSessionRecords(sourceFile);
  // Opening an old session can migrate it in place. Do not let this detached
  // operation rewrite the source, even if it was replaced while the UI waited.
  const header = sourceRecords[0];
  if (header?.type !== "session" || header.version !== CURRENT_SESSION_VERSION
    || header.id !== ctx.sessionManager.getHeader()?.id) {
    throw new Error("The persisted session changed or requires migration; clone cancelled.");
  }
  const sessionDir = resolve(ctx.sessionManager.getSessionDir());
  const existingFiles = new Set(readdirSync(sessionDir));
  const detached = SessionManager.open(sourceFile, sessionDir, cwd);
  if (!detached.getEntry(entryId)) throw new Error(`Selected entry is not persisted: ${entryId}`);
  let createdFile: string | undefined;
  try {
    createdFile = detached.createBranchedSession(entryId);
    if (!createdFile || resolve(createdFile) === resolve(sourceFile)
      || dirname(resolve(createdFile)) !== sessionDir || existingFiles.has(basename(createdFile))) {
      throw new Error("Could not allocate a new session file for the clone.");
    }
    // Pi defers writing paths without user/assistant messages. Persist those too,
    // and sanitize only detached JSON, never objects owned by the live manager.
    const records = existsSync(createdFile)
      ? readSessionRecords(createdFile)
      : [detached.getHeader()!, ...detached.getEntries()];
    sanitizeRecords(records);
    writeJsonlFile(createdFile, records);
    if (!existsSync(createdFile)) throw new Error("The cloned session was not persisted.");
    if (decision !== undefined) saveConversationTrust(scope.cwd, createdFile, decision);
    return { sessionFile: createdFile, cwd };
  } catch (error) {
    // createBranchedSession can fail during its first write, after allocating the
    // detached manager's filename but before returning it. Never remove a source
    // or a file that already existed before this operation.
    const candidate = createdFile ?? detached.getSessionFile();
    if (candidate && resolve(candidate) !== resolve(sourceFile)
      && dirname(resolve(candidate)) === sessionDir && !existingFiles.has(basename(candidate))) {
      try {
        rmSync(candidate, { force: true });
      } catch (cleanupError) {
        throw new Error(`Clone failed: ${String(error)}. Could not remove incomplete clone ${candidate}: ${String(cleanupError)}`);
      }
    }
    throw new Error(`Clone failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
