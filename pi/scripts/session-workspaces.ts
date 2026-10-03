// Loaded explicitly by the persistent session-picker RPC service, not in
// conversation agents. It uses an unsaved Pi session; workspace lifecycle
// mutations stay in the shared helpers.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  listWorkspaces,
  prepareWorkspaceDiscard,
  removeWorkspace,
  retainedChildWorkspaces,
  sameSessionFile,
} from "../extensions/shared/workspace";

export default function sessionWorkspaces(pi: ExtensionAPI) {
  pi.registerCommand("pi-session-workspaces", {
    description: "Prepare recovery patches and remove workspaces linked to closed session files",
    handler: async (args, ctx) => {
      try {
        const request: unknown = JSON.parse(args);
        if (!request || typeof request !== "object") throw new Error("Invalid workspace request.");
        const { action, paths, workspaceIds } = request as Record<string, unknown>;
        if (action !== "remove" || !Array.isArray(paths)
          || paths.length === 0 || !paths.every((path): path is string => typeof path === "string" && path !== "")) {
          throw new Error("Expected a removal action and session file paths.");
        }
        const sessionPaths = paths.map((path) => path.replace(/\.archived$/, ""));
        const linked = listWorkspaces().filter((record) => (record.retained || record.lifecycle === "cleanup_failed")
          && sessionPaths.some((path) => sameSessionFile(record.sourceSessionFile, path)
            || sameSessionFile(record.targetSessionFile, path)));
        for (const record of linked) {
          if (retainedChildWorkspaces(record.id).length > 0) {
            throw new Error(`Join or discard child workspaces before deleting ${record.label}.`);
          }
        }
        if (!Array.isArray(workspaceIds) || !workspaceIds.every((id) => typeof id === "string")
          || JSON.stringify([...workspaceIds].sort()) !== JSON.stringify(linked.map((record) => record.id).sort())) {
          throw new Error("Linked workspaces changed while confirming; select the sessions again.");
        }
        // Snapshot once, after user approval and before removing any worktree.
        // Ref-cleanup retries reuse the patch saved before the worktree was removed.
        const prepared = linked.map((record) => record.retained ? prepareWorkspaceDiscard(record.id) : record);
        // Ask the picker to recheck live ownership after startup/snapshotting,
        // immediately before removal. This is not another user-facing dialog.
        const authorized = await ctx.ui.confirm("Remove prepared session workspaces?", JSON.stringify(prepared.map((record) => record.id).sort()));
        if (!authorized) throw new Error("Workspace removal cancelled; session files were kept.");
        for (const record of prepared) {
          const lifecycle = record.integration === "applied" || record.integration === "none" ? "integrated" : "discarded";
          const removed = removeWorkspace(record.id, lifecycle);
          if (removed.lifecycle === "cleanup_failed") {
            throw new Error(`Could not remove ${record.label}: ${removed.integrationReason ?? removed.worktreePath}. Session files were kept; earlier workspace removals may have succeeded.`);
          }
        }
        ctx.ui.setStatus("pi-session-workspaces", JSON.stringify({
          success: true,
          workspaceIds: prepared.map((record) => record.id),
        }));
      } catch (error) {
        ctx.ui.setStatus("pi-session-workspaces", JSON.stringify({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        }));
      }
    },
  });
}
