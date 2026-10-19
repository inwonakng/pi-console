import type { ExtensionAPI, ExtensionCommandContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, getAgentDir, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { spawnSync } from "child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { appendFile } from "fs/promises";
import { dirname, join, relative, resolve } from "path";
import { createHash } from "crypto";
import { loadWorkspace, prepareWorkspaceDiscard, removeWorkspace, retainedChildWorkspaces, sameSessionFile, workspaceDiscardWarning, workspaceForContext } from "./shared/workspace";
import { locationForEntry, moveToLocation } from "./shared/workspace-navigation";
import { collectDeletedIds, locationWorkspaceId, planSessionDeletion, readSessionRecords, recordId, workspaceIdsRemovedWithSubtree, writeJsonlFile } from "./shared/session-deletion";
import { hasRunningSubagents, subagentHistoryBlockReason } from "./shared/subagent-state";
import { pathInside, resolveToolPath } from "./shared/paths";

type SnapshotState =
  | { kind: "missing" }
  | { kind: "file"; blob: string; mode: number }
  | { kind: "symlink"; target: string };

type FileRecord = {
	path: string;
	before: SnapshotState;
	after: SnapshotState;
};

type TurnRecord = {
	version: 1;
	sessionFile: string | undefined;
	baseEntryId: string | null;
	entryId?: string;
	workspaceId: string;
	timestamp: string;
	files: FileRecord[];
};

type FileState = {
	before: SnapshotState;
	after?: SnapshotState;
};

type TurnState = {
	baseEntryId: string | null;
	workspaceId: string;
	cwd: string;
	root: string;
	gitRoot: string;
	dirtyAtStart: Set<string>;
	files: Map<string, FileState>;
};

const HISTORY_DIR = join(getAgentDir(), "history");
const SNAPSHOT_GIT_DIR = join(HISTORY_DIR, "objects.git");

let turn: TurnState | undefined;

function assertOk(value: unknown, message: string): asserts value {
	if (!value) {
		throw new Error(message);
	}
}

function markHistoryChanged(ctx: ExtensionCommandContext) {
	ctx.ui.setStatus("pi-history-changed", new Date().toISOString());
}

function runGit(args: string[], options: { cwd?: string; input?: Buffer; binary?: boolean } = {}) {
	const result = spawnSync("git", args, {
		cwd: options.cwd,
		input: options.input,
		encoding: options.binary || options.input ? undefined : "utf-8",
	});
	if (result.status !== 0) {
		const stderr = Buffer.isBuffer(result.stderr) ? result.stderr.toString("utf-8") : result.stderr;
		throw new Error(`git ${args.join(" ")} failed: ${stderr || result.error?.message || "unknown error"}`);
	}
	return result.stdout;
}

function ensureSnapshotStore() {
	mkdirSync(HISTORY_DIR, { recursive: true });
	if (!existsSync(SNAPSHOT_GIT_DIR)) {
		runGit(["init", "--bare", SNAPSHOT_GIT_DIR]);
	}
}

function hashSessionFile(sessionFile: string | undefined) {
	const value = sessionFile || "ephemeral";
	return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function historyFile(sessionFile: string | undefined) {
	mkdirSync(HISTORY_DIR, { recursive: true });
	return join(HISTORY_DIR, `${hashSessionFile(sessionFile)}.jsonl`);
}

function isHistoryIgnoredPath(path: string) {
	const normalized = path.replace(/\\/g, "/");
	const spawnRoot = `${CONFIG_DIR_NAME}/spawn`;
	return normalized === spawnRoot || normalized.startsWith(`${spawnRoot}/`);
}

function isSafeWorkspacePath(root: string, path: string): boolean {
	const canonicalRoot = realpathSync(root);
	let ancestor = dirname(path);
	while (true) {
		try {
			// A dangling symlink is an existing ancestor, not a missing directory
			// we can skip. Only the leaf may be treated as a symlink object.
			lstatSync(ancestor);
			break;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
			const parent = dirname(ancestor);
			if (parent === ancestor) return false;
			ancestor = parent;
		}
	}
	try {
		return pathInside(canonicalRoot, realpathSync(ancestor));
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ENOENT" && code !== "ENOTDIR" && code !== "ELOOP") throw error;
		return false;
	}
}

function normalizePath(root: string, cwd: string, path: string): string | undefined {
	const absolute = resolveToolPath(path, cwd);
	// History observes worktree changes; access-mode authorizes external writes.
	if (!pathInside(root, absolute) || !isSafeWorkspacePath(root, absolute)) {
		return undefined;
	}
	return relative(root, absolute) || ".";
}

function absolutePath(root: string, path: string) {
	const resolvedPath = resolve(root, path);
	assertOk(pathInside(root, resolvedPath), `Refusing to restore outside workspace: ${path}`);
	assertOk(isSafeWorkspacePath(root, resolvedPath), `Refusing to follow a path outside workspace: ${resolvedPath}`);
	return resolvedPath;
}

function parseGitStatus(output: string) {
	const paths = new Set<string>();
	const parts = output.split("\0").filter((part) => part.length > 0);
	for (let index = 0; index < parts.length; index++) {
		const part = parts[index];
		const status = part.slice(0, 2);
		const path = part.slice(3);
		if (status.includes("R") || status.includes("C")) {
			index++;
			const nextPath = parts[index];
			if (nextPath) {
				paths.add(nextPath);
			}
		}
		if (path) {
			paths.add(path);
		}
	}
	return paths;
}

function gitStatusPaths(gitRoot: string) {
	const output = runGit(["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: gitRoot });
	return parseGitStatus(String(output));
}

function snapshotCurrentFile(root: string, path: string): SnapshotState {
	ensureSnapshotStore();
	const filePath = absolutePath(root, path);
	let stats;
	try {
		stats = lstatSync(filePath);
	} catch {
		return { kind: "missing" };
	}
	if (stats.isSymbolicLink()) {
		return { kind: "symlink", target: readlinkSync(filePath) };
	}
	assertOk(stats.isFile(), `Unsupported history path type: ${filePath}`);
	const output = runGit(["--git-dir", SNAPSHOT_GIT_DIR, "hash-object", "-w", filePath]);
	return { kind: "file", blob: String(output).trim(), mode: stats.mode & 0o777 };
}

function snapshotGitHead(gitRoot: string, path: string): SnapshotState {
	const treeEntry = String(runGit(["ls-tree", "-z", "HEAD", "--", path], { cwd: gitRoot }));
	if (!treeEntry) {
		return { kind: "missing" };
	}
	const header = treeEntry.slice(0, treeEntry.indexOf("\t"));
	const [mode, type, object] = header.split(" ");
	assertOk(type === "blob" && object, `Unsupported Git history entry for ${path}: ${header}`);
	const content = runGit(["cat-file", "-p", object], { cwd: gitRoot, binary: true }) as Buffer;
	if (mode === "120000") {
		return { kind: "symlink", target: content.toString("utf8") };
	}
	ensureSnapshotStore();
	const blob = runGit(["--git-dir", SNAPSHOT_GIT_DIR, "hash-object", "-w", "--stdin"], { input: content });
	return { kind: "file", blob: String(blob).trim(), mode: mode === "100755" ? 0o755 : 0o644 };
}

function sameState(left: SnapshotState, right: SnapshotState) {
	if (left.kind !== right.kind) return false;
	if (left.kind === "missing") return true;
	if (left.kind === "symlink") return left.target === (right as { kind: "symlink"; target: string }).target;
	const other = right as { kind: "file"; blob: string; mode: number };
	return left.blob === other.blob && left.mode === other.mode;
}

function formatBytes(bytes: number) {
	const units = ["B", "KiB", "MiB", "GiB", "TiB"];
	let value = bytes;
	let unitIndex = 0;
	while (value >= 1024 && unitIndex < units.length - 1) {
		value /= 1024;
		unitIndex++;
	}
	const digits = unitIndex > 0 && value < 10 ? 1 : 0;
	return `${value.toFixed(digits)} ${units[unitIndex]}`;
}

function snapshotBefore(path: string) {
	assertOk(turn, "No active turn");
	const normalizedPath = normalizePath(turn.root, turn.cwd, path);
	if (normalizedPath === undefined || isHistoryIgnoredPath(normalizedPath)) {
		return;
	}
	if (!turn.files.has(normalizedPath)) {
		turn.files.set(normalizedPath, {
			before: snapshotCurrentFile(turn.root, normalizedPath),
		});
	}
}

function snapshotAfter(path: string) {
	assertOk(turn, "No active turn");
	const normalizedPath = normalizePath(turn.root, turn.cwd, path);
	if (normalizedPath === undefined || isHistoryIgnoredPath(normalizedPath)) {
		return;
	}
	const current = turn.files.get(normalizedPath) || {
		before: snapshotCurrentFile(turn.root, normalizedPath),
	};
	current.after = snapshotCurrentFile(turn.root, normalizedPath);
	turn.files.set(normalizedPath, current);
}

function recordGitChanges() {
	if (!turn) {
		return;
	}
	const dirtyNow = gitStatusPaths(turn.gitRoot);
	const observedPaths = new Set([...turn.dirtyAtStart, ...dirtyNow]);
	for (const normalizedPath of observedPaths) {
		if (isHistoryIgnoredPath(normalizedPath)) {
			continue;
		}
		if (!turn.files.has(normalizedPath)) {
			turn.files.set(normalizedPath, {
				before: turn.dirtyAtStart.has(normalizedPath)
					? snapshotCurrentFile(turn.root, normalizedPath)
					: snapshotGitHead(turn.gitRoot, normalizedPath),
			});
		}
		const current = turn.files.get(normalizedPath)!;
		current.after = snapshotCurrentFile(turn.root, normalizedPath);
	}
}

async function appendRecord(sessionFile: string | undefined, record: TurnRecord) {
	const path = historyFile(sessionFile);
	await withFileMutationQueue(path, async () => {
		await appendFile(path, `${JSON.stringify(record)}\n`, "utf-8");
	});
}

function readRecords(sessionFile: string | undefined) {
	const path = historyFile(sessionFile);
	if (!existsSync(path)) {
		return [] as TurnRecord[];
	}
	return readFileSync(path, "utf-8")
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => JSON.parse(line) as TurnRecord);
}

// Older records only identify the leaf before turn_start, which precedes saving
// the user prompt. Resolve their final assistant/tool-result entry from the tree and completion time.
function recordEntryId(record: TurnRecord, entries: SessionEntry[]): string | undefined {
	if (record.entryId) return record.entryId;
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	let owner: string | undefined;
	for (const entry of entries) {
		if (entry.id === record.baseEntryId || entry.type !== "message"
			|| (entry.message.role !== "assistant" && entry.message.role !== "toolResult")
			|| entry.timestamp > record.timestamp) continue;
		let ancestor: SessionEntry | undefined = entry;
		while (ancestor && ancestor.id !== record.baseEntryId) {
			ancestor = ancestor.parentId ? byId.get(ancestor.parentId) : undefined;
		}
		if (record.baseEntryId === null || ancestor) owner = entry.id;
	}
	return owner;
}

function branchIdsAfter(entries: SessionEntry[], targetId: string | null) {
	const ids = new Set<string>();
	const targetIndex = targetId ? entries.findIndex((entry) => entry.id === targetId) : -1;
	assertOk(!targetId || targetIndex >= 0, `Could not find target entry: ${targetId}`);
	const startIndex = targetId ? targetIndex + 1 : 0;
	for (const entry of entries.slice(startIndex)) {
		ids.add(entry.id);
	}
	return ids;
}

function restoreBlob(blob: string, path: string) {
	const output = runGit(["--git-dir", SNAPSHOT_GIT_DIR, "cat-file", "-p", blob], { binary: true });
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, output);
}

function removeCurrentPath(path: string) {
	let stats;
	try {
		stats = lstatSync(path);
	} catch {
		return;
	}
	if (stats.isDirectory() && !stats.isSymbolicLink()) {
		rmdirSync(path);
	} else {
		unlinkSync(path);
	}
}

function restoreState(root: string, path: string, state: SnapshotState) {
	const filePath = absolutePath(root, path);
	if (state.kind === "missing") {
		removeCurrentPath(filePath);
		return;
	}
	mkdirSync(dirname(filePath), { recursive: true });
	removeCurrentPath(filePath);
	if (state.kind === "symlink") {
		symlinkSync(state.target, filePath);
		return;
	}
	restoreBlob(state.blob, filePath);
	chmodSync(filePath, state.mode);
}

function restorePlan(records: TurnRecord[]) {
	const planned = new Map<string, FileRecord>();
	for (const record of records) {
		for (const file of record.files) {
			if (isHistoryIgnoredPath(file.path)) {
				continue;
			}
			const existing = planned.get(file.path);
			planned.set(file.path, {
				path: file.path,
				before: existing ? existing.before : file.before,
				after: file.after,
			});
		}
	}
	return Array.from(planned.values());
}

function validateCurrentState(root: string, files: FileRecord[]) {
	const conflicts = [];
	for (const file of files) {
		const current = snapshotCurrentFile(root, file.path);
		if (!sameState(current, file.after)) {
			conflicts.push(file.path);
		}
	}
	return conflicts;
}

async function revertAfter(ctx: ExtensionCommandContext, targetId: string | null, selected: SessionEntry | undefined, isRuntimeActive: () => boolean): Promise<void> {
	const blocked = subagentHistoryBlockReason();
	if (blocked) {
		ctx.ui.notify(blocked, "warning");
		return;
	}
	if (!ctx.isIdle() || hasRunningSubagents()) {
		ctx.ui.notify("Wait for Pi and its subagents to finish before reverting session history.", "warning");
		return;
	}
	const sessionFile = ctx.sessionManager.getSessionFile();
	assertOk(sessionFile, "Reverting history requires a persisted session.");
	const sourceLeaf = ctx.sessionManager.getLeafId();
	const branch = ctx.sessionManager.getBranch();
	const afterIds = branchIdsAfter(branch, targetId);
	const records = readSessionRecords(sessionFile);
	const deletedIds = selected
		? collectDeletedIds(records, selected.id)
		: targetId ? collectDeletedIds(records, targetId)
			: new Set(records.filter((record) => record.type !== "session").map(recordId).filter((id): id is string => !!id));
	if (!selected && targetId) deletedIds.delete(targetId);
	if (deletedIds.size === 0) {
		ctx.ui.notify("No history to revert.", "info");
		return;
	}
	const plan = planSessionDeletion(records, deletedIds, targetId);
	const target = locationForEntry(ctx, targetId);
	const removedWorkspaceIds = workspaceIdsRemovedWithSubtree(records, deletedIds);
	const referenced = removedWorkspaceIds.map((id) => {
		const record = loadWorkspace(id);
		assertOk(record, `Cannot revert: workspace record ${id} is missing.`);
		assertOk(record.kind === "task" && sameSessionFile(record.sourceSessionFile, sessionFile),
			`Cannot revert workspace ${id}: it does not belong to this conversation.`);
		return record;
	});
	// Applied changes cannot be undone by deleting their worktree, even if another branch references it.
	const retainedBefore = new Set(branch.filter((entry) => !afterIds.has(entry.id))
		.map(locationWorkspaceId).filter(Boolean));
	const introduced = branch.filter((entry) => afterIds.has(entry.id))
		.map(locationWorkspaceId)
		.filter((id): id is string => !!id && !retainedBefore.has(id))
		.map((id) => {
			const workspace = loadWorkspace(id);
			assertOk(workspace, `Cannot revert: workspace record ${id} is missing.`);
			return workspace;
		});
	if ([...referenced, ...introduced].some((record) => record.integration === "applied")) {
		ctx.ui.notify("Cannot revert an already integrated workspace; its changes were applied to the destination checkout.", "error");
		return;
	}
	const discarded = referenced.filter((record) => record.retained);
	if (discarded.some((record) => retainedChildWorkspaces(record.id).length)) {
		ctx.ui.notify("Join or discard child workspaces before reverting their parent worktree.", "warning");
		return;
	}
	// Only active-path snapshots are rolled back. Inactive descendants are deleted, not replayed.
	const entries = ctx.sessionManager.getEntries();
	const snapshots = readRecords(sessionFile).map((record) => ({ record, entryId: recordEntryId(record, entries) }));
	for (const { record, entryId } of snapshots) {
		assertOk(entryId || (record.baseEntryId !== targetId && !afterIds.has(record.baseEntryId ?? "")),
			"Cannot determine which turn owns an older rollback record; history was not changed.");
	}
	const rollbackRecords = snapshots.filter(({ entryId }) => entryId && afterIds.has(entryId))
		.map(({ record }) => record).filter((record) => !removedWorkspaceIds.includes(record.workspaceId));
	const rollback = [...new Set(rollbackRecords.map((record) => record.workspaceId))].map((id) => {
		const workspace = loadWorkspace(id);
		assertOk(workspace?.retained && existsSync(workspace.worktreePath), `Rollback workspace ${id} is unavailable.`);
		assertOk(workspace.kind === "task" && sameSessionFile(workspace.sourceSessionFile, sessionFile),
			`Rollback workspace ${id} does not belong to this conversation.`);
		return { workspace, files: restorePlan(rollbackRecords.filter((record) => record.workspaceId === id)) };
	});
	const validateFiles = () => {
		const conflicts = rollback.flatMap(({ workspace, files }) =>
			validateCurrentState(workspace.worktreePath, files).map((path) => `${workspace.label}: ${path}`));
		assertOk(conflicts.length === 0, `Revert blocked; files changed since the agent turn:\n${conflicts.join("\n")}`);
	};
	validateFiles();
	const patches = await Promise.all(discarded.map((record) => prepareWorkspaceDiscard(record.id)));
	const fileCount = rollback.reduce((count, item) => count + item.files.length, 0);
	const approved = await ctx.ui.confirm(
		JSON.stringify({ kind: "pi_confirmation", prompt: "Permanently revert history?", notify: false }),
		`Delete ${deletedIds.size} history entries${selected ? ", including the selected message and every branch beneath it" : " after the selected point"}? This cannot be undone through the tree.\n`
		+ `Restore ${fileCount} recorded file change(s) on the active path.\n`
		+ `Continue in ${target.cwd}.\n`
		+ (patches.length ? workspaceDiscardWarning(patches) : "No worktree will be discarded."));
	if (!approved) return;
	assertOk(isRuntimeActive() && ctx.sessionManager.getSessionFile() === sessionFile
		&& ctx.sessionManager.getLeafId() === sourceLeaf, "Session history changed; select the subtree again.");
	let historyDeleted = false;
	let filesRestored = false;
	ctx.ui.setStatus("pi-history-revert", "pending");
	try {
		const moved = await moveToLocation(ctx, target.cwd, plan.desiredLeafId, {
			reload: true,
			saveCursor: false,
			beforeSwitch: async () => {
				assertOk(isRuntimeActive() && ctx.isIdle() && !hasRunningSubagents() && !subagentHistoryBlockReason(),
					"Pi or a subagent became busy; revert cancelled.");
				assertOk(ctx.sessionManager.getSessionFile() === sessionFile && ctx.sessionManager.getLeafId() === sourceLeaf,
					"Session history changed; select the subtree again.");
				const validateSession = () => assertOk(
					JSON.stringify(readSessionRecords(sessionFile)) === JSON.stringify(records),
					"Session history changed while preparing revert; select the rollback point again.");
				validateSession();
				validateFiles();
				for (const { workspace, files } of rollback) {
					for (const file of files) {
						await withFileMutationQueue(absolutePath(workspace.worktreePath, file.path), async () => {
							assertOk(sameState(snapshotCurrentFile(workspace.worktreePath, file.path), file.after),
								`File changed while preparing revert: ${file.path}`);
							filesRestored = true;
							restoreState(workspace.worktreePath, file.path, file.before);
						});
					}
				}
				await withFileMutationQueue(sessionFile, async () => {
					validateSession();
					writeJsonlFile(sessionFile, plan.records);
					historyDeleted = true;
				});
			},
			onArrival: async (nextCtx) => {
				const warnings: string[] = [];
				try {
					const path = historyFile(sessionFile);
					await withFileMutationQueue(path, async () => {
						writeJsonlFile(path, readRecords(sessionFile).filter((record) => {
							const entryId = recordEntryId(record, entries);
							return !entryId || !deletedIds.has(entryId);
						}));
					});
				} catch (error) {
					warnings.push(`Could not prune rollback records: ${error instanceof Error ? error.message : String(error)}`);
				}
				for (const record of discarded) {
					try {
						const cleaned = await removeWorkspace(record.id, "discarded");
						if (cleaned.lifecycle === "cleanup_failed") {
							warnings.push(`Could not remove ${record.label}: ${cleaned.integrationReason}`);
						}
					} catch (error) {
						warnings.push(`Could not remove ${record.label}: ${error instanceof Error ? error.message : String(error)}`);
					}
				}
				nextCtx.ui.setStatus("pi-tree-leaf", nextCtx.sessionManager.getLeafId() ?? "");
				nextCtx.ui.setStatus("pi-history-revert", "complete");
				markHistoryChanged(nextCtx);
				nextCtx.ui.notify(warnings.length
					? `History was permanently reverted, but cleanup is incomplete:\n${warnings.join("\n")}`
					: `Permanently reverted ${deletedIds.size} history entries and ${fileCount} recorded file change(s).`,
					warnings.length ? "warning" : "info");
			},
		});
		if (!moved) {
			// Cancellation happens before runtime replacement, so ctx is still live.
			// Restore its original tree before allowing it to append anything else.
			try {
				await withFileMutationQueue(sessionFile, async () => {
					assertOk(JSON.stringify(readSessionRecords(sessionFile)) === JSON.stringify(plan.records),
						"Session changed after the revert commit; refusing to overwrite concurrent entries.");
					writeJsonlFile(sessionFile, records);
					historyDeleted = false;
				});
			} catch (error) {
				throw new Error(`Reload was cancelled and the original history could not be restored; Pi is shutting down to prevent stale history writes: ${error instanceof Error ? error.message : String(error)}`);
			}
			for (const { workspace, files } of rollback) {
				for (const file of files) {
					await withFileMutationQueue(absolutePath(workspace.worktreePath, file.path), async () => {
						assertOk(sameState(snapshotCurrentFile(workspace.worktreePath, file.path), file.before),
							`File changed after revert was cancelled: ${file.path}`);
						restoreState(workspace.worktreePath, file.path, file.after);
					});
				}
			}
			filesRestored = false;
			ctx.ui.setStatus("pi-history-revert", undefined);
			ctx.ui.notify("Revert cancelled. Original history and files were restored; no worktrees were removed.", "warning");
		}
	} catch (error) {
		// A switch can throw before teardown as well as after it. Only the former
		// leaves an old runtime able to append beneath deleted entries.
		if (isRuntimeActive()) {
			ctx.ui.setStatus("pi-history-revert", undefined);
			if (historyDeleted) ctx.shutdown();
		}
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(historyDeleted
			? `History was deleted, but revert could not finish: ${reason}. Restart or resume ${sessionFile} before continuing; inspect workspace cleanup.`
			: `Revert stopped without deleting history: ${reason}${filesRestored ? ". File restoration started and may be partial; inspect the affected files." : ""}`);
	}
}

export async function revertSubtree(ctx: ExtensionCommandContext, entryId: string, isRuntimeActive: () => boolean): Promise<void> {
	assertOk(isRuntimeActive(), "Session changed; select the subtree again.");
	const entry = ctx.sessionManager.getEntry(entryId);
	assertOk(entry, `Unknown tree entry: ${entryId}`);
	assertOk(ctx.sessionManager.getBranch().some((item) => item.id === entryId),
		"Undo work is only available for a subtree on the active conversation path.");
	await revertAfter(ctx, entry.parentId, entry, isRuntimeActive);
}

export default function historyExtension(pi: ExtensionAPI) {
	let runtimeActive = true;
	pi.on("session_shutdown", () => { runtimeActive = false; });

	pi.on("turn_start", (_event, ctx) => {
		turn = undefined;
		const workspace = workspaceForContext(ctx.cwd, ctx.sessionManager.getSessionFile());
		if (!workspace || !existsSync(workspace.worktreePath)) {
			return;
		}
		turn = {
			baseEntryId: ctx.sessionManager.getLeafId(),
			workspaceId: workspace.id,
			cwd: ctx.cwd,
			root: workspace.worktreePath,
			gitRoot: workspace.worktreePath,
			dirtyAtStart: gitStatusPaths(workspace.worktreePath),
			files: new Map(),
		};

		const snapshotPaths: string[] = [];
		let snapshotBytes = 0;
		for (const path of turn.dirtyAtStart) {
			if (isHistoryIgnoredPath(path)) {
				continue;
			}
			snapshotPaths.push(path);
			try {
				const stats = lstatSync(absolutePath(turn.root, path));
				if (stats.isFile()) {
					snapshotBytes += stats.size;
				}
			} catch {
				// Missing or unreadable paths are represented by the snapshot itself.
			}
		}

		if (snapshotPaths.length > 0) {
			const noun = snapshotPaths.length === 1 ? "file" : "files";
			ctx.ui.notify(
				`History: snapshotting ${snapshotPaths.length} dirty ${noun} (${formatBytes(snapshotBytes)}) for rollback`,
				"info",
			);
		}
		for (const path of snapshotPaths) {
			if (!turn.files.has(path)) {
				turn.files.set(path, { before: snapshotCurrentFile(turn.root, path) });
			}
		}
	});

	pi.on("tool_call", (event) => {
		if (!turn) {
			return undefined;
		}
		if ((event.toolName === "edit" || event.toolName === "write") && typeof event.input.path === "string") {
			snapshotBefore(event.input.path);
		}
		return undefined;
	});

	pi.on("tool_result", (event) => {
		if (!turn || event.isError) {
			return undefined;
		}
		if ((event.toolName === "edit" || event.toolName === "write") && typeof event.input.path === "string") {
			snapshotAfter(event.input.path);
		}
		return undefined;
	});

	pi.on("turn_end", async (event, ctx) => {
		if (!turn) {
			return;
		}
		recordGitChanges();
		const files: FileRecord[] = [];
		for (const [path, state] of turn.files) {
			if (isHistoryIgnoredPath(path)) {
				continue;
			}
			const after = state.after || snapshotCurrentFile(turn.root, path);
			if (!sameState(state.before, after)) {
				files.push({ path, before: state.before, after });
			}
		}
		if (files.length > 0) {
			await appendRecord(ctx.sessionManager.getSessionFile(), {
				version: 1,
				sessionFile: ctx.sessionManager.getSessionFile(),
				baseEntryId: turn.baseEntryId,
				entryId: event.toolResultEntryIds.at(-1) ?? event.messageEntryId,
				workspaceId: turn.workspaceId,
				timestamp: new Date().toISOString(),
				files,
			});
		}
		turn = undefined;
	});

	pi.registerCommand("pi-revert-after", {
		description: "Permanently delete descendants after an active-branch entry id and undo recorded file changes",
		handler: async (args, ctx) => {
			const targetId = args.trim() || null;
			await revertAfter(ctx, targetId, undefined, () => runtimeActive);
		},
	});
}
