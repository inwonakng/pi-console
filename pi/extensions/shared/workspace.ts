import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { pathInside as lexicalPathInside } from "./paths";
import { commitDestination, prepareWorkspaceCommit, publishWorkspaceCommit, type WorkspaceCommit } from "./workspace-commits";

export type WorkspaceKind = "task" | "child";
export type WorkspaceLifecycle =
  | "active"
  | "integration_pending"
  | "conflicted"
  | "retained"
  | "cleanup_failed"
  | "integrated"
  | "discard_pending"
  | "discarded";
export type WorkspaceIntegration = "pending" | "none" | "applied" | "conflict" | "failed";

export type WorkspaceIntegrationReview = {
  applied: boolean;
  before: string;
  after: string;
  files: { path: string; status: string; additions: number | null; deletions: number | null }[];
  ignoredFiles: string[];
};

export type WorkspaceRecord = {
  version: 1;
  id: string;
  kind: WorkspaceKind;
  label: string;
  lifecycle: WorkspaceLifecycle;
  destinationRoot: string;
  destinationCwd: string;
  relativeCwd: string;
  worktreePath: string;
  workspaceCwd: string;
  baselineCommit: string;
  baselineTree: string;
  baselineRef: string;
  resultCommit?: string;
  resultTree?: string;
  resultRef?: string;
  sourceSessionFile?: string;
  targetSessionFile?: string;
  parentWorkspaceId?: string;
  runId?: string;
  /** Service-owned child work must finish cleanup before capture/application/removal. */
  managedCleanupPending?: string;
  integration: WorkspaceIntegration;
  integrationReason?: string;
  integrationReview?: WorkspaceIntegrationReview;
  integrationCommit?: WorkspaceCommit;
  integrationIgnoredChanges?: { path: string; hash: string }[];
  reverts?: { workspaceId: string; commit: string; reason: string; prepared: boolean };
  changedFiles: string[];
  includedIgnoredFiles?: { path: string; originalHash: string }[];
  unpreservedFiles?: string[];
  resultPatchPath: string;
  applicationPatchPath: string;
  conflictPath: string;
  retained: boolean;
  createdAt: string;
  updatedAt: string;
};

export type WorkspaceDisplayState = {
  id?: string;
  kind?: WorkspaceKind;
  baselineTree?: string;
  name: string;
  branch?: string;
  path: string;
  cwd: string;
  directory: string;
  project: string;
  sessionFile?: string;
  lifecycle: WorkspaceLifecycle | "local" | "external";
  localCheckout: boolean;
  transitionPending?: boolean;
};

type Snapshot = {
  head: string;
  branch?: string;
  commit: string;
  tree: string;
  ref: string;
  indexFingerprint: string;
};

type GitResult = {
  status: number;
  stdout: Buffer;
  stderr: Buffer;
};

export const WORKSPACE_CONTINUATION_STATUS = "pi-workspace-continuation";
type WorkspaceContinuation = { sessionFile: string; phase: "pending" | "starting" };
type WorkspaceGlobalState = {
  destinationQueues: Map<string, Promise<void>>;
  pendingWorkspaceId?: string;
  continuation?: WorkspaceContinuation;
  expectedWorkspaceMissing?: string;
};

const WORKSPACE_ROOT = resolve(
  process.env.PI_WORKSPACE_ROOT
  ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "pi", "workspaces"),
);
const RECORDS_DIR = join(WORKSPACE_ROOT, "records");
const TREES_DIR = join(WORKSPACE_ROOT, "trees");
const ARTIFACTS_DIR = join(WORKSPACE_ROOT, "artifacts");
const TEMP_DIR = join(WORKSPACE_ROOT, "tmp");
const LOCKS_DIR = join(WORKSPACE_ROOT, "locks");
const GLOBAL_KEY = Symbol.for("pi.agent.extensions.workspace-state");
const globalObject = globalThis as typeof globalThis & Record<symbol, WorkspaceGlobalState | undefined>;
const globalState: WorkspaceGlobalState = globalObject[GLOBAL_KEY] ??= { destinationQueues: new Map() };

function ensureDirectories(): void {
  for (const path of [RECORDS_DIR, TREES_DIR, ARTIFACTS_DIR, TEMP_DIR, LOCKS_DIR]) {
    mkdirSync(path, { recursive: true });
  }
}

function canonicalPath(path: string): string {
  let current = resolve(path);
  const suffix: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) {
      return resolve(path);
    }
    suffix.unshift(basename(current));
    current = parent;
  }
  return resolve(realpathSync.native(current), ...suffix);
}

function canonicalSessionFile(sessionFile: string | undefined): string | undefined {
  return sessionFile ? canonicalPath(sessionFile) : undefined;
}

export function sameSessionFile(left: string | undefined, right: string | undefined): boolean {
  return canonicalSessionFile(left) === canonicalSessionFile(right);
}

export function pathInside(parent: string, child: string): boolean {
  return lexicalPathInside(canonicalPath(parent), canonicalPath(child));
}

function gitResult(cwd: string, args: string[], options: { env?: NodeJS.ProcessEnv; input?: Buffer } = {}): GitResult {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    env: options.env,
    input: options.input,
    encoding: null,
    maxBuffer: 128 * 1024 * 1024,
    // Bounded service cleanup; ordinary interactive workspace behavior is unchanged.
    ...(process.env.PI_CONSOLE_SERVICE === "1" ? { timeout: 10000, killSignal: "SIGKILL" as const } : {}),
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? Buffer.alloc(0),
    stderr: result.stderr ?? Buffer.from(result.error?.message ?? "", "utf8"),
  };
}

function gitBuffer(cwd: string, args: string[], options: { env?: NodeJS.ProcessEnv; input?: Buffer } = {}): Buffer {
  const result = gitResult(cwd, args, options);
  if (result.status !== 0) {
    const detail = result.stderr.toString("utf8").trim() || result.stdout.toString("utf8").trim();
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${detail || `exit ${result.status}`}`);
  }
  return result.stdout;
}

function gitText(cwd: string, args: string[], options: { env?: NodeJS.ProcessEnv; input?: Buffer } = {}): string {
  return gitBuffer(cwd, args, options).toString("utf8").trimEnd();
}

function gitTextOrUndefined(cwd: string, args: string[]): string | undefined {
  const result = gitResult(cwd, args);
  if (result.status !== 0) {
    return undefined;
  }
  return result.stdout.toString("utf8").trim() || undefined;
}

function splitNul(output: Buffer): string[] {
  return output.toString("utf8").split("\0").filter((entry) => entry.length > 0);
}

function fingerprint(path: string): string {
  if (!existsSync(path)) {
    return "missing";
  }
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function regularFileHash(root: string, path: string): string {
  const absolute = join(root, path);
  if (!pathInside(root, absolute) || !lstatSync(absolute).isFile()) {
    throw new Error(`Expected a regular file inside ${root}: ${path}`);
  }
  const hash = createHash("sha256");
  const handle = openSync(absolute, "r");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    let bytesRead: number;
    while ((bytesRead = readSync(handle, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, bytesRead));
    }
    return hash.digest("hex");
  } finally {
    closeSync(handle);
  }
}

function ignoredFilePaths(root: string, cwd: string, paths: string[]): string[] {
  const result = new Set<string>();
  for (const path of paths) {
    if (!path || path.includes("\0") || path.startsWith("/") || resolve(cwd, path) === resolve(root)) {
      throw new Error(`Expected a relative ignored file path: ${path}`);
    }
    const absolute = resolve(cwd, path);
    if (!pathInside(root, absolute) || !lstatSync(absolute).isFile()) {
      throw new Error(`Expected a regular file inside the repository: ${path}`);
    }
    const relativePath = relative(root, absolute);
    if (gitBuffer(root, ["ls-files", "--cached", "-z", "--", relativePath]).length > 0
      || gitResult(root, ["check-ignore", "-q", "--", relativePath]).status !== 0) {
      throw new Error(`File is not ignored and untracked: ${path}`);
    }
    result.add(relativePath);
  }
  return [...result];
}

function safeRefSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._/-]+/g, "-").replace(/^[-/.]+|[-/.]+$/g, "") || randomUUID();
}

function snapshotRef(workspaceId: string, purpose: string): string {
  return `refs/pi/workspaces/${safeRefSegment(workspaceId)}/${safeRefSegment(purpose)}`;
}

function updateRef(cwd: string, ref: string, commit: string): void {
  gitBuffer(cwd, ["update-ref", ref, commit]);
}

function deleteRef(cwd: string, ref: string | undefined): void {
  if (!ref) {
    return;
  }
  const result = gitResult(cwd, ["update-ref", "-d", ref]);
  if (result.status !== 0) {
    throw new Error(result.stderr.toString("utf8").trim() || `Could not delete ${ref}`);
  }
}

function rejectUnsupportedRepositoryState(gitRoot: string): void {
  if (gitBuffer(gitRoot, ["ls-files", "-u", "-z"]).length > 0) {
    throw new Error("Cannot snapshot a repository with unresolved index conflicts.");
  }
  if (gitTextOrUndefined(gitRoot, ["config", "--bool", "core.sparseCheckout"]) === "true") {
    throw new Error("Sparse checkouts are not supported by Pi workspaces yet.");
  }
  const submoduleCheck = gitResult(gitRoot, [
    "submodule",
    "foreach",
    "--recursive",
    "--quiet",
    "test -z \"$(git status --porcelain=v1 --untracked-files=all)\"",
  ]);
  if (submoduleCheck.status !== 0) {
    throw new Error("Dirty submodule working trees are not supported by Pi workspaces.");
  }
}

function captureSnapshot(gitRoot: string, workspaceId: string, purpose: string): Snapshot {
  ensureDirectories();
  rejectUnsupportedRepositoryState(gitRoot);
  const head = gitText(gitRoot, ["rev-parse", "HEAD"]).trim();
  const branch = gitTextOrUndefined(gitRoot, ["symbolic-ref", "--quiet", "HEAD"]);
  const indexPath = gitText(gitRoot, ["rev-parse", "--path-format=absolute", "--git-path", "index"]).trim();
  const tempIndex = join(TEMP_DIR, `${safeRefSegment(workspaceId)}-${safeRefSegment(purpose)}-${randomUUID()}.index`);
  try {
    if (existsSync(indexPath)) {
      copyFileSync(indexPath, tempIndex);
    } else {
      writeFileSync(tempIndex, Buffer.alloc(0));
      gitBuffer(gitRoot, ["read-tree", head], { env: { ...process.env, GIT_INDEX_FILE: tempIndex } });
    }
    const env = { ...process.env, GIT_INDEX_FILE: tempIndex };
    gitBuffer(gitRoot, ["add", "-A"], { env });
    const tree = gitText(gitRoot, ["write-tree"], { env }).trim();
    const commit = commitSnapshotTree(gitRoot, tree, head, purpose);
    const ref = snapshotRef(workspaceId, purpose);
    updateRef(gitRoot, ref, commit);
    return { head, branch, commit, tree, ref, indexFingerprint: fingerprint(indexPath) };
  } finally {
    rmSync(tempIndex, { force: true });
  }
}

function commitSnapshotTree(gitRoot: string, tree: string, parent: string, purpose: string): string {
  return gitText(gitRoot, ["commit-tree", tree, "-p", parent], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Pi Workspace",
      GIT_AUTHOR_EMAIL: "workspace@pi.local",
      GIT_COMMITTER_NAME: "Pi Workspace",
      GIT_COMMITTER_EMAIL: "workspace@pi.local",
    },
    input: Buffer.from(`Pi workspace ${purpose}\n`, "utf8"),
  }).trim();
}

function integrationFiles(root: string, before: string, after: string): WorkspaceIntegrationReview["files"] {
  const revisions = [before, after];
  const statuses = splitNul(gitBuffer(root, ["diff", "--no-renames", "--name-status", "-z", ...revisions]));
  const statusByPath = new Map<string, string>();
  for (let i = 0; i < statuses.length; i += 2) {
    statusByPath.set(statuses[i + 1]!, statuses[i]!);
  }
  return splitNul(gitBuffer(root, ["diff", "--no-renames", "--numstat", "-z", ...revisions])).map((entry) => {
    const [, added, deleted, path] = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(entry) ?? [];
    if (!path || !added || !deleted || !statusByPath.has(path)) throw new Error("Invalid integration diff statistics.");
    return {
      path,
      status: statusByPath.get(path)!,
      additions: added === "-" ? null : Number(added),
      deletions: deleted === "-" ? null : Number(deleted),
    };
  });
}

function integrationReview(record: WorkspaceRecord, destination: Snapshot, mergedTree: string): WorkspaceIntegrationReview {
  const files = integrationFiles(record.destinationRoot, destination.tree, mergedTree);
  const after = commitSnapshotTree(record.destinationRoot, mergedTree, destination.commit, "integration-after");
  // These refs deliberately outlive worktree cleanup and keep the history
  // reachable through Git garbage collection without changing a user branch.
  const attempt = randomUUID();
  updateRef(record.destinationRoot, snapshotRef(record.id, `integration-${attempt}-before`), destination.commit);
  updateRef(record.destinationRoot, snapshotRef(record.id, `integration-${attempt}-after`), after);
  return { applied: false, before: destination.commit, after, files, ignoredFiles: [] };
}

export function formatIntegrationSummary(record: WorkspaceRecord): string {
  const lines = [record.integrationReview ? formatIntegrationChanges(record.integrationReview) : ""];
  if (record.integrationCommit) {
    lines.push(`Commit (${record.integrationCommit.status}): ${record.integrationCommit.oid}`,
      record.integrationCommit.message.split("\n")[0]!);
  }
  if (record.reverts) lines.push(`Reverts: ${record.reverts.commit}\nReason: ${record.reverts.reason}`);
  if (record.integrationReview?.ignoredFiles.length) lines.push("Ignored-file updates are outside the commit and cannot be undone by Git revert.");
  return lines.filter(Boolean).join("\n\n");
}

function formatIntegrationChanges(review: Pick<WorkspaceIntegrationReview, "files" | "ignoredFiles">, pending = false): string {
  const displayPath = (path: string): string => /[\s"\\]/.test(path) ? JSON.stringify(path) : path;
  const lines = review.files.map((file) => {
    const counts = file.additions === null || file.deletions === null ? "binary" : `+${file.additions}  -${file.deletions}`;
    return `${file.status}  ${displayPath(file.path)}  ${counts}`;
  });
  if (lines.length > 0) {
    const additions = review.files.reduce((sum, file) => sum + (file.additions ?? 0), 0);
    const deletions = review.files.reduce((sum, file) => sum + (file.deletions ?? 0), 0);
    lines.push("", `${review.files.length} ${review.files.length === 1 ? "file" : "files"} changed, ${additions} insertions(+), ${deletions} deletions(-)`);
  } else if (review.ignoredFiles.length === 0) {
    lines.push(pending ? "No changes to apply." : "No changes applied.");
  }
  if (review.ignoredFiles.length > 0) {
    lines.push("", `${pending ? "Ignored files to update" : "Updated ignored files"} (outside Git diff; line counts unavailable):`, ...review.ignoredFiles.map(displayPath));
  }
  return lines.join("\n");
}

function recordPath(id: string): string {
  return join(RECORDS_DIR, `${safeRefSegment(id)}.json`);
}

function saveWorkspace(record: WorkspaceRecord): void {
  ensureDirectories();
  record.updatedAt = new Date().toISOString();
  const destination = recordPath(record.id);
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  renameSync(temporary, destination);
}

export function loadWorkspace(id: string): WorkspaceRecord | undefined {
  const path = recordPath(id);
  if (!existsSync(path)) {
    return undefined;
  }
  try {
    return JSON.parse(readFileSync(path, "utf8")) as WorkspaceRecord;
  } catch {
    return undefined;
  }
}

export function listWorkspaces(): WorkspaceRecord[] {
  ensureDirectories();
  const records: WorkspaceRecord[] = [];
  for (const entry of readdirSync(RECORDS_DIR, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }
    try {
      records.push(JSON.parse(readFileSync(join(RECORDS_DIR, entry.name), "utf8")) as WorkspaceRecord);
    } catch {
      // A partially copied or manually edited record is not authoritative.
    }
  }
  return records.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function findGitRoot(cwd: string): string | undefined {
  return gitTextOrUndefined(cwd, ["rev-parse", "--show-toplevel"]);
}

export function createWorkspace(input: {
  kind: WorkspaceKind;
  destinationCwd: string;
  sourceSessionFile?: string;
  parentWorkspaceId?: string;
  runId?: string;
  label?: string;
  ignoredFiles?: string[];
}): WorkspaceRecord {
  const destinationRoot = findGitRoot(input.destinationCwd);
  if (!destinationRoot) {
    throw new Error("Pi workspaces require a Git repository.");
  }
  const destinationCwd = canonicalPath(input.destinationCwd);
  if (!pathInside(destinationRoot, destinationCwd)) {
    throw new Error(`Working directory is outside repository root: ${destinationCwd}`);
  }
  if (pathInside(destinationRoot, WORKSPACE_ROOT)) {
    throw new Error(`Pi workspace storage must be outside the destination repository. Set PI_WORKSPACE_ROOT to an external path (current: ${WORKSPACE_ROOT}).`);
  }
  const includedPaths = ignoredFilePaths(destinationRoot, destinationCwd, input.ignoredFiles ?? []);
  const id = `${input.kind}-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const baseline = captureSnapshot(destinationRoot, id, "baseline");
  const requestedWorktreePath = join(TREES_DIR, id);
  gitBuffer(destinationRoot, ["worktree", "add", "--detach", requestedWorktreePath, baseline.commit]);
  const worktreePath = canonicalPath(requestedWorktreePath);
  const relativeCwd = relative(destinationRoot, destinationCwd);
  const workspaceCwd = relativeCwd ? join(worktreePath, relativeCwd) : worktreePath;
  const artifactDir = join(ARTIFACTS_DIR, id);
  mkdirSync(artifactDir, { recursive: true });
  const includedIgnoredFiles: NonNullable<WorkspaceRecord["includedIgnoredFiles"]> = [];
  try {
    for (const path of includedPaths) {
      const originalHash = regularFileHash(destinationRoot, path);
      const target = join(worktreePath, path);
      if (!pathInside(worktreePath, target) || existsSync(target)) {
        throw new Error(`Cannot copy ignored file into worktree: ${path}`);
      }
      mkdirSync(dirname(target), { recursive: true });
      if (!pathInside(worktreePath, target)) {
        throw new Error(`Ignored file would escape the worktree: ${path}`);
      }
      copyFileSync(join(destinationRoot, path), target);
      if (regularFileHash(worktreePath, path) !== originalHash || regularFileHash(destinationRoot, path) !== originalHash) {
        throw new Error(`Ignored file changed while entering the workspace: ${path}`);
      }
      includedIgnoredFiles.push({ path, originalHash });
    }
  } catch (error) {
    const removed = gitResult(destinationRoot, ["worktree", "remove", "--force", worktreePath]);
    if (removed.status !== 0) {
      throw new Error(`Could not copy ignored files; worktree retained at ${worktreePath}: ${removed.stderr.toString("utf8").trim()}`, { cause: error });
    }
    deleteRef(destinationRoot, baseline.ref);
    throw error;
  }
  const now = new Date().toISOString();
  const record: WorkspaceRecord = {
    version: 1,
    id,
    kind: input.kind,
    label: input.label ?? `${input.kind}-${id.slice(-8)}`,
    lifecycle: "active",
    destinationRoot,
    destinationCwd,
    relativeCwd,
    worktreePath,
    workspaceCwd,
    baselineCommit: baseline.commit,
    baselineTree: baseline.tree,
    baselineRef: baseline.ref,
    sourceSessionFile: canonicalSessionFile(input.sourceSessionFile),
    parentWorkspaceId: input.parentWorkspaceId,
    runId: input.runId,
    managedCleanupPending: process.env.PI_CONSOLE_SERVICE === "1" && input.kind === "child" ? input.runId : undefined,
    integration: "pending",
    changedFiles: [],
    includedIgnoredFiles,
    resultPatchPath: join(artifactDir, "result.patch"),
    applicationPatchPath: join(artifactDir, "application.patch"),
    conflictPath: join(artifactDir, "conflict.txt"),
    retained: true,
    createdAt: now,
    updatedAt: now,
  };
  saveWorkspace(record);
  return record;
}

export function isWorkspaceFinalized(record: WorkspaceRecord): boolean {
  return record.integration === "applied" || record.integration === "none";
}

export function workspaceForContext(cwd: string, _sessionFile?: string): WorkspaceRecord | undefined {
  const resolvedCwd = canonicalPath(cwd);
  const envId = process.env.PI_WORKSPACE_ID;
  if (envId) {
    const record = loadWorkspace(envId);
    if (record && record.retained && pathInside(record.worktreePath, resolvedCwd)) {
      return record;
    }
  }
  const candidates = listWorkspaces().filter((record) => {
    if (!record.retained) {
      return false;
    }
    return pathInside(record.worktreePath, resolvedCwd);
  });
  return candidates.sort((left, right) => right.worktreePath.length - left.worktreePath.length)[0];
}

export function retainedChildWorkspaces(parentId: string): WorkspaceRecord[] {
  return listWorkspaces().filter((record) =>
    record.kind === "child" && record.retained && record.parentWorkspaceId === parentId,
  );
}

/** A deletion may remove a parent only when every retained child is selected. */
export function orderWorkspaceDeletion(records: WorkspaceRecord[]): WorkspaceRecord[] {
  const selected = new Map(records.map((record) => [record.id, record]));
  const all = listWorkspaces();
  const ordered: WorkspaceRecord[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (record: WorkspaceRecord): void => {
    if (visited.has(record.id)) return;
    if (visiting.has(record.id)) throw new Error(`Workspace ancestry is cyclic at ${record.label}.`);
    assertManagedCleanup(record);
    visiting.add(record.id);
    for (const child of all.filter((child) => child.parentWorkspaceId === record.id
      && (child.retained || child.lifecycle === "cleanup_failed"))) {
      const included = selected.get(child.id);
      if (!included) throw new Error(`Child workspace ${child.label} is still referenced outside this deletion; ${record.label} was kept.`);
      visit(included);
    }
    visiting.delete(record.id);
    visited.add(record.id);
    ordered.push(record);
  };
  for (const record of records) visit(record);
  return ordered;
}

export function sessionWorkspacesForDeletion(sessionFiles: string[]): WorkspaceRecord[] {
  return orderWorkspaceDeletion(listWorkspaces().filter((record) => (record.retained || record.lifecycle === "cleanup_failed")
    && sessionFiles.some((path) => sameSessionFile(record.sourceSessionFile, path) || sameSessionFile(record.targetSessionFile, path))));
}

export function taskWorkspacesForSession(sessionFile: string | undefined): WorkspaceRecord[] {
  return sessionFile ? listWorkspaces().filter((record) =>
    record.kind === "task" && record.retained && sameSessionFile(record.sourceSessionFile, sessionFile),
  ) : [];
}

export function setPendingWorkspace(id: string | undefined): void {
  globalState.pendingWorkspaceId = id;
}

export function getPendingWorkspaceId(): string | undefined {
  return globalState.pendingWorkspaceId;
}

export function beginWorkspaceContinuation(sessionFile: string): WorkspaceContinuation {
  return globalState.continuation = { sessionFile, phase: "pending" };
}

export function getWorkspaceContinuation(sessionFile: string | undefined): WorkspaceContinuation | undefined {
  const continuation = globalState.continuation;
  return continuation && sameSessionFile(continuation.sessionFile, sessionFile) ? continuation : undefined;
}

export function clearWorkspaceContinuation(continuation: WorkspaceContinuation): void {
  // A completed continuation may already have queued its next workspace switch.
  if (globalState.continuation === continuation) globalState.continuation = undefined;
}

export function setExpectedWorkspaceMissing(id: string | undefined): void {
  globalState.expectedWorkspaceMissing = id;
}

export function getExpectedWorkspaceMissing(): string | undefined {
  return globalState.expectedWorkspaceMissing;
}

function snapshotWorkspaceResult(record: WorkspaceRecord): WorkspaceRecord {
  if (!existsSync(record.worktreePath)) {
    throw new Error(`Workspace path is missing: ${record.worktreePath}`);
  }
  const result = captureSnapshot(record.worktreePath, record.id, "result");
  record.resultCommit = result.commit;
  record.resultTree = result.tree;
  record.resultRef = result.ref;
  const patch = gitBuffer(record.worktreePath, ["diff", "--binary", "--full-index", record.baselineTree, result.tree]);
  writeFileSync(record.resultPatchPath, patch);
  record.changedFiles = splitNul(gitBuffer(record.worktreePath, ["diff", "--no-renames", "--name-only", "-z", record.baselineTree, result.tree]));
  const included = new Set((record.includedIgnoredFiles ?? []).map((file) => file.path));
  record.unpreservedFiles = splitNul(gitBuffer(record.worktreePath, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"]))
    .filter((path) => !included.has(path));
  saveWorkspace(record);
  return record;
}

export function workspaceDiscardWarning(records: WorkspaceRecord[]): string {
  if (records.length === 0) return "";
  const lines = ["The following worktrees will also be removed. Unintegrated changes will be discarded; existing destination changes will not be reverted:"];
  for (const record of records) {
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

function assertManagedCleanup(record: WorkspaceRecord): void {
  if (record.managedCleanupPending) throw new Error(`Workspace ${record.id} has known unresolved managed writers (${record.managedCleanupPending}); capture/integration/removal blocked`);
}

export async function prepareWorkspaceDiscard(id: string): Promise<WorkspaceRecord> {
  return withWorkspaceLock(id, async (record) => {
    assertManagedCleanup(record);
    assertCommitSettled(record);
    if (isWorkspaceFinalized(record)) return record;
    assertWorkspaceAvailable(record);
    return snapshotWorkspaceResult(record);
  });
}

/** Update live metadata from the record reloaded under the mutation lock. */
export async function updateWorkspace(id: string, update: (record: WorkspaceRecord) => void): Promise<WorkspaceRecord> {
  return withWorkspaceLock(id, async (record) => {
    if (isWorkspaceFinalized(record)) return record;
    assertWorkspaceAvailable(record);
    update(record);
    saveWorkspace(record);
    return record;
  });
}

function checkCancellation(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Workspace operation aborted before application.");
}

async function withWorkspaceLock<T>(id: string, fn: (record: WorkspaceRecord) => Promise<T>, signal?: AbortSignal): Promise<T> {
  checkCancellation(signal);
  const initial = loadWorkspace(id);
  if (!initial) throw new Error(`Unknown workspace: ${id}`);
  return withDestinationQueue(initial.destinationRoot, async () => {
    checkCancellation(signal);
    const releaseLock = await acquireFilesystemLock(initial.destinationRoot, signal);
    try {
      checkCancellation(signal);
      const record = loadWorkspace(id);
      if (!record) throw new Error(`Workspace record disappeared: ${id}`);
      return await fn(record);
    } finally {
      releaseLock();
    }
  });
}

async function withDestinationQueue<T>(destinationRoot: string, fn: () => Promise<T>): Promise<T> {
  const key = resolve(destinationRoot);
  const previous = globalState.destinationQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolvePromise) => {
    release = resolvePromise;
  });
  const chained = previous.then(() => current);
  globalState.destinationQueues.set(key, chained);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (globalState.destinationQueues.get(key) === chained) globalState.destinationQueues.delete(key);
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Lack of permission to inspect a process is not proof that it died.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function acquireFilesystemLock(destinationRoot: string, signal?: AbortSignal): Promise<() => void> {
  ensureDirectories();
  const key = createHash("sha256").update(resolve(destinationRoot)).digest("hex").slice(0, 24);
  const lockPath = join(LOCKS_DIR, `${key}.lock`);
  const ownerPath = join(lockPath, "owner.json");
  const deadline = Date.now() + 30_000;
  while (true) {
    checkCancellation(signal);
    try {
      mkdirSync(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const owner = JSON.parse(readFileSync(ownerPath, "utf8")) as { pid?: unknown };
        if (typeof owner.pid === "number" && !processAlive(owner.pid)) {
          rmSync(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch {
        try {
          if (Date.now() - statSync(lockPath).mtimeMs > 30_000) {
            rmSync(lockPath, { recursive: true, force: true });
            continue;
          }
        } catch {
          continue;
        }
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for workspace mutation in ${destinationRoot}`);
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
      continue;
    }
    try {
      writeFileSync(ownerPath, JSON.stringify({ pid: process.pid, destinationRoot, createdAt: new Date().toISOString() }), "utf8");
    } catch (error) {
      rmSync(lockPath, { recursive: true, force: true });
      throw error;
    }
    return () => rmSync(lockPath, { recursive: true, force: true });
  }
}

async function withMutationQueues<T>(paths: string[], fn: () => Promise<T>): Promise<T> {
  const ordered = [...new Set(paths.map((path) => resolve(path)))].sort();
  const run = async (index: number): Promise<T> => {
    if (index >= ordered.length) {
      return fn();
    }
    return withFileMutationQueue(ordered[index]!, () => run(index + 1));
  };
  return run(0);
}

function mergeTree(record: WorkspaceRecord, destination: Snapshot): { mergedTree?: string; diagnostics?: string } {
  if (!record.resultTree) {
    throw new Error("Workspace result snapshot is missing.");
  }
  const result = gitResult(record.destinationRoot, [
    "merge-tree",
    "--write-tree",
    `--merge-base=${record.baselineTree}`,
    destination.tree,
    record.resultTree,
  ]);
  const stdout = result.stdout.toString("utf8");
  const stderr = result.stderr.toString("utf8");
  if (result.status === 1) {
    return { diagnostics: `${stdout}${stderr}`.trim() || "Git reported a merge conflict." };
  }
  if (result.status !== 0) {
    throw new Error(`${stdout}${stderr}`.trim() || `git merge-tree exited ${result.status}`);
  }
  const mergedTree = stdout.split("\n", 1)[0]?.trim();
  if (!mergedTree) {
    throw new Error("git merge-tree did not return a merged tree.");
  }
  return { mergedTree };
}

function realIndexFingerprint(gitRoot: string): string {
  const indexPath = gitText(gitRoot, ["rev-parse", "--path-format=absolute", "--git-path", "index"]).trim();
  return fingerprint(indexPath);
}

function changedIgnoredFiles(record: WorkspaceRecord): { path: string; hash: string }[] {
  const changed: { path: string; hash: string }[] = [];
  for (const file of record.includedIgnoredFiles ?? []) {
    if (record.resultTree && gitBuffer(record.worktreePath, ["ls-tree", "-r", "-z", record.resultTree, "--", file.path]).length > 0) {
      throw new Error(`Included ignored file became tracked in the workspace: ${file.path}`);
    }
    const hash = regularFileHash(record.worktreePath, file.path);
    if (hash === file.originalHash) continue;
    const destinationHash = regularFileHash(record.destinationRoot, file.path);
    if (gitBuffer(record.destinationRoot, ["ls-files", "--cached", "-z", "--", file.path]).length > 0
      || gitResult(record.destinationRoot, ["check-ignore", "-q", "--", file.path]).status !== 0) {
      throw new Error(`Included file is no longer ignored and untracked: ${file.path}`);
    }
    if (destinationHash !== file.originalHash && destinationHash !== hash) {
      throw new Error(`Ignored file changed in the original checkout; refusing to overwrite: ${file.path}`);
    }
    changed.push({ path: file.path, hash });
  }
  return changed;
}

function assertWorkspaceAvailable(record: WorkspaceRecord): void {
  if (record.lifecycle === "discarded") {
    throw new Error(`Workspace ${record.id} was discarded and is not eligible for integration.`);
  }
  if (!record.retained || !existsSync(record.worktreePath)) {
    throw new Error(`Worktree is unavailable for workspace ${record.id}.`);
  }
}

function prepareIntegration(record: WorkspaceRecord): {
  destination: Snapshot;
  merge: ReturnType<typeof mergeTree>;
  ignoredChanges: { path: string; hash: string }[];
} {
  snapshotWorkspaceResult(record);
  const ignoredChanges = changedIgnoredFiles(record);
  const destination = captureSnapshot(record.destinationRoot, record.id, `destination-${randomUUID()}`);
  try {
    return { destination, merge: mergeTree(record, destination), ignoredChanges };
  } catch (error) {
    deleteRef(record.destinationRoot, destination.ref);
    throw error;
  }
}

/** Prepare the same destination-relative comparison as integration, without applying it. */
export async function previewWorkspaceIntegration(id: string, signal?: AbortSignal): Promise<string> {
  return withWorkspaceLock(id, async (record) => {
    assertManagedCleanup(record);
    if (isWorkspaceFinalized(record)) return formatIntegrationSummary(record);
    assertWorkspaceAvailable(record);
    if (record.integrationCommit) return `${formatIntegrationSummary(record)}\n\nResume the recorded commit attempt only if the saved destination state still matches; no new task patch will be computed.`;
    const { destination, merge, ignoredChanges } = prepareIntegration(record);
    try {
      checkCancellation(signal);
      if (!merge.mergedTree) {
        return `Integration conflicts prevent application. Review / modify the workspace before trying again.\n\n${merge.diagnostics ?? "Git reported a merge conflict."}`;
      }
      return formatIntegrationChanges({
        files: integrationFiles(record.destinationRoot, destination.tree, merge.mergedTree),
        ignoredFiles: ignoredChanges
          .filter((file) => regularFileHash(record.destinationRoot, file.path) !== file.hash)
          .map((file) => file.path),
      }, true);
    } finally {
      deleteRef(record.destinationRoot, destination.ref);
    }
  }, signal);
}

export async function integrateWorkspace(id: string, signal?: AbortSignal, options: { commitMessage?: string } = {}): Promise<WorkspaceRecord> {
  return withWorkspaceLock(id, async (record) => {
    assertManagedCleanup(record);
    let applicationStarted = false;
    let destinationRef: string | undefined;
    try {
      // Finalized contributions are idempotent, including after cleanup.
      if (isWorkspaceFinalized(record)) return record;
      assertWorkspaceAvailable(record);
      if (record.reverts) {
        if (!record.reverts.prepared) throw new Error("Revert preparation conflicted; discard this workspace and review the target before retrying.");
        assertRevertTarget(record.destinationRoot, record.reverts.workspaceId, record.id);
        if (!options.commitMessage && !record.integrationCommit) throw new Error("Revert integration requires a commit message.");
      }
      // Resume only a recorded publication, never recompute/reapply a task delta
      // against files that may already contain it after an interrupted attempt.
      if (record.integrationCommit) return await resumeWorkspaceCommit(record, signal);
      // Each tool result owns one attempt; previous results keep their pinned
      // revisions even when a retry fails before preparing a new comparison.
      delete record.integrationReview;
      record.integration = "pending";
      delete record.integrationReason;
      saveWorkspace(record);
      const { destination, merge } = prepareIntegration(record);
      destinationRef = destination.ref;
      if (!merge.mergedTree) {
        const diagnostics = merge.diagnostics ?? "Git reported a merge conflict.";
        writeFileSync(record.conflictPath, `${diagnostics}\n`, "utf8");
        record.integration = "conflict";
        record.integrationReason = diagnostics;
        record.lifecycle = "conflicted";
        saveWorkspace(record);
        return record;
      }

      const applicationPatch = gitBuffer(record.destinationRoot, [
        "diff",
        "--binary",
        "--full-index",
        destination.tree,
        merge.mergedTree,
      ]);
      writeFileSync(record.applicationPatchPath, applicationPatch);
      const affected = splitNul(gitBuffer(record.destinationRoot, [
        "diff",
        "--no-renames",
        "--name-only",
        "-z",
        destination.tree,
        merge.mergedTree,
      ]));
      const absoluteAffected = affected.map((path) => join(record.destinationRoot, path));
      const ignoredAffected = (record.includedIgnoredFiles ?? []).map((file) => join(record.destinationRoot, file.path));
      let changedIncludedFile = false;

      await withMutationQueues([...absoluteAffected, ...ignoredAffected], async () => {
        checkCancellation(signal);
        // The destination lock excludes removal and record writers throughout
        // preparation and file-queue waits.
        const current = loadWorkspace(id);
        if (!current) throw new Error(`Workspace record disappeared: ${id}`);
        assertWorkspaceAvailable(current);
        const recheck = captureSnapshot(record.destinationRoot, record.id, `recheck-${randomUUID()}`);
        try {
          if (recheck.tree !== destination.tree || recheck.indexFingerprint !== destination.indexFingerprint
            || recheck.head !== destination.head || recheck.branch !== destination.branch) {
            throw new Error("Destination changed while integration was being prepared; retry integration.");
          }
          const ignoredChanges = changedIgnoredFiles(record);
          checkCancellation(signal);
          const review = integrationReview(record, destination, merge.mergedTree!);
          record.integrationReview = review;
          record.integrationIgnoredChanges = ignoredChanges;
          if (options.commitMessage && applicationPatch.length > 0) {
            record.integrationCommit = prepareWorkspaceCommit({
              root: record.destinationRoot, artifactDir: workspaceArtifactDir(record.id), workspaceId: record.id,
              sessionFile: record.sourceSessionFile, beforeTree: destination.tree, afterTree: merge.mergedTree!,
              sourceTree: record.resultTree!, patch: applicationPatch, message: options.commitMessage, expectedHead: destination.head,
              expectedBranch: destination.branch, expectedIndex: destination.indexFingerprint, reverts: record.reverts?.commit,
            });
          }
          // Preserve the attempted comparison and commit plan before mutation.
          saveWorkspace(record);
          const apply = () => {
            if (applicationPatch.length > 0) {
              gitBuffer(record.destinationRoot, ["apply", "--check", "--binary", "--whitespace=nowarn", record.applicationPatchPath]);
              const indexBefore = realIndexFingerprint(record.destinationRoot);
              applicationStarted = true;
              gitBuffer(record.destinationRoot, ["apply", "--binary", "--whitespace=nowarn", record.applicationPatchPath]);
              review.applied = true;
              saveWorkspace(record);
              if (realIndexFingerprint(record.destinationRoot) !== indexBefore) {
                throw new Error("Destination index changed during integration.");
              }
            }
            for (const file of ignoredChanges) {
              const destinationPath = join(record.destinationRoot, file.path);
              if (regularFileHash(record.destinationRoot, file.path) === file.hash) continue;
              const temporary = `${destinationPath}.pi-${randomUUID()}.tmp`;
              try {
                copyFileSync(join(record.worktreePath, file.path), temporary);
                if (regularFileHash(record.destinationRoot, relative(record.destinationRoot, temporary)) !== file.hash) {
                  throw new Error(`Ignored file changed while copying: ${file.path}`);
                }
                applicationStarted = true;
                renameSync(temporary, destinationPath);
                changedIncludedFile = true;
                review.ignoredFiles.push(file.path);
                review.applied = true;
                saveWorkspace(record);
              } finally {
                rmSync(temporary, { force: true });
              }
            }
            if (record.integrationCommit) assertCommittedWorktree(record);
          };
          if (record.integrationCommit) {
            publishWorkspaceCommit(record.destinationRoot, record.integrationCommit, () => saveWorkspace(record), apply);
            record.integrationCommit.status = "published";
            saveWorkspace(record);
          } else apply();
        } finally {
          deleteRef(record.destinationRoot, recheck.ref);
        }
      });

      record.integration = applicationPatch.length > 0 || changedIncludedFile ? "applied" : "none";
      record.integrationReason = undefined;
      record.lifecycle = "integration_pending";
      saveWorkspace(record);
      return record;
    } catch (error) {
      if (signal?.aborted && !applicationStarted) throw error;
      const record = loadWorkspace(id);
      if (!record || isWorkspaceFinalized(record)) throw error;
      // Do not resurrect a deleted record or turn removal into a merge failure.
      assertWorkspaceAvailable(record);
      if (record.integration !== "conflict") {
        record.integration = "failed";
        const reason = error instanceof Error ? error.message : String(error);
        record.integrationReason = applicationStarted
          ? `Destination mutation began; files may already have been applied. ${reason}`
          : reason;
        record.lifecycle = "retained";
        saveWorkspace(record);
      }
      return record;
    } finally {
      deleteRef(record.destinationRoot, destinationRef);
    }
  }, signal);
}

function assertCommitSettled(record: WorkspaceRecord): void {
  if (record.integrationCommit?.status === "prepared") {
    throw new Error("Recover the recorded integration commit before discarding its workspace or deleting its session. Destination files or the branch may already have changed; discard is not commit undo.");
  }
}

function assertCommittedWorktree(record: WorkspaceRecord): void {
  const snapshot = captureSnapshot(record.destinationRoot, record.id, `publication-${randomUUID()}`);
  try {
    if (snapshot.tree !== record.integrationCommit!.afterTree) throw new Error("Destination files changed during commit publication; inspect the retained attempt before retrying.");
  } finally { deleteRef(record.destinationRoot, snapshot.ref); }
}

async function resumeWorkspaceCommit(record: WorkspaceRecord, signal?: AbortSignal): Promise<WorkspaceRecord> {
  const plan = record.integrationCommit!, review = record.integrationReview;
  if (!review) throw new Error("Interrupted commit has no saved integration comparison; inspect its recovery metadata.");
  const paths = [...review.files.map(file => file.path), ...(record.integrationIgnoredChanges ?? []).map(file => file.path)]
    .map(path => join(record.destinationRoot, path));
  await withMutationQueues(paths, async () => {
    checkCancellation(signal);
    const source = captureSnapshot(record.worktreePath, record.id, `recovery-source-${randomUUID()}`);
    try {
      if (source.tree !== plan.sourceTree) throw new Error("Workspace changed after commit preparation; preserve the newer edits before recovering this integration.");
    } finally { deleteRef(record.worktreePath, source.ref); }
    const snapshot = captureSnapshot(record.destinationRoot, record.id, `recovery-${randomUUID()}`);
    try {
      if (snapshot.tree !== plan.beforeTree && snapshot.tree !== plan.afterTree) {
        throw new Error("Interrupted integration has partial or newer destination edits; inspect the saved comparison before continuing. No patch was reapplied.");
      }
      if (snapshot.tree === plan.beforeTree && (review.applied || snapshot.head !== plan.parent || snapshot.indexFingerprint !== plan.indexBefore)) {
        throw new Error("Interrupted integration no longer matches its original unapplied state; refusing to reapply it.");
      }
      for (const file of record.integrationIgnoredChanges ?? []) {
        if (regularFileHash(record.worktreePath, file.path) !== file.hash) throw new Error(`Ignored source changed since the recorded attempt: ${file.path}`);
      }
      const ignoredChanges = changedIgnoredFiles(record);
      const plannedIgnored = new Map((record.integrationIgnoredChanges ?? []).map(file => [file.path, file.hash]));
      if (ignoredChanges.length !== plannedIgnored.size || ignoredChanges.some(file => plannedIgnored.get(file.path) !== file.hash)) {
        throw new Error("Included ignored files changed after commit preparation; preserve those newer edits before recovering this integration.");
      }
      publishWorkspaceCommit(record.destinationRoot, plan, () => saveWorkspace(record), () => {
        if (snapshot.tree === plan.beforeTree) {
          gitBuffer(record.destinationRoot, ["apply", "--check", "--binary", "--whitespace=nowarn", record.applicationPatchPath]);
          gitBuffer(record.destinationRoot, ["apply", "--binary", "--whitespace=nowarn", record.applicationPatchPath]);
        }
        review.applied = true;
        saveWorkspace(record);
        for (const file of ignoredChanges) {
          const temporary = join(record.destinationRoot, `${file.path}.pi-${randomUUID()}.tmp`);
          try {
            copyFileSync(join(record.worktreePath, file.path), temporary);
            if (regularFileHash(record.destinationRoot, relative(record.destinationRoot, temporary)) !== file.hash) throw new Error(`Ignored source changed during recovery: ${file.path}`);
            renameSync(temporary, join(record.destinationRoot, file.path));
            if (!review.ignoredFiles.includes(file.path)) review.ignoredFiles.push(file.path);
            saveWorkspace(record);
          } finally { rmSync(temporary, { force: true }); }
        }
        assertCommittedWorktree(record);
      });
      plan.status = "published";
      record.integration = "applied";
      record.lifecycle = "integration_pending";
      delete record.integrationReason;
      saveWorkspace(record);
    } finally { deleteRef(record.destinationRoot, snapshot.ref); }
  });
  return record;
}

function assertRevertTarget(root: string, workspaceId: string, exceptId?: string): WorkspaceRecord {
  const target = loadWorkspace(workspaceId), commit = target?.integrationCommit;
  if (!target || target.kind !== "task" || canonicalPath(target.destinationRoot) !== canonicalPath(root)
    || commit?.status !== "published" || !isWorkspaceFinalized(target)) {
    throw new Error("Revert requires a successfully committed task integration in this destination repository.");
  }
  commitDestination(root);
  if (gitResult(root, ["merge-base", "--is-ancestor", commit.oid, "HEAD"]).status !== 0) {
    throw new Error("The recorded integration commit is not in the current branch's history.");
  }
  const parents = gitText(root, ["rev-list", "--parents", "-n", "1", commit.oid]).split(" ");
  if (parents.length !== 2 || parents[1] !== commit.parent) throw new Error("Recorded integration commit does not match its saved parent.");
  for (const other of listWorkspaces()) {
    if (other.id === exceptId || other.reverts?.commit !== commit.oid || canonicalPath(other.destinationRoot) !== canonicalPath(root)) continue;
    if (other.retained && !isWorkspaceFinalized(other)) throw new Error(`A reversal is already being prepared in workspace ${other.id}. Resume or discard it first.`);
    if (other.integrationCommit?.status === "published" && gitResult(root, ["merge-base", "--is-ancestor", other.integrationCommit.oid, "HEAD"]).status === 0) {
      throw new Error(`This integration already has a recorded revert: ${other.integrationCommit.oid}`);
    }
  }
  return target;
}

/** Prepare a reversal against the current checkout, never reset its branch or
 * replay a historical whole-file snapshot over later work. */
export async function createRevertWorkspace(input: {
  workspaceId: string; destinationCwd: string; sourceSessionFile: string; reason: string;
}, signal?: AbortSignal): Promise<WorkspaceRecord> {
  const root = findGitRoot(input.destinationCwd);
  if (!root || workspaceForContext(input.destinationCwd)) throw new Error("Prepare a revert from the origin checkout, outside any active workspace.");
  if (!input.reason.trim() || input.reason.includes("\0") || Buffer.byteLength(input.reason) > 8192) throw new Error("A revert reason is required (maximum 8 KiB, no NUL bytes).");
  return withWorkspaceLock(input.workspaceId, async () => {
    checkCancellation(signal);
    const target = assertRevertTarget(root, input.workspaceId);
    const commit = target.integrationCommit!;
    const record = createWorkspace({ kind: "task", destinationCwd: input.destinationCwd,
      sourceSessionFile: input.sourceSessionFile, label: `revert-${commit.oid.slice(0, 8)}` });
    record.reverts = { workspaceId: target.id, commit: commit.oid, reason: input.reason.trim(), prepared: false };
    saveWorkspace(record);
    // Reverse only this commit's delta; later compatible edits survive.
    const result = gitResult(root, ["merge-tree", "--write-tree", `--merge-base=${commit.oid}`, record.baselineCommit, commit.parent]);
    if (result.status !== 0) {
      record.lifecycle = "conflicted";
      record.integration = result.status === 1 ? "conflict" : "failed";
      record.integrationReason = result.stdout.toString("utf8") + result.stderr.toString("utf8");
      writeFileSync(record.conflictPath, record.integrationReason);
      saveWorkspace(record);
      return record;
    }
    const tree = result.stdout.toString("utf8").split("\n")[0]!.trim();
    const patch = gitBuffer(root, ["diff", "--binary", "--full-index", record.baselineTree, tree]);
    if (!patch.length) {
      record.integration = "failed";
      record.integrationReason = "The recorded change is already absent; no revert was prepared.";
      saveWorkspace(record);
      return record;
    }
    gitBuffer(record.worktreePath, ["apply", "--binary", "--whitespace=nowarn", "-"], { input: patch });
    record.reverts.prepared = true;
    snapshotWorkspaceResult(record);
    return record;
  }, signal);
}

function cleanupGitDirectory(record: WorkspaceRecord): string {
  const visited = new Set<string>();
  let current: WorkspaceRecord | undefined = record;
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    for (const path of [current.worktreePath, current.destinationRoot]) {
      if (!existsSync(path)) continue;
      const commonDir = gitTextOrUndefined(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
      if (commonDir) return commonDir;
    }
    // Older records can outlive both their worktree and their parent worktree.
    current = current.parentWorkspaceId ? loadWorkspace(current.parentWorkspaceId) : undefined;
  }
  throw new Error(`Could not locate the Git repository for ${record.label}.`);
}

export async function removeWorkspace(id: string, finalLifecycle: "integrated" | "discarded", sessionDeletion = false): Promise<WorkspaceRecord> {
  return withWorkspaceLock(id, async (record) => {
    assertManagedCleanup(record);
    assertCommitSettled(record);
    if (!record.retained && record.lifecycle !== "cleanup_failed") return record;
    if (sessionDeletion && record.retained) {
      assertWorkspaceAvailable(record);
      if (isWorkspaceFinalized(record)) {
        // Preserve the recorded integration snapshot and patch. A retained,
        // finalized worktree may have acquired new edits after failed cleanup.
        const current = captureSnapshot(record.worktreePath, record.id, "deletion-check-" + randomUUID());
        try {
          if (current.tree !== record.resultTree) throw new Error(`Finalized workspace ${record.label} has newer changes; preserve them before deleting its session.`);
        } finally { deleteRef(record.worktreePath, current.ref); }
      } else snapshotWorkspaceResult(record);
      // Capture/check and forced removal share the destination lock and have no
      // intervening await, so another managed writer cannot change the bytes.
    }
    // Integration may have won while a discard was waiting for the lock.
    // Cleanup must not relabel an already applied contribution as discarded.
    const lifecycle = isWorkspaceFinalized(record) ? "integrated" : finalLifecycle;
    if (lifecycle === "integrated" && !isWorkspaceFinalized(record)) {
      throw new Error(`Workspace ${id} has not been integrated.`);
    }
    return removeWorkspaceLocked(record, lifecycle);
  });
}

function removeWorkspaceLocked(record: WorkspaceRecord, finalLifecycle: "integrated" | "discarded"): WorkspaceRecord {
  try {
    if (retainedChildWorkspaces(record.id).length > 0) {
      throw new Error(`Join or discard child workspaces before removing ${record.label}.`);
    }
    // Cleanup only needs the shared repository, not the integration destination.
    const gitDir = cleanupGitDirectory(record);
    if (record.retained && existsSync(record.worktreePath)) {
      gitBuffer(gitDir, ["worktree", "remove", "--force", record.worktreePath]);
    }
    record.retained = false;
    record.lifecycle = finalLifecycle;
    saveWorkspace(record);
    deleteRef(gitDir, record.baselineRef);
    deleteRef(gitDir, record.resultRef);
    delete record.integrationReason;
  } catch (error) {
    record.lifecycle = "cleanup_failed";
    record.integrationReason = error instanceof Error ? error.message : String(error);
  }
  saveWorkspace(record);
  return record;
}

function branchAt(cwd: string): string | undefined {
  const symbolic = gitTextOrUndefined(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (symbolic) {
    return symbolic;
  }
  const commit = gitTextOrUndefined(cwd, ["rev-parse", "--short", "HEAD"]);
  return commit ? `detached@${commit}` : undefined;
}

export function workspaceDisplayState(cwd: string, sessionFile?: string): WorkspaceDisplayState {
  const gitRoot = findGitRoot(cwd);
  // Git lists the main checkout first, even from nested Pi or external worktrees.
  const project = gitRoot
    ? gitTextOrUndefined(gitRoot, ["worktree", "list", "--porcelain", "-z"])?.match(/^worktree ([^\0]+)\0/)?.[1] ?? gitRoot
    : canonicalPath(cwd);
  const record = workspaceForContext(cwd, sessionFile);
  if (record) {
    return {
      id: record.id,
      kind: record.kind,
      baselineTree: record.kind === "task" ? record.baselineTree : undefined,
      name: basename(record.worktreePath),
      branch: branchAt(record.worktreePath),
      path: record.worktreePath,
      cwd: canonicalPath(cwd),
      directory: record.destinationCwd,
      project,
      sessionFile,
      lifecycle: record.lifecycle,
      localCheckout: false,
    };
  }
  if (!gitRoot) {
    return {
      name: "Local checkout",
      path: canonicalPath(cwd),
      cwd: canonicalPath(cwd),
      directory: canonicalPath(cwd),
      project,
      sessionFile,
      lifecycle: "local",
      localCheckout: true,
    };
  }
  const gitDir = gitTextOrUndefined(gitRoot, ["rev-parse", "--path-format=absolute", "--git-dir"]);
  const commonDir = gitTextOrUndefined(gitRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const externalWorktree = !!gitDir && !!commonDir && resolve(gitDir) !== resolve(commonDir);
  return {
    name: externalWorktree ? basename(gitRoot) : "Local checkout",
    branch: branchAt(gitRoot),
    path: gitRoot,
    cwd: canonicalPath(cwd),
    directory: canonicalPath(cwd),
    project,
    sessionFile,
    lifecycle: externalWorktree ? "external" : "local",
    localCheckout: !externalWorktree,
  };
}

export function formatWorkspaceRecord(record: WorkspaceRecord): string {
  const lines = [
    `${record.label} (${record.kind}, ${record.lifecycle})`,
    `- id: ${record.id}`,
    `- worktree: ${record.worktreePath}`,
    `- cwd: ${record.workspaceCwd}`,
    `- destination: ${record.destinationRoot}`,
    `- baseline: ${record.baselineCommit}`,
    `- integration: ${record.integration}${record.integrationReason ? ` (${record.integrationReason})` : ""}`,
    ...(record.integrationCommit ? [`- commit (${record.integrationCommit.status}): ${record.integrationCommit.oid}`] : []),
    ...(record.reverts ? [`- reverts: ${record.reverts.commit} (${record.reverts.reason})`] : []),
    `- result patch: ${record.resultPatchPath}`,
    `- application patch: ${record.applicationPatchPath}`,
  ];
  if (record.sourceSessionFile) lines.push(`- owner session: ${record.sourceSessionFile}`);
  if (record.targetSessionFile) lines.push(`- child session: ${record.targetSessionFile}`);
  if (record.changedFiles.length > 0) lines.push(`- changed files: ${record.changedFiles.join(", ")}`);
  if (record.includedIgnoredFiles?.length) {
    lines.push(`- included ignored files (outside Git patch): ${record.includedIgnoredFiles.map((file) => file.path).join(", ")}`);
  }
  if (record.unpreservedFiles && record.unpreservedFiles.length > 0) {
    lines.push(`- ignored untracked files (not in patch): ${record.unpreservedFiles.join(", ")}`);
  }
  return lines.join("\n");
}

export function workspaceArtifactDir(id: string): string {
  ensureDirectories();
  const path = join(ARTIFACTS_DIR, safeRefSegment(id));
  mkdirSync(path, { recursive: true });
  return path;
}

export function workspaceStorageRoot(): string {
  ensureDirectories();
  return WORKSPACE_ROOT;
}
