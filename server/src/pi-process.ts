import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { managedSpawn, managedResult, stopManaged, type ManagedExit } from "../../pi/scripts/managed-process.mjs";
import { randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { realpathSync } from "node:fs";
import type { RpcCommand, RpcExtensionUIResponse, RpcResponse, RpcSessionState } from "@earendil-works/pi-coding-agent";
import { PiInteractions, type InteractionSnapshot } from "./pi-interactions.js";
import { parsePiRecord, type PiEvent, type PiRecord } from "./pi-records.js";

const MAX_RECORD_BYTES = 16 * 1024 * 1024;
const MAX_PENDING = 128;
const MAX_QUEUED_BYTES = 32 * 1024 * 1024;
type PiResponse = Extract<RpcResponse, { success: true }>;
export class PiCommandError extends Error {
  constructor(readonly outcome: "rejected" | "uncertain", message: string) { super(message); }
}
export type PiExit = { code: number | null; signal: NodeJS.Signals | null; error?: string; descendantsUnresolved?: boolean };
export type PiProcessOptions = {
  binary: string;
  appRoot: string;
  cwd: string;
  sessionDirectory: string;
  workspaceRoot: string;
  session: { id: string } | { file: string };
  environment: NodeJS.ProcessEnv;
  provider?: string;
  model?: string;
  /** Shared owner authority, checked before spawn and every actual pipe write. */
  assertExecutionAllowed: () => void;
  onEvent: (event: PiEvent) => void;
  onDispatch?: (command: RpcCommand & { id: string }) => void;
  onResponse?: (response: RpcResponse, command: RpcCommand & { id: string }) => void;
  onInteractionChange?: () => void;
  onExit: (exit: PiExit) => void;
};

/** Private host-side JSONL transport. Never expose request() as a frontend API. */
export class PiProcess {
  private readonly process: ChildProcessWithoutNullStreams;
  private readonly interactions: PiInteractions;
  private readonly pending = new Map<string, { command: RpcCommand & { id: string }; resolve: (response: PiResponse) => void; reject: (error: Error) => void }>();
  private readonly closed: Promise<PiExit>;
  private writing: Promise<void> = Promise.resolve();
  private queuedWrites = 0;
  private queuedBytes = 0;
  private nextId = 0;
  private readonly requestPrefix = randomUUID();
  private buffer = "";
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });
  private stderr = "";
  private stopping = false;
  private exited = false;
  private failure?: Error;
  private stdioTimer?: NodeJS.Timeout;
  private descendantsUnresolved = false;

  constructor(private readonly options: PiProcessOptions) {
    for (const path of [options.binary, options.appRoot, options.cwd, options.sessionDirectory, options.workspaceRoot]) {
      if (!isAbsolute(path)) throw new Error("Pi worker paths must be resolved absolute host paths");
    }
    if ("file" in options.session && !isAbsolute(options.session.file)) throw new Error("Pi session file must be an absolute host path");
    if (options.provider && !options.model) throw new Error("Selecting a Pi provider also requires a model");
    const binary = realpathSync(options.binary);
    const appRoot = realpathSync(options.appRoot);
    const args = ["--mode", "rpc", "-e", join(appRoot, "pi"), "--pi-console-trust-ui", "--session-dir", options.sessionDirectory];
    if ("file" in options.session) args.push("--session", options.session.file);
    else args.push("--session-id", options.session.id);
    if (options.provider) args.push("--provider", options.provider);
    if (options.model) args.push("--model", options.model);
    const env = { ...options.environment };
    for (const key of ["TMUX", "TMUX_PANE", "PI_CONSOLE_OVERVIEW", "PI_CONSOLE_SIDEBAR", "PI_CONSOLE_SESSION", "PI_CONSOLE_RESTART_FILE",
      "PI_SIDE_AGENT", "PI_SPAWN_AGENT", "PI_SPAWN_ACCESS_MODE", "PI_WORKSPACE_ID", "PI_SUBAGENT_NAME", "PI_INTERACTION_MODE"]) delete env[key];
    env.PI_CONSOLE_SERVICE = "1";
    env.PI_CONSOLE_SESSION_FILE = "file" in options.session ? options.session.file : "";
    env.PI_WORKSPACE_ROOT = options.workspaceRoot;
    env.PI_BINARY = binary;
    this.interactions = new PiInteractions((request) => {
      if (!this.stopping && !this.exited) void this.write({ type: "extension_ui_response", id: request.id, cancelled: true }).catch((error: unknown) => this.fail(error));
    });
    options.assertExecutionAllowed();
    this.process = managedSpawn(binary, args, { cwd: options.cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    this.closed = new Promise<PiExit>((resolve) => {
      this.process.once("error", (error) => this.fail(error));
      this.process.once("exit", () => {
        this.exited = true;
        // Drain final stdout after exit. Only abandon the pipes if descendants
        // keep them open beyond the bounded shutdown grace period.
        this.stdioTimer = setTimeout(() => {
          try {
            const evidence = managedResult(this.process);
            this.descendantsUnresolved = evidence ? evidence.managedUnresolved : true;
          } catch { this.descendantsUnresolved = true; }
          if (this.descendantsUnresolved) this.fail(new Error("Pi exited without reconciled managed work"));
          this.process.stdin.destroy();
          this.process.stdout.destroy();
          this.process.stderr.destroy();
        }, 5000);
      });
      this.process.once("close", (code, signal) => {
        this.exited = true;
        if (this.stdioTimer) clearTimeout(this.stdioTimer);
        this.interactions.ended();
        this.rejectPending(this.failure ?? new Error("Pi process exited; outstanding command outcomes may be uncertain"));
        let evidence: ManagedExit | undefined;
        try { evidence = managedResult(this.process); }
        catch (error) { evidence = { code: null, signal: null, managedUnresolved: true, error: String(error) }; }
        const exit: PiExit = { code: evidence ? evidence.code : code, signal: evidence ? evidence.signal : signal,
          error: this.failure?.message ?? evidence?.error,
          descendantsUnresolved: this.descendantsUnresolved || evidence?.managedUnresolved === true };
        resolve(exit);
        options.onExit(exit);
      });
    });
    this.process.stderr.setEncoding("utf8");
    this.process.stdout.on("data", (chunk: Buffer) => {
      if (this.failure) return;
      let text: string;
      try { text = this.decoder.decode(chunk, { stream: true }); }
      catch { this.fail(new Error("Invalid UTF-8 in Pi stdout")); return; }
      this.read(text);
    });
    this.process.stdout.on("end", () => this.endOutput());
    this.process.stderr.on("data", (chunk: string) => { this.stderr = (this.stderr + chunk).slice(-8192); });
    this.process.stdin.on("error", (error) => this.fail(error));
    this.process.stdout.on("error", (error) => this.fail(error));
    this.process.stderr.on("error", (error) => this.fail(error));
  }

  /** RPC is ready, not trust/workspace initialization or permission to prompt. */
  async ready(): Promise<RpcSessionState> {
    const response = await this.request({ type: "get_state" });
    if (response.command !== "get_state") throw new Error("Pi returned the wrong startup response");
    if (!this.interactions.snapshot().runtime?.active) {
      const error = new Error("Pi worker did not load pi-console's managed lifecycle extension");
      this.fail(error);
      throw error;
    }
    return response.data;
  }

  interactionSnapshot(): InteractionSnapshot {
    return this.interactions.snapshot();
  }

  recentStderr(): string {
    return this.stderr;
  }

  request(command: RpcCommand, beforeDispatch?: () => void): Promise<PiResponse> {
    if (this.stopping || this.exited || this.failure) return Promise.reject(this.failure ?? new Error("Pi process is stopping or stopped"));
    if (this.pending.size >= MAX_PENDING) return Promise.reject(new Error("Pi outstanding command limit exceeded"));
    const id = `host-${this.requestPrefix}-${++this.nextId}`;
    return new Promise<PiResponse>((resolve, reject) => {
      this.pending.set(id, { command: { ...command, id }, resolve, reject });
      void this.write({ ...command, id }, beforeDispatch).catch((error: unknown) => {
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  /** Flush is not an acknowledgment; authoritative closure arrives separately. */
  respond(response: RpcExtensionUIResponse, runtimeId: string, beforeDispatch?: () => void): Promise<void> {
    if (this.stopping || this.exited || this.failure) return Promise.reject(this.failure ?? new Error("Pi process is stopping or stopped"));
    return this.write(response, () => {
      beforeDispatch?.();
      this.interactions.submit(response, runtimeId);
      this.options.onInteractionChange?.();
    });
  }

  /** Observe owned-child completion without requesting shutdown. */
  waitForExit(): Promise<PiExit> { return this.closed; }

  async stop(): Promise<PiExit> {
    if (this.stopping || this.exited) return this.closed;
    this.stopping = true;
    this.process.stdin.end();
    if (stopManaged(this.process)) return this.closed;
    // Shutdown escalation, not a deadline on agent work. Signals target only the
    // live ChildProcess handle; never recover or kill a PID read from disk.
    const terminate = setTimeout(() => { this.process.kill("SIGTERM"); }, 2000);
    const kill = setTimeout(() => { this.process.kill("SIGKILL"); }, 5000);
    try { return await this.closed; }
    finally { clearTimeout(terminate); clearTimeout(kill); }
  }

  private async write(record: RpcCommand | RpcExtensionUIResponse, reserve?: () => void): Promise<void> {
    if (this.stopping || this.exited || this.failure) throw this.failure ?? new Error("Pi process is stopping or stopped");
    const line = JSON.stringify(record) + "\n";
    const bytes = Buffer.byteLength(line);
    if (bytes > MAX_RECORD_BYTES) throw new Error("Pi command record exceeds 16 MiB");
    if (this.queuedWrites >= MAX_PENDING || this.queuedBytes + bytes > MAX_QUEUED_BYTES) throw new Error("Pi write queue limit exceeded");
    this.queuedWrites++;
    this.queuedBytes += bytes;
    const task = this.writing.then(() => new Promise<void>((resolve, reject) => {
      if (this.stopping || this.exited || this.failure) { reject(this.failure ?? new Error("Pi stopped before command dispatch")); return; }
      // Runtime/interaction guards run at the actual write position, not when
      // the record first joins the backpressured queue.
      this.options.assertExecutionAllowed();
      reserve?.();
      // Waiting for the write callback serializes records and respects pipe
      // backpressure; a fast caller cannot build an unbounded stdin buffer.
      if (record.type !== "extension_ui_response" && record.id) this.options.onDispatch?.({ ...record, id: record.id });
      // Preflight/publication callbacks can discover storage failure reentrantly.
      // No await or callback may separate this final authority check from write.
      if (this.stopping || this.exited || this.failure) throw this.failure ?? new Error("Pi stopped before command dispatch");
      this.options.assertExecutionAllowed();
      this.process.stdin.write(line, (error) => error ? reject(error) : resolve());
    }));
    this.writing = task.catch(() => undefined);
    try { await task; }
    finally { this.queuedWrites--; this.queuedBytes -= bytes; }
  }

  private read(chunk: string): void {
    if (this.failure) return;
    this.buffer += chunk;
    try {
      for (let newline = this.buffer.indexOf("\n"); newline !== -1; newline = this.buffer.indexOf("\n")) {
        const line = this.buffer.slice(0, newline).replace(/\r$/, "");
        this.buffer = this.buffer.slice(newline + 1);
        if (Buffer.byteLength(line) > MAX_RECORD_BYTES) throw new Error("Pi stdout record exceeds 16 MiB");
        if (line) this.record(parsePiRecord(line));
      }
      if (Buffer.byteLength(this.buffer) > MAX_RECORD_BYTES) throw new Error("Pi stdout record exceeds 16 MiB");
    } catch (error) { this.fail(error); }
  }

  private endOutput(): void {
    if (this.failure) return;
    let tail: string;
    try { tail = this.decoder.decode(); }
    catch { this.fail(new Error("Incomplete or invalid UTF-8 at Pi stdout EOF")); return; }
    if (tail) this.read(tail);
    if (this.failure) return;
    if (this.buffer.length) { this.fail(new Error("Pi stdout ended with an incomplete JSONL record")); return; }
    const error = new Error("Pi response channel closed; outstanding command outcomes may be uncertain");
    if (!this.stopping && !this.exited && (this.pending.size > 0 || this.interactions.snapshot().runtime?.active)) this.fail(error);
    else {
      this.rejectPending(error);
      void this.stop();
    }
  }

  private record(record: PiRecord): void {
    if (record.type === "response") {
      const request = record.id ? this.pending.get(record.id) : undefined;
      if (!request || !record.id) throw new Error("Pi response has no matching command ID");
      if (record.command !== request.command.type) throw new Error("Pi response command does not match its request");
      // Materialize at the stdout position, not in an awaiting continuation that
      // may run after additional records from this same chunk have been reduced.
      this.options.onResponse?.(record, request.command);
      this.pending.delete(record.id);
      if (record.success) request.resolve(record);
      else request.reject(new PiCommandError("rejected", record.error));
      return;
    }
    this.interactions.apply(record);
    this.options.onEvent(record);
  }

  private fail(error: unknown): void {
    if (this.failure) return;
    this.failure = error instanceof Error ? error : new Error(String(error));
    this.rejectPending(this.failure);
    void this.stop();
  }

  private rejectPending(error: Error): void {
    for (const request of this.pending.values()) request.reject(new PiCommandError("uncertain", error.message));
    this.pending.clear();
  }
}
