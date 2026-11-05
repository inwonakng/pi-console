import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { spawnSync } from "node:child_process";
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readlinkSync, rmSync, type BigIntStats } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { BashCheckpointChange, SnapshotState } from "./checkpoint-enrollment";

export type BashFileChanges = {
  root: string;
  files: Array<{
    path: string;
    status: "A" | "M" | "D" | "T";
    added: number;
    removed: number;
    binary?: true;
    patch?: string;
  }>;
  moreFiles?: number;
  truncated?: true;
};

type CachedBlob = { fingerprint: string; mode: string; blob: string };
type Repository = { root: string; directory: string; env: NodeJS.ProcessEnv; blobs: Map<string, CachedBlob> };
export type BashFileSnapshot = { repository: Repository; tree: string } | { root: string; failure: string };
const PATCH_BUDGET = 64_000;
const FILE_LIMIT = 200;
// A new cache identity prevents runtime reloads from reusing old indexes that
// were attached to the user's Git metadata/configuration.
const key = Symbol.for("pi.agent.extensions.bash-file-changes.raw-v2");
const globalState = globalThis as typeof globalThis & {
  [key]?: { repositories: Map<string, Repository>; failures: Map<string, number>; skipped: Map<string, string>; exitRegistered: boolean };
};
const state = globalState[key] ??= { repositories: new Map(), failures: new Map(), skipped: new Map(), exitRegistered: false };

// Never inherit Git execution/configuration overrides (including config-env and
// object alternates). Discovery reads repository config, but cannot run hooks,
// fsmonitor, filters or a pager. Snapshot commands use separate, empty metadata.
function gitEnvironment(isolated = false): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (name.startsWith("GIT_")) delete env[name];
  return { ...env, ...(isolated ? { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } : {}),
    GIT_ATTR_NOSYSTEM: "1", GIT_NO_REPLACE_OBJECTS: "1", GIT_TERMINAL_PROMPT: "0" };
}

function git(cwd: string, args: string[], env = gitEnvironment(), input?: Buffer, maxBuffer = 64 * 1024 * 1024): Buffer {
  const result = spawnSync("git", ["--no-optional-locks", "--no-pager", "-c", "core.hooksPath=/dev/null",
    "-c", "core.splitIndex=false", "-c", "core.fsmonitor=false", "-c", "core.attributesFile=/dev/null",
    "-c", "core.untrackedCache=false", "-c", "gc.auto=0", "-c", "maintenance.auto=false", ...args], {
    cwd, env, input, timeout: 10_000, maxBuffer,
  });
  if (result.error || result.status !== 0) throw result.error ?? new Error("Bash file snapshot git operation failed");
  return result.stdout;
}

export function cleanupBashFileChanges(): void {
  for (const repository of state.repositories.values()) {
    repository.blobs.clear();
    try { rmSync(repository.directory, { recursive: true, force: true }); } catch { /* Best-effort shutdown. */ }
  }
  state.repositories.clear();
}

function repositoryFor(root: string): Repository {
  const cached = state.repositories.get(root);
  if (cached) return cached;
  // History's current object store is SHA1. Do not silently normalize sparse
  // checkouts into deletions, or interpret another index/object format.
  if (git(root, ["rev-parse", "--show-object-format"]).toString().trim() !== "sha1") throw new Error("non-SHA1 repository");
  if (git(root, ["config", "--bool", "--default", "false", "--get", "core.sparseCheckout"]).toString().trim() === "true") {
    throw new Error("sparse checkout");
  }
  const store = join(getAgentDir(), "history", "objects.git");
  mkdirSync(dirname(store), { recursive: true });
  if (!existsSync(store)) git(root, ["init", "--bare", "--template=", "--object-format=sha1", store]);
  const directory = mkdtempSync(join(tmpdir(), `pi-bash-index-${process.pid}-`));
  try {
    git(directory, ["init", "--bare", "--template=", "--object-format=sha1", join(directory, "git")]);
    const env = { ...gitEnvironment(true), GIT_DIR: join(directory, "git"), GIT_INDEX_FILE: join(directory, "index"), GIT_OBJECT_DIRECTORY: join(store, "objects") };
    const repository: Repository = { root, directory, env, blobs: new Map() };
    state.repositories.set(root, repository);
    if (!state.exitRegistered) {
      process.once("exit", cleanupBashFileChanges);
      state.exitRegistered = true;
    }
    return repository;
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

function utf8(contents: Buffer): string {
  const value = contents.toString();
  // The UI/history path schema is UTF-8. Never alias an undecodable filename or
  // symlink target to another path via replacement characters.
  if (!Buffer.from(value).equals(contents)) throw new Error("non-UTF8 path or symlink target");
  return value;
}

function hasDirectoryAncestors(root: string, path: string): boolean {
  let ancestor = dirname(path);
  while (ancestor !== ".") {
    try {
      // Do not follow an ancestor symlink, even one currently pointing in-root.
      // Old tracked children under a replaced directory are now missing.
      if (!lstatSync(join(root, ancestor)).isDirectory()) return false;
    } catch (error) {
      if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
      throw error;
    }
    ancestor = dirname(ancestor);
  }
  return true;
}

function fingerprint(stats: BigIntStats): string {
  // Nanosecond timestamps retain the filesystem's highest available resolution.
  // ctime also invalidates same-size writes whose mtime was deliberately reset.
  return [stats.dev, stats.ino, stats.size, stats.mtimeNs, stats.ctimeNs, stats.mode].join(":");
}

function snapshot(repository: Repository): string {
  const { root, env } = repository;
  const paths = new Map<string, string>();
  // Use the real index only for discovery: tracked paths stay included even
  // when ignored; untracked paths obey .gitignore and info/exclude. No add,
  // update-index or object writes ever target the original repository.
  for (const entry of utf8(git(root, ["ls-files", "--stage", "-z"])).split("\0")) {
    if (!entry) continue;
    const match = /^(\d{6}) ([0-9a-f]+) (\d)\t([\s\S]+)$/.exec(entry);
    if (!match || match[3] !== "0") throw new Error("unmerged or invalid index");
    paths.set(match[4], match[1]);
  }
  for (const path of utf8(git(root, ["ls-files", "--others", "--exclude-standard", "-z"])).split("\0")) {
    // Git reports an untracked nested repository as a directory/gitlink.
    if (path) paths.set(path.replace(/\/$/, ""), path.endsWith("/") ? "160000" : "");
  }
  const entries: string[] = [];
  const blobs = new Map<string, CachedBlob>();
  for (const [path, indexMode] of paths) {
    if (!hasDirectoryAncestors(root, path)) continue;
    const absolute = join(root, path);
    let stats;
    try { stats = lstatSync(absolute, { bigint: true }); }
    catch (error) {
      if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) continue;
      throw error;
    }
    let mode: string;
    let blob: string;
    if (stats.isDirectory()) {
      if (indexMode !== "160000") continue;
      // Gitlinks remain unsupported for rollback, but changes must be visible.
      mode = "160000";
      blob = git(absolute, ["rev-parse", "--verify", "HEAD"]).toString().trim();
    } else {
      if (!stats.isFile() && !stats.isSymbolicLink()) throw new Error("special file");
      const stamp = fingerprint(stats);
      let cached = repository.blobs.get(path);
      if (cached?.fingerprint !== stamp) {
        let contents: Buffer;
        if (stats.isSymbolicLink()) {
          mode = "120000";
          contents = readlinkSync(absolute, { encoding: "buffer" });
          utf8(contents);
        } else {
          const fd = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
          try {
            if (fingerprint(fstatSync(fd, { bigint: true })) !== stamp) throw new Error("file replaced during snapshot");
            mode = stats.mode & 0o111n ? "100755" : "100644";
            contents = readFileSync(fd);
            if (fingerprint(fstatSync(fd, { bigint: true })) !== stamp) throw new Error("file changed during snapshot");
          } finally { closeSync(fd); }
        }
        if (fingerprint(lstatSync(absolute, { bigint: true })) !== stamp || !hasDirectoryAncestors(root, path)) {
          throw new Error("path changed during snapshot");
        }
        // Cache only stable raw reads. No Git-normalized/index blobs are reused.
        // Objects go straight to history, without alternates, and are self-contained.
        blob = git(repository.directory, ["hash-object", "--no-filters", "-w", "--stdin"], env, contents).toString().trim();
        cached = { fingerprint: stamp, mode, blob };
      }
      blobs.set(path, cached);
      ({ mode, blob } = cached);
    }
    entries.push(`${mode} ${blob}\t${path}\0`);
  }
  git(repository.directory, ["read-tree", "--empty"], env);
  if (entries.length) git(repository.directory, ["update-index", "-z", "--index-info"], env, Buffer.from(entries.join("")));
  const tree = git(repository.directory, ["write-tree"], env).toString().trim();
  // Publish only complete snapshots; removal/replacement and ignored paths drop
  // old entries instead of leaving reusable stale fingerprints behind.
  repository.blobs = blobs;
  return tree;
}

function recordFailure(root: string): void {
  const failures = (state.failures.get(root) ?? 0) + 1;
  state.failures.set(root, failures);
  const repository = state.repositories.get(root);
  repository?.blobs.clear();
  if (failures < 2) return;
  // Do not repeatedly stall foreground launches. Keep unavailable-coverage
  // evidence on subsequent launches rather than implying a successful rewind.
  state.skipped.set(root, "Bash file observation disabled after repeated snapshot failures");
  if (repository) {
    try { rmSync(repository.directory, { recursive: true, force: true }); } catch { /* Best-effort cleanup. */ }
    state.repositories.delete(root);
  }
}

/** Called synchronously after approval, at the managed process launch boundary. */
export function captureBashFileSnapshot(cwd: string, broadRead = true): BashFileSnapshot | undefined {
  // Even discovery can read config includes outside the worktree. Under a
  // restricted effective policy, do not run Git or crawl the repository at all.
  if (!broadRead) return { root: resolve(cwd), failure: "Bash file observation unavailable under restricted read authority" };
  const absoluteCwd = resolve(cwd);
  const skipped = state.skipped.get(absoluteCwd);
  if (skipped) return { root: absoluteCwd, failure: skipped };
  let root: string | undefined;
  try {
    if (git(cwd, ["rev-parse", "--is-inside-work-tree"]).toString().trim() !== "true") return undefined;
    root = git(cwd, ["rev-parse", "--show-toplevel"]).toString().replace(/\n$/, "");
    const failure = state.skipped.get(root);
    if (failure) return { root, failure };
    const repository = repositoryFor(root);
    return { repository, tree: snapshot(repository) };
  } catch (error) {
    // Optional observation must never change command execution. Even failed
    // discovery (e.g. invalid config) must not imply complete rollback coverage.
    root ??= absoluteCwd;
    recordFailure(root);
    return { root, failure: `Bash file snapshot failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function beforeState(repository: Repository, mode: string, blob: string): SnapshotState {
  if (mode === "000000") return { kind: "missing" };
  if (mode !== "100644" && mode !== "100755" && mode !== "120000") {
    return { kind: "unsupported", reason: mode === "160000" ? "submodule" : `git mode ${mode}` };
  }
  if (mode === "120000") return { kind: "symlink", target: utf8(git(repository.directory, ["cat-file", "blob", blob], repository.env)) };
  return { kind: "file", blob, mode: mode === "100755" ? 0o755 : 0o644 };
}

function unavailable(root: string, reason: string): { checkpoints: BashCheckpointChange[]; fileChanges?: undefined } {
  return { checkpoints: [{ canonicalPath: root, before: { kind: "unsupported", reason } }] };
}

export function collectBashFileChanges(before: BashFileSnapshot | undefined): {
  fileChanges?: BashFileChanges;
  checkpoints: BashCheckpointChange[];
} | undefined {
  if (!before) return undefined;
  if ("failure" in before) return unavailable(before.root, before.failure);
  try {
    const { repository, tree } = before;
    const after = snapshot(repository);
    if (tree === after) return undefined;
    const revisions = [tree, after];
    const diff = ["diff-tree", "-r", "--no-renames", "--no-commit-id", "--no-ext-diff", "--no-textconv"];
    const raw = utf8(git(repository.directory, [...diff, "--raw", "--no-abbrev", "-z", ...revisions], repository.env)).split("\0");
    const stats = new Map<string, { added: number; removed: number; binary?: true }>();
    for (const entry of utf8(git(repository.directory, [...diff, "--numstat", "-z", ...revisions], repository.env)).split("\0")) {
      if (!entry) continue;
      const match = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(entry);
      if (!match) throw new Error("Invalid diff statistics");
      stats.set(match[3], {
        added: match[1] === "-" ? 0 : Number(match[1]),
        removed: match[2] === "-" ? 0 : Number(match[2]),
        ...(match[1] === "-" || match[2] === "-" ? { binary: true as const } : {}),
      });
    }
    const fileChanges: BashFileChanges = { root: repository.root, files: [] };
    const checkpoints: BashCheckpointChange[] = [];
    let patchCharacters = 0;
    for (let i = 0; i < raw.length - 1; i += 2) {
      const match = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([AMDT])$/.exec(raw[i]);
      const path = raw[i + 1];
      const counts = stats.get(path);
      if (!match || !counts) throw new Error("Invalid raw diff");
      checkpoints.push({ canonicalPath: resolve(repository.root, path), before: beforeState(repository, match[1], match[3]) });
      if (fileChanges.files.length === FILE_LIMIT) {
        fileChanges.moreFiles = (fileChanges.moreFiles ?? 0) + 1;
        continue;
      }
      const file: BashFileChanges["files"][number] = { path, status: match[5] as "A" | "M" | "D" | "T", ...counts };
      if (!file.binary && match[1] !== "160000" && match[2] !== "160000") {
        let patch: string | undefined;
        if (patchCharacters < PATCH_BUDGET) {
          try {
            patch = git(repository.directory, [...diff, "--patch", "--no-color", ...revisions,
              "--", `:(literal)${path}`], repository.env, undefined, PATCH_BUDGET * 4 + 1).toString();
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOBUFS") throw error;
          }
        }
        if (patch !== undefined && patchCharacters + patch.length <= PATCH_BUDGET) {
          file.patch = patch;
          patchCharacters += patch.length;
        } else fileChanges.truncated = true;
      }
      fileChanges.files.push(file);
    }
    return fileChanges.files.length ? { fileChanges, checkpoints } : undefined;
  } catch (error) {
    recordFailure(before.repository.root);
    return unavailable(before.repository.root, `Bash file snapshot failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
