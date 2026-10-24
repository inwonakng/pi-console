import { serviceUi } from "./shared/service-ui";
import { registerServiceOperation } from "./shared/service-operation";
import { collectDeletedIds, parentId, planSessionDeletion, readSessionRecords, recordId, workspacesRemovedWithSubtree, writeJsonlFile } from "./shared/session-deletion";
import { withFileMutationQueue, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { revertSubtree } from "./history";
import { cloneThroughEntry } from "./shared/session-clone";
import { selectNavigation } from "./shared/navigation";
import { locationForEntry, moveToLocation } from "./shared/workspace-navigation";
import {
	prepareWorkspaceDiscard,
	removeWorkspace,
	workspaceDiscardWarning,
	type WorkspaceRecord,
} from "./shared/workspace";
import { hasRunningSubagents, subagentHistoryBlockReason } from "./shared/subagent-state";

function parseArgs(args: string) {
	const parts = args.trim().split(/\s+/).filter(Boolean);
	const entryId = parts.find((part) => !part.startsWith("--") && !part.startsWith("-"));
	const summarize = parts.includes("--summary") || parts.includes("-s");
	const yes = parts.includes("--yes") || parts.includes("-y");
	return { entryId, summarize, yes };
}

function contentText(content: unknown): string {
	if (typeof content === "string") {
		return content;
	}
	if (!Array.isArray(content)) {
		return "";
	}
	return content
		.map((item) => {
			if (typeof item === "string") {
				return item;
			}
			if (item && typeof item === "object" && "type" in item && item.type === "text" && "text" in item) {
				return typeof item.text === "string" ? item.text : "";
			}
			return "";
		})
		.join("");
}

function editorTextForTreeEntry(entry: unknown): string | undefined {
	if (!entry || typeof entry !== "object" || !("type" in entry)) {
		return undefined;
	}
	if (entry.type === "message" && "message" in entry) {
		const message = entry.message;
		if (message && typeof message === "object" && "role" in message && message.role === "user" && "content" in message) {
			return contentText(message.content);
		}
	}
	if (entry.type === "custom_message" && "content" in entry) {
		return contentText(entry.content);
	}
	return undefined;
}

function deletionConfirmation(entryId: string, deleteCount: number, workspaces: WorkspaceRecord[]): string {
	const descendants = deleteCount - 1;
	const lines = [
		`Delete entry ${entryId} and ${descendants} descendant entr${descendants === 1 ? "y" : "ies"}?`,
	];
	if (workspaces.length === 0) return lines[0]!;
	lines.push("", workspaceDiscardWarning(workspaces));
	return lines.join("\n");
}

export default function treeExtension(pi: ExtensionAPI) {
	let runtimeActive = true;
	pi.on("session_shutdown", () => { runtimeActive = false; });
	registerServiceOperation(pi, "history.clone", async ({ entryId }, ctx) => {
		return cloneThroughEntry(ctx, entryId, () => runtimeActive, { canonicalManagedFile: true });
	});

	registerServiceOperation(pi, "history.fork", async ({ entryId }, ctx) => {
		const selected = ctx.sessionManager.getEntry(entryId);
		if (selected?.type !== "message" || selected.message.role !== "user") return;
		const editorText = editorTextForTreeEntry(selected);
		const result = await cloneThroughEntry(ctx, entryId, () => runtimeActive, { canonicalManagedFile: true, beforeUserMessage: true });
		return result ? { ...result, editorText } : undefined;
	});

	pi.registerCommand("pi-tree-clone", {
		description: "Copy the branch through a turn without replacing this session",
		handler: async (args, ctx) => {
			const [entryId, requestId] = args.trim().split(/\s+/);
			if (!entryId || !requestId) throw new Error("Usage: /pi-tree-clone <entry-id> <request-id>");
			const sourceSessionFile = ctx.sessionManager.getSessionFile();
			try {
				const result = await cloneThroughEntry(ctx, entryId, () => runtimeActive);
				ctx.ui.setStatus("pi-tree-clone", JSON.stringify({ requestId, sourceSessionFile, cancelled: !result, ...result }));
			} catch (error) {
				if (runtimeActive) ctx.ui.setStatus("pi-tree-clone", JSON.stringify({
					requestId, sourceSessionFile, error: error instanceof Error ? error.message : String(error),
				}));
			}
		},
	});

	const jump = async (args: string, ctx: import("@earendil-works/pi-coding-agent").ExtensionCommandContext) => {
			const { entryId, summarize } = parseArgs(args);
			if (!entryId) {
				ctx.ui.notify("Usage: /pi-tree-jump <entry-id> [--summary]", "error");
				return;
			}

			const blocked = subagentHistoryBlockReason();
			if (blocked) {
				ctx.ui.notify(blocked, "warning");
				return;
			}
			const entry = ctx.sessionManager.getEntry(entryId);
			if (!entry) {
				ctx.ui.notify(`Unknown tree entry: ${entryId}`, "error");
				return;
			}

			const targetPosition = (entry.type === "message" && entry.message.role === "user")
				|| entry.type === "custom_message" ? entry.parentId : entry.id;
			const location = locationForEntry(ctx, targetPosition);
			if (summarize && location.cwd !== ctx.cwd) {
				ctx.ui.notify("Cross-workspace branch summaries are not supported; jump without summary instead.", "warning");
				return;
			}
			if (summarize) {
				const result = await ctx.navigateTree(entryId, { summarize: true });
				if (result.cancelled) return;
			}
			const moved = await moveToLocation(ctx, location.cwd, ctx.sessionManager.getLeafId(), {
				navigateTo: summarize ? undefined : entryId,
				onArrival: (nextCtx) => {
				const editorText = editorTextForTreeEntry(entry);
				if (editorText !== undefined) nextCtx.ui.setEditorText(editorText);
				nextCtx.ui.setStatus("pi-tree-leaf", nextCtx.sessionManager.getLeafId() ?? "");
				nextCtx.ui.setStatus("pi-history-changed", new Date().toISOString());
				nextCtx.ui.notify(`Tree: moved to ${entryId}${summarize ? " with summary" : ""}.`, "info");
			},
			});
			if (!moved) ctx.ui.notify("Tree navigation was cancelled.", "warning");
			return moved ? { changed: true, editorText: editorTextForTreeEntry(entry) } : undefined;
	};
	registerServiceOperation(pi, "history.navigate", ({ entryId, summarize }, ctx) => jump(`${entryId}${summarize ? " --summary" : ""}`, ctx));
	pi.registerCommand("pi-tree-jump", { description: "Navigate to an entry in the current session tree", handler: async (args, ctx) => { await jump(args, ctx); } });

	const deleteTree = async (args: string, ctx: import("@earendil-works/pi-coding-agent").ExtensionCommandContext) => {
			const { entryId, yes } = parseArgs(args);
			if (!entryId) {
				ctx.ui.notify("Usage: /pi-tree-delete <entry-id> [--yes]", "error");
				return;
			}
			const blocked = subagentHistoryBlockReason();
			if (blocked) {
				ctx.ui.notify(blocked, "warning");
				return;
			}
			if (!ctx.isIdle() || hasRunningSubagents()) {
				ctx.ui.notify("Wait for Pi and its subagents to finish before deleting session history.", "warning");
				return;
			}

			const sessionFile = ctx.sessionManager.getSessionFile();
			if (!sessionFile) {
				ctx.ui.notify("Cannot delete tree entries from an in-memory session.", "error");
				return;
			}

			const selectionLeafId = ctx.sessionManager.getLeafId();
			const undoOption = "History + undo work";
			const options = ["History only"];
			if (ctx.sessionManager.getBranch().some((entry) => entry.id === entryId)) options.push(undoOption);
			const mode = await selectNavigation(ctx, "Delete subtree (selected turn and all descendants)", options);
			if (!mode) return;
			if (!runtimeActive || ctx.sessionManager.getSessionFile() !== sessionFile
				|| ctx.sessionManager.getLeafId() !== selectionLeafId) {
				ctx.ui.notify("Session history changed; select the subtree again.", "warning");
				return;
			}
			if (mode === undoOption) {
				return revertSubtree(ctx, entryId, () => runtimeActive);
			}
			if (!runtimeActive || !ctx.isIdle() || hasRunningSubagents() || subagentHistoryBlockReason()) {
				ctx.ui.notify("Session activity changed; select the subtree again.", "warning");
				return;
			}

			const records = readSessionRecords(sessionFile);
			const target = records.find((record) => recordId(record) === entryId);
			if (!target) {
				ctx.ui.notify(`Unknown tree entry: ${entryId}`, "error");
				return;
			}
			const removedIds = collectDeletedIds(records, entryId);
			const currentLeafId = ctx.sessionManager.getLeafId();
			const expectedLeaf = currentLeafId && !removedIds.has(currentLeafId) ? currentLeafId : parentId(target) ?? null;
			let location: ReturnType<typeof locationForEntry>;
			let removedWorkspaces: WorkspaceRecord[];
			try {
				location = locationForEntry(ctx, expectedLeaf);
				const affected = workspacesRemovedWithSubtree(records, removedIds, sessionFile);
				removedWorkspaces = await Promise.all(affected.map((record) => record.retained ? prepareWorkspaceDiscard(record.id) : record));
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Could not prepare tree deletion: ${message}`, "error");
				return;
			}

			if (!yes) {
				const confirmed = await serviceUi(ctx).confirm(
					JSON.stringify({
						kind: "pi_confirmation",
						prompt: removedWorkspaces.length > 0 ? "Delete session history and workspaces?" : "Delete session history?",
						notify: false,
					}),
					deletionConfirmation(entryId, removedIds.size, removedWorkspaces),
				);
				if (!confirmed) return;
			}

			const plan = planSessionDeletion(records, removedIds, expectedLeaf);
			let committed = false;
			let cleanupIncomplete = false;
			const restoreOriginal = async () => {
				await withFileMutationQueue(sessionFile, async () => {
					if (JSON.stringify(readSessionRecords(sessionFile)) !== JSON.stringify(plan.records)) {
						throw new Error("Session changed after deletion; refusing to overwrite concurrent history.");
					}
					writeJsonlFile(sessionFile, records);
					committed = false;
				});
			};
			try {
				const switched = await moveToLocation(ctx, location.cwd, plan.desiredLeafId, {
					reload: true,
					beforeSwitch: async () => {
						await withFileMutationQueue(sessionFile, async () => {
							if (!runtimeActive || !ctx.isIdle() || hasRunningSubagents() || subagentHistoryBlockReason()
								|| ctx.sessionManager.getSessionFile() !== sessionFile || ctx.sessionManager.getLeafId() !== selectionLeafId
								|| JSON.stringify(readSessionRecords(sessionFile)) !== JSON.stringify(records)) {
								throw new Error("Session history or activity changed; select the subtree again.");
							}
							writeJsonlFile(sessionFile, plan.records);
							committed = true;
						});
					},
					onArrival: async (nextCtx) => {
						for (const record of removedWorkspaces) {
							try {
								const lifecycle = record.integration === "applied" || record.integration === "none"
									? "integrated" : "discarded";
								const cleaned = await removeWorkspace(record.id, lifecycle);
								if (cleaned.lifecycle === "cleanup_failed") {
									cleanupIncomplete = true;
									nextCtx.ui.notify(`Could not remove ${record.label}: ${cleaned.integrationReason ?? cleaned.worktreePath}`, "warning");
								}
							} catch (error) {
								cleanupIncomplete = true;
								nextCtx.ui.notify(`Could not remove ${record.label}: ${String(error)}`, "warning");
							}
						}
						nextCtx.ui.setStatus("pi-tree-leaf", nextCtx.sessionManager.getLeafId() ?? "");
						nextCtx.ui.setStatus("pi-history-changed", new Date().toISOString());
					},
				});
				if (!switched) {
					if (!runtimeActive) throw new Error("Session runtime changed before deletion completed.");
					await restoreOriginal();
					ctx.ui.notify("Deletion cancelled. Original history was restored; no workspaces were removed.", "warning");
				}
				return switched ? { changed: true, status: cleanupIncomplete ? "cleanup_incomplete" : "applied" } : undefined;
			} catch (error) {
				// A cancelled/failed switch can leave the old manager alive. Restore
				// its original tree before allowing another append from that manager.
				if (committed && runtimeActive) {
					try {
						await restoreOriginal();
					} catch (restoreError) {
						ctx.shutdown();
						throw new Error(`Deletion failed and original history could not be restored; Pi is stopping to prevent stale history writes: ${String(restoreError)}`);
					}
				}
				throw new Error(committed
					? `History was deleted, but reload could not finish. Restart or resume ${sessionFile}: ${String(error)}`
					: `Deletion stopped without changing history: ${String(error)}`);
			}
	};
	registerServiceOperation(pi, "history.delete", ({ entryId }, ctx) => deleteTree(entryId, ctx));
	pi.registerCommand("pi-tree-delete", { description: "Delete an entry and its descendant subtree from the current session",
		handler: async (args, ctx) => { await deleteTree(args, ctx); } });
}
