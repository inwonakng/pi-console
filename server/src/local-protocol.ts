import type { Readable, Writable } from "node:stream";
import { randomUUID } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import { object } from "./pi-records.js";
import { NATIVE_OPERATIONS } from "./session-operations.js";
import { BUNDLED_SOURCES } from "./session-bundled.js";

export const PROTOCOL = 1;
export const CAPABILITIES = ["snapshot", "snapshot.sections", "snapshot.history", "history.treeEntries", "transport.chunks", "updates", "sessions.subscribe", "notifications.subscribe", "host.create", "window.open", "window.submit", "host.resume", "host.recover", "host.saved", "host.history", "host.archive", "host.delete", "control.acquire", "control.takeover", "control.release",
  "interaction.respond", "interaction.cancel", "prompt.submit", "turn.abort", "queue.edit", "queue.remove", "queue.reserve", "queue.release",
  "session.manage", "session.manage.status", "session.rename", "workspace.review.save", "workspace.review.stage", "workspace.review.unstage", "workspace.review.restore", "session.read", "resource.read", "resource.complete", "host.directories", "host.options", "host.complete", "session.restart", "session.kill", ...Object.keys(BUNDLED_SOURCES), ...NATIVE_OPERATIONS, "response.viewed", "command.status", "effect.inspect", "service.stop", "service.restart", "service.restart.status"] as const;
// Shared by the public listener and registered local-profile relays.
export const REMOTE_METHODS = new Set(["hello", "health", "sessions", "sessions.subscribe", "notifications.subscribe", "host.command", "host.status", "window.open", "window.submit", "session.manage", "session.manage.status", "attach", "detach", "snapshot", "snapshot.history", "session.read", "resource.read", "resource.complete", "host.directories", "host.options", "host.complete", "host.saved", "host.history", "command", "grant", "heartbeat", "response.viewed", "command.status", "effect.inspect", "service.restart", "service.restart.status"]);
export const MAX_RESPONSE = 80 * 1024 * 1024;
export const MAX_REQUEST = 2 * 1024 * 1024;

/** LF-delimited, strict UTF-8, bounded even when a peer never sends a newline. */
export async function* records(input: Readable, limit: number): AsyncGenerator<Record<string, unknown>> {
  let parts: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of input) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let start = 0;
    for (let end = 0; end <= buffer.length; end++) {
      if (end !== buffer.length && buffer[end] !== 10) continue;
      const part = buffer.subarray(start, end);
      bytes += part.length;
      if (bytes > limit) throw new Error("IPC frame exceeds the size limit");
      if (part.length) parts.push(part);
      if (end < buffer.length) {
        const line = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts, bytes));
        let value: unknown;
        try { value = JSON.parse(line); } catch { throw new Error("Invalid IPC JSON"); }
        if (!object(value)) throw new Error("IPC record must be an object");
        yield value;
        parts = []; bytes = 0;
      }
      start = end + 1;
    }
  }
  if (bytes) throw new Error("IPC stream ended inside a frame");
}

const CHUNK_UNITS = 16 * 1024;

type Write = { text: string; bytes: number; offset: number; index: number; transfer?: string;
  started?: () => void; resolve: () => void; reject: (error: Error) => void };

export type RecordWriteOptions = { control?: boolean; ordered?: boolean; started?: () => void };

/** Bounded frames let renewal replies and ordered updates pass bulk responses.
 * Ordered responses share the FIFO lane with updates instead of bulk responses.
 */
export class RecordWriter {
  chunks = false;
  private readonly control: Write[] = [];
  private readonly normal: Write[] = [];
  private readonly bulk: Write[] = [];
  private pending = 0;
  private running = false;
  private bulkNext = false;
  private failure?: Error;
  constructor(private readonly output: Writable, private readonly limit = MAX_RESPONSE + MAX_REQUEST) {}
  get queuedBytes(): number { return this.pending; }
  send(value: unknown, options: RecordWriteOptions = {}): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    const text = JSON.stringify(value);
    const bytes = Buffer.byteLength(text) + 1;
    if (bytes > MAX_RESPONSE || this.pending + bytes > this.limit) return Promise.reject(new Error("IPC output budget exceeded; reconnect for a fresh snapshot"));
    this.pending += bytes;
    return new Promise<void>((resolve, reject) => {
      const chunked = this.chunks && text.length > CHUNK_UNITS;
      const lane = options.control ? this.control : !options.ordered && chunked && object(value) && value.type === "response" ? this.bulk : this.normal;
      lane.push({ text, bytes, offset: 0, index: 0, ...(chunked ? { transfer: randomUUID() } : {}), started: options.started, resolve, reject });
      if (!this.running) { this.running = true; void this.pump(); }
    });
  }
  private async pump(): Promise<void> {
    try {
      while (this.control.length || this.normal.length || this.bulk.length) {
        const lane = this.control.length ? this.control
          : this.bulk.length && (!this.normal.length || this.bulkNext) ? this.bulk : this.normal;
        const item = lane[0]!;
        if (!item.index) { item.started?.(); item.started = undefined; }
        let end = Math.min(item.offset + CHUNK_UNITS, item.text.length);
        // Lua JSON decoders reject isolated surrogates; keep UTF-16 pairs intact.
        const last = item.text.charCodeAt(end - 1);
        if (end < item.text.length && last >= 0xd800 && last <= 0xdbff) end--;
        const done = !item.transfer || end === item.text.length;
        const line = item.transfer ? JSON.stringify({ type: "transport_chunk", transfer: item.transfer, index: item.index++,
          text: item.text.slice(item.offset, end), ...(done ? { bytes: item.bytes - 1 } : {}) }) + "\n" : item.text + "\n";
        if (this.output.destroyed || this.output.writableEnded) throw new Error("IPC connection is closed");
        if (!this.output.write(line)) await new Promise<void>((resolve, reject) => {
          const cleanup = () => { this.output.off("drain", drained); this.output.off("close", closed); this.output.off("error", failed); };
          const drained = () => { cleanup(); resolve(); };
          const closed = () => { cleanup(); reject(new Error("IPC closed during output")); };
          const failed = (error: Error) => { cleanup(); reject(error); };
          this.output.once("drain", drained); this.output.once("close", closed); this.output.once("error", failed);
        });
        item.offset = end;
        if (lane !== this.control) this.bulkNext = lane === this.normal;
        if (done) { lane.shift(); this.pending -= item.bytes; item.resolve(); }
        // Even a fast pipe must service timers and incoming renewal requests.
        await setImmediate();
      }
    } catch (error) {
      this.failure = error instanceof Error ? error : new Error("IPC output failed");
      for (const lane of [this.control, this.normal, this.bulk]) {
        for (const item of lane.splice(0)) item.reject(this.failure);
      }
      this.pending = 0;
    } finally { this.running = false; }
  }
}

/** Transport framing only; application correlation and sequence fences stay at callers. */
export class TransportChunks {
  private readonly transfers = new Map<string, { parts: string[]; bytes: number }>();
  private bytes = 0;
  consume(record: Record<string, unknown>): Record<string, unknown> | undefined {
    if (record.type !== "transport_chunk") return record;
    if (typeof record.transfer !== "string" || !/^[0-9a-f-]{36}$/.test(record.transfer)
      || !Number.isSafeInteger(record.index) || typeof record.text !== "string" || !record.text.length || record.text.length > CHUNK_UNITS
      || Object.keys(record).some(key => !["type", "transfer", "index", "text", "bytes"].includes(key))) throw new Error("Invalid transport chunk");
    let transfer = this.transfers.get(record.transfer);
    if (!transfer) {
      if (record.index !== 0 || this.transfers.size >= 32) throw new Error("Invalid transport transfer");
      transfer = { parts: [], bytes: 0 }; this.transfers.set(record.transfer, transfer);
    }
    if (record.index !== transfer.parts.length) throw new Error("Out-of-order transport chunk");
    const bytes = Buffer.byteLength(record.text);
    transfer.bytes += bytes; this.bytes += bytes;
    if (transfer.bytes > MAX_RESPONSE + 32768 || this.bytes > MAX_RESPONSE + MAX_REQUEST + 32768
      || transfer.parts.length >= 5120) throw new Error("Transport aggregate limit exceeded");
    transfer.parts.push(record.text);
    if (record.bytes === undefined) return;
    const text = transfer.parts.join("");
    if (!Number.isSafeInteger(record.bytes) || Number(record.bytes) < 1 || Number(record.bytes) + 1 > MAX_RESPONSE
      || record.bytes !== Buffer.byteLength(text)) throw new Error("Invalid transport completion");
    this.transfers.delete(record.transfer); this.bytes -= transfer.bytes;
    let value: unknown;
    try { value = JSON.parse(text); } catch { throw new Error("Invalid transport JSON"); }
    if (!object(value) || value.type === "transport_chunk") throw new Error("Invalid transport record");
    return value;
  }
  finish(): void { if (this.transfers.size) throw new Error("Incomplete transport transfer"); }
}
