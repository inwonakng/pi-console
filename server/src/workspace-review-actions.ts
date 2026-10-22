import { constants, closeSync, fchmodSync, fstatSync, ftruncateSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readSync, realpathSync, renameSync, rmSync, unlinkSync, writeSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fingerprint } from "./resource-reads.js";
import { CommandError } from "./session-commands.js";

const FILE_BYTES = 1024 * 1024;
const TOTAL_BYTES = 4 * FILE_BYTES;
const INDEX_BYTES = 16 * FILE_BYTES;
type FileState = { path: string; version: string; bytes?: Buffer; mode: number; parents: string[] };
type Regular = { version: string; bytes?: Buffer; mode: number };
type GitState = { directory: string; repositoryRoot: string; index: Regular; head: string; version: string };
export type ActionSnapshot = { version: string; files: FileState[]; git: GitState };
export type ReviewAction = "stage" | "unstage" | "restore";
export type ReviewRecovery = { path: string; existed: boolean; encoding: "base64"; content: string; mode: number };
export type ReviewGit = (args: string[], index?: string) => Promise<Buffer>;

function digest(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function conflict(): never { throw new CommandError("resource_conflict", "Review file, index or HEAD changed; reopen the review. No automatic retry is allowed."); }
function unavailable(message: string): never { throw new CommandError("resource_unavailable", message); }
function missing(error: unknown): boolean { return error instanceof Error && "code" in error && error.code === "ENOENT"; }
function identity(path: string): string {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== BigInt(process.getuid!())) unavailable("Review directories must be service-user-owned and cannot be symbolic links");
  return [stat.dev, stat.ino, stat.mode, stat.uid].join(":");
}
function readExact(fd: number, size: number): Buffer {
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < bytes.length) {
    const read = readSync(fd, bytes, offset, bytes.length - offset, offset);
    if (!read) conflict();
    offset += read;
  }
  return bytes;
}
function regular(path: string, maximum: number, optional = false): Regular {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stamp = fstatSync(fd, { bigint: true });
    if (!stamp.isFile() || stamp.nlink !== 1n || stamp.uid !== BigInt(process.getuid!())) unavailable("Review actions require single-linked regular files owned by the service user");
    if (stamp.size > BigInt(maximum)) throw new CommandError("resource_limit", "Review action exceeds its file/index byte limit");
    const bytes = readExact(fd, Number(stamp.size)), version = fingerprint(stamp);
    if (fingerprint(fstatSync(fd, { bigint: true })) !== version || fingerprint(lstatSync(path, { bigint: true })) !== version) conflict();
    return { bytes, mode: Number(stamp.mode & 0o777n), version: digest([version, bytes.toString("base64")]) };
  } catch (error) {
    if (optional && missing(error)) return { version: "missing", mode: 0 };
    if (error instanceof Error && "code" in error && ["ELOOP", "EACCES", "EPERM"].includes(String(error.code))) throw new CommandError("resource_denied", "Review action path is inaccessible or symbolic");
    throw error;
  } finally { if (fd !== undefined) closeSync(fd); }
}
function location(root: string): { directory: string; common: string; version: string } {
  if (realpathSync(root) !== root || process.getuid === undefined) unavailable("Review root changed");
  const pointer = join(root, ".git"), stat = lstatSync(pointer);
  let directory: string, common: string, links: unknown;
  if (stat.isDirectory()) {
    directory = common = pointer;
    links = identity(pointer);
  } else {
    const link = regular(pointer, 8192);
    const target = link.bytes!.toString("utf8").trim().match(/^gitdir: (.+)$/)?.[1];
    if (!target || !isAbsolute(target)) unavailable("Invalid task worktree Git pointer");
    directory = resolve(target);
    const back = regular(join(directory, "gitdir"), 8192);
    if (back.bytes!.toString("utf8").trim() !== pointer) unavailable("Git directory does not belong to this task worktree");
    const shared = regular(join(directory, "commondir"), 8192);
    common = resolve(directory, shared.bytes!.toString("utf8").trim());
    if (!directory.startsWith(join(common, "worktrees") + sep)) unavailable("Invalid task worktree Git directory");
    links = [link.version, back.version, shared.version];
  }
  if (realpathSync(directory) !== directory || realpathSync(common) !== common) unavailable("Symbolic Git directory components are unsupported");
  return { directory, common, version: digest([links, identity(directory), identity(common)]) };
}
function gitState(root: string, repository: string): GitState {
  const loc = location(root), repositoryRoot = realpathSync(repository), owner = location(repositoryRoot);
  if (loc.common !== owner.common) unavailable("Task Git directory no longer belongs to its recorded destination repository");
  const headFile = regular(join(loc.directory, "HEAD"), 8192);
  const headText = headFile.bytes!.toString("utf8").trim();
  const ref = headText.match(/^ref: (refs\/heads\/[^\x00-\x20\\]+)$/)?.[1];
  let head = headText, reference: Regular | undefined, packed: Regular | undefined;
  if (ref) {
    if (ref.split("/").some((part) => part === "." || part === ".." || !part)) unavailable("Invalid HEAD reference");
    // Ref parents must not redirect a read outside the common Git directory.
    let parent = loc.common;
    for (const part of ref.split("/").slice(0, -1)) {
      parent = join(parent, part);
      try { if (realpathSync(parent) !== parent) unavailable("Symbolic Git reference components are unsupported"); }
      catch (error) { if (!missing(error)) throw error; break; }
    }
    reference = regular(join(loc.common, ref), 8192, true);
    if (reference.bytes) head = reference.bytes.toString("utf8").trim();
    else {
      packed = regular(join(loc.common, "packed-refs"), INDEX_BYTES, true);
      head = packed.bytes?.toString("utf8").split("\n").find((line) => line.endsWith(" " + ref))?.split(" ")[0] ?? "";
    }
  }
  if (!/^[a-f0-9]{40,64}$/.test(head)) unavailable("Review actions require an existing HEAD commit");
  const index = regular(join(loc.directory, "index"), INDEX_BYTES, true);
  return { directory: loc.directory, repositoryRoot, index, head, version: digest([loc.version, owner.version, repositoryRoot, headFile.version, reference?.version, packed?.version, head, index.version]) };
}
function fileState(root: string, path: string): FileState {
  const parts = path.split("/");
  if (!path || isAbsolute(path) || /[\x00-\x1f\x7f\\]/.test(path) || parts.some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git")) unavailable("Invalid review action path");
  let parent = root, absent = false;
  const parents = [identity(root)];
  for (const part of parts.slice(0, -1)) {
    parent = join(parent, part);
    try { parents.push(absent ? "missing" : identity(parent)); }
    catch (error) { if (!missing(error)) throw error; absent = true; parents.push("missing"); }
  }
  const current = absent ? { version: "missing", mode: 0 } : regular(join(root, path), FILE_BYTES, true);
  return { path, parents, ...current };
}
/** Captures exactly the reviewed paths plus the shared index/HEAD. No index refresh,
 * clean filters, hooks, or filesystem mutations occur while issuing action references. */
export function actionSnapshot(root: string, paths: string[], repositoryRoot: string): ActionSnapshot {
  if (paths.length > 512 || Buffer.byteLength(paths.join("\0")) > 128 * 1024) throw new CommandError("resource_limit", "Review action path limit exceeded");
  const git = gitState(root, repositoryRoot), files: FileState[] = [];
  let bytes = 0;
  for (const path of paths) {
    const file = fileState(root, path);
    bytes += file.bytes?.length ?? 0;
    if (bytes > TOTAL_BYTES) throw new CommandError("resource_limit", "Review action exceeds 4 MiB of current file content; select individual files");
    files.push(file);
  }
  return { git, files, version: digest([git.version, files.map((file) => [file.path, file.version, file.parents])]) };
}
function write(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset, offset);
}
function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** Git prepares a private alternate index. Only the final synchronous boundary can
 * publish it or touch worktree bytes. Cooperative Git writers obey index.lock.
 * As with text saves, this is not isolation from hostile same-user filesystem writes. */
export async function applyReviewAction(root: string, workspaceRoot: string, before: string, snapshot: ActionSnapshot, operation: ReviewAction, allIndex: boolean,
  git: ReviewGit, check: () => void, preserve: (recovery: ReviewRecovery) => Promise<void>): Promise<void> {
  if (!snapshot.files.length && !(operation === "unstage" && allIndex)) unavailable("There are no reviewed files to change");
  if (operation === "restore" && snapshot.files.length !== 1) unavailable("Restoration requires an individually reviewed file");
  const index = join(snapshot.git.directory, "index"), lock = index + ".lock";
  const currentVersion = () => actionSnapshot(root, snapshot.files.map((file) => file.path), snapshot.git.repositoryRoot).version;
  let lockFd: number | undefined, temporary: string | undefined, mutated = false;
  const sameLock = () => {
    if (lockFd === undefined) return false;
    const fd = fstatSync(lockFd, { bigint: true });
    try { const named = lstatSync(lock, { bigint: true }); return !named.isSymbolicLink() && fd.dev === named.dev && fd.ino === named.ino && named.nlink === 1n; }
    catch (error) { if (missing(error)) return false; throw error; }
  };
  try {
    check();
    if (currentVersion() !== snapshot.version) conflict();
    try { lockFd = openSync(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch (error) { if (error instanceof Error && "code" in error && error.code === "EEXIST") throw new CommandError("resource_conflict", "Git index is locked by another operation; reopen the review after it finishes"); throw error; }
    temporary = mkdtempSync(join(workspaceRoot, ".review-index-"));
    const prepared = join(temporary, "index");
    if (snapshot.git.index.bytes) {
      const fd = openSync(prepared, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      try { write(fd, snapshot.git.index.bytes); } finally { closeSync(fd); }
    } else await git(["read-tree", "--empty"], prepared);
    const paths = snapshot.files.map((file) => file.path);
    let restored: Buffer | undefined, restoreMode = 0o644;
    if (operation === "stage") {
      const staged = await git(["ls-files", "--stage", "-z", "--", ...paths], prepared);
      const baseline = await git(["ls-tree", "-z", before, "--", ...paths]);
      for (const entry of [staged, baseline].flatMap((bytes) => bytes.toString("utf8").split("\0").filter(Boolean))) {
        if (!/^100(?:644|755) /.test(entry)) unavailable("Staging symlink/submodule resources, including their deletions, is unsupported");
      }
      await git(["add", "--", ...paths], prepared);
    } else if (operation === "unstage") {
      // read-tree replaces only the private index, unlike reset without pathspecs
      // which can also write HEAD/ORIG_HEAD. Full unstage never reads worktree files.
      await git(allIndex ? ["read-tree", snapshot.git.head] : ["reset", "--quiet", snapshot.git.head, "--", ...paths], prepared);
    }
    if (operation === "restore") {
      const entry = (await git(["ls-tree", before, "--", paths[0]])).toString("utf8");
      if (entry) {
        if (!/^100(644|755) blob /.test(entry)) unavailable("Baseline restoration supports regular files, not symlinks or submodules");
        restoreMode = entry.startsWith("100755") ? 0o755 : 0o644;
        await git(["reset", "--quiet", before, "--", ...paths], prepared);
        restored = await git(["show", before + ":" + paths[0]]);
        if (restored.length > FILE_BYTES) throw new CommandError("resource_limit", "Baseline restoration exceeds 1 MiB");
      }
      const original = snapshot.files[0];
      await preserve({ path: original.path, existed: original.bytes !== undefined, encoding: "base64", content: original.bytes?.toString("base64") ?? "", mode: original.mode });
    }
    const preparedIndex = regular(prepared, INDEX_BYTES).bytes!;
    // All awaits, including the durable recovery checkpoint, finish before here.
    check();
    if (!sameLock() || currentVersion() !== snapshot.version) conflict();
    write(lockFd, preparedIndex); fsyncSync(lockFd);
    check();
    if (!sameLock() || currentVersion() !== snapshot.version) conflict();
    if (operation === "restore") {
      const original = snapshot.files[0], target = join(root, original.path);
      if (restored === undefined) {
        if (original.bytes !== undefined) { mutated = true; unlinkSync(target); syncDirectory(dirname(target)); }
      } else {
        let parent = root;
        for (const part of original.path.split("/").slice(0, -1)) {
          const next = join(parent, part);
          try { identity(next); }
          catch (error) { if (!missing(error)) throw error; mutated = true; mkdirSync(next, { mode: 0o700 }); syncDirectory(parent); }
          parent = next;
        }
        const fd = openSync(target, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK
          | (original.bytes === undefined ? constants.O_CREAT | constants.O_EXCL : 0), restoreMode);
        if (original.bytes === undefined) mutated = true;
        try {
          const stamp = fstatSync(fd, { bigint: true });
          if (!stamp.isFile() || stamp.nlink !== 1n || stamp.uid !== BigInt(process.getuid!())) unavailable("Restore target changed type or ownership");
          if (original.bytes !== undefined && (stamp.size > BigInt(FILE_BYTES)
            || digest([fingerprint(stamp), readExact(fd, Number(stamp.size)).toString("base64")]) !== original.version
            || fingerprint(lstatSync(target, { bigint: true })) !== fingerprint(stamp))) conflict();
          mutated = true; write(fd, restored);
          ftruncateSync(fd, restored.length); fchmodSync(fd, restoreMode); fsyncSync(fd);
        } finally { closeSync(fd); }
        syncDirectory(parent);
      }
    }
    check();
    if (!sameLock() || gitState(root, snapshot.git.repositoryRoot).version !== snapshot.git.version) conflict();
    // Diffview removes a baseline-absent working file without changing its index
    // entry, even when that addition is staged. Preserve that distinction.
    if (operation !== "restore" || restored !== undefined) {
      mutated = true;
      renameSync(lock, index); syncDirectory(snapshot.git.directory);
    }
  } catch (error) {
    if (mutated) throw new Error("Review action may be partially applied; inspect the original receipt and retained recovery bytes before further action", { cause: error });
    throw error;
  } finally {
    if (lockFd !== undefined) {
      try { if (sameLock()) unlinkSync(lock); } finally { closeSync(lockFd); }
    }
    if (temporary) rmSync(temporary, { recursive: true });
  }
}
