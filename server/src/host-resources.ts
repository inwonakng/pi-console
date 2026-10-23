import { createHash, type Hash } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, mkdir, open, readFile, readdir, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import type { Channel } from "./session-catalog.js";
import type { ResourceManifest, ResourceStamp } from "../../pi/scripts/managed-process.mjs";
export type { ResourceStamp } from "../../pi/scripts/managed-process.mjs";

const DEFAULT_PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
const PI_PACKAGE = "@earendil-works/pi-coding-agent";
// Refuse oversized installations rather than silently leaving resources unpinned.
const MAX_ENTRIES = 100_000;
const MAX_BYTES = 1024 * 1024 * 1024;
const MAX_DEPTH = 128;
const MAX_MANIFEST_BYTES = 1024 * 1024;

export type HostResourcesOptions = {
  channel: Channel;
  root?: string;
  appRoot: string;
  /** An explicit host path, not a command to look up in a frontend's PATH. */
  binary: string;
  /** Host launch environment; when omitted, use the service process environment. */
  environment?: NodeJS.ProcessEnv;
};

export type HostResources = ResourceManifest & {
  readonly channel: Channel;
  /** Canonical private profile; defaults to HOME/.local/state/pi-console/service/<channel>
   * on both Linux and macOS, independent of release directories and XDG overrides. */
  readonly root: string;
  readonly appRoot: string;
  readonly binary: string;
  /** Installed SDK belonging to the pinned host launcher, never frontend resolution. */
  readonly packageRoot: string;
  readonly environment: NodeJS.ProcessEnv;
};

type Manifest = {
  name?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

/** Prepare host-owned resources only: never call with an environment supplied by a client.
 * Pin resolved paths, not mutable launcher links such as `current`. Existing running
 * workers are not stopped when a change is detected; the caller fences new launches. */
export async function prepareHostResources(options: HostResourcesOptions): Promise<HostResources> {
  const channel = options.channel;
  if (channel !== "stable" && channel !== "dev") throw new Error("Unknown service channel");
  const environment = hostEnvironment(options.environment ?? process.env);
  const appRoot = await realpath(resolve(options.appRoot));
  const binary = await resolveManagedLauncher(await realpath(resolve(options.binary)), environment);
  if (!(await lstat(appRoot)).isDirectory()) throw new Error("Application root must be a host directory");
  if (!(await lstat(binary)).isFile()) throw new Error("Pi binary must be a host file");
  await access(binary, constants.X_OK);
  const bundledRoot = join(appRoot, "pi");
  if (!(await lstat(bundledRoot)).isDirectory()) throw new Error("Bundled Pi resources must be a directory");
  const packageRoot = await installedPackage(binary);
  const rootPath = resolve(options.root ?? join(environment.HOME!, ".local", "state", "pi-console", "service", channel));
  await mkdir(rootPath, { recursive: true, mode: 0o700 });
  const profile = await lstat(rootPath);
  if (!profile.isDirectory() || profile.uid !== process.getuid?.() || (profile.mode & 0o077) !== 0) {
    throw new Error(`Service profile must be owned by this user with mode 0700: ${rootPath}`);
  }
  const root = await realpath(rootPath);
  const resources = new ResourceFingerprint();
  resources.record(["host-resources-v1", channel, appRoot, binary, packageRoot]);
  await resources.tree(binary);
  await resources.package(packageRoot);
  await resources.package(bundledRoot);
  const manifest: ResourceManifest = Object.freeze({
    buildId: `sha256:${resources.digest()}`, files: Object.freeze(resources.files),
    resolutions: Object.freeze(resources.resolutions), lookup: Object.freeze(resources.lookup),
  });
  return Object.freeze({ channel, root, appRoot, binary, packageRoot, environment: Object.freeze(environment), ...manifest });
}

function hostEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (/^(?:NVIM|VIM|TMUX)/.test(key)
      || /^(?:ITERM|KITTY)_/.test(key)
      || /^(?:PI_CONSOLE_|PI_SIDE_|PI_SPAWN_|PI_WORKSPACE_|PI_SUBAGENT_|PI_NOTIFICATION_|PI_COMPLETION_|PI_PERMISSION_)/.test(key)
      || ["PI_BINARY", "PI_SESSION_DIR", "PI_INTERACTION_MODE", "TERM", "TERM_PROGRAM", "TERM_PROGRAM_VERSION", "COLORTERM", "WINDOWID"].includes(key)) continue;
    environment[key] = value;
  }
  const home = environment.HOME || homedir();
  if (!isAbsolute(home)) throw new Error("Host HOME must be an absolute path");
  environment.HOME = home;
  environment.PATH ||= DEFAULT_PATH;
  return environment;
}

async function manifest(path: string): Promise<Manifest> {
  const file = await open(path, "r");
  try {
    if ((await file.stat()).size > MAX_MANIFEST_BYTES) throw new Error(`Package manifest is too large: ${path}`);
    const value: unknown = JSON.parse(await file.readFile("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid package manifest: ${path}`);
    const object = value as Record<string, unknown>;
    if (object.name !== undefined && typeof object.name !== "string") throw new Error(`Invalid package name: ${path}`);
    for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
      const entries = object[field];
      if (entries === undefined) continue;
      if (!entries || typeof entries !== "object" || Array.isArray(entries)
        || !Object.entries(entries).every(([name, version]) => /^(?:@[a-zA-Z0-9_.-]+\/)?[a-zA-Z0-9_.-]+$/.test(name)
          && name !== "." && name !== ".." && typeof version === "string")) throw new Error(`Invalid package dependencies: ${path}`);
    }
    return object as Manifest;
  } finally { await file.close(); }
}

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** Resolve the installer's launcher without executing shell code or retaining its
 * mutable version selector. Workers must execute and fingerprint the same release. */
async function resolveManagedLauncher(binary: string, environment: NodeJS.ProcessEnv): Promise<string> {
  if (basename(binary) !== "pi" || basename(dirname(binary)) !== "bin") return binary;
  const root = join(dirname(dirname(binary)), "install");
  const markerPath = join(root, "managed-install.json");
  let marker: unknown;
  try { marker = JSON.parse(await readFile(markerPath, "utf8")); }
  catch (error) { if (missing(error)) return binary; throw error; }
  if (!marker || typeof marker !== "object" || !("kind" in marker) || marker.kind !== "pi-managed-install"
    || !("schemaVersion" in marker) || marker.schemaVersion !== 1 || !("layout" in marker) || marker.layout !== "releases-v1") {
    throw new Error(`Managed Pi install marker is invalid: ${markerPath}`);
  }
  const versionPath = join(root, "current-version");
  const version = (await readFile(versionPath, "utf8")).split("\n", 1)[0];
  if (!/^[0-9A-Za-z._+-]+$/.test(version) || version === "." || version === "..") {
    throw new Error(`Managed Pi version file is invalid: ${versionPath}`);
  }
  const resolved = await realpath(join(root, "releases", version, "node_modules", ".bin", "pi"));
  environment.PI_MANAGED_INSTALL_ROOT = root;
  // Preserve the launcher's Node/npm PATH setup, but pin the resolved directory.
  const nodeBin = join(environment.XDG_DATA_HOME || join(environment.HOME!, ".local", "share"), "pi-node", "current", "bin");
  try {
    await access(join(nodeBin, "node"), constants.X_OK);
    environment.PATH = `${await realpath(nodeBin)}${delimiter}${environment.PATH}`;
  } catch (error) {
    if (!missing(error) && (error as NodeJS.ErrnoException).code !== "EACCES") throw error;
  }
  return resolved;
}

async function installedPackage(binary: string): Promise<string> {
  for (let directory = dirname(binary); ; directory = dirname(directory)) {
    try {
      if ((await manifest(join(directory, "package.json"))).name === PI_PACKAGE) return directory;
    } catch (error) { if (!missing(error)) throw error; }
    if (dirname(directory) === directory) break;
  }
  throw new Error(`Pi binary must belong to an installed ${PI_PACKAGE} package`);
}

/** Full trees (including node_modules, lockfiles, JS, TS and assets), plus dependency
 * graphs for hoisted packages. Follow and hash symlink targets; skip only .git and
 * .DS_Store. Realpath deduplication bounds cycles without ignoring target contents. */
class ResourceFingerprint {
  readonly files: ResourceStamp[] = [];
  readonly resolutions: { from: string; name: string; target: string | null }[] = [];
  readonly lookup: { path: string; target: string | null }[] = [];
  private readonly hash: Hash = createHash("sha256");
  private readonly directories = new Set<string>();
  private readonly packages = new Set<string>();
  private entries = 0;
  private bytes = 0;

  record(value: unknown): void { this.hash.update(JSON.stringify(value) + "\n"); }
  digest(): string { return this.hash.digest("hex"); }

  async tree(path: string, depth = 0): Promise<void> {
    if (++this.entries > MAX_ENTRIES || depth > MAX_DEPTH) throw new Error("Host resource entry/depth limit exceeded");
    const target = await realpath(path);
    const info = await lstat(target);
    const stamp = await lstat(target, { bigint: true });
    this.files.push({ path, target, ino: String(stamp.ino), mode: String(stamp.mode), size: String(stamp.size), mtimeNs: String(stamp.mtimeNs), ctimeNs: String(stamp.ctimeNs) });
    this.record([path, target, info.mode]);
    if (info.isDirectory()) {
      if (this.directories.has(target)) return;
      this.directories.add(target);
      for (const name of (await readdir(target)).sort()) {
        if (name !== ".git" && name !== ".DS_Store") await this.tree(join(target, name), depth + 1);
      }
      return;
    }
    if (!info.isFile()) throw new Error(`Unsupported host resource type: ${path}`);
    this.bytes += info.size;
    if (this.bytes > MAX_BYTES) throw new Error("Host resources exceed the 1 GiB fingerprint limit");
    const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await file.stat({ bigint: true });
      const content = createHash("sha256");
      let bytes = 0;
      for await (const chunk of file.createReadStream({ autoClose: false })) {
        bytes += chunk.length;
        if (bytes > info.size) throw new Error(`Host resource grew during fingerprinting: ${path}`);
        content.update(chunk);
      }
      const after = await file.stat({ bigint: true });
      if (bytes !== info.size || before.ino !== after.ino || before.size !== after.size
        || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
        throw new Error(`Host resource changed during fingerprinting: ${path}`);
      }
      this.record([bytes, content.digest("hex")]);
    } finally { await file.close(); }
  }

  async package(path: string): Promise<void> {
    const root = await realpath(path);
    this.record(["package", path, root]);
    if (this.packages.has(root)) return;
    this.packages.add(root);
    await this.tree(root);
    const value = await manifest(join(root, "package.json"));
    const names = new Set([...Object.keys(value.dependencies ?? {}), ...Object.keys(value.optionalDependencies ?? {}), ...Object.keys(value.peerDependencies ?? {})]);
    const require = createRequire(join(root, "package.json"));
    for (const name of [...names].sort()) {
      let dependency: string | undefined;
      // Resolving package.json through exports is not supported by all packages.
      // Use Node's package lookup directories so hoisted dependencies are included.
      for (const directory of require.resolve.paths(name) ?? []) {
        const candidate = join(directory, name);
        // Node can load package-less index directories or CommonJS files too.
        // Pin every search candidate, including absent nearer candidates, rather
        // than assuming that package.json is the only resolution boundary.
        for (const path of [candidate, candidate + ".js", candidate + ".json", candidate + ".node"]) {
          let target: string | null = null;
          try { target = await realpath(path); }
          catch (error) { if (!missing(error)) throw error; }
          this.lookup.push({ path, target });
          if (target) await this.tree(path);
        }
        try { await access(join(candidate, "package.json")); dependency ??= candidate; }
        catch (error) { if (!missing(error)) throw error; }
      }
      this.resolutions.push({ from: join(root, "package.json"), name, target: dependency ? await realpath(dependency) : null });
      this.record(["dependency", root, name, dependency ?? null]);
      if (dependency) await this.package(dependency);
      else if (value.dependencies?.[name] !== undefined && value.optionalDependencies?.[name] === undefined) {
        throw new Error(`Required host resource dependency is not installed: ${name} (${root})`);
      }
    }
  }
}
