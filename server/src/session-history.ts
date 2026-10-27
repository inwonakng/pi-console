import type { RpcResponse } from "@earendil-works/pi-coding-agent";
import type { PiMessage } from "./pi-conversation.js";
import { object } from "./pi-records.js";
import { CommandError } from "./session-commands.js";

// Keep in step with pi/extensions/shared/service-history.ts. No public pagination.
export const HISTORY_COMMAND = "pi-console-history-read";
export const HISTORY_STATUS = "pi-console-history-result";
export const HISTORY_RESULT_BYTES = 80 * 1024 * 1024 - 64 * 1024;
export type HistoryKind = "projected-tail" | "entries" | "tree";
export type HistoryIdentity = { version: 1; invocationId: string; runtimeId: string; sessionId: string; sessionFile: string; kind: HistoryKind };
export type ProjectedTail = { messages: PiMessage[]; omittedMessages: number; messageBytes: number[] };
type Entries = Extract<RpcResponse, { command: "get_entries"; success: true }>["data"];
type Tree = Extract<RpcResponse, { command: "get_tree"; success: true }>["data"];
export type HistoryData = ProjectedTail | Entries | Tree;

/** One bounded, correlated result. Malformed transport fails closed like native RPC. */
export class HistoryRead {
  private readonly chunks: string[] = [];
  private bytes = 0;
  private terminal = false;
  private failure?: CommandError;
  private data?: HistoryData;
  readonly limit: number;

  constructor(readonly identity: HistoryIdentity) {
    this.limit = identity.kind === "projected-tail" ? 16 * 1024 * 1024 + 64 * 1024 : HISTORY_RESULT_BYTES;
  }

  consume(value: Record<string, unknown>): boolean {
    if (this.terminal || Object.entries(this.identity).some(([key, expected]) => value[key] !== expected)
      || value.index !== this.chunks.length) throw new Error("Unmatched or out-of-order history result");
    const keys = [...Object.keys(this.identity), "index"];
    if (typeof value.text === "string") {
      keys.push("text");
      if (Object.keys(value).some(key => !keys.includes(key)) || !value.text.length || value.text.length > 64 * 1024) throw new Error("Invalid history chunk");
      this.bytes += Buffer.byteLength(value.text);
      // A slice may bisect a surrogate pair, costing a few extra encoded bytes.
      if (this.bytes > this.limit + 8192 || this.chunks.length >= 1280) throw new Error("History aggregate limit exceeded");
      this.chunks.push(value.text);
      return false;
    }
    this.terminal = true;
    if (value.status === "failed") {
      keys.push("status", "code", "error");
      if (this.chunks.length || (value.code !== "resource_limit" && value.code !== "resource_unavailable"
        && value.code !== "session_busy" && value.code !== "stale_runtime")
        || typeof value.error !== "string" || Buffer.byteLength(value.error) > 8192
        || Object.keys(value).some(key => !keys.includes(key))) throw new Error("Invalid history refusal");
      this.failure = new CommandError(value.code, value.error);
    } else {
      keys.push("status", "bytes");
      const text = this.chunks.join("");
      this.chunks.length = 0;
      if (value.status !== "completed" || value.bytes !== Buffer.byteLength(text) || Number(value.bytes) > this.limit
        || Object.keys(value).some(key => !keys.includes(key))) throw new Error("Invalid history completion");
      let data: unknown;
      try { data = JSON.parse(text); } catch { throw new Error("Invalid history JSON"); }
      if (!object(data)) throw new Error("Invalid history data");
      if (this.identity.kind === "projected-tail") {
        if (Object.keys(data).length !== 2 || !Array.isArray(data.messages) || data.messages.length > 512
          || !Number.isSafeInteger(data.omittedMessages) || Number(data.omittedMessages) < 0) throw new Error("Invalid projected tail");
        let bytes = 0;
        const messageBytes: number[] = [];
        for (const message of data.messages) {
          if (!object(message) || typeof message.role !== "string") throw new Error("Invalid projected message");
          const size = Buffer.byteLength(JSON.stringify(message));
          messageBytes.push(size); bytes += size;
        }
        if (bytes > 16 * 1024 * 1024) throw new Error("Projected tail limit exceeded");
        // Owner-internal accounting, never accepted from the wire or published.
        data.messageBytes = messageBytes;
      } else if (Object.keys(data).length !== 2 || !Array.isArray(data[this.identity.kind])
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
