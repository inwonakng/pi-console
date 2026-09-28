import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { locationForEntry, moveToLocation } from "./shared/workspace-navigation";
import {
	loadWorkspace,
	prepareWorkspaceDiscard,
	removeWorkspace,
	retainedChildWorkspaces,
	type WorkspaceRecord,
} from "./shared/workspace";
import { hasRunningSubagents } from "./spawn";

type JsonRecord = Record<string, unknown>;

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

function readSessionRecords(sessionFile: string): JsonRecord[] {
	return readFileSync(sessionFile, "utf8")
		.split(/\r?\n/)
		.filter((line) => line.trim() !== "")
		.map((line) => JSON.parse(line) as JsonRecord);
}

function recordId(record: JsonRecord): string | undefined {
	return typeof record.id === "string" ? record.id : undefined;
}

function parentId(record: JsonRecord): string | null | undefined {
	if (record.parentId === null) {
		return null;
	}
	return typeof record.parentId === "string" ? record.parentId : undefined;
}

function collectDeletedIds(records: JsonRecord[], targetId: string): Set<string> {
	const deleted = new Set<string>([targetId]);
	let changed = true;
	while (changed) {
		changed = false;
		for (const record of records) {
			const id = recordId(record);
			const parent = parentId(record);
			if (!id || deleted.has(id) || !parent || !deleted.has(parent)) {
				continue;
			}
			deleted.add(id);
			changed = true;
		}
	}
	return deleted;
}

function locationWorkspaceId(record: JsonRecord): string | undefined {
	if (record.type !== "custom" || record.customType !== "pi-workspace-location"
		|| !record.data || typeof record.data !== "object") {
		return undefined;
	}
	const workspaceId = (record.data as Record<string, unknown>).workspaceId;
	return typeof workspaceId === "string" && workspaceId !== "" ? workspaceId : undefined;
}

function workspacesRemovedWithSubtree(
	records: JsonRecord[],
	deletedIds: Set<string>,
	sessionFile: string,
): WorkspaceRecord[] {
	const deletedWorkspaceIds = new Set<string>();
	const survivingWorkspaceIds = new Set<string>();
	for (const record of records) {
		const workspaceId = locationWorkspaceId(record);
		const id = recordId(record);
		if (!workspaceId || !id) continue;
		(deletedIds.has(id) ? deletedWorkspaceIds : survivingWorkspaceIds).add(workspaceId);
	}
	return [...deletedWorkspaceIds]
		.filter((id) => !survivingWorkspaceIds.has(id))
		.map(loadWorkspace)
		.filter((record): record is WorkspaceRecord => !!record
			&& record.kind === "task"
			&& record.retained
			&& record.sourceSessionFile === sessionFile);
}

function deletionConfirmation(entryId: string, deleteCount: number, workspaces: WorkspaceRecord[]): string {
	const descendants = deleteCount - 1;
	const lines = [
		`Delete entry ${entryId} and ${descendants} descendant entr${descendants === 1 ? "y" : "ies"}?`,
	];
	if (workspaces.length === 0) return lines[0]!;
	lines.push("", "The following worktrees will also be removed. Unintegrated changes will be discarded; existing destination changes will not be reverted:");
	for (const record of workspaces) {
		lines.push(`- ${record.label} (${record.lifecycle}): ${record.worktreePath}`);
		lines.push(`  changed files: ${record.changedFiles.length > 0 ? record.changedFiles.join(", ") : "(none)"}`);
		lines.push(`  recovery patch: ${record.resultPatchPath}`);
		if (record.includedIgnoredFiles?.length) {
			lines.push(`  included ignored files (not in patch): ${record.includedIgnoredFiles.map((file) => file.path).join(", ")}`);
		}
		if (record.unpreservedFiles?.length) {
			lines.push(`  ignored untracked files (not in patch): ${record.unpreservedFiles.join(", ")}`);
		}
	}
	return lines.join("\n");
}

function makeId(existingIds: Set<string>): string {
	for (let attempt = 0; attempt < 100; attempt++) {
		const id = Math.floor(Math.random() * 0xffffffff)
			.toString(16)
			.padStart(8, "0")
			.slice(0, 8);
		if (!existingIds.has(id)) {
			return id;
		}
	}
	throw new Error("Could not allocate unique session entry id");
}

function appendLeafMarker(records: JsonRecord[], leafParentId: string | null): string {
	const existingIds = new Set(records.map(recordId).filter((id): id is string => typeof id === "string"));
	const id = makeId(existingIds);
	records.push({
		type: "custom",
		id,
		parentId: leafParentId,
		timestamp: new Date().toISOString(),
		customType: "pi-tree-delete-leaf",
		data: { reason: "preserve active leaf after subtree deletion" },
	});
	return id;
}

function rewriteSessionWithoutSubtree(sessionFile: string, targetId: string, currentLeafId: string | null) {
	const records = readSessionRecords(sessionFile);
	const target = records.find((record) => recordId(record) === targetId);
	if (!target) {
		throw new Error(`Unknown tree entry: ${targetId}`);
	}
	const deletedIds = collectDeletedIds(records, targetId);
	const targetParentId = parentId(target) ?? null;
	let desiredLeafParentId = currentLeafId && !deletedIds.has(currentLeafId) ? currentLeafId : targetParentId;

	const kept = records.filter((record) => {
		const id = recordId(record);
		return !id || !deletedIds.has(id);
	});

	const keptEntryIds = new Set(kept.map(recordId).filter((id): id is string => typeof id === "string"));
	const orphan = kept.find((record) => {
		const parent = parentId(record);
		return typeof parent === "string" && !keptEntryIds.has(parent);
	});
	if (orphan) {
		throw new Error(`Deletion would orphan retained entry ${recordId(orphan) ?? "unknown"}.`);
	}

	const removedCount = deletedIds.size;
	if (desiredLeafParentId !== null && !keptEntryIds.has(desiredLeafParentId)) {
		desiredLeafParentId = null;
	}
	const lastKeptId = kept.length > 0 ? recordId(kept[kept.length - 1]!) : undefined;
	let markerId: string | undefined;
	if (desiredLeafParentId === null || lastKeptId !== desiredLeafParentId) {
		markerId = appendLeafMarker(kept, desiredLeafParentId);
	}

	const temporary = `${sessionFile}.${process.pid}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporary, kept.map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8");
		renameSync(temporary, sessionFile);
	} finally {
		rmSync(temporary, { force: true });
	}

	return {
		deletedCount: removedCount,
		desiredLeafId: markerId ?? desiredLeafParentId,
	};
}

export default function treeExtension(pi: ExtensionAPI) {
	pi.registerCommand("pi-tree-jump", {
		description: "Navigate to an entry in the current session tree",
		handler: async (args, ctx) => {
			const { entryId, summarize } = parseArgs(args);
			if (!entryId) {
				ctx.ui.notify("Usage: /pi-tree-jump <entry-id> [--summary]", "error");
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
		},
	});

	pi.registerCommand("pi-tree-delete", {
		description: "Delete an entry and its descendant subtree from the current session",
		handler: async (args, ctx) => {
			const { entryId, yes } = parseArgs(args);
			if (!entryId) {
				ctx.ui.notify("Usage: /pi-tree-delete <entry-id> [--yes]", "error");
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
				const blocked = affected.find((record) => retainedChildWorkspaces(record.id).length > 0);
				if (blocked) {
					ctx.ui.notify(`Join or discard child workspaces before deleting ${blocked.label}.`, "warning");
					return;
				}
				removedWorkspaces = affected.map((record) => prepareWorkspaceDiscard(record.id));
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Could not prepare tree deletion: ${message}`, "error");
				return;
			}

			if (!yes) {
				const confirmed = await ctx.ui.confirm(
					removedWorkspaces.length > 0 ? "Delete session history and workspaces?" : "Delete session history?",
					deletionConfirmation(entryId, removedIds.size, removedWorkspaces),
				);
				if (!confirmed) return;
			}

			let result: ReturnType<typeof rewriteSessionWithoutSubtree>;
			try {
				result = rewriteSessionWithoutSubtree(sessionFile, entryId, currentLeafId);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Could not delete tree entry: ${message}`, "error");
				return;
			}

			const switched = await moveToLocation(ctx, location.cwd, result.desiredLeafId, {
				reload: true,
				onArrival: (nextCtx) => {
					for (const record of removedWorkspaces) {
						const lifecycle = record.integration === "applied" || record.integration === "none"
							? "integrated"
							: "discarded";
						const cleaned = removeWorkspace(record.id, lifecycle);
						if (cleaned.lifecycle === "cleanup_failed") {
							nextCtx.ui.notify(`Could not remove ${record.label}: ${cleaned.integrationReason ?? cleaned.worktreePath}`, "warning");
						}
					}
					nextCtx.ui.setStatus("pi-tree-leaf", nextCtx.sessionManager.getLeafId() ?? "");
					nextCtx.ui.setStatus("pi-history-changed", new Date().toISOString());
				},
			});
			if (!switched) {
				ctx.ui.notify(
					`Deleted entries, but session reload was cancelled. Restart or resume ${sessionFile} to pick up the change.`,
					"warning",
				);
			}
		},
	});
}
