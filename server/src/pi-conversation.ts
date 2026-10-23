import type { JsonAgentSessionEvent, RpcCommand, RpcResponse, RpcSessionState } from "@earendil-works/pi-coding-agent";
import { type PiEvent } from "./pi-records.js";

type Success<C extends string> = Extract<RpcResponse, { command: C; success: true }>;
export type PiMessage = Success<"get_messages">["data"]["messages"][number];
type Assistant = Extract<PiMessage, { role: "assistant" }>;
type SessionStats = Success<"get_session_stats">["data"] & {
  tokens: { sessionCacheRead?: number; sessionCacheWrite?: number };
};
type ToolStart = Extract<JsonAgentSessionEvent, { type: "tool_execution_start" }>;
type ToolEnd = Extract<JsonAgentSessionEvent, { type: "tool_execution_end" }>;
export type ToolState = Omit<ToolStart, "type"> & {
  state: "running" | "completed" | "interrupted";
  partialResult?: Extract<JsonAgentSessionEvent, { type: "tool_execution_update" }>["partialResult"];
  result?: ToolEnd["result"];
  isError?: boolean;
  durationMs?: number;
};
export type WorkState = {
  id: string;
  kind: "prompt" | "steer" | "follow_up" | "bash";
  text: string;
  state: "dispatched" | "accepted" | "completed" | "rejected" | "uncertain";
  disposition?: "started" | "queued" | "handled";
  output?: string;
  omittedOutputBytes?: number;
  result?: Success<"bash">["data"];
  error?: string;
};
export type ConversationSnapshot = {
  /** Current Pi projection, not the full session tree. Older messages are separate history. */
  messages: PiMessage[];
  omittedMessages: number;
  historyRevision: number;
  hydrated: boolean;
  partialAssistant?: { message: Assistant; toolArguments: Record<number, string>; interrupted: boolean };
  tools: ToolState[];
  work: WorkState[];
  queue: { steering: readonly string[]; followUp: readonly string[] };
  execution: {
    running: boolean;
    interrupted: boolean;
    compaction?: Extract<JsonAgentSessionEvent, { type: "compaction_start" | "compaction_end" }>;
    retry?: Extract<JsonAgentSessionEvent, { type: "auto_retry_start" | "auto_retry_end" }>;
    summarization?: Extract<JsonAgentSessionEvent, { type: "summarization_retry_scheduled" | "summarization_retry_attempt_start" }>;
  };
  statuses: Record<string, string>;
  widgets: Record<string, { lines: string[]; placement: "aboveEditor" | "belowEditor" }>;
  title?: string;
  piState?: RpcSessionState;
  stats?: SessionStats;
};

export type FrontendEffect =
  | { type: "notification"; message: string; level: "info" | "warning" | "error" }
  | { type: "editor_text"; text: string }
  | { type: "extension_signal"; key: string; value?: string };

// Internal owner updates, NOT a client protocol or a raw RPC dispatch API.
export type ConversationChange =
  | { type: "event"; event: JsonAgentSessionEvent }
  | { type: "history"; messages: PiMessage[] }
  | { type: "pi_state"; state: RpcSessionState }
  | { type: "session_stats"; stats: SessionStats }
  | { type: "status"; key: string; value?: string }
  | { type: "widget"; key: string; value?: ConversationSnapshot["widgets"][string] }
  | { type: "title"; title: string }
  | { type: "work"; work: WorkState }
  | { type: "invalidate_history" }
  | { type: "runtime_ended" };

const HISTORY_BYTES = 16 * 1024 * 1024;
const LIVE_BYTES = 32 * 1024 * 1024;
const OUTPUT_BYTES = 1024 * 1024;
const EFFECT_STATUSES = new Set(["pi-side-response", "pi-tree-clone", "pi-history-changed", "pi-desktop-notification", "pi-spawn-notification"]);
const LIFECYCLE_STATUSES = new Set(["pi-console-runtime", "pi-console-dialog"]);

/** Always reduced by the owner, even with no subscribers. No frontend actions here. */
export class PiConversation {
  private state: ConversationSnapshot = {
    messages: [], omittedMessages: 0, historyRevision: 0, hydrated: false,
    tools: [], work: [], queue: { steering: [], followUp: [] },
    execution: { running: false, interrupted: false }, statuses: {}, widgets: {},
  };
  private historyBytes = 0;
  private readonly messageBytes: number[] = [];
  private version = 0;
  private unsettled = false;
  private readonly liveSizes = new Map<string, number>();
  private liveBytes = 0;

  private cacheRead = 0;
  private cacheWrite = 0;

  snapshot(): ConversationSnapshot {
    const snapshot = structuredClone(this.state);
    if (snapshot.stats) {
      // Match the legacy footer: largest single-turn cache footprint, not
      // cumulative cache tokens. Compute before bounded history drops messages.
      snapshot.stats.tokens.sessionCacheRead = this.cacheRead;
      snapshot.stats.tokens.sessionCacheWrite = this.cacheWrite;
    }
    return snapshot;
  }
  /** Exact owner-observed output metadata, without copying a conversation per chunk. */
  outputPaths(): string[] {
    const paths = new Set<string>();
    const collect = (value: unknown): void => {
      if (!value || typeof value !== "object") return;
      const item = value as { fullOutputPath?: unknown; details?: { fullOutputPath?: unknown } };
      for (const path of [item.fullOutputPath, item.details?.fullOutputPath]) if (typeof path === "string") paths.add(path);
    };
    for (const message of this.state.messages) collect(message);
    for (const tool of this.state.tools) { collect(tool.result); collect(tool.partialResult); }
    for (const work of this.state.work) collect(work.result);
    return [...paths];
  }
  get historyVersion(): number { return this.version; }
  get awaitingSettlement(): boolean { return this.unsettled; }
  get hydrated(): boolean { return this.state.hydrated; }
  get sessionState(): RpcSessionState | undefined { return this.state.piState; }
  status(key: string): string | undefined { return this.state.statuses[key]; }
  get idle(): boolean {
    return !this.state.execution.running && (!this.state.partialAssistant || this.state.partialAssistant.interrupted)
      && !this.state.tools.some((tool) => tool.state === "running")
      && !this.state.work.some((work) => work.kind === "bash" && work.state === "dispatched");
  }

  /** Unlike isStreaming/get_state, only agent_settled closes an observed run.
   * Native pending messages stay distinct from the owner's editable queue. */
  get executionSettled(): boolean {
    return this.idle && !this.unsettled && !this.state.piState?.isStreaming && !this.state.piState?.isCompacting
      && this.state.execution.compaction?.type !== "compaction_start"
      && this.state.execution.retry?.type !== "auto_retry_start" && !this.state.execution.summarization;
  }
  get settled(): boolean {
    return this.executionSettled && !this.state.queue.steering.length && !this.state.queue.followUp.length && !this.state.piState?.pendingMessageCount;
  }

  /** Separate effects before retention. Closure is consumed by PiInteractions. */
  event(event: PiEvent): ConversationChange | FrontendEffect | undefined {
    if (event.type === "extension_error") return;
    if (event.type !== "extension_ui_request") return { type: "event", event };
    switch (event.method) {
      case "notify": return { type: "notification", message: event.message, level: event.notifyType ?? "info" };
      case "set_editor_text": return { type: "editor_text", text: event.text };
      case "setTitle": return { type: "title", title: event.title };
      case "setWidget": return { type: "widget", key: event.widgetKey, value: event.widgetLines === undefined ? undefined
        : { lines: event.widgetLines, placement: event.widgetPlacement ?? "aboveEditor" } };
      case "setStatus":
        if (LIFECYCLE_STATUSES.has(event.statusKey)) return;
        if (EFFECT_STATUSES.has(event.statusKey)) return { type: "extension_signal", key: event.statusKey, value: event.statusText };
        return { type: "status", key: event.statusKey, value: event.statusText };
    }
  }

  dispatch(command: RpcCommand & { id: string }): WorkState | undefined {
    if (command.type !== "prompt" && command.type !== "steer" && command.type !== "follow_up" && command.type !== "bash") return;
    return { id: command.id, kind: command.type, text: command.type === "bash" ? command.command : command.message,
      state: "dispatched", ...(command.type === "bash" ? { output: "", omittedOutputBytes: 0 } : {}) };
  }

  response(response: RpcResponse): WorkState | undefined {
    const work = this.state.work.find((work) => work.id === response.id);
    if (!work) return;
    if (!response.success) return { ...work, state: "rejected", error: response.error };
    if (response.command === "bash") return { ...work, state: "completed", result: response.data };
    if (response.command === "prompt" || response.command === "steer" || response.command === "follow_up") {
      return { ...work, state: "accepted", disposition: response.data.disposition };
    }
  }

  apply(change: ConversationChange): void {
    switch (change.type) {
      case "history":
        this.state.messages = [];
        this.messageBytes.length = 0;
        this.historyBytes = 0;
        this.state.omittedMessages = 0;
        this.cacheRead = 0;
        this.cacheWrite = 0;
        for (const message of change.messages) this.append(message);
        this.state.historyRevision++;
        this.state.hydrated = true;
        if (this.state.partialAssistant?.interrupted) {
          this.state.partialAssistant = undefined;
          this.reserve("partial", undefined);
        }
        break;
      case "invalidate_history": this.state.hydrated = false; this.version++; break;
      case "pi_state":
        this.reserve("pi_state", change.state);
        this.state.piState = change.state;
        this.state.execution.running = change.state.isStreaming;
        break;
      case "session_stats":
        this.reserve("session_stats", change.stats);
        this.state.stats = change.stats;
        break;
      case "status": this.reserve(`status:${change.key}`, change.value); setValue(this.state.statuses, change.key, change.value); break;
      case "widget": this.reserve(`widget:${change.key}`, change.value); setValue(this.state.widgets, change.key, change.value); break;
      case "title": this.reserve("title", change.title); this.state.title = change.title; break;
      case "work": {
        this.reserve(`work:${change.work.id}`, change.work);
        const index = this.state.work.findIndex((work) => work.id === change.work.id);
        if (index === -1) {
          if (this.state.work.length >= 128) {
            const removable = this.state.work.findIndex((work) => work.state !== "dispatched");
            if (removable === -1) throw new Error("Pi retained work limit exceeded");
            this.reserve(`work:${this.state.work[removable]!.id}`, undefined);
            this.state.work.splice(removable, 1);
          }
          this.state.work.push(change.work);
        } else this.state.work[index] = change.work;
        this.version++;
        break;
      }
      case "runtime_ended":
        this.unsettled = false;
        this.state.hydrated = false;
        this.state.execution = { running: false, interrupted: true };
        if (this.state.partialAssistant) this.state.partialAssistant.interrupted = true;
        for (const tool of this.state.tools) if (tool.state === "running") tool.state = "interrupted";
        for (const work of this.state.work) if (work.state === "dispatched") work.state = "uncertain";
        this.state.queue = { steering: [], followUp: [] };
        this.state.statuses = {};
        this.state.widgets = {};
        this.state.title = undefined;
        this.state.piState = undefined;
        this.state.stats = undefined;
        this.cacheRead = 0;
        this.cacheWrite = 0;
        this.reserve("session_stats", undefined);
        for (const key of this.liveSizes.keys()) {
          if (key.startsWith("status:") || key.startsWith("widget:") || key === "title" || key === "pi_state" || key === "queue" || key.startsWith("execution:")) this.reserve(key, undefined);
        }
        this.version++;
        break;
      case "event": this.reduceEvent(change.event); break;
    }
  }

  /** Account changed slots only: serializing the whole partial conversation on
   * every text delta would make the owner's stdout path quadratic in output. */
  private reserve(key: string, value: unknown): void {
    this.reserveBytes(key, value === undefined ? 0 : size(value) + Buffer.byteLength(key));
  }

  private reserveBytes(key: string, bytes: number): void {
    const total = this.liveBytes - (this.liveSizes.get(key) ?? 0) + bytes;
    if (total > LIVE_BYTES || (bytes && !this.liveSizes.has(key) && this.liveSizes.size >= 2048)) {
      throw new Error("Pi live conversation state exceeds 32 MiB or 2048 retained slots");
    }
    if (bytes) this.liveSizes.set(key, bytes);
    else this.liveSizes.delete(key);
    this.liveBytes = total;
  }

  private append(message: PiMessage): void {
    if (message.role === "assistant") {
      this.cacheRead = Math.max(this.cacheRead, message.usage.cacheRead);
      this.cacheWrite = Math.max(this.cacheWrite, message.usage.cacheWrite);
    }
    const bytes = size(message);
    if (bytes > HISTORY_BYTES) throw new Error("Pi conversation message exceeds 16 MiB");
    this.state.messages.push(message);
    this.messageBytes.push(bytes);
    this.historyBytes += bytes;
    while (this.state.messages.length > 512 || this.historyBytes > HISTORY_BYTES) {
      this.state.messages.shift();
      this.historyBytes -= this.messageBytes.shift()!;
      this.state.omittedMessages++;
    }
  }

  private reduceEvent(event: JsonAgentSessionEvent): void {
    this.version++;
    switch (event.type) {
      case "message_start":
        if (event.message.role === "assistant") {
          this.reserve("partial", event.message);
          this.state.partialAssistant = { message: event.message, toolArguments: {}, interrupted: false };
        }
        break;
      case "message_update": this.updateAssistant(event); break;
      case "message_end":
        this.append(event.message);
        if (event.message.role === "assistant") {
          this.state.partialAssistant = undefined;
          this.reserve("partial", undefined);
        }
        break;
      case "tool_execution_start": {
        // Providers may reuse a call ID in a later run/runtime. Completed
        // conversation results live in messages, not this live-output index.
        const previous = this.state.tools.findIndex((tool) => tool.toolCallId === event.toolCallId);
        if (previous !== -1) {
          if (this.state.tools[previous]!.state === "running") throw new Error("Duplicate active Pi tool ID");
          this.reserve(`tool:${event.toolCallId}`, undefined);
          this.state.tools.splice(previous, 1);
        }
        if (this.state.tools.length >= 256) {
          const index = this.state.tools.findIndex((tool) => tool.state !== "running");
          if (index === -1) throw new Error("Pi active tool limit exceeded");
          this.reserve(`tool:${this.state.tools[index]!.toolCallId}`, undefined);
          this.state.tools.splice(index, 1);
        }
        const { type: _type, ...tool } = event;
        this.reserve(`tool:${tool.toolCallId}`, tool);
        this.state.tools.push({ ...tool, state: "running" });
        break;
      }
      case "tool_execution_update": {
        const tool = this.state.tools.find((tool) => tool.toolCallId === event.toolCallId);
        if (!tool) throw new Error("Pi tool update has no start");
        this.reserve(`tool:${tool.toolCallId}`, { ...tool, partialResult: event.partialResult });
        tool.partialResult = event.partialResult;
        break;
      }
      case "tool_execution_end": {
        const tool = this.state.tools.find((tool) => tool.toolCallId === event.toolCallId);
        if (!tool) throw new Error("Pi tool result has no start");
        this.reserve(`tool:${tool.toolCallId}`, { ...tool, partialResult: undefined, result: event.result });
        tool.state = "completed";
        tool.partialResult = undefined;
        tool.result = event.result;
        tool.isError = event.isError;
        tool.durationMs = event.durationMs;
        break;
      }
      case "bash_execution_update": {
        const work = this.state.work.find((work) => work.id === event.id && work.kind === "bash");
        if (!work) throw new Error("Pi bash output has no dispatched command");
        const output = Buffer.from((work.output ?? "") + event.delta);
        const excess = Math.max(0, output.length - OUTPUT_BYTES);
        // Avoid decoding a truncated UTF-8 code point at the head of the tail.
        let start = excess;
        while (start < output.length && (output[start]! & 0xc0) === 0x80) start++;
        // Output is tail-bounded; charge escaped bytes as an upper bound without
        // serializing the already-retained prefix again.
        const removed = output.subarray(0, start).toString("utf8");
        this.reserveBytes(`work:${work.id}`, (this.liveSizes.get(`work:${work.id}`) ?? 0) + size(event.delta) - size(removed));
        work.output = output.subarray(start).toString("utf8");
        work.omittedOutputBytes = (work.omittedOutputBytes ?? 0) + start;
        break;
      }
      case "queue_update": this.reserve("queue", event); this.state.queue = { steering: event.steering, followUp: event.followUp }; break;
      case "agent_start": this.unsettled = true; this.state.execution.running = true; this.state.execution.interrupted = false; break;
      // agent_end is not settlement: retries, compaction and queues can continue.
      case "agent_settled": this.unsettled = false; this.state.execution.running = false; break;
      case "compaction_start": case "compaction_end": this.reserve("execution:compaction", event); this.state.execution.compaction = event; break;
      case "auto_retry_start": case "auto_retry_end": this.reserve("execution:retry", event); this.state.execution.retry = event; break;
      case "summarization_retry_scheduled": case "summarization_retry_attempt_start": this.reserve("execution:summarization", event); this.state.execution.summarization = event; break;
      case "summarization_retry_finished": this.reserve("execution:summarization", undefined); this.state.execution.summarization = undefined; break;
      case "session_info_changed":
        if (this.state.piState) {
          this.reserve("pi_state", { ...this.state.piState, sessionName: event.name });
          this.state.piState.sessionName = event.name;
        }
        break;
      case "thinking_level_changed": if (this.state.piState) this.state.piState.thinkingLevel = event.level; break;
    }
    if (this.state.piState) {
      this.state.piState.isStreaming = this.state.execution.running;
      this.state.piState.isCompacting = this.state.execution.compaction?.type === "compaction_start";
      this.state.piState.pendingMessageCount = this.state.queue.steering.length + this.state.queue.followUp.length;
    }
  }

  private updateAssistant(event: Extract<JsonAgentSessionEvent, { type: "message_update" }>): void {
    const partial = this.state.partialAssistant;
    if (!partial || partial.interrupted) throw new Error("Pi assistant update has no active message");
    partial.message.usage = event.usage;
    const update = event.assistantMessageEvent;
    // Deltas are charged once. End records may duplicate their block content;
    // this conservative upper bound is released at authoritative message_end.
    this.reserveBytes("partial", (this.liveSizes.get("partial") ?? 0) + ("delta" in update ? size(update.delta) : size(update)));
    if (update.type === "done") { partial.message = update.message; return; }
    if (update.type === "error") { partial.message = update.error; return; }
    if (update.type === "start") return;
    const index = update.contentIndex;
    if (!Number.isSafeInteger(index) || index < 0 || index > 4096) throw new Error("Invalid Pi assistant content index");
    const blocks = partial.message.content;
    switch (update.type) {
      case "text_start": blocks[index] = { type: "text", text: "" }; break;
      case "thinking_start": blocks[index] = { type: "thinking", thinking: "" }; break;
      case "toolcall_start": blocks[index] = { type: "toolCall", id: update.id, name: update.toolName, arguments: {} }; partial.toolArguments[index] = ""; break;
      case "text_delta": case "text_end": {
        const block = blocks[index];
        if (block?.type !== "text") throw new Error("Pi text update has no matching block");
        block.text = update.type === "text_delta" ? block.text + update.delta : update.content;
        break;
      }
      case "thinking_delta": case "thinking_end": {
        const block = blocks[index];
        if (block?.type !== "thinking") throw new Error("Pi thinking update has no matching block");
        block.thinking = update.type === "thinking_delta" ? block.thinking + update.delta : update.content;
        break;
      }
      case "toolcall_delta":
        if (blocks[index]?.type !== "toolCall") throw new Error("Pi argument update has no matching tool call");
        partial.toolArguments[index] = (partial.toolArguments[index] ?? "") + update.delta;
        break;
      case "toolcall_end": blocks[index] = update.toolCall; delete partial.toolArguments[index]; break;
    }
  }
}

function size(value: unknown): number { return Buffer.byteLength(JSON.stringify(value)); }
function setValue<T>(values: Record<string, T>, key: string, value: T | undefined): void {
  // Define own properties even for extension keys such as __proto__.
  if (value === undefined) delete values[key];
  else Object.defineProperty(values, key, { value, enumerable: true, configurable: true, writable: true });
}
