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
import { dirname, join, relative, resolve, sep } from "path";
import { createHash } from "crypto";
import { listWorkspaces, loadWorkspace, prepareWorkspaceDiscard, removeWorkspace, retainedChildWorkspaces, workspaceForContext } from "./shared/workspace";
import { locationForEntry, locationEntry, moveToLocation, workspaceIdAt } from "./shared/workspace-navigation";
import { hasRunningSubagents } from "./spawn";

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

function pathInside(parent: string, child: string) {
	const rel = relative(resolve(parent), resolve(child));
	return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep));
}

function assertSafeWorkspacePath(root: string, path: string) {
	const canonicalRoot = realpathSync(root);
	let ancestor = dirname(path);
	while (!existsSync(ancestor) && ancestor !== dirname(ancestor)) {
		ancestor = dirname(ancestor);
	}
	const canonicalAncestor = realpathSync(ancestor);
	assertOk(pathInside(canonicalRoot, canonicalAncestor), `Refusing to follow a path outside workspace: ${path}`);
}

function normalizePath(root: string, cwd: string, path: string) {
	const absolute = resolve(cwd, path);
	assertOk(pathInside(root, absolute), `Refusing to snapshot outside workspace: ${path}`);
	assertSafeWorkspacePath(root, absolute);
	return relative(root, absolute) || ".";
}

function absolutePath(root: string, path: string) {
	const resolvedPath = resolve(root, path);
	assertOk(pathInside(root, resolvedPath), `Refusing to restore outside workspace: ${path}`);
	assertSafeWorkspacePath(root, resolvedPath);
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
	if (isHistoryIgnoredPath(normalizedPath)) {
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
	if (isHistoryIgnoredPath(normalizedPath)) {
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

function messageText(entry: SessionEntry) {
	if (entry.type !== "message" || entry.message.role !== "user") {
		return "";
	}
	const content = entry.message.content;
	if (typeof content === "string") {
		return content;
	}
	return content
		.filter((item) => item.type === "text")
		.map((item) => item.text)
		.join("");
}

function shortText(text: string) {
	const firstLine = text.trim().split(/\r?\n/, 1)[0] || "(empty)";
	return firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
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

async function revertAfter(ctx: ExtensionCommandContext, targetId: string | null, navigateTo?: string): Promise<"same" | "switched" | false> {
	const sessionFile = ctx.sessionManager.getSessionFile();
	const branch = ctx.sessionManager.getBranch();
	const afterIds = branchIdsAfter(branch, targetId);
	const beforeIds = new Set(branch.filter((entry) => !afterIds.has(entry.id)).map((entry) => entry.id));
	const retainedBefore = new Set(branch.filter((entry) => beforeIds.has(entry.id) && locationEntry(entry))
		.map((entry) => (entry.data as { workspaceId?: string } | undefined)?.workspaceId));
	const discardedIds = new Set(branch.filter((entry) => afterIds.has(entry.id) && locationEntry(entry))
		.map((entry) => (entry.data as { workspaceId?: string } | undefined)?.workspaceId)
		.filter((id): id is string => !!id && !retainedBefore.has(id)));
	const referenced = listWorkspaces().filter((record) => discardedIds.has(record.id));
	if (referenced.length !== discardedIds.size) throw new Error("Cannot roll back: a workspace record is missing.");
	if (referenced.some((record) => record.integration === "applied")) {
		ctx.ui.notify("Cannot roll back an already integrated workspace; its changes were applied to the destination checkout.", "error");
		return false;
	}
	const discarded = referenced.filter((record) => record.retained);
	if (discarded.some((record) => retainedChildWorkspaces(record.id).length)) {
		ctx.ui.notify("Join or discard child workspaces before rolling back their parent worktree.", "warning");
		return false;
	}
	if (hasRunningSubagents() && discarded.length) {
		ctx.ui.notify("Join or stop running subagents before discarding their parent workspace.", "warning");
		return false;
	}
	const targetWorkspaceId = workspaceIdAt(ctx, targetId);
	const targetWorkspace = targetWorkspaceId ? loadWorkspace(targetWorkspaceId) : undefined;
	if (targetWorkspaceId && (!targetWorkspace?.retained || !existsSync(targetWorkspace.worktreePath))) {
		ctx.ui.notify(`Destination workspace ${targetWorkspaceId} is unavailable.`, "error");
		return false;
	}
	const files = targetWorkspace ? restorePlan(readRecords(sessionFile).filter((record) =>
		record.workspaceId === targetWorkspace.id && record.baseEntryId !== null && afterIds.has(record.baseEntryId),
	)) : [];
	if (targetWorkspace && files.length) {
		const conflicts = validateCurrentState(targetWorkspace.worktreePath, files);
		if (conflicts.length) {
			ctx.ui.notify(`Rollback blocked; files changed since the agent turn:\n${conflicts.join("\n")}`, "error");
			return false;
		}
	}
	const target = locationForEntry(ctx, targetId);
	if (discarded.length || target.cwd !== ctx.cwd) {
		if (hasRunningSubagents()) {
			ctx.ui.notify("Join or stop running subagents before switching workspaces during rollback.", "warning");
			return false;
		}
		if (!navigateTo) {
			ctx.ui.notify("Cross-workspace rollback requires selecting a message through /pi-history.", "warning");
			return false;
		}
		const patches = discarded.map((record) => prepareWorkspaceDiscard(record.id));
		const approved = await ctx.ui.confirm("Change workspace during rollback?",
			`Switch to ${target.cwd}?${patches.length ? `\nThe following worktrees will be discarded (recovery patches remain):\n${patches.map((record) => `- ${record.label}: ${record.worktreePath}\n  ${record.resultPatchPath}`).join("\n")}` : "\nNo worktree will be discarded."}\n${files.length ? `${files.length} recorded file change(s) in the destination workspace will be rolled back.` : "Destination files will remain at their current state."} Proceed?`);
		if (!approved) return false;
	}
	for (const file of files) restoreState(targetWorkspace!.worktreePath, file.path, file.before);
	if (!discarded.length && target.cwd === ctx.cwd) {
		if (files.length) ctx.ui.notify(`Reverted ${files.length} file(s).`, "info");
		return "same";
	}
	const moved = await moveToLocation(ctx, target.cwd, ctx.sessionManager.getLeafId(), {
		navigateTo,
		onArrival: (nextCtx) => {
			for (const record of discarded) {
				const cleaned = removeWorkspace(record.id, "discarded");
				if (cleaned.lifecycle === "cleanup_failed") nextCtx.ui.notify(`Could not remove ${record.label}: ${cleaned.integrationReason}`, "warning");
			}
			if (navigateTo) {
				const selected = nextCtx.sessionManager.getEntry(navigateTo);
				if (selected) nextCtx.ui.setEditorText(messageText(selected));
			}
			nextCtx.ui.setStatus("pi-tree-leaf", nextCtx.sessionManager.getLeafId() ?? "");
			markHistoryChanged(nextCtx);
		},
	});
	return moved ? "switched" : false;
}

async function pickUserMessage(ctx: ExtensionCommandContext) {
	const entries = ctx.sessionManager
		.getBranch()
		.filter((entry) => {
			return entry.type === "message" && entry.message.role === "user";
		})
		.reverse();
	if (entries.length === 0) {
		ctx.ui.notify("No user messages in this session.", "warning");
		return undefined;
	}
	const options = entries.map((entry) => `${entry.id}  ${shortText(messageText(entry))}`);
	const choice = await ctx.ui.select("Pi history", options);
	if (!choice) {
		return undefined;
	}
	const id = choice.split(/\s+/, 1)[0];
	return entries.find((entry) => entry.id === id);
}

export default function historyExtension(pi: ExtensionAPI) {
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

	pi.on("turn_end", async (_event, ctx) => {
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
				workspaceId: turn.workspaceId,
				timestamp: new Date().toISOString(),
				files,
			});
		}
		turn = undefined;
	});

	pi.registerCommand("pi-history", {
		description: "Pick an earlier user message and fork or revert to it; revert undoes related file changes",
		handler: async (_args, ctx) => {
			const entry = await pickUserMessage(ctx);
			if (!entry) {
				return;
			}
			const action = await ctx.ui.select("History action", ["Revert (undoes related file changes)", "Fork"]);
			if (action === "Fork") {
				const text = messageText(entry);
				await ctx.fork(entry.id, {
					position: "before",
					withSession: async (newCtx) => {
						newCtx.ui.setEditorText(text);
						markHistoryChanged(newCtx);
					},
				});
			} else if (action === "Revert (undoes related file changes)") {
				const reverted = await revertAfter(ctx, entry.parentId, entry.id);
				if (!reverted) return;
				if (reverted === "same") {
					const result = await ctx.navigateTree(entry.id);
					if (result.cancelled) return;
					ctx.sessionManager.appendCustomEntry("pi-workspace-cursor", {});
					markHistoryChanged(ctx);
					ctx.ui.setEditorText(messageText(entry));
				}
			}
		},
	});

	pi.registerCommand("pi-revert-after", {
		description: "Revert recorded file changes after an entry id",
		handler: async (args, ctx) => {
			const targetId = args.trim() || null;
			const reverted = await revertAfter(ctx, targetId);
			if (reverted) {
				markHistoryChanged(ctx);
			}
		},
	});

	pi.registerCommand("pi-fork-message", {
		description: "Fork before a user message and prefill it for editing",
		handler: async (args, ctx) => {
			const id = args.trim();
			assertOk(id, "Usage: /pi-fork-message <entry-id>");
			const entry = ctx.sessionManager.getEntry(id);
			assertOk(entry, `Unknown entry: ${id}`);
			const text = messageText(entry);
			await ctx.fork(id, {
				position: "before",
				withSession: async (newCtx) => {
					newCtx.ui.setEditorText(text);
					markHistoryChanged(newCtx);
				},
			});
		},
	});
}
