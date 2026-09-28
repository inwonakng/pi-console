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
import { basename, dirname, join, relative, resolve, sep } from "node:path";

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
  integration: WorkspaceIntegration;
  integrationReason?: string;
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
  name: string;
  branch?: string;
  path: string;
  cwd: string;
  directory: string;
  sessionFile?: string;
  lifecycle: WorkspaceLifecycle | "local" | "external";
  localCheckout: boolean;
};

type Snapshot = {
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

type WorkspaceGlobalState = {
  destinationQueues: Map<string, Promise<void>>;
  pendingWorkspaceId?: string;
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
const globalState = globalObject[GLOBAL_KEY] ??= { destinationQueues: new Map() };

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

export function pathInside(parent: string, child: string): boolean {
  const rel = relative(canonicalPath(parent), canonicalPath(child));
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep));
}

function gitResult(cwd: string, args: string[], options: { env?: NodeJS.ProcessEnv; input?: Buffer } = {}): GitResult {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    env: options.env,
    input: options.input,
    encoding: null,
    maxBuffer: 128 * 1024 * 1024,
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
    const commit = gitText(gitRoot, ["commit-tree", tree, "-p", head], {
      env: {
        ...env,
        GIT_AUTHOR_NAME: "Pi Workspace",
        GIT_AUTHOR_EMAIL: "workspace@pi.local",
        GIT_COMMITTER_NAME: "Pi Workspace",
        GIT_COMMITTER_EMAIL: "workspace@pi.local",
      },
      input: Buffer.from(`Pi workspace ${purpose}\n`, "utf8"),
    }).trim();
    const ref = snapshotRef(workspaceId, purpose);
    updateRef(gitRoot, ref, commit);
    return { commit, tree, ref, indexFingerprint: fingerprint(indexPath) };
  } finally {
    rmSync(tempIndex, { force: true });
  }
}

function recordPath(id: string): string {
  return join(RECORDS_DIR, `${safeRefSegment(id)}.json`);
}

export function saveWorkspace(record: WorkspaceRecord): void {
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
    sourceSessionFile: input.sourceSessionFile,
    parentWorkspaceId: input.parentWorkspaceId,
    runId: input.runId,
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

export function taskWorkspacesForSession(sessionFile: string | undefined): WorkspaceRecord[] {
  return sessionFile ? listWorkspaces().filter((record) =>
    record.kind === "task" && record.retained && record.sourceSessionFile === sessionFile,
  ) : [];
}

export function setPendingWorkspace(id: string | undefined): void {
  globalState.pendingWorkspaceId = id;
}

export function getPendingWorkspaceId(): string | undefined {
  return globalState.pendingWorkspaceId;
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

export function prepareWorkspaceDiscard(id: string): WorkspaceRecord {
  const record = loadWorkspace(id);
  if (!record) {
    throw new Error(`Unknown workspace: ${id}`);
  }
  return snapshotWorkspaceResult(record);
}

async function withDestinationQueue<T>(destinationRoot: string, fn: () => Promise<T>): Promise<T> {
  const key = resolve(destinationRoot);
  const previous = globalState.destinationQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolvePromise) => {
    release = resolvePromise;
  });
  globalState.destinationQueues.set(key, previous.then(() => current));
  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function acquireFilesystemLock(destinationRoot: string): Promise<() => void> {
  ensureDirectories();
  const key = createHash("sha256").update(resolve(destinationRoot)).digest("hex").slice(0, 24);
  const lockPath = join(LOCKS_DIR, `${key}.lock`);
  const ownerPath = join(lockPath, "owner.json");
  const deadline = Date.now() + 30_000;
  while (true) {
    try {
      mkdirSync(lockPath);
      writeFileSync(ownerPath, JSON.stringify({ pid: process.pid, destinationRoot, createdAt: new Date().toISOString() }), "utf8");
      return () => rmSync(lockPath, { recursive: true, force: true });
    } catch {
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
        throw new Error(`Timed out waiting to integrate into ${destinationRoot}`);
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    }
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

export async function integrateWorkspace(id: string): Promise<WorkspaceRecord> {
  const initial = loadWorkspace(id);
  if (!initial) {
    throw new Error(`Unknown workspace: ${id}`);
  }
  if (isWorkspaceFinalized(initial)) {
    return initial;
  }
  return withDestinationQueue(initial.destinationRoot, async () => {
    const releaseLock = await acquireFilesystemLock(initial.destinationRoot);
    try {
      let record = loadWorkspace(id);
      if (!record) {
        throw new Error(`Workspace record disappeared: ${id}`);
      }
      record = snapshotWorkspaceResult(record);
      changedIgnoredFiles(record);
      const destination = captureSnapshot(record.destinationRoot, record.id, `destination-${randomUUID()}`);
      const merge = mergeTree(record, destination);
      if (!merge.mergedTree) {
        const diagnostics = merge.diagnostics ?? "Git reported a merge conflict.";
        writeFileSync(record.conflictPath, `${diagnostics}\n`, "utf8");
        record.integration = "conflict";
        record.integrationReason = diagnostics;
        record.lifecycle = "conflicted";
        saveWorkspace(record);
        deleteRef(record.destinationRoot, destination.ref);
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
        const recheck = captureSnapshot(record.destinationRoot, record.id, `recheck-${randomUUID()}`);
        try {
          if (recheck.tree !== destination.tree || recheck.indexFingerprint !== destination.indexFingerprint) {
            throw new Error("Destination changed while integration was being prepared; retry integration.");
          }
          const ignoredChanges = changedIgnoredFiles(record);
          changedIncludedFile = ignoredChanges.length > 0;
          if (applicationPatch.length > 0) {
            gitBuffer(record.destinationRoot, ["apply", "--check", "--binary", "--whitespace=nowarn", record.applicationPatchPath]);
            const indexBefore = realIndexFingerprint(record.destinationRoot);
            gitBuffer(record.destinationRoot, ["apply", "--binary", "--whitespace=nowarn", record.applicationPatchPath]);
            const indexAfter = realIndexFingerprint(record.destinationRoot);
            if (indexAfter !== indexBefore) {
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
              renameSync(temporary, destinationPath);
            } finally {
              rmSync(temporary, { force: true });
            }
          }
        } finally {
          deleteRef(record.destinationRoot, recheck.ref);
        }
      });

      record.integration = applicationPatch.length > 0 || changedIncludedFile ? "applied" : "none";
      record.integrationReason = undefined;
      record.lifecycle = "integration_pending";
      saveWorkspace(record);
      deleteRef(record.destinationRoot, destination.ref);
      return record;
    } catch (error) {
      const record = loadWorkspace(id) ?? initial;
      if (record.integration !== "conflict") {
        record.integration = "failed";
        record.integrationReason = error instanceof Error ? error.message : String(error);
        record.lifecycle = "retained";
        saveWorkspace(record);
      }
      return record;
    } finally {
      releaseLock();
    }
  });
}

export function removeWorkspace(id: string, finalLifecycle: "integrated" | "discarded"): WorkspaceRecord {
  const record = loadWorkspace(id);
  if (!record) {
    throw new Error(`Unknown workspace: ${id}`);
  }
  if (record.retained && existsSync(record.worktreePath)) {
    const result = gitResult(record.destinationRoot, ["worktree", "remove", "--force", record.worktreePath]);
    if (result.status !== 0) {
      record.lifecycle = "cleanup_failed";
      record.integrationReason = result.stderr.toString("utf8").trim() || "git worktree remove failed";
      saveWorkspace(record);
      return record;
    }
  }
  record.retained = false;
  record.lifecycle = finalLifecycle;
  saveWorkspace(record);
  try {
    deleteRef(record.destinationRoot, record.baselineRef);
    deleteRef(record.destinationRoot, record.resultRef);
  } catch (error) {
    record.lifecycle = "cleanup_failed";
    record.integrationReason = error instanceof Error ? error.message : String(error);
    saveWorkspace(record);
  }
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
  const record = workspaceForContext(cwd, sessionFile);
  if (record) {
    return {
      id: record.id,
      kind: record.kind,
      name: basename(record.worktreePath),
      branch: branchAt(record.worktreePath),
      path: record.worktreePath,
      cwd: canonicalPath(cwd),
      directory: record.destinationCwd,
      sessionFile,
      lifecycle: record.lifecycle,
      localCheckout: false,
    };
  }
  const gitRoot = findGitRoot(cwd);
  if (!gitRoot) {
    return {
      name: "Local checkout",
      path: canonicalPath(cwd),
      cwd: canonicalPath(cwd),
      directory: canonicalPath(cwd),
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
