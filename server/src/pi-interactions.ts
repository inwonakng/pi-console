import type { RpcExtensionUIResponse } from "@earendil-works/pi-coding-agent";
import { dialogRequest, dialogTag, object, type DialogTag, type PiDialogRequest, type PiEvent } from "./pi-records.js";

export type PiRuntime = {
  id: string;
  sessionId: string;
  sessionFile?: string;
  cwd: string;
  active: boolean;
};
export type PendingInteraction = {
  request: PiDialogRequest;
  runtimeId: string;
  tag?: DialogTag;
  submitted: boolean;
};
export type InteractionSnapshot = {
  runtime?: PiRuntime;
  revision: number;
  pending: PendingInteraction[];
};

/** Live interaction state only, not a complete conversation snapshot. */
export class PiInteractions {
  private runtime?: PiRuntime;
  private revision = 0;
  private readonly pending = new Map<string, PendingInteraction & { bytes: number }>();
  private pendingBytes = 0;

  constructor(private readonly discard: (request: PiDialogRequest) => void) {}

  get runtimeRevision(): number { return this.revision; }
  get interactionCount(): number { return this.pending.size; }
  get pendingCount(): number {
    let count = 0;
    for (const item of this.pending.values()) if (!item.submitted) count++;
    return count;
  }
  runtimeSnapshot(): PiRuntime | undefined { return this.runtime && { ...this.runtime }; }
  hasPending(id: string): boolean { return this.pending.get(id)?.submitted === false; }

  snapshot(): InteractionSnapshot {
    return structuredClone({ runtime: this.runtime, revision: this.revision, pending: [...this.pending.values()].map(({ bytes: _bytes, ...item }) => item) });
  }

  apply(event: PiEvent): void {
    if (event.type !== "extension_ui_request") return;
    if (dialogRequest(event)) {
      if (!this.runtime?.active) throw new Error("Pi dialog arrived without an active managed runtime");
      if (typeof event.title !== "string") throw new Error("Invalid Pi dialog title");
      if (event.method === "select" && (!Array.isArray(event.options) || !event.options.every((option) => typeof option === "string"))) throw new Error("Invalid Pi dialog choices");
      const bytes = Buffer.byteLength(JSON.stringify(event));
      const tag = dialogTag(event.title);
      if (tag && tag.runtimeId !== this.runtime.id) throw new Error("Pi dialog targets a stale runtime");
      if (this.pending.has(event.id)) throw new Error("Duplicate Pi dialog ID");
      if (this.pending.size >= 256 || this.pendingBytes + bytes > 32 * 1024 * 1024) throw new Error("Pi pending interaction limit exceeded");
      this.pending.set(event.id, { request: event, runtimeId: this.runtime.id, tag, submitted: false, bytes });
      this.pendingBytes += bytes;
      return;
    }
    if (event.method !== "setStatus" || (event.statusKey !== "pi-console-runtime" && event.statusKey !== "pi-console-dialog")) return;
    if (typeof event.statusText !== "string") throw new Error("Missing managed Pi lifecycle status");
    let status: unknown;
    try { status = JSON.parse(event.statusText); }
    catch { throw new Error("Invalid JSON in managed Pi lifecycle status"); }
    if (!object(status)) throw new Error("Invalid managed Pi lifecycle status");
    if (event.statusKey === "pi-console-runtime") {
      this.applyRuntime(status);
    } else {
      if (status.state !== "closed" || typeof status.id !== "string" || typeof status.runtimeId !== "string"
        || !["resolved", "aborted", "runtime-ended", "error"].includes(String(status.reason))) throw new Error("Invalid Pi dialog closure");
      for (const [id, pending] of this.pending) {
        if (pending.tag?.id !== status.id || pending.runtimeId !== status.runtimeId) continue;
        this.remove(id);
        // Pi's raw editor promise has no AbortSignal support. Its bundled wrapper
        // has already invalidated the wait; retire that raw callback as cleanup.
        if (!pending.submitted && pending.request.method === "editor" && status.reason !== "resolved") this.discard(pending.request);
        break;
      }
    }
  }

  submit(response: RpcExtensionUIResponse, runtimeId: string): void {
    if (!this.runtime?.active || this.runtime.id !== runtimeId) throw new Error("Pi runtime changed before the interaction reply");
    const pending = this.pending.get(response.id);
    if (!pending || pending.runtimeId !== runtimeId) throw new Error("Pi interaction is no longer pending");
    if (pending.submitted) throw new Error("Pi interaction reply was already submitted");
    if ("cancelled" in response && response.cancelled !== true) throw new Error("Invalid Pi cancellation reply");
    if (!("cancelled" in response)) {
      if (pending.request.method === "confirm") {
        if (!("confirmed" in response) || typeof response.confirmed !== "boolean") throw new Error("Confirmation reply required");
      } else {
        if (!("value" in response) || typeof response.value !== "string") throw new Error("Text reply required");
        if (pending.request.method === "select" && !pending.request.options.includes(response.value)) throw new Error("Unknown Pi selection");
      }
    }
    // Reserve before writing. A lost write/ack is uncertain, never a reason for
    // this adapter to submit the answer again under a new command ID.
    pending.submitted = true;
    // Bundled requests publish closure. A legacy extension has no such contract;
    // retire its view on submission without pretending it acknowledged the reply.
    if (!pending.tag) this.remove(response.id);
  }

  ended(): void {
    if (this.runtime?.active) {
      this.runtime.active = false;
      this.revision++;
    }
    this.pending.clear();
    this.pendingBytes = 0;
  }

  private remove(id: string): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    this.pendingBytes -= pending.bytes;
  }

  private applyRuntime(status: Record<string, unknown>): void {
    if (typeof status.runtimeId !== "string" || typeof status.sessionId !== "string" || typeof status.cwd !== "string"
      || (status.sessionFile !== undefined && typeof status.sessionFile !== "string")
      || (status.state !== "started" && status.state !== "stopped")) throw new Error("Invalid Pi runtime status");
    if (status.state === "stopped" && this.runtime?.id !== status.runtimeId) return;
    if (status.state === "started" && this.runtime?.id === status.runtimeId && this.runtime.active) return;
    if (status.state === "stopped" && !this.runtime?.active) return;
    const abandoned = [...this.pending.values()];
    this.pending.clear();
    this.pendingBytes = 0;
    this.runtime = { id: status.runtimeId, sessionId: status.sessionId, sessionFile: status.sessionFile, cwd: status.cwd, active: status.state === "started" };
    this.revision++;
    for (const item of abandoned) if (!item.submitted) this.discard(item.request);
  }
}
