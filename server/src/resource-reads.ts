import { createHash } from "node:crypto";
import { constants, type BigIntStats, type Dirent } from "node:fs";
import { lstat, open, opendir, realpath, type FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { object } from "./pi-records.js";
import { CommandError } from "./session-commands.js";

export type ResourceContext = {
  sessionFile: string;
  cwd: string;
  workspaceRoot: string;
  workspaceId?: string;
  workspacesRoot: string;
  tempRoot: string;
  skillPaths: readonly string[];
  liveOutputPaths: readonly string[];
  check: () => void;
};

type Artifact = "brief" | "result" | "transcript" | "status" | "agent_prompt" | "patch";
type ReadInput = {
  kind: "history" | "file" | "skill" | "output" | "spawn";
  path?: string;
  runId?: string;
  artifact?: Artifact;
  offset?: number;
  version?: string;
};
type TextChunk = { text: string; path: string; offset: number; nextOffset: number | null; version: string; size: number };
type FileEntry = { path: string; kind: "file" | "directory" };
type Target = { root: string; path: string; owned?: boolean };
type Opened = Target & { file: FileHandle; stamp: BigIntStats; canonical: string };

const CHUNK_BYTES = 64 * 1024;
const RECORD_BYTES = 16 * 1024 * 1024;
const SCAN_BYTES = 256 * 1024 * 1024;
const DIRECTORY_ENTRIES = 10_000;
const RUNS = 256;
const SCAN_FILES = 128;
const ANCESTORS = 16;
const PAGE_SIZE = 128;
const ARTIFACTS: Record<Exclude<Artifact, "patch">, string> = {
  brief: "brief.md", result: "result.md", transcript: "transcript.jsonl", status: "status.json", agent_prompt: "subagent-prompt.md",
};
let active = 0;

function refuse(reason: string, message: string): never {
  const code = reason === "resource_payload" || reason === "resource_offset" ? "invalid_command"
    : reason === "resource_oversize" ? "resource_limit"
    : ["resource_missing", "resource_binary", "resource_type"].includes(reason) ? "resource_unavailable" : "resource_denied";
  throw new CommandError(code, `${reason}: ${message}`);
}
function changed(): never { throw new CommandError("resource_conflict", "Resource changed; restart the read at offset 0"); }
function identifier(value: unknown): value is string { return typeof value === "string" && /^[\w-]{1,128}$/.test(value); }
function pathString(value: unknown, empty = false): value is string {
  return typeof value === "string" && (empty || value.length > 0) && Buffer.byteLength(value) <= 4096
    && !/[\u0000-\u001f\u007f]/.test(value) && !value.split(/[\\/]/).includes("..");
}
function offset(value: unknown): value is number | undefined {
  return value === undefined || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
}
function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return object(value) && Object.keys(value).every((key) => keys.includes(key));
}
function readInput(value: unknown): ReadInput {
  if (!exact(value, ["kind", "path", "runId", "artifact", "offset", "version"])
    || typeof value.kind !== "string" || !["history", "file", "skill", "output", "spawn"].includes(value.kind)
    || (value.path !== undefined && !pathString(value.path)) || !offset(value.offset)
    || (value.version !== undefined && (typeof value.version !== "string" || !/^[a-f0-9]{64}$/.test(value.version)))
    || ((value.offset as number | undefined) ?? 0) > 0 && value.version === undefined) {
    refuse("resource_payload", "Invalid read payload or missing continuation version");
  }
  if (value.kind === "spawn") {
    if (value.path !== undefined || !identifier(value.runId)
      || typeof value.artifact !== "string" || ![...Object.keys(ARTIFACTS), "patch"].includes(value.artifact)) refuse("resource_payload", "Spawn reads need runId and artifact only");
  } else if (value.runId !== undefined || value.artifact !== undefined || (value.kind !== "history" && value.path === undefined)) {
    refuse("resource_payload", "Invalid fields for resource kind");
  }
  return value as ReadInput;
}
async function limited<T>(check: () => void, work: () => Promise<T>): Promise<T> {
  check();
  if (active >= 4) throw new CommandError("session_busy", "Resource read concurrency limit reached");
  active++;
  try {
    const result = await work();
    check();
    return result;
  } catch (error) {
    if (error instanceof CommandError) throw error;
    if (error instanceof Error && "code" in error) {
      const code = String(error.code);
      if (["ENOENT", "ENOTDIR"].includes(code)) refuse("resource_missing", "Resource does not exist");
      if (["ELOOP", "EACCES", "EPERM"].includes(code)) refuse("resource_denied", "Resource is inaccessible or a symbolic link");
      if (code === "EISDIR") refuse("resource_type", "Only regular files can be read");
    }
    throw error;
  } finally { active--; }
}
function inside(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return suffix === "" || (!isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`));
}

/** Trusted roots may themselves have OS aliases (for example /var on macOS).
 * Below that root, reject every symlink component, including in-root links. */
export async function canonical(target: Target, check: () => void): Promise<string> {
  check();
  if (!pathString(target.root) || !isAbsolute(target.root) || !pathString(target.path) || !isAbsolute(target.path)) {
    refuse("resource_denied", "Resource paths must be absolute and traversal-free");
  }
  const lexicalRoot = resolve(target.root);
  const root = await realpath(lexicalRoot);
  const requested = resolve(target.path);
  // Accept either the configured trusted root or its canonical spelling.
  const base = inside(lexicalRoot, requested) ? lexicalRoot : root;
  if (!inside(base, requested)) refuse("resource_denied", "Path is outside its allowed root");
  let current = root;
  const parts = relative(base, requested).split(sep).filter(Boolean);
  if (parts.length > 128) refuse("resource_oversize", "Path exceeds component limit");
  for (const part of parts) {
    check();
    current = join(current, part);
    if ((await lstat(current)).isSymbolicLink()) refuse("resource_denied", "Symbolic link components are not allowed");
  }
  const result = await realpath(current);
  if (result !== current || !inside(root, result)) refuse("resource_denied", "Canonical path escaped its allowed root");
  check();
  return result;
}
export function fingerprint(stamp: BigIntStats): string {
  return createHash("sha256").update([stamp.dev, stamp.ino, stamp.mode, stamp.uid, stamp.size, stamp.mtimeNs, stamp.ctimeNs].join(":")).digest("hex");
}
async function openTarget(target: Target, check: () => void): Promise<Opened> {
  const path = await canonical(target, check);
  // NONBLOCK also prevents a raced FIFO from waiting for a writer before fstat.
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stamp = await file.stat({ bigint: true });
    if (!stamp.isFile()) refuse("resource_type", "Only regular files can be read");
    if (stamp.size > BigInt(Number.MAX_SAFE_INTEGER)) refuse("resource_oversize", "File is too large for byte offsets");
    if (target.owned && (process.getuid === undefined || stamp.uid !== BigInt(process.getuid()) || stamp.nlink !== 1n)) {
      refuse("resource_denied", "Resource must be single-linked and owned by the service user");
    }
    const opened = { ...target, file, stamp, canonical: path };
    await unchanged(opened, check);
    return opened;
  } catch (error) { await file.close(); throw error; }
}
async function unchanged(opened: Opened, check: () => void): Promise<void> {
  check();
  if (await canonical(opened, check) !== opened.canonical
    || fingerprint(await opened.file.stat({ bigint: true })) !== fingerprint(opened.stamp)
    || fingerprint(await lstat(opened.canonical, { bigint: true })) !== fingerprint(opened.stamp)) changed();
  check();
}
function decode(bytes: Buffer): string {
  if (bytes.includes(0)) refuse("resource_binary", "NUL bytes are not supported");
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { refuse("resource_binary", "Resource is not valid UTF-8 text"); }
}
async function readBytes(opened: Opened, start: number, length: number, check: () => void): Promise<Buffer> {
  const bytes = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    check();
    const result = await opened.file.read(bytes, read, length - read, start + read);
    if (!result.bytesRead) changed();
    read += result.bytesRead;
  }
  check();
  return bytes;
}
async function chunk(target: Target, input: ReadInput, check: () => void): Promise<TextChunk> {
  const opened = await openTarget(target, check);
  try {
    const size = Number(opened.stamp.size);
    const version = fingerprint(opened.stamp);
    if (input.version !== undefined && input.version !== version) changed();
    const start = input.offset ?? 0;
    if (start > size) refuse("resource_offset", "Offset is beyond end of file");
    const bytes = await readBytes(opened, start, Math.min(CHUNK_BYTES, size - start), check);
    let length = bytes.length;
    if (start + length < size && length) {
      // Remove only an incomplete trailing sequence; never mask malformed bytes.
      let lead = length - 1;
      while (lead >= length - 3 && lead >= 0 && (bytes[lead] & 0xc0) === 0x80) lead--;
      if (lead >= 0) {
        const first = bytes[lead];
        const expected = first >= 0xc2 && first <= 0xdf ? 2 : first >= 0xe0 && first <= 0xef ? 3 : first >= 0xf0 && first <= 0xf4 ? 4 : 1;
        if (expected > length - lead) length = lead;
      }
    }
    const text = decode(bytes.subarray(0, length));
    await unchanged(opened, check);
    return { text, path: opened.canonical, offset: start, nextOffset: start + length < size ? start + length : null, version, size };
  } finally { await opened.file.close(); }
}
export async function metadata(target: Target, check: () => void, budget: { bytes: number }): Promise<Record<string, unknown>> {
  const opened = await openTarget({ ...target, owned: true }, check);
  try {
    if (opened.stamp.size > BigInt(RECORD_BYTES) || budget.bytes + Number(opened.stamp.size) > RECORD_BYTES) {
      refuse("resource_oversize", "Resource metadata exceeds the aggregate 16 MiB read budget");
    }
    budget.bytes += Number(opened.stamp.size);
    const bytes = await readBytes(opened, 0, Number(opened.stamp.size), check);
    await yieldTurn(); check();
    let value: unknown;
    try { value = JSON.parse(decode(bytes)); }
    catch (error) { if (error instanceof CommandError) throw error; refuse("resource_metadata", "Invalid resource metadata JSON"); }
    if (!object(value)) refuse("resource_metadata", "Resource metadata must be an object");
    await unchanged(opened, check);
    return value;
  } finally { await opened.file.close(); }
}

class Provenance {
  private readonly runs = new Map<string, Promise<Record<string, unknown> | undefined>>();
  private readonly metadataBudget = { bytes: 0 };
  constructor(private readonly context: ResourceContext) {}

  async run(id: string, ancestors: readonly string[] = []): Promise<Record<string, unknown> | undefined> {
    this.context.check();
    if (!identifier(id)) refuse("resource_denied", "Invalid run identifier");
    if (ancestors.includes(id) || ancestors.length >= ANCESTORS) refuse("resource_provenance", "Run ancestry is cyclic or too deep");
    let pending = this.runs.get(id);
    if (!pending) {
      pending = this.validateRun(id, [...ancestors, id]);
      this.runs.set(id, pending);
    }
    return pending;
  }

  private async validateRun(id: string, ancestors: readonly string[]): Promise<Record<string, unknown> | undefined> {
    const { context } = this;
    let status: Record<string, unknown>;
    try { status = await metadata({ root: context.workspacesRoot, path: join(context.workspacesRoot, "runs", id, "status.json") }, context.check, this.metadataBudget); }
    catch (error) { if (missing(error)) return; throw error; }
    if (status.runId !== id || !pathString(status.parentSessionFile) || !isAbsolute(status.parentSessionFile)) return;
    if (await this.sameSession(status.parentSessionFile, context.sessionFile)) return status;
    const runsRoot = join(context.workspacesRoot, "runs");
    const canonicalRuns = await realpath(runsRoot);
    const parent = resolve(status.parentSessionFile);
    const root = inside(resolve(runsRoot), parent) ? resolve(runsRoot) : canonicalRuns;
    if (!inside(root, parent)) return;
    const parts = relative(root, parent).split(sep);
    if (parts.length < 3 || !identifier(parts[0]) || parts[1] !== "sessions" || !parent.endsWith(".jsonl")) return;
    if (!await this.run(parts[0], ancestors)) return;
    // A nested run's session parent must be an actual regular, user-owned file
    // below that validated ancestor's sessions directory, not a frontend path.
    const opened = await openTarget({ root: context.workspacesRoot, path: parent, owned: true }, context.check);
    await opened.file.close();
    return status;
  }

  async sameSession(left: string, right: string): Promise<boolean> {
    if (!pathString(left) || !isAbsolute(left) || !pathString(right) || !isAbsolute(right)) return false;
    // Only compare against the trusted session's spellings; never canonicalize
    // an unrelated supplied parent and accidentally grant it session authority.
    const managed = await canonical({ root: dirname(right), path: right }, this.context.check);
    return resolve(left) === resolve(right) || resolve(left) === managed;
  }

  async patch(id: string, status: Record<string, unknown>): Promise<Target> {
    const { context } = this;
    const worktree = object(status.worktree) ? status.worktree : undefined;
    const workspaceId = status.workspaceId ?? worktree?.workspaceId;
    if (!identifier(workspaceId) || (worktree && worktree.workspaceId !== workspaceId)) {
      refuse("resource_provenance", "Run has no validated patch workspace");
    }
    const expected = join(context.workspacesRoot, "artifacts", workspaceId, "result.patch");
    let record: Record<string, unknown> | undefined;
    try { record = await metadata({ root: context.workspacesRoot, path: join(context.workspacesRoot, "records", `${workspaceId}.json`) }, context.check, this.metadataBudget); }
    catch (error) { if (!missing(error)) throw error; }
    if (record) {
      if (record.version !== 1 || record.id !== workspaceId || record.kind !== "child" || record.runId !== id
        || typeof record.sourceSessionFile !== "string" || !await this.sameSession(record.sourceSessionFile, String(status.parentSessionFile))
        || record.resultPatchPath !== expected) refuse("resource_provenance", "Patch workspace relation does not match this run");
    } else {
      // Deleted workspace records can leave generated recovery metadata in the
      // same validated run. Require both published forms and the fixed filename.
      if (!worktree || worktree.retained !== true || status.workspaceId !== workspaceId
        || status.patchPath !== expected || worktree.patchPath !== expected || !workspaceId.startsWith("child-")
        || !["completed", "failed", "aborted"].includes(String(status.status))) {
        refuse("resource_provenance", "Retained patch provenance is uncertain");
      }
    }
    return { root: context.workspacesRoot, path: expected, owned: true };
  }
}
function missing(error: unknown): boolean { return error instanceof Error && "code" in error && error.code === "ENOENT"; }

type ScanBudget = { bytes: number; files: number };
async function scanJsonl(target: Target, budget: ScanBudget, check: () => void, visit: (record: unknown) => boolean): Promise<boolean> {
  if (++budget.files > SCAN_FILES) refuse("resource_oversize", "Output discovery exceeds file scan limit");
  const opened = await openTarget({ ...target, owned: true }, check);
  try {
    const size = Number(opened.stamp.size);
    if (budget.bytes + size > SCAN_BYTES) refuse("resource_oversize", "Output discovery exceeds 256 MiB scan limit");
    budget.bytes += size;
    let fragments: Buffer[] = [];
    let recordSize = 0;
    const parse = async (): Promise<boolean> => {
      const bytes = Buffer.concat(fragments, recordSize);
      fragments = []; recordSize = 0;
      await yieldTurn(); check();
      if (!bytes.length) return false;
      let value: unknown;
      try { value = JSON.parse(decode(bytes)); }
      catch (error) { if (error instanceof CommandError) throw error; refuse("resource_metadata", "Invalid JSONL record in managed history"); }
      return visit(value);
    };
    for (let position = 0; position < size; position += CHUNK_BYTES) {
      check();
      const block = await readBytes(opened, position, Math.min(CHUNK_BYTES, size - position), check);
      let start = 0;
      for (let end = block.indexOf(10); ; end = block.indexOf(10, start)) {
        const limit = end === -1 ? block.length : end;
        const fragment = block.subarray(start, limit);
        recordSize += fragment.length;
        if (recordSize > RECORD_BYTES) refuse("resource_oversize", "JSONL record exceeds 16 MiB");
        fragments.push(fragment);
        if (end === -1) break;
        if (await parse()) { await unchanged(opened, check); return true; }
        start = end + 1;
      }
      await yieldTurn(); check();
    }
    // Pi appends complete newline-terminated records. A live partial tail grants
    // no authority until its newline arrives, but still counts toward the limit.
    await unchanged(opened, check);
    return false;
  } finally { await opened.file.close(); }
}
/** Historical review pins must come from a workspace result in this managed history,
 * never arbitrary frontend repository/revision inputs. */
export async function historicalWorkspaceReview(context: ResourceContext, workspaceId: string, before: string, after: string): Promise<Record<string, unknown>> {
  let found: Record<string, unknown> | undefined;
  await scanJsonl({ root: dirname(context.sessionFile), path: context.sessionFile }, { bytes: 0, files: 0 }, context.check, (record) => {
    if (!object(record) || record.type !== "message" || !object(record.message) || record.message.role !== "toolResult" || record.message.toolName !== "workspace" || !object(record.message.details)) return false;
    const details = record.message.details, review = details.integrationReview;
    if (details.id !== workspaceId || !object(review) || review.before !== before || review.after !== after
      || !(["applied", "none"].includes(String(details.integration)) || details.integration === "failed" && review.applied === true)) return false;
    found = details; return true;
  });
  if (!found) refuse("resource_denied", "Historical review comparison has no managed workspace result");
  return found;
}
function outputReference(record: unknown, path: string): boolean {
  if (!object(record)) return false;
  const matches = (details: unknown): boolean => object(details) && details.fullOutputPath === path;
  if (record.type === "message" && object(record.message)) {
    if (record.message.role === "toolResult" && matches(record.message.details)) return true;
    if (record.message.role === "bashExecution" && record.message.fullOutputPath === path) return true;
  }
  const event = object(record.event) ? record.event : undefined;
  if (!event) return false;
  if ((event.type === "tool_execution_end" || event.type === "tool_execution_update")) {
    const result = event.type === "tool_execution_end" ? event.result : event.partialResult;
    if (object(result) && matches(result.details)) return true;
  }
  return (event.type === "message_end" || event.type === "message_update") && object(event.message)
    && (event.message.role === "toolResult" && matches(event.message.details)
      || event.message.role === "bashExecution" && event.message.fullOutputPath === path);
}

async function directoryEntries(target: Target, check: () => void): Promise<{ path: string; entries: Dirent[] }> {
  const path = await canonical(target, check);
  const before = await lstat(path, { bigint: true });
  if (!before.isDirectory()) refuse("resource_type", "Completion path must be a directory");
  const directory = await opendir(path, { bufferSize: 32 });
  const entries: Dirent[] = [];
  try {
    for (;;) {
      check();
      const entry = await directory.read();
      if (!entry) break;
      if (entries.length >= DIRECTORY_ENTRIES) refuse("resource_oversize", "Directory exceeds 10000 entry scan limit");
      entries.push(entry);
      if (entries.length % 128 === 0) { await yieldTurn(); check(); }
    }
  } finally { await directory.close(); }
  if (await canonical(target, check) !== path || fingerprint(await lstat(path, { bigint: true })) !== fingerprint(before)) changed();
  entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  return { path, entries };
}
async function authorizeOutput(context: ResourceContext, path: string, provenance: Provenance): Promise<Target> {
  if (!isAbsolute(path)) refuse("resource_denied", "Output references must be absolute");
  const target = { root: context.tempRoot, path, owned: true };
  await canonical(target, context.check);
  if (context.liveOutputPaths.includes(path)) return target;
  const budget = { bytes: 0, files: 0 };
  const visit = (record: unknown): boolean => outputReference(record, path);
  if (await scanJsonl({ root: dirname(context.sessionFile), path: context.sessionFile }, budget, context.check, visit)) return target;
  let runs: Awaited<ReturnType<typeof directoryEntries>>;
  try { runs = await directoryEntries({ root: context.workspacesRoot, path: join(context.workspacesRoot, "runs") }, context.check); }
  catch (error) { if (missing(error)) refuse("resource_denied", "Output has no managed fullOutputPath reference"); throw error; }
  const candidates = runs.entries.filter((entry) => entry.isDirectory() && identifier(entry.name));
  if (candidates.length > RUNS) refuse("resource_oversize", "Output discovery exceeds 256 run limit");
  for (const entry of candidates) {
    context.check();
    if (!await provenance.run(entry.name)) continue;
    try {
      if (await scanJsonl({ root: context.workspacesRoot, path: join(context.workspacesRoot, "runs", entry.name, "transcript.jsonl") }, budget, context.check, visit)) return target;
    } catch (error) { if (!missing(error)) throw error; }
  }
  refuse("resource_denied", "Output has no managed fullOutputPath reference");
}

export async function readResource(context: ResourceContext, input: unknown): Promise<TextChunk> {
  return limited(context.check, async () => {
    const request = readInput(input);
    const provenance = new Provenance(context);
    let target: Target;
    switch (request.kind) {
      case "history":
        if (request.path !== undefined && request.path !== context.sessionFile) refuse("resource_denied", "History path must be the managed session file");
        target = { root: dirname(context.sessionFile), path: context.sessionFile, owned: true };
        break;
      case "file":
        target = { root: context.workspaceRoot, path: resolve(context.cwd, request.path!) };
        break;
      case "skill":
        if (!context.skillPaths.includes(request.path!)) refuse("resource_denied", "Skill is not in the discovered skill allowlist");
        target = { root: dirname(request.path!), path: request.path! };
        break;
      case "output": target = await authorizeOutput(context, request.path!, provenance); break;
      case "spawn": {
        const status = await provenance.run(request.runId!);
        if (!status) refuse("resource_denied", "Run does not belong to the managed conversation");
        target = request.artifact === "patch" ? await provenance.patch(request.runId!, status)
          : { root: context.workspacesRoot, path: join(context.workspacesRoot, "runs", request.runId!, ARTIFACTS[request.artifact! as Exclude<Artifact, "patch">]), owned: true };
        break;
      }
    }
    return chunk(target, request, context.check);
  });
}

/** Host-level completion accepts absolute directories only, never a frontend cwd.
 * Entries are absolute child directory paths; no file names or contents escape. */
export async function completeDirectory(input: unknown, check: () => void): Promise<{ path: string; entries: string[]; nextOffset: number | null }> {
  return limited(check, async () => {
    if (!exact(input, ["path", "offset"]) || !pathString(input.path) || !isAbsolute(input.path) || !offset(input.offset)) {
      refuse("resource_payload", "Directory completion requires an absolute path and optional offset");
    }
    const { path, entries } = await directoryEntries({ root: sep, path: input.path }, check);
    const directories = entries.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink());
    const start = (input.offset as number | undefined) ?? 0;
    if (start > directories.length) refuse("resource_offset", "Completion offset is beyond the directory page");
    const page = directories.slice(start, start + PAGE_SIZE).map((entry) => join(path, entry.name));
    return { path, entries: page, nextOffset: start + page.length < directories.length ? start + page.length : null };
  });
}

export async function completeFiles(context: ResourceContext, input: unknown): Promise<{ path: string; entries: FileEntry[]; nextOffset: number | null }> {
  return limited(context.check, async () => {
    if (!exact(input, ["prefix", "offset"]) || !pathString(input.prefix, true) || !offset(input.offset)) {
      refuse("resource_payload", "File completion requires prefix and optional offset");
    }
    const prefix = resolve(context.cwd, input.prefix);
    const trailing = input.prefix === "" || input.prefix.endsWith(sep);
    const directory = trailing ? prefix : dirname(prefix);
    const name = trailing ? "" : basename(prefix);
    const result = await directoryEntries({ root: context.workspaceRoot, path: directory }, context.check);
    const matches = result.entries.filter((entry) => entry.name.startsWith(name) && (entry.isDirectory() || entry.isFile()) && !entry.isSymbolicLink());
    const start = (input.offset as number | undefined) ?? 0;
    if (start > matches.length) refuse("resource_offset", "Completion offset is beyond the file page");
    const page: FileEntry[] = matches.slice(start, start + PAGE_SIZE).map((entry) => ({
      path: (isAbsolute(input.prefix as string) ? join(result.path, entry.name) : relative(context.cwd, join(result.path, entry.name))) + (entry.isDirectory() ? sep : ""),
      kind: entry.isDirectory() ? "directory" : "file",
    }));
    return { path: result.path, entries: page, nextOffset: start + page.length < matches.length ? start + page.length : null };
  });
}
