import { setImmediate as yieldTurn } from "node:timers/promises";
import type { RpcResponse } from "@earendil-works/pi-coding-agent";
import { messageKey, type PiMessage } from "./pi-conversation.js";
import { object } from "./pi-records.js";
import { CommandError } from "./session-commands.js";
import { readResource, type ResourceContext } from "./resource-reads.js";

export type TranscriptPreview = { messages: PiMessage[]; messageKeys: string[]; omittedMessages: number };

/** Best-effort saved-history fallback. Complex projections remain worker-owned. */
export async function savedHistoryPreview(context: ResourceContext): Promise<TranscriptPreview | undefined> {
  let page = await readResource(context, { kind: "history" });
  const version = page.version;
  let text = page.text;
  while (page.nextOffset !== null) {
    page = await readResource(context, { kind: "history", offset: page.nextOffset, version });
    text += page.text;
  }
  context.check();
  if (!text.endsWith("\n")) return;
  const entries = new Map<string, Record<string, unknown>>();
  let leaf: string | undefined;
  let records = 0;
  for (const line of text.split("\n")) {
    if (++records % 128 === 0) { await yieldTurn(); context.check(); }
    if (!line) continue;
    if (Buffer.byteLength(line) > 16 * 1024 * 1024) return;
    const entry: unknown = JSON.parse(line);
    if (!object(entry)) return;
    if (entry.type === "session") continue;
    // Only ordinary messages and inert metadata. Compaction, context edits and
    // custom-message projection belong to the worker, including future types.
    if (!["message", "thinking_level_change", "model_change", "usage", "custom", "label", "session_info"].includes(String(entry.type))) return;
    if (typeof entry.id !== "string" || entries.has(entry.id)
      || entry.parentId !== null && typeof entry.parentId !== "string") return;
    entries.set(entry.id, entry);
    leaf = entry.id;
  }
  const messages: PiMessage[] = [];
  const seen = new Set<string>();
  while (leaf) {
    if (seen.has(leaf)) return;
    seen.add(leaf);
    if (seen.size % 128 === 0) { await yieldTurn(); context.check(); }
    const entry = entries.get(leaf);
    if (!entry) return;
    if (entry.type === "message") {
      if (!object(entry.message) || typeof entry.message.role !== "string") return;
      messages.push(entry.message as PiMessage);
    }
    leaf = entry.parentId as string | undefined;
  }
  messages.reverse();
  return { messages, messageKeys: messages.map(messageKey), omittedMessages: 0 };
}

// Private worker wire contract; public snapshot paging is handled separately.
export const HISTORY_COMMAND = "pi-console-history-read";
export const HISTORY_STATUS = "pi-console-history-result";
export const HISTORY_RESULT_BYTES = 80 * 1024 * 1024 - 64 * 1024;
export type HistoryKind = "projection" | "entries" | "tree" | "treeEntries";
export type HistoryIdentity = { version: 1; invocationId: string; runtimeId: string; sessionId: string; sessionFile: string; kind: HistoryKind };
export type ProjectedHistory = { messages: PiMessage[]; omittedMessages: number };
type Entries = Extract<RpcResponse, { command: "get_entries"; success: true }>["data"];
type Tree = Extract<RpcResponse, { command: "get_tree"; success: true }>["data"];
type TreeEntries = { entries: Record<string, unknown>[]; leafId: string | null };
export type HistoryData = ProjectedHistory | Entries | Tree | TreeEntries;

/** Correlated history stream with bounded messages. Malformed transport fails closed. */
export class HistoryRead {
  private readonly chunks: string[] = [];
  private bytes = 0;
  private index = 0;
  private readonly messages: PiMessage[] = [];
  private terminal = false;
  private failure?: CommandError;
  private data?: HistoryData;
  readonly limit: number;

  constructor(readonly identity: HistoryIdentity) {
    this.limit = identity.kind === "projection" ? 16 * 1024 * 1024 : HISTORY_RESULT_BYTES;
  }

  consume(value: Record<string, unknown>): boolean {
    if (this.terminal || Object.entries(this.identity).some(([key, expected]) => value[key] !== expected)
      || value.index !== this.index) throw new Error("Unmatched or out-of-order history result");
    const keys = [...Object.keys(this.identity), "index"];
    if (typeof value.text === "string") {
      keys.push("text");
      if (this.identity.kind === "projection") keys.push("messageEnd");
      if (Object.keys(value).some(key => !keys.includes(key)) || !value.text.length || value.text.length > 64 * 1024
        || value.messageEnd !== undefined && value.messageEnd !== true) throw new Error("Invalid history chunk");
      this.index++;
      this.bytes += Buffer.byteLength(value.text);
      // A slice may bisect a surrogate pair, costing a few extra encoded bytes.
      if (this.bytes > this.limit + 8192 || this.chunks.length >= 1280) throw new Error("History aggregate limit exceeded");
      this.chunks.push(value.text);
      if (value.messageEnd === true) {
        const text = this.chunks.join("");
        if (Buffer.byteLength(text) > this.limit) throw new Error("Projected message limit exceeded");
        const message: unknown = JSON.parse(text);
        if (!object(message) || typeof message.role !== "string") throw new Error("Invalid projected message");
        this.messages.push(message as PiMessage);
        this.chunks.length = 0;
        this.bytes = 0;
      }
      return false;
    }
    this.terminal = true;
    if (value.status === "failed") {
      keys.push("status", "code", "error");
      if ((this.identity.kind !== "projection" && this.chunks.length) || (value.code !== "resource_limit" && value.code !== "resource_unavailable"
        && value.code !== "session_busy" && value.code !== "stale_runtime")
        || typeof value.error !== "string" || Buffer.byteLength(value.error) > 8192
        || Object.keys(value).some(key => !keys.includes(key))) throw new Error("Invalid history refusal");
      this.chunks.length = 0;
      this.messages.length = 0;
      this.failure = new CommandError(value.code, value.error);
    } else if (this.identity.kind === "projection") {
      keys.push("status", "messages");
      if (value.status !== "completed" || value.messages !== this.messages.length || this.chunks.length
        || Object.keys(value).some(key => !keys.includes(key))) throw new Error("Invalid projection completion");
      this.data = { messages: this.messages, omittedMessages: 0 };
    } else {
      keys.push("status", "bytes");
      const text = this.chunks.join("");
      this.chunks.length = 0;
      if (value.status !== "completed" || value.bytes !== Buffer.byteLength(text) || Number(value.bytes) > this.limit
        || Object.keys(value).some(key => !keys.includes(key))) throw new Error("Invalid history completion");
      let data: unknown;
      try { data = JSON.parse(text); } catch { throw new Error("Invalid history JSON"); }
      if (!object(data)) throw new Error("Invalid history data");
      if (Object.keys(data).length !== 2 || !Array.isArray(data[this.identity.kind === "treeEntries" ? "entries" : this.identity.kind])
        || (data.leafId !== null && typeof data.leafId !== "string")) throw new Error("Invalid history data");
      this.data = data as HistoryData;
    }
    return true;
  }

  finish(response: RpcResponse): HistoryData {
    if (!response.success || response.command !== "prompt" || response.data.disposition !== "handled" || !this.terminal) {
      throw new Error("Missing handled history completion");
    }
    if (this.failure) throw this.failure;
    if (!this.data) throw new Error("Missing history data");
    return this.data;
  }
}
