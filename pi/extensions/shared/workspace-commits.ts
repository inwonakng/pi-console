import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, copyFileSync, existsSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

type BranchIndexUpdate = {
  oid: string;
  parent: string;
  branch: string;
  indexBefore: string;
  indexAfter: string;
  preparedIndex: string;
  publicationLock?: { pid: number; device: number; inode: number };
};

export type WorkspaceUndo = BranchIndexUpdate & {
  reason: string;
  files: string[];
  status: "prepared" | "completed";
};
export type WorkspaceUndoPreview = { head: string; branch: string; index: string; files: string[] };

/** Persisted before any destination mutation; also identifies an interrupted publication. */
export type WorkspaceCommit = BranchIndexUpdate & {
  beforeTree: string;
  afterTree: string;
  sourceTree: string;
  message: string;
  status: "prepared" | "published" | "undone";
  undo?: WorkspaceUndo;
};

function git(root: string, args: string[], index?: string, input?: Buffer): Buffer {
  const result = spawnSync("git", ["-C", root, ...args], {
    env: { ...process.env, ...(index ? { GIT_INDEX_FILE: index } : {}) }, input,
    maxBuffer: 128 * 1024 * 1024,
    ...(process.env.PI_CONSOLE_SERVICE === "1" ? { timeout: 10000, killSignal: "SIGKILL" as const } : {}),
  });
  if (result.status !== 0) throw new Error(result.stderr?.toString().trim() || result.error?.message || `git ${args[0]} failed`);
  return result.stdout;
}
const text = (root: string, args: string[], index?: string) => git(root, args, index).toString("utf8").trim();
const indexFingerprint = (path: string): string => existsSync(path)
  ? createHash("sha256").update(readFileSync(path)).digest("hex") : "missing";
const indexPath = (root: string) => text(root, ["rev-parse", "--path-format=absolute", "--git-path", "index"]);

export function commitDestination(root: string): { head: string; branch: string } {
  const head = text(root, ["rev-parse", "HEAD"]);
  const branch = text(root, ["symbolic-ref", "HEAD"]);
  if (!branch.startsWith("refs/heads/")) throw new Error("Automatic commits require a checked-out local branch.");
  for (const marker of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "sequencer"]) {
    if (existsSync(text(root, ["rev-parse", "--path-format=absolute", "--git-path", marker]))) {
      throw new Error("Finish the existing Git merge/rebase/cherry-pick/revert before committing a workspace.");
    }
  }
  return { head, branch };
}

function validateCommitMessage(message: string): string {
  if (!message.trim() || message.includes("\0") || Buffer.byteLength(message) > 16 * 1024) {
    throw new Error("A commit message describing the change and its reason is required (maximum 16 KiB, no NUL bytes).");
  }
  return message.trim();
}

/** Build the task-only commit and replacement index without staging the user's other edits. */
export function prepareWorkspaceCommit(input: {
  root: string; artifactDir: string; workspaceId: string; sessionFile?: string;
  beforeTree: string; afterTree: string; sourceTree: string; patch: Buffer; message: string;
  expectedHead: string; expectedBranch?: string; expectedIndex: string; reverts?: string;
}): WorkspaceCommit {
  const { root } = input;
  const destination = commitDestination(root);
  if (destination.head !== input.expectedHead || destination.branch !== input.expectedBranch) {
    throw new Error("Destination branch or HEAD changed while integration was prepared; retry integration.");
  }
  const realIndex = indexPath(root);
  const indexBefore = input.expectedIndex;
  const checkIndex = () => {
    if (indexFingerprint(realIndex) !== indexBefore) throw new Error("Destination index changed while preparing its commit; retry integration.");
  };
  checkIndex();
  const affected = git(root, ["diff", "--no-renames", "--name-only", "-z", input.beforeTree, input.afterTree]).toString("utf8").split("\0").filter(Boolean);
  const dirty = new Set([
    ...git(root, ["diff", "--no-renames", "--name-only", "-z", destination.head, input.beforeTree]).toString("utf8").split("\0"),
    ...git(root, ["diff", "--cached", "--no-renames", "--name-only", "-z", destination.head]).toString("utf8").split("\0"),
  ]);
  const overlaps = affected.filter(path => dirty.has(path));
  if (overlaps.length) throw new Error(`Automatic commit would overlap existing uncommitted work. Ask the user how to separate those edits; do not stage, commit or move them automatically:\n${overlaps.join("\n")}`);
  const message = validateCommitMessage(input.message)
    + `\n\nPi-Workspace: ${input.workspaceId}\n`
    + (input.sessionFile ? `Pi-Session: ${basename(input.sessionFile, ".jsonl")}\n` : "")
    + (input.reverts ? `Pi-Reverts: ${input.reverts}\n` : "");
  // Check identity before applying files. Unlike private workspace snapshots,
  // these are user-history commits and must not use a fabricated Git identity.
  git(root, ["var", "GIT_AUTHOR_IDENT"]);
  git(root, ["var", "GIT_COMMITTER_IDENT"]);
  const preparedIndex = join(input.artifactDir, "commit.index");
  const commitIndex = join(input.artifactDir, "commit-tree.index");
  try {
    rmSync(commitIndex, { force: true });
    git(root, ["read-tree", destination.head], commitIndex);
    git(root, ["apply", "--cached", "--binary", "--whitespace=nowarn", "-"], commitIndex, input.patch);
    const tree = text(root, ["write-tree"], commitIndex);
    // Preserve unrelated staged entries from exactly the reviewed index.
    checkIndex();
    if (existsSync(realIndex)) {
      copyFileSync(realIndex, preparedIndex);
      if (indexFingerprint(preparedIndex) !== indexBefore) throw new Error("Destination index changed while being copied.");
    } else git(root, ["read-tree", destination.head], preparedIndex);
    git(root, ["apply", "--cached", "--binary", "--whitespace=nowarn", "-"], preparedIndex, input.patch);
    const signing = text(root, ["config", "--bool", "--default", "false", "--get", "commit.gpgsign"]) === "true" ? ["-S"] : [];
    const oid = git(root, ["commit-tree", ...signing, tree, "-p", destination.head], undefined, Buffer.from(message)).toString("utf8").trim();
    git(root, ["update-ref", `refs/pi/workspaces/${input.workspaceId}/integration-commit`, oid]);
    checkIndex();
    return { oid, parent: destination.head, branch: destination.branch,
      beforeTree: input.beforeTree, afterTree: input.afterTree, sourceTree: input.sourceTree, indexBefore,
      indexAfter: indexFingerprint(preparedIndex), preparedIndex, message, status: "prepared" };
  } finally { rmSync(commitIndex, { force: true }); }
}

/** Inspect an undo without changing files, refs or the index. Remote refs are
 * only local evidence; confirmation must disclose that they may be stale. */
export function previewCommitUndo(root: string, commit: WorkspaceCommit): WorkspaceUndoPreview {
  const destination = commitDestination(root), undo = commit.undo;
  if (commit.status !== "published" || undo?.status === "completed") throw new Error("Undo requires a committed integration that has not already been undone.");
  if (destination.branch !== commit.branch || (destination.head !== commit.oid && !(undo && destination.head === commit.parent))) {
    throw new Error("Undo requires the recorded integration at the tip of its checked-out branch; later commits will not be removed.");
  }
  const parents = text(root, ["rev-list", "--parents", "-n", "1", commit.oid]).split(" ");
  if (parents.length !== 2 || parents[1] !== commit.parent) throw new Error("Integration commit does not match its recorded parent.");
  const remotes = text(root, ["for-each-ref", `--contains=${commit.oid}`, "--format=%(refname)", "refs/remotes/"]);
  if (remotes) throw new Error(`Undo refused: the commit is reachable from known remote-tracking refs:\n${remotes}`);
  const index = indexFingerprint(indexPath(root));
  const files = undo?.files ?? git(root, ["diff", "--no-renames", "--name-only", "-z", commit.parent, commit.oid]).toString("utf8").split("\0").filter(Boolean);
  if (undo) {
    if (![undo.indexBefore, undo.indexAfter].includes(index)) throw new Error("Interrupted undo cannot resume: the index changed. Preserve the newer staging before recovery.");
  } else {
    if (git(root, ["ls-files", "--unmerged", "-z"]).length) throw new Error("Resolve index conflicts before undoing a commit.");
    const staged = new Set(git(root, ["diff", "--cached", "--no-renames", "--name-only", "-z", commit.oid]).toString("utf8").split("\0"));
    const overlaps = files.filter(path => staged.has(path));
    if (overlaps.length) throw new Error(`Undo would overlap staged changes; separate those edits first:\n${overlaps.join("\n")}`);
  }
  return { head: destination.head, branch: destination.branch, index, files };
}

/** Build a replacement index by reversing only the commit's entries. Working
 * files are never touched; unrelated staging is copied from the reviewed index. */
export function prepareCommitUndo(root: string, commit: WorkspaceCommit, artifactDir: string, reason: string,
  expected: WorkspaceUndoPreview): WorkspaceUndo {
  const check = () => {
    const current = previewCommitUndo(root, commit);
    if (current.head !== expected.head || current.branch !== expected.branch || current.index !== expected.index) {
      throw new Error("Branch, HEAD or index changed after undo confirmation; review and confirm again.");
    }
  };
  check();
  if (commit.undo) return commit.undo;
  const preparedIndex = join(artifactDir, "undo.index");
  copyFileSync(indexPath(root), preparedIndex);
  if (indexFingerprint(preparedIndex) !== expected.index) throw new Error("Index changed while preparing undo.");
  const patch = git(root, ["diff", "--binary", "--full-index", commit.oid, commit.parent]);
  if (patch.length) git(root, ["apply", "--cached", "--binary", "--whitespace=nowarn", "-"], preparedIndex, patch);
  check();
  return { oid: commit.parent, parent: commit.oid, branch: commit.branch,
    indexBefore: expected.index, indexAfter: indexFingerprint(preparedIndex), preparedIndex,
    reason: reason.trim(), files: expected.files, status: "prepared" };
}

/** The caller holds the workspace destination lock. Git's index lock excludes
 * cooperative Git writers while files, branch and index are published. A crash
 * can split these steps; the durable plan permits only exact-state recovery. */
export function publishWorkspaceCommit(root: string, plan: BranchIndexUpdate, persist: () => void, apply: () => void): void {
  const index = indexPath(root), lock = index + ".lock";
  const validate = () => {
    const { head, branch } = commitDestination(root);
    const hash = indexFingerprint(index);
    if (branch !== plan.branch || ![plan.parent, plan.oid].includes(head)
      || ![plan.indexBefore, plan.indexAfter].includes(hash)) {
      throw new Error("Interrupted commit cannot be resumed: destination branch, HEAD or index changed. Inspect the retained workspace and commit metadata.");
    }
    return { head, hash };
  };
  validate();
  // Only reclaim a lock whose exact file identity was persisted by this plan
  // and whose owning process demonstrably exited. Unknown Git locks stay put.
  const ownedLock = () => {
    try {
      const stat = lstatSync(lock), owner = plan.publicationLock;
      return !!owner && !stat.isSymbolicLink() && stat.dev === owner.device && stat.ino === owner.inode;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  };
  if (ownedLock()) {
    let exited = false;
    try { process.kill(plan.publicationLock!.pid, 0); }
    catch (error) { exited = (error as NodeJS.ErrnoException).code === "ESRCH"; }
    if (exited && ownedLock()) rmSync(lock);
  }
  let fd: number;
  try { fd = openSync(lock, "wx", 0o600); }
  catch (error) { throw new Error(`Destination Git index is locked at ${lock}. An unknown or live lock is never removed automatically; identify the process holding it before removing it and retrying.`, { cause: error }); }
  try {
    const stat = fstatSync(fd);
    plan.publicationLock = { pid: process.pid, device: stat.dev, inode: stat.ino };
    persist();
    validate();
    apply();
    const current = validate();
    const bytes = readFileSync(plan.preparedIndex);
    if (indexFingerprint(plan.preparedIndex) !== plan.indexAfter) throw new Error("Prepared commit index changed; refusing publication.");
    writeFileSync(fd, bytes);
    fsyncSync(fd);
    if (!ownedLock()) throw new Error("Publication index lock changed ownership; inspect the recorded attempt before retrying.");
    if (current.head === plan.parent) git(root, ["update-ref", plan.branch, plan.oid, plan.parent]);
    renameSync(lock, index);
    delete plan.publicationLock;
  } finally {
    closeSync(fd);
    if (ownedLock()) rmSync(lock);
  }
}
