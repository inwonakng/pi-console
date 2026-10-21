import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { managedSpawn, managedResult, stopManaged } from "../../scripts/managed-process.mjs";
import type { RpcCommand, RpcExtensionUIResponse } from "@earendil-works/pi-coding-agent";

export type SideRpcEvent = Record<string, unknown>;

/** A private transport: unlike RpcClient it can answer extension UI requests. */
export class SideRpc {
  private readonly process: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, { resolve: (data: unknown) => void; reject: (error: Error) => void }>();
  private nextId = 0;
  private ended = false;
  private stopping = false;
  private stderr = "";
  private readonly closed: Promise<void>;

  constructor(args: string[], cwd: string, onEvent: (event: SideRpcEvent) => void, onExit: (error: Error) => void) {
    this.process = managedSpawn(process.env.PI_BINARY || "pi", args, {
      cwd,
      env: {
        ...process.env,
        PI_SIDE_AGENT: "1",
        PI_SPAWN_AGENT: "1",
        PI_SPAWN_ACCESS_MODE: "ask",
        PI_INTERACTION_MODE: "interactive",
        PI_CONSOLE_SESSION_FILE: "",
        PI_WORKSPACE_ID: "",
        PI_SUBAGENT_NAME: "",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.process.stdout.setEncoding("utf8");
    this.process.stderr.setEncoding("utf8");
    let buffer = "";
    this.process.stdout.on("data", (text: string) => {
      buffer += text;
      for (let newline = buffer.indexOf("\n"); newline !== -1; newline = buffer.indexOf("\n")) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        try {
          const event = JSON.parse(line) as SideRpcEvent;
          if (event.type === "response" && typeof event.id === "string") {
            const request = this.pending.get(event.id);
            this.pending.delete(event.id);
            if (event.success === false) request?.reject(new Error(String(event.error)));
            else request?.resolve(event.data);
          } else {
            onEvent(event);
          }
        } catch (error) {
          this.fail(error instanceof Error ? error : new Error(String(error)));
          onExit(new Error(`Side RPC protocol failure: ${String(error)}`));
          void this.stop().catch(() => undefined);
        }
      }
    });
    this.process.stderr.on("data", (text: string) => { this.stderr = (this.stderr + text).slice(-4000); });
    this.process.stdin.on("error", (error) => this.fail(error));
    this.closed = new Promise((resolve, reject) => {
      this.process.once("error", (error) => {
        this.ended = true;
        this.fail(error);
        if (!this.stopping) onExit(error);
        resolve();
      });
      this.process.once("close", (code, signal) => {
        this.ended = true;
        const error = new Error(`Side Pi exited (code=${code}, signal=${signal}).${this.stderr ? `\n${this.stderr}` : ""}`);
        this.fail(error);
        if (!this.stopping) onExit(error);
        try {
          if (managedResult(this.process)?.managedUnresolved) reject(new Error("Side managed work remains unresolved"));
          else resolve();
        } catch (failure) { reject(failure); }
      });
    });
    void this.closed.catch(() => undefined);
  }

  get stopped(): boolean {
    return this.ended || this.stopping;
  }

  request<T = unknown>(command: RpcCommand): Promise<T> {
    if (this.ended || this.stopping) return Promise.reject(new Error("Side Pi is stopped."));
    const id = `side-${++this.nextId}`;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (data) => resolve(data as T), reject });
      this.process.stdin.write(`${JSON.stringify({ ...command, id })}\n`, (error) => {
        if (error) {
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }

  respond(response: RpcExtensionUIResponse): void {
    if (this.ended || this.stopping) return;
    this.process.stdin.write(`${JSON.stringify(response)}\n`, (error) => {
      if (error) this.fail(error);
    });
  }

  async stop(): Promise<void> {
    if (this.stopping || this.ended) return this.closed;
    this.stopping = true;
    this.process.stdin.end();
    if (stopManaged(this.process)) return this.closed;
    // These are shutdown escalation timers, never generation deadlines.
    const terminate = setTimeout(() => this.process.kill("SIGTERM"), 2000);
    const kill = setTimeout(() => this.process.kill("SIGKILL"), 5000);
    try { await this.closed; }
    finally {
      clearTimeout(terminate);
      clearTimeout(kill);
    }
  }

  private fail(error: Error): void {
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }
}

/** RPC deliberately strips cumulative snapshots; reconstruct only the live view. */
export function updateSidePartial(message: SideRpcEvent, event: SideRpcEvent): void {
  const update = event.assistantMessageEvent as SideRpcEvent | undefined;
  if (!update) return;
  if (event.usage) message.usage = event.usage;
  const content = message.content as SideRpcEvent[];
  const index = update.contentIndex;
  if (typeof index !== "number") return;
  const type = update.type;
  if (type === "text_start") content[index] = { type: "text", text: "" };
  if (type === "thinking_start") content[index] = { type: "thinking", thinking: "" };
  if (type === "toolcall_start") content[index] = { type: "toolCall", id: update.id, name: update.toolName, arguments: {} };
  if (type === "text_delta" || type === "text_end") {
    const block = content[index] ??= { type: "text", text: "" };
    block.text = type === "text_end" ? update.content : String(block.text ?? "") + String(update.delta ?? "");
  }
  if (type === "thinking_delta" || type === "thinking_end") {
    const block = content[index] ??= { type: "thinking", thinking: "" };
    block.thinking = type === "thinking_end" ? update.content : String(block.thinking ?? "") + String(update.delta ?? "");
  }
  if (type === "toolcall_end") content[index] = update.toolCall as SideRpcEvent;
}
