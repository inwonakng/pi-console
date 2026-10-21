import type { JsonAgentSessionEvent, RpcExtensionUIRequest, RpcResponse } from "@earendil-works/pi-coding-agent";

export type PiEvent = JsonAgentSessionEvent | RpcExtensionUIRequest | {
  type: "extension_error";
  extensionPath: string;
  event: string;
  error: string;
};
export type PiRecord = RpcResponse | PiEvent;
export type PiDialogRequest = Extract<RpcExtensionUIRequest, { method: "select" | "confirm" | "input" | "editor" }>;

export function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Validate the envelope from our owned Pi child, not an application command. */
export function parsePiRecord(line: string): PiRecord {
  let value: unknown;
  try { value = JSON.parse(line); }
  catch { throw new Error("Invalid JSON in Pi stdout"); }
  if (!object(value) || typeof value.type !== "string") throw new Error("Invalid Pi record envelope");
  if (value.type === "response" && (typeof value.command !== "string" || typeof value.success !== "boolean"
    || (value.id !== undefined && typeof value.id !== "string"))) throw new Error("Invalid Pi response envelope");
  if (value.type === "extension_ui_request" && (typeof value.id !== "string" || typeof value.method !== "string")) {
    throw new Error("Invalid Pi UI request envelope");
  }
  // Event payloads follow the installed Pi contract. Only this private adapter
  // consumes raw RPC; frontend commands must have their own validated allowlist.
  return value as PiRecord;
}

export function dialogRequest(event: PiEvent): event is PiDialogRequest {
  return event.type === "extension_ui_request"
    && (event.method === "select" || event.method === "confirm" || event.method === "input" || event.method === "editor");
}

export type DialogTag = { id: string; runtimeId: string; deadline?: number };

export function dialogTag(title: string): DialogTag | undefined {
  let value: unknown;
  try { value = JSON.parse(title); } catch { return; }
  if (!object(value) || !object(value.serviceDialog)) return;
  const tag = value.serviceDialog;
  if (typeof tag.id !== "string" || typeof tag.runtimeId !== "string"
    || (tag.deadline !== undefined && (typeof tag.deadline !== "number" || !Number.isFinite(tag.deadline)))) return;
  return { id: tag.id, runtimeId: tag.runtimeId, deadline: tag.deadline };
}
