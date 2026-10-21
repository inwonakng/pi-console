import { createHash, randomBytes, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { object } from "./pi-records.js";
import { validRenameTitle } from "./session-rename.js";
import { validNative, type NativeOperation } from "./session-operations.js";
import { validBundled, type BundledOperation } from "./session-bundled.js";

export type CommandErrorCode = "invalid_command" | "stale_epoch" | "stale_runtime" | "session_unavailable"
  | "attachment_closed" | "control_required" | "control_revoked" | "control_claimed"
  | "interaction_resolved" | "command_conflict" | "command_limit" | "queue_conflict" | "queue_limit" | "reservation_expired"
  | "session_busy" | "unsupported_command" | "storage_pressure";
export class CommandError extends Error {
  constructor(readonly code: CommandErrorCode, message: string) { super(message); }
}

type Envelope = {
  version: 1; id: string; sessionId: string; serviceEpoch: string; runtimeRevision: number; attachmentId: string;
};
type Authorized = { controlToken: string };
export type SessionCommand = Envelope & (
  | { operation: "control.acquire"; payload: Record<string, never> }
  | { operation: "control.takeover"; payload: { confirmed: true } }
  | (Authorized & (
    | NativeOperation
    | BundledOperation
    | { operation: "session.restart" | "session.kill"; payload: { confirmed: true } }
    | { operation: "control.release" | "turn.abort"; payload: Record<string, never> }
    | { operation: "interaction.respond"; payload: { requestId: string; answer: { value: string } | { confirmed: boolean } } }
    | { operation: "interaction.cancel"; payload: { requestId: string } }
    | { operation: "prompt.submit"; payload: { text: string } }
    | { operation: "session.rename"; payload: { title: string } }
    | { operation: "queue.edit"; payload: { itemId: string; expectedRevision: number; text: string } }
    | { operation: "queue.remove" | "queue.reserve"; payload: { itemId: string; expectedRevision: number } }
    | { operation: "queue.release"; payload: { reservationId: string } }
  ))
);
export type CommandReceipt = {
  id: string; sessionId: string; serviceEpoch: string; runtimeRevision: number;
  operation: SessionCommand["operation"];
  status: "accepted" | "completed" | "failed" | "uncertain";
  /** Snapshot-only marker: full recovery text remains available through commandStatus. */
  recoveryAvailable?: true;
  /** Completion describes command handling, NOT completion of agent work. */
  result?: { delivery?: "flushed"; cleared?: { steering: string[]; followUp: string[] }; idle?: boolean;
    queueItemId?: string; queueItemRevision?: number; queueItemText?: string; reservationId?: string; title?: string;
    submittedText?: string; editorText?: string; disposition?: "queued" | "handled" | "accepted"; exitCode?: number; cancelled?: boolean;
    mode?: string; changed?: boolean; sessionId?: string; workspaceId?: string; lifecycle?: string; integration?: string; status?: string; enabled?: boolean };
  error?: { code: string; message: string };
};
export type StoredCommand = { fingerprint: string; receipt: CommandReceipt };
export type Controller = { attachmentId: string; label: string; grantId: string };
export type ControlGrant = Controller & { token: string; heartbeatMs: 5000; expiresAfterMs: 20000 };

const identifier = (value: unknown): value is string => typeof value === "string" && /^[\w-]{1,128}$/.test(value);
const exact = (value: Record<string, unknown>, keys: string[]): boolean => Object.keys(value).every((key) => keys.includes(key));
function invalid(): never { throw new CommandError("invalid_command", "Invalid owner command or payload"); }

/** Non-slash text only. Pi's prompt RPC otherwise dispatches extension commands. */
export function validPromptText(value: unknown): value is string {
  return typeof value === "string" && !!value.trim() && !value.trimStart().startsWith("/")
    && Buffer.byteLength(value) <= 1024 * 1024;
}

/** An explicit application allowlist. No raw RPC records or freeform slash commands. */
export function sessionCommand(value: unknown): SessionCommand {
  if (!object(value) || value.version !== 1 || !identifier(value.id) || !identifier(value.sessionId)
    || !identifier(value.serviceEpoch) || !identifier(value.attachmentId)
    || !Number.isSafeInteger(value.runtimeRevision) || (value.runtimeRevision as number) < 0
    || !object(value.payload) || !exact(value, ["version", "id", "sessionId", "serviceEpoch", "runtimeRevision", "attachmentId", "controlToken", "operation", "payload"])) invalid();
  const payload = value.payload;
  switch (value.operation) {
    case "control.acquire": if (!exact(payload, []) || value.controlToken !== undefined) invalid(); break;
    case "control.takeover": if (!exact(payload, ["confirmed"]) || payload.confirmed !== true || value.controlToken !== undefined) invalid(); break;
    case "control.release": case "turn.abort": if (!exact(payload, [])) invalid(); break;
    case "session.restart": case "session.kill": if (!exact(payload, ["confirmed"]) || payload.confirmed !== true) invalid(); break;
    case "interaction.cancel": if (!exact(payload, ["requestId"]) || !identifier(payload.requestId)) invalid(); break;
    case "prompt.submit": if (!exact(payload, ["text"]) || !validPromptText(payload.text)) invalid(); break;
    case "session.rename": if (!exact(payload, ["title"]) || !validRenameTitle(payload.title)) invalid(); break;
    case "queue.edit": case "queue.remove": case "queue.reserve":
      if (!exact(payload, value.operation === "queue.edit" ? ["itemId", "expectedRevision", "text"] : ["itemId", "expectedRevision"])
        || !identifier(payload.itemId) || !Number.isSafeInteger(payload.expectedRevision) || (payload.expectedRevision as number) < 1
        || (value.operation === "queue.edit" && !validPromptText(payload.text))) invalid();
      break;
    case "queue.release": if (!exact(payload, ["reservationId"]) || !identifier(payload.reservationId)) invalid(); break;
    case "interaction.respond":
      if (!exact(payload, ["requestId", "answer"]) || !identifier(payload.requestId) || !object(payload.answer)) invalid();
      if (!(exact(payload.answer, ["value"]) && typeof payload.answer.value === "string")
        && !(exact(payload.answer, ["confirmed"]) && typeof payload.answer.confirmed === "boolean")) invalid();
      if (typeof payload.answer.value === "string" && Buffer.byteLength(payload.answer.value) > 1024 * 1024) invalid();
      break;
    default: if (!validNative(value.operation, payload) && !validBundled(value.operation, payload)) invalid();
  }
  if (value.operation !== "control.acquire" && value.operation !== "control.takeover"
    && (typeof value.controlToken !== "string" || value.controlToken.length > 128 || !value.controlToken.length)) invalid();
  return structuredClone(value) as SessionCommand;
}

export function commandFingerprint(command: SessionCommand): string {
  // Attachment/grant are delivery authority, not mutation identity: reconnects
  // resolve an old command without acquiring or replaying its old grant.
  const payload = command.operation === "interaction.respond"
    ? { requestId: command.payload.requestId, answer: "value" in command.payload.answer
      ? { value: command.payload.answer.value } : { confirmed: command.payload.answer.confirmed } }
    : command.operation === "queue.edit" ? { itemId: command.payload.itemId, expectedRevision: command.payload.expectedRevision, text: command.payload.text }
    : command.operation === "queue.remove" || command.operation === "queue.reserve"
      ? { itemId: command.payload.itemId, expectedRevision: command.payload.expectedRevision }
      : Object.fromEntries(Object.entries(command.payload).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  return createHash("sha256").update(JSON.stringify([command.sessionId, command.serviceEpoch,
    command.runtimeRevision, command.operation, payload])).digest("hex");
}

/** Ephemeral grants are never persisted or included in snapshots/receipts. */
export class SessionControl {
  private readonly attachments = new Map<string, string>();
  private grant?: Controller & { token: string; deadline: number };
  private timer?: NodeJS.Timeout;

  constructor(private readonly changed: () => void) {}
  attach(id: string, label: string): void { this.attachments.set(id, label); }
  detach(id: string): void {
    this.attachments.delete(id);
    if (this.grant?.attachmentId === id) this.revoke();
  }
  snapshot(): Controller | undefined {
    if (!this.grant) return;
    const { attachmentId, label, grantId } = this.grant;
    return { attachmentId, label, grantId };
  }
  current(): Controller | undefined { this.expire(); return this.snapshot(); }
  matches(attachmentId: string, grantId: string, token?: string): boolean {
    this.expire();
    return this.attachments.has(attachmentId) && this.grant?.attachmentId === attachmentId
      && this.grant.grantId === grantId && (token === undefined || this.grant.token === token);
  }
  grantFor(id: string): ControlGrant | undefined {
    this.attached(id);
    this.expire();
    if (this.grant?.attachmentId !== id) return;
    return { ...this.snapshot()!, token: this.grant.token, heartbeatMs: 5000, expiresAfterMs: 20000 };
  }
  attached(id: string): void {
    if (!this.attachments.has(id)) throw new CommandError("attachment_closed", "Session attachment is closed");
  }
  authorize(command: SessionCommand): void {
    this.attached(command.attachmentId);
    this.expire();
    if (command.operation === "control.takeover") return;
    if (command.operation === "control.acquire") {
      if (this.grant) throw new CommandError("control_claimed", "Session control is already claimed");
      return;
    }
    if (!this.grant) throw new CommandError("control_required", "Session control is required");
    if (this.grant.attachmentId !== command.attachmentId || this.grant.token !== command.controlToken) {
      throw new CommandError("control_revoked", "Session control grant was revoked or replaced");
    }
  }
  heartbeat(attachmentId: string, token: string): void {
    this.attached(attachmentId);
    this.expire();
    if (!this.grant || this.grant.attachmentId !== attachmentId || this.grant.token !== token) {
      throw new CommandError("control_revoked", "Session control grant was revoked or replaced");
    }
    this.grant.deadline = performance.now() + 20000;
    this.arm();
  }
  apply(command: SessionCommand): void {
    // A detach/expiry can occur during durable reservation. Never resurrect it.
    this.authorize(command);
    switch (command.operation) {
      case "control.acquire": case "control.takeover":
        this.grant = { attachmentId: command.attachmentId, label: this.attachments.get(command.attachmentId)!,
          grantId: randomUUID(), token: randomBytes(32).toString("hex"), deadline: performance.now() + 20000 };
        this.arm(); this.changed(); break;
      case "control.release": this.revoke(); break;
    }
  }
  revoke(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.grant) return;
    this.grant = undefined;
    this.changed();
  }
  private expire(): void { if (this.grant && performance.now() >= this.grant.deadline) this.revoke(); }
  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.expire(); if (this.grant) this.arm(); }, Math.max(1, this.grant!.deadline - performance.now()));
    this.timer.unref();
  }
}
