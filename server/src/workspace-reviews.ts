import { execFile } from "node:child_process";
import { createHmac, randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { constants, closeSync, fstatSync, ftruncateSync, lstatSync, openSync, readFileSync, realpathSync, writeSync, fsyncSync } from "node:fs";
import { readdir, lstat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { canonical, fingerprint, metadata, readResource, historicalWorkspaceReview, type ResourceContext } from "./resource-reads.js";
import { object } from "./pi-records.js";
import { CommandError } from "./session-commands.js";
import { actionSnapshot, applyReviewAction, type ReviewAction, type ReviewRecovery } from "./workspace-review-actions.js";

const TEXT_BYTES = 1024 * 1024;
const REVIEW_BYTES = 4 * 1024 * 1024;
const FILES = 512;
type Binding = { workspaceId: string; recordVersion: string; root: string; repositoryRoot: string; before: string; after?: string; historical: boolean; pinned?: true };
type Edit = Binding & { path: string; version: string; hash: string };
export type ReviewSave = { operation: "workspace.review.save"; payload: { resourceId: string; expectedVersion: string; text: string } };
export type ReviewMutation = ReviewSave
  | { operation: "workspace.review.stage" | "workspace.review.unstage"; payload: { actionId: string } }
  | { operation: "workspace.review.restore"; payload: { actionId: string; confirmed: true } };
type ActionReference = Binding & { action: { version: string; mode: "file" | "stageAll" | "unstageAll"; path?: string } };
type FileChange = { path: string; status: string; additions: number | null; deletions: number | null; staged?: boolean };

function deny(message: string): never { throw new CommandError("resource_denied", message); }
function conflict(): never { throw new CommandError("resource_conflict", "Owner resource changed; inspect current owner content. Your draft was not saved."); }
function unavailable(message: string): never { throw new CommandError("resource_unavailable", message); }
function limit(message: string): never { throw new CommandError("resource_limit", message); }
function exact(value: unknown, keys: string[]): value is Record<string, unknown> { return object(value) && Object.keys(value).every((key) => keys.includes(key)); }
function id(value: unknown): value is string { return typeof value === "string" && /^[\w-]{1,128}$/.test(value); }
function path(value: unknown): value is string { return typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= 4096 && !isAbsolute(value) && !/[\x00-\x1f\x7f\\]/.test(value) && !value.split("/").some((part) => part === ".." || part === "." || !part); }
function hash(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function text(bytes: Buffer, nulDelimited = false): string {
  if (!nulDelimited && bytes.includes(0)) unavailable("Binary review resources are unsupported");
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { return unavailable("Non-UTF-8 review resources are unsupported"); }
}
export function validReviewAction(operation: string, payload: Record<string, unknown>): boolean {
  return ["workspace.review.stage", "workspace.review.unstage", "workspace.review.restore"].includes(operation)
    && exact(payload, operation === "workspace.review.restore" ? ["actionId", "confirmed"] : ["actionId"])
    && typeof payload.actionId === "string" && payload.actionId.length > 0 && payload.actionId.length <= 32768
    && (operation !== "workspace.review.restore" || payload.confirmed === true);
}
export function validReviewSave(payload: Record<string, unknown>): boolean {
  return exact(payload, ["resourceId", "expectedVersion", "text"]) && typeof payload.resourceId === "string" && payload.resourceId.length <= 32768
    && typeof payload.expectedVersion === "string" && /^[a-f0-9]{64}$/.test(payload.expectedVersion)
    && typeof payload.text === "string" && Buffer.byteLength(payload.text) <= TEXT_BYTES && !payload.text.includes("\0")
    && new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.from(payload.text)) === payload.text;
}

/** Allowlisted reads and private alternate-index preparation. Never publish an index
 * or restore worktree bytes from a subprocess; that boundary is synchronous below. */
async function git(root: string, args: string[], check: () => void, bytes = REVIEW_BYTES, index?: string): Promise<Buffer> {
  check();
  const overrides: string[] = [];
  if (["diff", "add"].includes(args[0])) {
    // Worktree comparisons otherwise execute clean/process filters even with
    // --no-ext-diff/--no-textconv. Disable every configured driver for this call.
    const config = text(await git(root, ["config", "--null", "--list"], check), true);
    const drivers = new Set(config.split("\0").map((entry) => entry.split("\n", 1)[0].match(/^filter\.(.*)\.(?:clean|smudge|process|required)$/)?.[1]).filter((entry): entry is string => entry !== undefined));
    for (const driver of drivers) for (const key of ["clean", "smudge", "process", "required"]) overrides.push("-c", `filter.${driver}.${key}=${key === "required" ? "false" : ""}`);
  }
  return new Promise((done, reject) => {
    const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
    // diff may rewrite an unchanged index to refresh stat data even with optional
    // locks disabled. Reads must not invalidate the index versions they issue.
    execFile("git", ["--no-optional-locks", "--literal-pathspecs", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false", "-c", "core.hooksPath=/dev/null", ...overrides, "-C", root, ...args],
      { encoding: "buffer", maxBuffer: bytes, timeout: 10_000, env: { ...environment, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", ...(index ? { GIT_INDEX_FILE: index } : {}) } }, (error, stdout) => {
        try { check(); if (error) { if (stdout.length >= bytes || "code" in error && error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") limit("Review Git output exceeds limit"); unavailable("Review Git object or worktree is unavailable"); } done(stdout); }
        catch (failure) { reject(failure); }
      });
  });
}

/** Ephemeral, signed resource references bind reads to this owner/session/runtime.
 * Nothing is persisted except ordinary save command receipts. References never authorize a write. */
export class WorkspaceReviews {
  private readonly secret = randomBytes(32);
  constructor(private readonly scope: () => string) {}
  private seal(value: Binding | Edit | ActionReference): string {
    const body = Buffer.from(JSON.stringify({ ...value, scope: this.scope() })).toString("base64url");
    return body + "." + createHmac("sha256", this.secret).update(body).digest("hex");
  }
  private unseal(value: unknown): Binding & Partial<Edit> & Partial<ActionReference> {
    if (typeof value !== "string" || value.length > 32768) deny("Invalid review resource reference");
    const [body, signature, extra] = value.split(".");
    const expected = createHmac("sha256", this.secret).update(body).digest();
    if (extra || !signature || !/^[a-f0-9]{64}$/.test(signature) || !timingSafeEqual(expected, Buffer.from(signature, "hex"))) deny("Review resource substitution refused");
    const decoded: unknown = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!object(decoded) || decoded.scope !== this.scope()) throw new CommandError("stale_runtime", "Review belongs to an old owner/session/runtime context");
    const { scope: _scope, ...binding } = decoded;
    return binding as Binding & Partial<Edit> & Partial<ActionReference>;
  }
  private recordPath(context: ResourceContext, workspaceId: string): string { return join(context.workspacesRoot, "records", workspaceId + ".json"); }
  private async record(context: ResourceContext, workspaceId: string): Promise<Record<string, unknown>> {
    if (!id(workspaceId)) deny("Invalid workspace ID");
    const record = await metadata({ root: context.workspacesRoot, path: this.recordPath(context, workspaceId) }, context.check, { bytes: 0 });
    if (record.id !== workspaceId || record.version !== 1 || record.kind !== "task") deny("Review requires a task workspace owned by this conversation");
    const session = await canonical({ root: resolve(context.sessionFile, ".."), path: context.sessionFile }, context.check);
    if (![record.sourceSessionFile, record.targetSessionFile].includes(context.sessionFile) && ![record.sourceSessionFile, record.targetSessionFile].includes(session)) deny("Workspace belongs to another conversation");
    return record;
  }
  private async binding(context: ResourceContext, workspaceId: string, pin?: { before: string; after: string }): Promise<{ binding: Binding; record: Record<string, unknown> }> {
    const record = pin ? await historicalWorkspaceReview(context, workspaceId, pin.before, pin.after) : await this.record(context, workspaceId);
    if (record.id !== workspaceId || record.kind !== "task" || ![record.sourceSessionFile, record.targetSessionFile].includes(context.sessionFile)) deny("Review requires this conversation's task workspace");
    const review = object(record.integrationReview) ? record.integrationReview : undefined;
    const historical = !!review && (["applied", "none"].includes(String(record.integration)) || record.integration === "failed" && review.applied === true);
    const before = historical ? review!.before : record.baselineCommit;
    const after = historical ? review!.after : undefined;
    const root = historical ? record.destinationRoot : record.worktreePath;
    if (typeof record.destinationRoot !== "string" || !isAbsolute(record.destinationRoot)
      || typeof root !== "string" || !isAbsolute(root) || typeof before !== "string" || !/^[a-f0-9]{40,64}$/.test(before)
      || historical && (typeof after !== "string" || !/^[a-f0-9]{40,64}$/.test(after))) deny("Invalid workspace review metadata");
    if (!historical && (context.workspaceRoot !== root || context.workspaceId !== workspaceId || record.managedCleanupPending)) unavailable("Only the current active task workspace can be edited");
    if (!historical && root !== join(context.workspacesRoot, "trees", workspaceId)) deny("Review worktree is outside the managed task tree");
    const canonicalRoot = await canonical({ root: historical ? root : context.workspacesRoot, path: root }, context.check);
    const binding: Binding = { workspaceId, recordVersion: hash(JSON.stringify(record)), root: canonicalRoot, repositoryRoot: record.destinationRoot, before, after: after as string | undefined, historical, ...(pin ? { pinned: true as const } : {}) };
    return { binding, record };
  }
  private async revalidate(context: ResourceContext, binding: Binding): Promise<void> {
    const current = (await this.binding(context, binding.workspaceId, binding.pinned ? { before: binding.before, after: binding.after! } : undefined)).binding;
    if (JSON.stringify(current) !== JSON.stringify(binding)) conflict();
    context.check();
  }
  async read(context: ResourceContext, input: unknown): Promise<unknown> {
    if (!object(input)) deny("Invalid review query");
    if (input.kind === "workspaceReviews" && exact(input, ["kind"])) {
      const directory = join(context.workspacesRoot, "records");
      const names = await readdir(directory); context.check();
      if (names.length > 1024) limit("Workspace review catalog exceeds 1024 records");
      const entries: Record<string, unknown>[] = [], budget = { bytes: 0 };
      for (const name of names.sort()) {
        if (!name.endsWith(".json") || !id(name.slice(0, -5))) continue;
        const record = await metadata({ root: context.workspacesRoot, path: join(directory, name) }, context.check, budget);
        if (record.kind === "task" && [record.sourceSessionFile, record.targetSessionFile].includes(context.sessionFile)) entries.push({ id: record.id, label: record.label, lifecycle: record.lifecycle });
      }
      return { entries };
    }
    if (input.kind === "workspaceReview" && exact(input, ["kind", "workspaceId", "before", "after"])) {
      const workspaceId = input.workspaceId ?? context.workspaceId;
      if (!id(workspaceId)) unavailable("No current task workspace; select a historical workspace review");
      const pin = input.before === undefined && input.after === undefined ? undefined :
        typeof input.before === "string" && /^[a-f0-9]{40,64}$/.test(input.before) && typeof input.after === "string" && /^[a-f0-9]{40,64}$/.test(input.after) ? { before: input.before, after: input.after } : deny("Invalid historical comparison");
      const { binding, record } = await this.binding(context, workspaceId, pin);
      const changes = await this.changes(context, binding);
      const stagePaths = changes.filter((file) => file.status !== "=").map((file) => file.path);
      const stage = binding.historical ? {} : this.actionReference(context, binding, stagePaths, "stageAll");
      const unstage = binding.historical ? {} : this.actionReference(context, binding, [], "unstageAll");
      const included = Array.isArray(record.includedIgnoredFiles) ? record.includedIgnoredFiles.filter(object).map((entry) => entry.path).filter(path) : [];
      const unpreserved = binding.historical ? record.unpreservedFiles ?? []
        : text(await git(binding.root, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"], context.check), true).split("\0").filter((name) => name && !included.includes(name));
      if (Array.isArray(unpreserved) && unpreserved.length > FILES) limit("Review exceeds 512 ignored-file notices");
      const ignored = binding.historical && object(record.integrationReview) && Array.isArray(record.integrationReview.ignoredFiles) ? record.integrationReview.ignoredFiles : included;
      if (!binding.historical && JSON.stringify(await this.changes(context, binding)) !== JSON.stringify(changes)) conflict();
      await this.revalidate(context, binding);
      this.recheckAction(context, binding, stage.actionId, stagePaths);
      this.recheckAction(context, binding, unstage.actionId, []);
      return { reviewId: this.seal(binding), workspaceId, historical: binding.historical, before: binding.before, after: binding.after,
        files: changes, ignoredFiles: ignored, unpreservedFiles: unpreserved,
        stageId: stage.actionId, stageUnsupported: stage.actionUnsupported, unstageId: unstage.actionId, unstageUnsupported: unstage.actionUnsupported,
        notice: "Ignored files are outside the Git diff. Historical ignored-file bytes are not retained. Stage/unstage act on reviewed owner files; confirmed restore returns an existing baseline file and its index entry to that baseline, or removes an added working file without changing its index entry. Binary files support index actions and baseline restore, but not text editing. Stage/restore of symlink/submodule resources is unsupported. Unstage resets only the index. Text saves never stage files.",
        partial: record.integration === "failed" };
    }
    if (input.kind === "workspaceReviewFile" && exact(input, ["kind", "reviewId", "path", "resourceId"]) && path(input.path)) {
      const raw = this.unseal(input.reviewId);
      const { path: _path, version: _version, hash: _hash, ...binding } = raw;
      // unseal validates the signed envelope; only Binding fields are compared below.
      const { binding: currentBinding, record } = await this.binding(context, binding.workspaceId, binding.pinned ? { before: binding.before, after: binding.after! } : undefined);
      if (hash(JSON.stringify(currentBinding)) !== hash(JSON.stringify(binding))) conflict();
      // Capture before any asynchronous diff/content rendering, then verify this
      // same state after the last await. Never sign newer, undisplayed bytes.
      const capturedActions = binding.historical ? {} : this.actionReference(context, currentBinding, [input.path], "file");
      const changes = await this.changes(context, currentBinding);
      const included = Array.isArray(record.includedIgnoredFiles) ? record.includedIgnoredFiles.filter(object).map((entry) => entry.path) : [];
      const change = changes.find((entry) => entry.path === input.path);
      const original = input.resourceId === undefined ? undefined : this.unseal(input.resourceId);
      const originallyRead = original?.path === input.path && original.workspaceId === binding.workspaceId && original.recordVersion === binding.recordVersion && original.root === binding.root && original.before === binding.before && original.after === binding.after;
      if (!change && !(included.includes(input.path) && !binding.historical) && !originallyRead) deny("File is outside this review");
      let before = "", after = "", version: string | undefined, resourceId: string | undefined, unsupported: string | undefined;
      try {
        before = change && change.status !== "A" && change.status !== "?" ? await this.blob(context, currentBinding, currentBinding.before, input.path) : "";
        if (currentBinding.historical) after = change?.status !== "D" ? await this.blob(context, currentBinding, currentBinding.after!, input.path) : "";
        else if (change?.status === "D") unsupported = "Deleted file: text :write is unavailable; use confirmed baseline restore (X)";
        else {
          let offset = 0; const parts: string[] = [];
          for (;;) {
            const page = await readResource({ ...context, workspaceRoot: binding.root, cwd: binding.root }, { kind: "file", path: input.path, offset, ...(version ? { version } : {}) });
            if (page.size > TEXT_BYTES) limit("Editable review text exceeds 1 MiB");
            version = page.version; parts.push(page.text);
            if (page.nextOffset === null) break;
            offset = page.nextOffset;
          }
          after = parts.join("");
          const stamp = await lstat(await canonical({ root: binding.root, path: join(binding.root, input.path) }, context.check), { bigint: true });
          context.check();
          if (fingerprint(stamp) !== version) conflict();
          if (stamp.nlink !== 1n || process.getuid === undefined || stamp.uid !== BigInt(process.getuid())) unavailable("Editable resources must be single-linked and owned by the service user");
          resourceId = this.seal({ ...currentBinding, path: input.path, version: version!, hash: hash(after) });
        }
      } catch (error) {
        if (!(error instanceof CommandError) || !["resource_unavailable", "resource_denied", "resource_limit"].includes(error.code)) throw error;
        unsupported = error.message; resourceId = undefined;
      }
      const patch = change ? await git(binding.root, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", binding.before, ...(binding.after ? [binding.after] : []), "--", input.path], context.check) : undefined;
      let diff = "Ignored file: outside Git diff";
      if (patch) {
        try { diff = text(patch); }
        catch (error) {
          if (!(error instanceof CommandError) || error.code !== "resource_unavailable") throw error;
          diff = "Binary/non-UTF-8 patch cannot be rendered. Supported index and raw baseline-restore actions remain available.";
        }
      }
      if (change?.status === "?" && resourceId) {
        const content = after.endsWith("\n") ? after.slice(0, -1) : after;
        const lines = after ? content.split("\n") : [];
        diff = `--- /dev/null\n+++ b/${input.path}\n` + (lines.length ? `@@ -0,0 +1,${lines.length} @@\n` + lines.map((line) => "+" + line).join("\n") + "\n" + (after.endsWith("\n") ? "" : "\\ No newline at end of file\n") : "");
      }
      if (resourceId) await readResource({ ...context, workspaceRoot: binding.root, cwd: binding.root }, { kind: "file", path: input.path, version });
      await this.revalidate(context, currentBinding);
      const actions = !binding.historical && change ? capturedActions : {};
      this.recheckAction(context, currentBinding, actions.actionId, [input.path]);
      return { path: input.path, before, after, diff, version, resourceId, historical: binding.historical, unsupported, ...actions };
    }
    throw new CommandError("invalid_command", "Invalid workspace review query");
  }
  private async changes(context: ResourceContext, binding: Binding): Promise<FileChange[]> {
    const args = ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", binding.before, ...(binding.after ? [binding.after] : [])];
    const names = text(await git(binding.root, [...args, "--name-status", "-z", "--"], context.check), true).split("\0").filter(Boolean);
    const counts = text(await git(binding.root, [...args, "--numstat", "-z", "--"], context.check), true).split("\0").filter(Boolean);
    const statistics = new Map(counts.map((entry) => {
      const [added, removed, name] = entry.split("\t");
      if (!path(name)) deny("Review contains an unsupported path");
      return [name, { additions: added === "-" ? null : Number(added), deletions: removed === "-" ? null : Number(removed) }] as const;
    }));
    const files: FileChange[] = [];
    for (let i = 0; i < names.length; i += 2) {
      if (!path(names[i + 1])) deny("Review contains an unsupported path");
      // Without index refresh, name-status can include stat-only dirtiness.
      // Numstat checks actual content/mode and is keyed by path, not list position.
      const count = statistics.get(names[i + 1]);
      if (count) files.push({ path: names[i + 1], status: names[i], ...count });
    }
    if (!binding.historical) {
      const staged = text(await git(binding.root, ["diff", "--cached", "--ita-visible-in-index", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", "HEAD", "--"], context.check), true).split("\0").filter(Boolean);
      for (const name of staged) {
        if (!path(name)) deny("Review contains an unsupported path");
        const existing = files.find((file) => file.path === name);
        if (existing) existing.staged = true;
        else files.push({ path: name, status: "=", additions: 0, deletions: 0, staged: true });
      }
      const untracked = text(await git(binding.root, ["ls-files", "--others", "--exclude-standard", "-z"], context.check), true).split("\0").filter(Boolean);
      for (const name of untracked) { if (!path(name)) deny("Review contains an unsupported path"); files.push({ path: name, status: "?", additions: null, deletions: null }); }
    }
    if (files.length > FILES) limit("Review exceeds 512 changed files");
    return files;
  }
  private async blob(context: ResourceContext, binding: Binding, revision: string, file: string): Promise<string> {
    const mode = text(await git(binding.root, ["ls-tree", revision, "--", file], context.check));
    if (!/^100(644|755) blob /.test(mode)) unavailable("Only regular text blobs are supported (no symlinks or submodules)");
    return text(await git(binding.root, ["show", revision + ":" + file], context.check, TEXT_BYTES));
  }
  private checkRecord(context: ResourceContext, binding: Binding): void {
    context.check();
    const recordPath = this.recordPath(context, binding.workspaceId);
    if (lstatSync(recordPath).isSymbolicLink() || realpathSync(recordPath) !== recordPath) deny("Workspace record changed scope");
    if (hash(JSON.stringify(JSON.parse(readFileSync(recordPath, "utf8")))) !== binding.recordVersion) conflict();
  }
  private actionReference(context: ResourceContext, binding: Binding, paths: string[], mode: "file" | "stageAll" | "unstageAll"): { actionId?: string; actionUnsupported?: string } {
    if (!paths.length && mode !== "unstageAll") return { actionUnsupported: "There are no reviewed working files to stage" };
    try {
      context.check();
      const snapshot = actionSnapshot(binding.root, paths, binding.repositoryRoot);
      context.check();
      return { actionId: this.seal({ ...binding, action: { version: snapshot.version, mode, ...(mode === "file" ? { path: paths[0] } : {}) } }) };
    } catch (error) {
      if (error instanceof CommandError && !["resource_denied", "resource_unavailable", "resource_limit"].includes(error.code)) throw error;
      return { actionUnsupported: error instanceof Error ? error.message : "Owner review actions are unavailable" };
    }
  }
  private recheckAction(context: ResourceContext, binding: Binding, reference: string | undefined, paths: string[]): void {
    if (!reference) return;
    context.check();
    const expected = this.unseal(reference).action!.version;
    if (actionSnapshot(binding.root, paths, binding.repositoryRoot).version !== expected) conflict();
  }
  async mutate(context: ResourceContext, operation: ReviewAction, actionId: string, preserve: (recovery: ReviewRecovery) => Promise<void>): Promise<{ status: string; resourcePath?: string }> {
    const { action, ...binding } = this.unseal(actionId);
    if (!action || binding.historical || !/^[a-f0-9]{64}$/.test(action.version)
      || action.mode === "file" && !path(action.path)
      || action.mode !== "file" && (action.path !== undefined || action.mode !== (operation === "stage" ? "stageAll" : operation === "unstage" ? "unstageAll" : ""))) deny("Action does not match its reviewed resource or operation");
    await this.revalidate(context, binding);
    const paths = action.path ? [action.path] : action.mode === "unstageAll" ? []
      : (await this.changes(context, binding)).filter((file) => file.status !== "=").map((file) => file.path);
    const snapshot = actionSnapshot(binding.root, paths, binding.repositoryRoot);
    if (snapshot.version !== action.version) conflict();
    await applyReviewAction(binding.root, context.workspacesRoot, binding.before, snapshot, operation, action.mode === "unstageAll",
      (args, index) => git(binding.root, args, context.check, REVIEW_BYTES, index),
      () => this.checkRecord(context, binding), preserve);
    return { status: operation === "stage" ? "staged" : operation === "unstage" ? "unstaged" : "restored", resourcePath: action.path };
  }
  async save(context: ResourceContext, payload: ReviewSave["payload"]): Promise<{ resourceVersion: string; resourceId: string }> {
    const edit = this.unseal(payload.resourceId);
    if (edit.historical || !path(edit.path) || !edit.version || !edit.hash || edit.version !== payload.expectedVersion) deny("Save does not match its originally read editable resource");
    const { binding } = await this.binding(context, edit.workspaceId);
    const { path: file, version, hash: expectedHash, ...originalBinding } = edit;
    if (JSON.stringify(binding) !== JSON.stringify(originalBinding)) conflict();
    const target = await canonical({ root: edit.root, path: join(edit.root, file) }, context.check);
    context.check();
    // All awaits finish before this boundary. Recheck authority, metadata, every path
    // component and the opened inode/content synchronously before the first write.
    let fd: number | undefined, mutated = false;
    try {
      this.checkRecord(context, edit);
      const checkPath = () => {
        if (realpathSync(edit.root) !== edit.root) deny("Review root changed");
        let component = edit.root;
        for (const part of relative(edit.root, target).split(sep)) { component = join(component, part); if (lstatSync(component).isSymbolicLink()) deny("Symbolic link components are unsupported"); }
        if (realpathSync(target) !== target || !target.startsWith(edit.root + sep)) deny("Review path escaped its scope");
      };
      checkPath();
      fd = openSync(target, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stamp = fstatSync(fd, { bigint: true });
      if (!stamp.isFile() || stamp.nlink !== 1n || process.getuid === undefined || stamp.uid !== BigInt(process.getuid())) deny("Saves require a single-linked regular file owned by the service user");
      if (fingerprint(stamp) !== version || fingerprint(lstatSync(target, { bigint: true })) !== version || stamp.size > BigInt(TEXT_BYTES) || hash(readFileSync(fd)) !== expectedHash) conflict();
      context.check(); checkPath();
      if (fingerprint(fstatSync(fd, { bigint: true })) !== version || fingerprint(lstatSync(target, { bigint: true })) !== version) conflict();
      mutated = true;
      const bytes = Buffer.from(payload.text);
      let written = 0;
      while (written < bytes.length) written += writeSync(fd, bytes, written, bytes.length - written, written);
      ftruncateSync(fd, bytes.length); fsyncSync(fd);
      const resourceVersion = fingerprint(fstatSync(fd, { bigint: true }));
      return { resourceVersion, resourceId: this.seal({ ...binding, path: file, version: resourceVersion, hash: hash(bytes) }) };
    } catch (error) {
      if (mutated) throw new Error("Review save outcome is uncertain; inspect the original command receipt and current owner content", { cause: error });
      if (error instanceof CommandError) throw error;
      return deny("Review resource could not be validated for saving");
    } finally { if (fd !== undefined) closeSync(fd); }
  }
}
