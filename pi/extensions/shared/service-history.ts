import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { serviceManaged, serviceRuntimeId } from "./service-ui";

// Keep the private wire contract in step with server/src/session-history.ts.
const COMMAND = "pi-console-history-read";
const STATUS = "pi-console-history-result";
const HISTORY_BYTES = 16 * 1024 * 1024;
const RESULT_BYTES = 80 * 1024 * 1024 - 64 * 1024; // Public response envelope allowance.
const CHUNK_UNITS = 64 * 1024;
type Kind = "projected-tail" | "entries" | "tree";
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
class ReadRefusal extends Error {
  constructor(readonly code: "session_busy" | "resource_limit" | "resource_unavailable" | "stale_runtime", message: string) { super(message); }
}

function capture(ctx: ExtensionCommandContext, kind: Kind, since?: string): unknown {
  const manager = ctx.sessionManager;
  if (kind === "projected-tail") {
    if (!ctx.isIdle()) throw new ReadRefusal("session_busy", "Projected history requires an idle session");
    const messages = manager.buildSessionProjection().messages;
    // Match the conversation reducer, including rejecting oversized older messages.
    const sizes = messages.map(message => {
      const bytes = Buffer.byteLength(JSON.stringify(message));
      if (bytes > HISTORY_BYTES) throw new ReadRefusal("resource_limit", "Pi conversation message exceeds 16 MiB");
      return bytes;
    });
    let start = messages.length, bytes = 0;
    while (start > 0 && messages.length - start < 512 && bytes + sizes[start - 1]! <= HISTORY_BYTES) {
      bytes += sizes[--start]!;
    }
    return { messages: messages.slice(start), omittedMessages: start };
  }
  if (kind === "entries") {
    let entries = manager.getEntries();
    if (since !== undefined) {
      const index = entries.findIndex(entry => entry.id === since);
      if (index === -1) throw new ReadRefusal("resource_unavailable", `Entry not found: ${since}`);
      entries = entries.slice(index + 1);
    }
    return { entries, leafId: manager.getLeafId() };
  }
  return { tree: manager.getTree(), leafId: manager.getLeafId() };
}

/** Fixed observational command: no messages, entries, model calls or async capture. */
export function registerServiceHistory(pi: ExtensionAPI): void {
  if (process.env.PI_CONSOLE_SERVICE !== "1") return;
  pi.registerCommand(COMMAND, { description: "Internal bounded service history read", handler: async (args, ctx) => {
    const v: unknown = JSON.parse(args);
    if (!serviceManaged(ctx) || !object(v) || v.version !== 1
      || Object.keys(v).some(key => !["version", "invocationId", "runtimeId", "sessionId", "sessionFile", "kind", "since"].includes(key))
      || ![v.invocationId, v.runtimeId, v.sessionId, v.sessionFile].every(part => typeof part === "string" && !!part && Buffer.byteLength(part) <= 4096)
      || typeof v.kind !== "string" || !["projected-tail", "entries", "tree"].includes(v.kind)
      || (v.since !== undefined && (v.kind !== "entries" || typeof v.since !== "string" || !v.since || Buffer.byteLength(v.since) > 4096))) {
      throw new Error("Invalid managed history read");
    }
    const identity = { version: 1, invocationId: v.invocationId, runtimeId: v.runtimeId,
      sessionId: v.sessionId, sessionFile: v.sessionFile, kind: v.kind };
    const reply = (data: Record<string, unknown>) => {
      const statusText = JSON.stringify({ ...identity, ...data });
      // Account for JSON nested in the actual RPC record, not only raw data.
      if (Buffer.byteLength(JSON.stringify({ type: "extension_ui_request", id: "x".repeat(36),
        method: "setStatus", statusKey: STATUS, statusText })) > 1024 * 1024) throw new Error("History record limit exceeded");
      ctx.ui.setStatus(STATUS, statusText);
    };
    let text: string;
    try {
      if (serviceRuntimeId(ctx) !== v.runtimeId || ctx.sessionManager.getSessionId() !== v.sessionId
        || ctx.sessionManager.getSessionFile() !== v.sessionFile) throw new ReadRefusal("stale_runtime", "History context changed");
      // Capture and serialize synchronously, before emitting any part of the result.
      // Conservative charging aborts large containers before constructing an
      // unlimited result string. Check exact serialized bytes afterward.
      let charged = 0;
      text = JSON.stringify(capture(ctx, v.kind as Kind, v.since as string | undefined), (key, value: unknown) => {
        charged += Buffer.byteLength(JSON.stringify(key)) + 1;
        if (value === null || typeof value !== "object") charged += Buffer.byteLength(JSON.stringify(value) ?? "null");
        else charged += 2;
        if (charged > RESULT_BYTES) throw new ReadRefusal("resource_limit", "History read exceeds public response budget");
        return value;
      });
      const limit = v.kind === "projected-tail" ? HISTORY_BYTES + 64 * 1024 : RESULT_BYTES;
      if (Buffer.byteLength(text) > limit) throw new ReadRefusal("resource_limit", "History read exceeds public response budget");
    } catch (error) {
      reply({ index: 0, status: "failed", code: error instanceof ReadRefusal ? error.code
        : error instanceof RangeError ? "resource_limit" : "resource_unavailable",
        error: error instanceof ReadRefusal ? error.message : error instanceof RangeError
          ? "History read exceeds serialization limits" : "Unable to capture session history" });
      return;
    }
    let index = 0;
    for (let offset = 0; offset < text.length; offset += CHUNK_UNITS) {
      reply({ index: index++, text: text.slice(offset, offset + CHUNK_UNITS) });
    }
    reply({ index, status: "completed", bytes: Buffer.byteLength(text) });
  } });
}
