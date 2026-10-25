import type { Readable, Writable } from "node:stream";
import { object } from "./pi-records.js";
import { NATIVE_OPERATIONS } from "./session-operations.js";
import { BUNDLED_SOURCES } from "./session-bundled.js";

export const PROTOCOL = 1;
export const CAPABILITIES = ["snapshot", "snapshot.sections", "attach.timings", "updates", "sessions.subscribe", "notifications.subscribe", "host.create", "host.resume", "host.recover", "host.saved", "host.history", "host.archive", "host.delete", "control.acquire", "control.takeover", "control.release",
  "interaction.respond", "interaction.cancel", "prompt.submit", "turn.abort", "queue.edit", "queue.remove", "queue.reserve", "queue.release",
  "session.manage", "session.manage.status", "session.rename", "workspace.review.save", "workspace.review.stage", "workspace.review.unstage", "workspace.review.restore", "session.read", "resource.read", "resource.complete", "host.directories", "host.options", "host.complete", "session.restart", "session.kill", ...Object.keys(BUNDLED_SOURCES), ...NATIVE_OPERATIONS, "response.viewed", "command.status", "effect.inspect", "service.stop", "service.restart", "service.restart.status"] as const;
// Shared by the public listener and registered local-profile relays.
export const REMOTE_METHODS = new Set(["hello", "health", "sessions", "sessions.subscribe", "notifications.subscribe", "host.command", "host.status", "session.manage", "session.manage.status", "attach", "detach", "snapshot", "session.read", "resource.read", "resource.complete", "host.directories", "host.options", "host.complete", "host.saved", "host.history", "command", "grant", "heartbeat", "response.viewed", "command.status", "effect.inspect", "service.restart", "service.restart.status"]);
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
        const value: unknown = JSON.parse(line);
        if (!object(value)) throw new Error("IPC record must be an object");
        yield value;
        parts = []; bytes = 0;
      }
      start = end + 1;
    }
  }
  if (bytes) throw new Error("IPC stream ended inside a frame");
}

export type AttachTimings = { handlingMs: number; snapshotMs: number; serializeMs: number };

/** Serial writes with a byte budget. Slow peers cannot hold owner reduction. */
export class RecordWriter {
  private lane: Promise<void> = Promise.resolve();
  private pending = 0;
  constructor(private readonly output: Writable, private readonly limit = MAX_RESPONSE + MAX_REQUEST) {}
  send(value: unknown, timings?: Omit<AttachTimings, "serializeMs">): Promise<void> {
    const started = timings ? performance.now() : 0;
    let line = JSON.stringify(value);
    if (timings) {
      // Append envelope metadata after serializing the response once. No snapshot re-encoding.
      const measured: AttachTimings = { ...timings, serializeMs: performance.now() - started };
      line = line.slice(0, -1) + ',"timings":' + JSON.stringify(measured) + "}";
    }
    line += "\n";
    const bytes = Buffer.byteLength(line);
    if (bytes > MAX_RESPONSE || this.pending + bytes > this.limit) return Promise.reject(new Error("IPC output budget exceeded; reconnect for a fresh snapshot"));
    this.pending += bytes;
    const task = this.lane.then(async () => {
      if (this.output.destroyed || this.output.writableEnded) throw new Error("IPC connection is closed");
      if (!this.output.write(line)) await new Promise<void>((resolve, reject) => {
        const cleanup = () => { this.output.off("drain", drained); this.output.off("close", closed); this.output.off("error", failed); };
        const drained = () => { cleanup(); resolve(); };
        const closed = () => { cleanup(); reject(new Error("IPC closed during output")); };
        const failed = (error: Error) => { cleanup(); reject(error); };
        this.output.once("drain", drained); this.output.once("close", closed); this.output.once("error", failed);
      });
    });
    this.lane = task.catch(() => undefined);
    return task.finally(() => { this.pending -= bytes; });
  }
}
