import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createHash, randomBytes } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { assertRepositoryIdle } from "./subagent-state";
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, writeFileSync, writeSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { Type } from "typebox";
import type { ManagedBashHooks } from "./managed-bash";
import type { ManagedExit } from "../../scripts/managed-process.mjs";

export const BASH_JOBS_STATUS = "pi-bash-jobs";
const PAGE_BYTES = 16 * 1024;
const ID = /^[A-Za-z0-9_-]{22}$/;
export type BashJobState = "starting" | "running" | "terminal" | "unresolved";
export type BashCompletionState = "pending" | "queued" | "delivered" | "collected" | "suppressed";
type Cleanup = "pending" | "complete" | "unresolved";
type StopReason = "stop" | "deadline" | "owner_shutdown";

type Metadata = {
  version: 1; sessionId: string; jobId: string; command: string; cwd: string;
  state: BashJobState; createdAt: string; startedAt?: string; endedAt?: string;
  managedId?: string; timeout?: number; exitCode: number | null; signal: string | null;
  sandboxBlocked: boolean; cleanup: Cleanup; stopReason?: StopReason; error?: string;
  completion: BashCompletionState;
};
export type BashJobSummary = Omit<Metadata, "version" | "sessionId"> & { restored: boolean };
export type BashJobLaunch = { kind: "bash_job_started"; jobId: string; managedId: string; state: BashJobState; startedAt: string };
export type BashJobOutput = { jobId: string; stream: "stdout" | "stderr"; text: string; offset: number; nextOffset: number; totalBytes: number; eof: boolean };
export type BashJobResult = { kind: "bash_job_result"; job: BashJobSummary; stdout: BashJobOutput; stderr: BashJobOutput };
export type BashJoinCancelled = { kind: "bash_join_cancelled"; jobId: string };
export type BashControlResult = BashJobResult | BashJoinCancelled
  | { kind: "bash_job_list"; jobs: BashJobSummary[]; nextOffset: number | null }
  | { kind: "bash_job_status"; job: BashJobSummary }
  | { kind: "bash_job_output"; output: BashJobOutput };
export type BashJobRunner = (options: {
  admissionSignal: AbortSignal; lifetimeSignal: AbortSignal; hooks: ManagedBashHooks;
  onBlocked: () => void; onDiagnostic: (data: Buffer) => void;
}) => Promise<unknown>;

const StateSchema = Type.Union(["starting", "running", "terminal", "unresolved"].map(value => Type.Literal(value)));
export const BashJobLaunchSchema = Type.Object({
  kind: Type.Literal("bash_job_started"), jobId: Type.String(), managedId: Type.String(), state: StateSchema, startedAt: Type.String(),
});
const SummarySchema = Type.Object({
  jobId: Type.String(), command: Type.String(), cwd: Type.String(), state: StateSchema,
  createdAt: Type.String(), startedAt: Type.Optional(Type.String()), endedAt: Type.Optional(Type.String()),
  managedId: Type.Optional(Type.String()), timeout: Type.Optional(Type.Number()),
  exitCode: Type.Union([Type.Number(), Type.Null()]), signal: Type.Union([Type.String(), Type.Null()]),
  sandboxBlocked: Type.Boolean(), cleanup: Type.Union([Type.Literal("pending"), Type.Literal("complete"), Type.Literal("unresolved")]),
  stopReason: Type.Optional(Type.Union([Type.Literal("stop"), Type.Literal("deadline"), Type.Literal("owner_shutdown")])),
  error: Type.Optional(Type.String()), completion: Type.Union(["pending", "queued", "delivered", "collected", "suppressed"].map(value => Type.Literal(value))),
  restored: Type.Boolean(),
});
const OutputSchema = Type.Object({
  jobId: Type.String(), stream: Type.Union([Type.Literal("stdout"), Type.Literal("stderr")]), text: Type.String(),
  offset: Type.Integer(), nextOffset: Type.Integer(), totalBytes: Type.Integer(), eof: Type.Boolean(),
});
export const BashJobResultSchema = Type.Object({ kind: Type.Literal("bash_job_result"), job: SummarySchema, stdout: OutputSchema, stderr: OutputSchema });
export const BashControlResultSchema = Type.Union([
  Type.Object({ kind: Type.Literal("bash_job_list"), jobs: Type.Array(SummarySchema), nextOffset: Type.Union([Type.Integer(), Type.Null()]) }),
  Type.Object({ kind: Type.Literal("bash_job_status"), job: SummarySchema }),
  Type.Object({ kind: Type.Literal("bash_job_output"), output: OutputSchema }), BashJobResultSchema,
  Type.Object({ kind: Type.Literal("bash_join_cancelled"), jobId: Type.String() }),
]);

type Job = {
  meta: Metadata; restored: boolean; admission: AbortController; lifetime: AbortController;
  done: Promise<void>; resolveDone: () => void; stdout?: number; stderr?: number;
};

function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw new Error(`Invalid private Bash job directory: ${path}`);
}
function ownedFile(path: string, flags: number): number {
  const fd = openSync(path, flags | constants.O_NOFOLLOW, 0o600);
  const stat = fstatSync(fd);
  if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) {
    closeSync(fd); throw new Error("Invalid owned Bash job file");
  }
  return fd;
}
function parentSessionIdentity(path: string): { file: string; id: string } {
  if (!isAbsolute(path)) throw new Error("Side Bash owner requires an absolute parent session file");
  const file = realpathSync(path);
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.()) throw new Error("Invalid side Bash parent session file");
    const buffer = Buffer.alloc(64 * 1024);
    const length = readSync(fd, buffer, 0, buffer.length, 0);
    const newline = buffer.indexOf(10, 0);
    if (newline < 0 || newline >= length) throw new Error("Invalid side Bash parent session header");
    const header = JSON.parse(buffer.subarray(0, newline).toString("utf8"));
    if (header?.type !== "session" || typeof header.id !== "string" || !header.id) throw new Error("Invalid side Bash parent session identity");
    return { file, id: header.id };
  } finally { closeSync(fd); }
}

/** Resolve only from the owning parent's session record and persisted side ID.
 * No frontend-provided storage path participates in job/output authorization. */
export function sideBashJobDirectory(parentSessionFile: string, parentSessionId: string, sideSessionId: string): string {
  const parent = parentSessionIdentity(parentSessionFile);
  if (parent.id !== parentSessionId || !sideSessionId) throw new Error("Side Bash parent/session identity mismatch");
  const container = `${parent.file}.side-jobs`;
  privateDirectory(container);
  const root = join(container, createHash("sha256").update(sideSessionId).digest("hex"));
  privateDirectory(root);
  const binding = { version: 1, parentSessionFile: parent.file, parentSessionId, sessionId: sideSessionId };
  const manifest = join(root, "owner.json");
  let fd: number;
  try {
    fd = ownedFile(manifest, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    fd = ownedFile(manifest, constants.O_RDONLY);
    try {
      if (fstatSync(fd).size > 64 * 1024) throw new Error("Side Bash owner manifest is too large");
      const stored = JSON.parse(readFileSync(fd, "utf8"));
      if (stored?.version !== binding.version || stored.parentSessionFile !== binding.parentSessionFile
        || stored.parentSessionId !== binding.parentSessionId || stored.sessionId !== binding.sessionId) {
        throw new Error("Side Bash owner manifest does not belong to this parent/generation");
      }
    } finally { closeSync(fd); }
    return root;
  }
  try { writeFileSync(fd, JSON.stringify(binding)); fsyncSync(fd); }
  finally { closeSync(fd); }
  const directory = openSync(root, constants.O_RDONLY);
  try { fsyncSync(directory); } finally { closeSync(directory); }
  return root;
}

function preview(value: string, limit: number): string { return value.length > limit ? `${value.slice(0, limit)}…[truncated]` : value; }
function message(error: unknown): string { return preview(error instanceof Error ? error.message : String(error), 4096); }
function unresolved(error: unknown): boolean { return !!error && typeof error === "object" && "managedUnresolved" in error && error.managedUnresolved === true; }

/** One session's Bash ownership. Output reads take an opaque ID, never a caller path. */
export class BashJobs {
  private readonly jobs = new Map<string, Job>();
  private readonly listeners = new Set<() => void>();
  private closing = false;
  private transition = false;
  private shutdownFlight?: Promise<void>;
  private completionHold = false;
  private readonly collectors = new Map<string, number>();
  private readonly deliveries = new Map<string, { done: Promise<void>; resolve: () => void }>();

  constructor(readonly sessionId: string, private readonly root: string) {
    privateDirectory(root);
    for (const name of readdirSync(root)) {
      if (!name.endsWith(".json") || !ID.test(name.slice(0, -5))) continue;
      const fd = ownedFile(join(root, name), constants.O_RDONLY);
      let meta: Metadata;
      try {
        if (fstatSync(fd).size > 16 * 1024 * 1024) throw new Error("Bash job metadata is too large");
        meta = JSON.parse(readFileSync(fd, "utf8"));
      } finally { closeSync(fd); }
      if (!meta || meta.version !== 1 || meta.sessionId !== sessionId || meta.jobId !== name.slice(0, -5)
        || typeof meta.command !== "string" || typeof meta.cwd !== "string" || typeof meta.createdAt !== "string"
        || typeof meta.sandboxBlocked !== "boolean" || (meta.error !== undefined && typeof meta.error !== "string")
        || (meta.exitCode !== null && !Number.isSafeInteger(meta.exitCode))
        || (meta.signal !== null && typeof meta.signal !== "string")
        || !["pending", "complete", "unresolved"].includes(meta.cleanup)
        || !["starting", "running", "terminal", "unresolved"].includes(meta.state)
        || (meta.state === "terminal" && meta.cleanup !== "complete")) throw new Error("Invalid Bash job metadata");
      // Inspection only: no old PID/handle is adopted, no launch or notification is replayed.
      if (meta.state === "running" || meta.state === "starting") {
        meta.state = "unresolved"; meta.cleanup = "unresolved";
        meta.error = "Previous owner ended without final cleanup evidence. No process was adopted or restarted.";
      }
      meta.completion = "suppressed";
      this.jobs.set(meta.jobId, { meta, restored: true, admission: new AbortController(), lifetime: new AbortController(), done: Promise.resolve(), resolveDone: () => {} });
    }
  }

  private path(jobId: string, suffix: string): string { return join(this.root, `${jobId}.${suffix}`); }
  private get(jobId: string): Job {
    if (!ID.test(jobId)) throw new Error("Invalid Bash job identity");
    const job = this.jobs.get(jobId);
    if (!job) throw new Error("Bash job does not belong to this session");
    return job;
  }
  private persist(job: Job): void {
    const path = this.path(job.meta.jobId, "json");
    const temporary = this.path(job.meta.jobId, `${randomBytes(8).toString("hex")}.tmp`);
    const fd = ownedFile(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
    try { writeFileSync(fd, JSON.stringify(job.meta)); fsyncSync(fd); }
    finally { closeSync(fd); }
    renameSync(temporary, path);
    const directory = openSync(this.root, constants.O_RDONLY);
    try { fsyncSync(directory); } finally { closeSync(directory); }
  }
  private changed(): void {
    // Observers cannot invalidate execution ownership or suppress cleanup.
    for (const listener of this.listeners) { try { listener(); } catch { /* observer only */ } }
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  status(jobId: string): BashJobSummary {
    const { version: _version, sessionId: _sessionId, ...meta } = this.get(jobId).meta;
    return { ...meta, command: preview(meta.command, 512), cwd: preview(meta.cwd, 512), error: meta.error === undefined ? undefined : preview(meta.error, 512), restored: this.get(jobId).restored };
  }
  list(offset = 0, limit = 20): { kind: "bash_job_list"; jobs: BashJobSummary[]; nextOffset: number | null } {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1) throw new Error("Invalid Bash job page");
    const ids = [...this.jobs.keys()];
    const end = Math.min(ids.length, offset + Math.min(limit, 20));
    return { kind: "bash_job_list", jobs: ids.slice(offset, end).map(id => this.status(id)), nextOffset: end < ids.length ? end : null };
  }
  activeOrUnresolved(): boolean { return [...this.jobs.values()].some(job => job.meta.state !== "terminal"); }
  counts(): { running: number; unresolved: number } {
    const jobs = [...this.jobs.values()];
    return { running: jobs.filter(job => job.meta.state === "starting" || job.meta.state === "running").length,
      unresolved: jobs.filter(job => job.meta.state === "unresolved").length };
  }
  assertTransitionAllowed(): void {
    if (this.activeOrUnresolved()) throw new BashTransitionBlocked("Active or unresolved Bash jobs block this transition. Join or explicitly stop them first.");
  }
  /** Synchronous exclusion held across the caller's destructive asynchronous work. */
  beginTransition(): () => void {
    this.assertTransitionAllowed();
    if (this.transition || this.closing) throw new Error("Bash owner is transitioning or closing");
    this.transition = true;
    let released = false;
    return () => { if (!released) { released = true; this.transition = false; } };
  }

  async start(command: string, cwd: string, timeout: number | undefined, signal: AbortSignal | undefined, run: BashJobRunner): Promise<BashJobLaunch> {
    if (this.closing || this.transition || transitions.reservation) throw new BashTransitionBlocked("Bash job admission is closed during a transition");
    if (signal?.aborted) throw new Error("aborted");
    if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0 || timeout * 1000 > 2147483647)) throw new Error("Invalid Bash timeout");
    const jobId = randomBytes(16).toString("base64url");
    let resolveDone!: () => void;
    const job: Job = { meta: { version: 1, sessionId: this.sessionId, jobId, command, cwd, timeout,
      state: "starting", createdAt: new Date().toISOString(), exitCode: null, signal: null,
      sandboxBlocked: false, cleanup: "pending", completion: "pending" }, restored: false,
      admission: new AbortController(), lifetime: new AbortController(), done: new Promise(resolve => { resolveDone = resolve; }), resolveDone: () => resolveDone() };
    // Reserve ownership synchronously, before permission dialogs or preparation waits.
    this.jobs.set(jobId, job);
    try {
      job.stdout = ownedFile(this.path(jobId, "stdout"), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
      job.stderr = ownedFile(this.path(jobId, "stderr"), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
      this.persist(job);
    } catch (error) {
      if (job.stdout !== undefined) closeSync(job.stdout);
      if (job.stderr !== undefined) closeSync(job.stderr);
      this.jobs.delete(jobId); throw error;
    }
    this.changed();
    let resolveLaunch!: (value: BashJobLaunch) => void;
    let rejectLaunch!: (error: Error) => void;
    const launched = new Promise<BashJobLaunch>((resolve, reject) => { resolveLaunch = resolve; rejectLaunch = reject; });
    const cancelAdmission = () => job.admission.abort();
    signal?.addEventListener("abort", cancelAdmission, { once: true });
    if (signal?.aborted) cancelAdmission();
    let launchResolved = false;
    let result: (ManagedExit & { timedOut: boolean }) | undefined;
    let outputError: unknown;
    const append = (stream: "stdout" | "stderr", data: Buffer) => {
      try {
        const fd = job[stream];
        if (fd === undefined) throw new Error("Bash log closed before workload output ended");
        let offset = 0;
        while (offset < data.length) offset += writeSync(fd, data, offset, data.length - offset);
      } catch (error) { outputError = error; job.lifetime.abort(); }
    };
    const finish = async () => {
      let failure: unknown;
      try {
        await run({ admissionSignal: job.admission.signal, lifetimeSignal: job.lifetime.signal,
          hooks: {
            onSpawn: () => signal?.removeEventListener("abort", cancelAdmission),
            onStarted: managedId => {
              job.meta.managedId = managedId; job.meta.startedAt = new Date().toISOString(); job.meta.state = "running";
              this.persist(job);
              launchResolved = true;
              resolveLaunch({ kind: "bash_job_started", jobId, managedId, state: job.meta.state, startedAt: job.meta.startedAt });
              this.changed();
            },
            onStdout: data => append("stdout", data), onStderr: data => append("stderr", data),
            onDeadline: () => { job.meta.stopReason ??= "deadline"; },
            onExit: exit => { result = exit; },
          }, onBlocked: () => { job.meta.sandboxBlocked = true; }, onDiagnostic: data => append("stderr", data) });
      } catch (error) { failure = error; }
      finally { signal?.removeEventListener("abort", cancelAdmission); }
      job.meta.exitCode = result?.code ?? null;
      job.meta.signal = result?.signal ?? null;
      if (result?.timedOut) job.meta.stopReason ??= "deadline";
      job.meta.cleanup = result?.managedUnresolved || unresolved(failure) ? "unresolved" : "complete";
      job.meta.state = job.meta.cleanup === "unresolved" ? "unresolved" : "terminal";
      job.meta.endedAt = new Date().toISOString();
      // Failed admissions already returned a tool error, not a second completion.
      if (!launchResolved) job.meta.completion = "suppressed";
      if (outputError || failure || result?.error) job.meta.error = message(outputError ?? failure ?? result?.error);
      for (const stream of ["stdout", "stderr"] as const) {
        const fd = job[stream];
        if (fd === undefined) continue;
        try { fsyncSync(fd); } catch (error) { job.meta.error = `Bash log persistence failed: ${message(error)}`; }
        finally { closeSync(fd); job[stream] = undefined; }
      }
      try { this.persist(job); }
      catch (error) {
        job.meta.state = "unresolved"; job.meta.error = `Final Bash metadata persistence failed: ${message(error)}`;
      }
      // A failed/denied launch has inspection metadata, never a fabricated successful start.
      if (!launchResolved) rejectLaunch(new Error(job.meta.error ?? "Bash workload did not start"));
      job.resolveDone();
      this.changed();
    };
    // Own the execution independently of the tool invocation and frontend connection.
    void finish().catch(error => {
      // Even a finalization/storage fault must settle waiters and retain the
      // ownership guard, rather than strand shutdown or claim successful cleanup.
      job.meta.state = "unresolved"; job.meta.cleanup = "unresolved"; job.meta.error = message(error);
      job.admission.abort(); job.lifetime.abort();
      try { this.persist(job); } catch { /* Retain in-memory truth when storage is unavailable. */ }
      rejectLaunch(new Error(job.meta.error)); job.resolveDone(); this.changed();
    });
    return launched;
  }

  output(jobId: string, stream: "stdout" | "stderr", offset = 0, limit = PAGE_BYTES): BashJobOutput {
    this.get(jobId);
    if (stream !== "stdout" && stream !== "stderr") throw new Error("Invalid Bash output stream");
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1) throw new Error("Invalid Bash output page");
    const fd = ownedFile(this.path(jobId, stream), constants.O_RDONLY);
    try {
      const totalBytes = fstatSync(fd).size;
      if (offset > totalBytes) throw new Error("Bash output offset exceeds log length");
      const buffer = Buffer.alloc(Math.min(PAGE_BYTES, limit, totalBytes - offset));
      let length = readSync(fd, buffer, 0, buffer.length, offset);
      let lines = 0;
      for (let i = 0; i < length; i++) if (buffer[i] === 10 && ++lines === 2000) { length = i + 1; break; }
      // Keep normal pages on UTF-8 boundaries. Tiny caller-selected byte windows
      // and non-text output can still contain replacement characters.
      if (offset + length < totalBytes && length >= 4) {
        let lead = length - 1;
        while (lead > length - 4 && (buffer[lead] & 0xc0) === 0x80) lead--;
        const first = buffer[lead];
        const width = first >= 0xf0 && first <= 0xf4 ? 4 : first >= 0xe0 && first <= 0xef ? 3 : first >= 0xc2 && first <= 0xdf ? 2 : 1;
        if (length - lead < width) length = lead;
      }
      return { jobId, stream, text: buffer.subarray(0, length).toString("utf8"), offset, nextOffset: offset + length, totalBytes, eof: offset + length === totalBytes };
    } finally { closeSync(fd); }
  }
  private terminalResult(jobId: string): BashJobResult {
    return { kind: "bash_job_result", job: this.status(jobId), stdout: this.output(jobId, "stdout"), stderr: this.output(jobId, "stderr") };
  }
  private async wait(jobId: string, signal?: AbortSignal): Promise<BashJobResult | BashJoinCancelled> {
    const job = this.get(jobId);
    if (signal?.aborted) return { kind: "bash_join_cancelled", jobId };
    let abort!: () => void;
    const cancelled = new Promise<"cancelled">((resolve) => { abort = () => resolve("cancelled"); signal?.addEventListener("abort", abort, { once: true }); });
    try {
      const outcome = await Promise.race([job.done, cancelled]);
      if (outcome === "cancelled" || signal?.aborted) return { kind: "bash_join_cancelled", jobId };
      return this.terminalResult(jobId);
    } finally { signal?.removeEventListener("abort", abort); }
  }
  /** Agent collection reserves before waiting. Automatic delivery and collection
   * cannot both claim a pending result. A prior delivery must acknowledge (or
   * abandon) its claim first; cancellation still stops only this wait. */
  async joinForAgent(jobId: string, signal?: AbortSignal): Promise<BashJobResult | BashJoinCancelled> {
    this.get(jobId);
    this.collectors.set(jobId, (this.collectors.get(jobId) ?? 0) + 1);
    try {
      const result = await this.wait(jobId, signal);
      if (result.kind !== "bash_job_result") return result;
      const delivery = this.deliveries.get(jobId);
      if (delivery) {
        let abort!: () => void;
        const cancelled = new Promise<void>(resolve => { abort = resolve; signal?.addEventListener("abort", abort, { once: true }); });
        try { if (!signal?.aborted) await Promise.race([delivery.done, cancelled]); }
        finally { signal?.removeEventListener("abort", abort); }
      }
      if (signal?.aborted) return { kind: "bash_join_cancelled", jobId };
      const job = this.get(jobId);
      if (!job.restored && !["delivered", "collected"].includes(job.meta.completion)) {
        const previous = job.meta.completion;
        job.meta.completion = "collected";
        try { this.persist(job); } catch (error) { job.meta.completion = previous; throw error; }
      }
      // Only a successful agent collection releases the interrupt hold. UI
      // observation, including observeJoin, never comes through this path.
      this.completionHold = false;
      result.job.completion = job.meta.completion;
      return result;
    } finally {
      const remaining = this.collectors.get(jobId)! - 1;
      if (remaining) this.collectors.set(jobId, remaining); else this.collectors.delete(jobId);
      this.changed();
    }
  }
  /** Frontend viewing/waiting is always observational. No caller-supplied consumer flag. */
  observeJoin(jobId: string, signal?: AbortSignal): Promise<BashJobResult | BashJoinCancelled> { return this.wait(jobId, signal); }
  private async stopOwned(job: Job, reason: "stop" | "owner_shutdown"): Promise<void> {
    if (!job.restored && (job.meta.state === "starting" || job.meta.state === "running")) {
      job.meta.stopReason ??= reason;
      // Stop remains effective even if durable bookkeeping fails.
      job.admission.abort(); job.lifetime.abort();
      await job.done;
    }
  }
  async stop(jobId: string): Promise<BashJobResult> {
    await this.stopOwned(this.get(jobId), "stop");
    return this.terminalResult(jobId);
  }
  /** Reserve agent collection before requesting stop. Cancellation never revokes
   * the independently owned cleanup, and cannot consume an unavailable result. */
  async stopForAgent(jobId: string, signal?: AbortSignal): Promise<BashJobResult | BashJoinCancelled> {
    const job = this.get(jobId);
    const [result] = await Promise.all([this.joinForAgent(jobId, signal), this.stopOwned(job, "stop")]);
    return result;
  }
  runningIds(): string[] {
    return [...this.jobs.values()].filter(job => !job.restored && ["starting", "running"].includes(job.meta.state)).map(job => job.meta.jobId);
  }
  holdCompletions(): void { this.completionHold = true; }
  releaseCompletions(): void { this.completionHold = false; this.changed(); }
  get completionsHeld(): boolean { return this.completionHold || this.closing; }
  /** The owned outbox is independent of Pi's clearable message queues. */
  completions(): BashJobSummary[] {
    return [...this.jobs.values()].filter(job => !job.restored && ["terminal", "unresolved"].includes(job.meta.state)
      && ["pending", "queued"].includes(job.meta.completion)).map(job => this.status(job.meta.jobId));
  }
  claimCompletion(jobId: string): BashJobResult | undefined {
    const job = this.get(jobId);
    if (this.completionsHeld || this.collectors.has(jobId) || job.restored || job.meta.completion !== "pending"
      || !["terminal", "unresolved"].includes(job.meta.state)) return;
    const result = this.terminalResult(jobId); // Obtain output before reserving.
    job.meta.completion = "queued";
    try { this.persist(job); } catch (error) { job.meta.completion = "pending"; throw error; }
    let resolve!: () => void;
    const done = new Promise<void>(finish => { resolve = finish; });
    this.deliveries.set(jobId, { done, resolve });
    result.job.completion = "queued";
    this.changed();
    return result;
  }
  acknowledgeCompletion(jobId: string, delivered: boolean): void {
    const job = this.get(jobId);
    const delivery = this.deliveries.get(jobId);
    if (!delivery) return;
    job.meta.completion = delivered ? "delivered" : "pending";
    // A real acknowledgment must never be rolled back in memory on a disk
    // failure: resume suppresses all old notifications regardless of metadata.
    try { this.persist(job); }
    finally { this.deliveries.delete(jobId); delivery.resolve(); this.changed(); }
  }
  shutdown(): Promise<void> {
    if (this.shutdownFlight) return this.shutdownFlight;
    this.closing = true; // Fence synchronous admissions before any await.
    this.shutdownFlight = (async () => {
      await Promise.all([...this.jobs.values()].map(job => this.stopOwned(job, "owner_shutdown")));
      this.assertTransitionAllowed();
    })();
    return this.shutdownFlight;
  }
}

type Owner = { manager: ExtensionContext["sessionManager"]; jobs: BashJobs; unsubscribe: () => void };
const key = Symbol.for("pi.agent.extensions.bash-jobs");
const globals = globalThis as typeof globalThis & { [key]?: Owner };

export class BashTransitionBlocked extends Error {
  readonly bashTransitionBlocked = true;
}
const transitionKey = Symbol.for("pi.agent.extensions.bash-transition");
type TransitionState = { context: AsyncLocalStorage<string>; reservation?: { token: string; release: () => void } };
const transitionGlobals = globalThis as typeof globalThis & { [transitionKey]?: TransitionState };
const transitions = transitionGlobals[transitionKey] ??= { context: new AsyncLocalStorage<string>() };

export function assertBashTransitionAllowed(): void {
  globals[key]?.jobs.assertTransitionAllowed();
  if (transitions.reservation && transitions.context.getStore() !== transitions.reservation.token) {
    throw new BashTransitionBlocked("Another destructive transition is pending");
  }
}
export function assertBashMutationAllowed(): void {
  if (transitions.reservation && transitions.context.getStore() !== transitions.reservation.token) {
    throw new BashTransitionBlocked("Filesystem mutation admission is closed during a transition");
  }
}
/** Private service reservations are bound to the runtime and a random operation token. */
export function reserveBashTransition(token: string): void {
  assertBashTransitionAllowed();
  try { assertRepositoryIdle(["/"]); }
  catch (error) { throw new BashTransitionBlocked(error instanceof Error ? error.message : String(error)); }
  const release = globals[key]?.jobs.beginTransition() ?? (() => {});
  transitions.reservation = { token, release };
}
export function releaseBashTransition(token: string): boolean {
  if (transitions.reservation?.token !== token) return false;
  const reservation = transitions.reservation;
  delete transitions.reservation;
  reservation.release();
  return true;
}
/** Nested workspace/history helpers share only their caller's reservation. */
export async function withBashTransition<T>(operation: () => Promise<T>): Promise<T> {
  const current = transitions.context.getStore();
  if (current && transitions.reservation?.token === current) {
    assertBashTransitionAllowed();
    return operation();
  }
  const token = randomBytes(16).toString("base64url");
  reserveBashTransition(token);
  try { return await transitions.context.run(token, operation); }
  finally { releaseBashTransition(token); }
}

export function initializeBashJobs(ctx: ExtensionContext): BashJobs {
  if (globals[key]?.manager === ctx.sessionManager && globals[key]?.jobs.sessionId === ctx.sessionManager.getSessionId()) return globals[key]!.jobs;
  if (globals[key]?.jobs.activeOrUnresolved()) throw new Error("Previous Bash owner still has active or unresolved jobs");
  globals[key]?.unsubscribe();
  const file = ctx.sessionManager.getSessionFile();
  const sessionId = ctx.sessionManager.getSessionId();
  let root: string;
  if (process.env.PI_SIDE_AGENT === "1") {
    const parentFile = ctx.sessionManager.getHeader()?.parentSession;
    if (!parentFile) throw new Error("Side Bash jobs require their owning parent session record");
    const parent = parentSessionIdentity(parentFile);
    root = sideBashJobDirectory(parent.file, parent.id, sessionId);
  } else {
    root = file ? join(dirname(file), ".bash-jobs", createHash("sha256").update(sessionId).digest("hex"))
      : mkdtempSync(join(tmpdir(), "pi-bash-jobs-"));
  }
  const jobs = new BashJobs(sessionId, root);
  const publish = () => {
    const counts = jobs.counts();
    ctx.ui.setStatus(BASH_JOBS_STATUS, ctx.mode === "tui"
      ? counts.running || counts.unresolved ? `commands ${counts.running}${counts.unresolved ? ` · unresolved ${counts.unresolved}` : ""}` : undefined
      : JSON.stringify(counts));
  };
  globals[key] = { manager: ctx.sessionManager, jobs, unsubscribe: jobs.subscribe(publish) };
  publish();
  return jobs;
}
export function bashJobs(ctx: ExtensionContext): BashJobs {
  const owner = globals[key];
  if (!owner || owner.manager !== ctx.sessionManager || owner.jobs.sessionId !== ctx.sessionManager.getSessionId()) throw new Error("No active Bash job owner for this session");
  return owner.jobs;
}
export async function shutdownBashJobs(): Promise<void> {
  const owner = globals[key];
  if (!owner) return;
  await owner.jobs.shutdown();
  owner.unsubscribe();
  delete globals[key];
}
