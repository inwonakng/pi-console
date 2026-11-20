import { validPublicBundled } from "../../pi/extensions/shared/bundled-payload.mjs";
import { object } from "./pi-records.js";
import { validBashResult, type BashServiceResult } from "./session-bash.js";

// Private owner handshake: deliberately excluded from public BundledOperation
// and BUNDLED_SOURCES, so clients cannot acquire an indefinite reservation.
export type BashTransitionPayload = { action: "acquire" | "release"; token: string };
export const BASH_TRANSITION_COMMAND = "pi-console-bash-transition";

export type BundledOperation =
  | { operation: "access.set"; payload: { mode: "readonly" | "ask" | "edit" | "full" } }
  | { operation: "integration.set"; payload: { mode: "ask" | "allowed" } }
  | { operation: "access.cycle"; payload: { modes: ("readonly" | "ask" | "edit" | "full")[] } }
  | { operation: "integration.cycle"; payload: { modes: ("ask" | "allowed")[] } }
  | { operation: "history.navigate"; payload: { entryId: string; summarize: boolean } }
  | { operation: "history.clone"; payload: { entryId: string } }
  | { operation: "history.fork"; payload: { entryId: string } }
  | { operation: "history.delete"; payload: { entryId: string } }
  | { operation: "workspace.enter"; payload: { id?: string; ignoredFiles?: string[] } }
  | { operation: "workspace.integrate"; payload: { id?: string; commitMessage?: string } }
  | { operation: "workspace.revert"; payload: { id: string; reason: string } }
  | { operation: "workspace.undo"; payload: { id: string; reason: string } }
  | { operation: "workspace.discard"; payload: { id?: string } }
  | { operation: "side.open"; payload: Record<string, never> }
  | { operation: "side.prompt" | "side.draft"; payload: { id: string; text: string } }
  | { operation: "side.reset"; payload: { fromId: string; abort: boolean } }
  | { operation: "side.select"; payload: { id: string; fromId: string; abort: boolean } }
  | { operation: "side.delete" | "side.abort"; payload: { id: string } }
  | { operation: "bash.list"; payload: { offset?: number } }
  | { operation: "bash.status" | "bash.join" | "bash.stop"; payload: { jobId: string } }
  | { operation: "bash.cancel-wait"; payload: { invocationId: string } }
  | { operation: "spawn.join"; payload: { id: string } }
  | { operation: "spawn.stop"; payload: { id: string } }
  | { operation: "title.generate"; payload: Record<string, never> }
  | { operation: "notifications.set"; payload: { enabled: boolean } }
  | { operation: "usage.refresh"; payload: Record<string, never> };
export const BUNDLED_SOURCES = {
  "access.set": "access-mode.ts", "access.cycle": "access-mode.ts",
  "integration.set": "workspace.ts", "integration.cycle": "workspace.ts",
  "history.navigate": "tree.ts", "history.clone": "tree.ts", "history.fork": "tree.ts", "history.delete": "tree.ts",
  "workspace.enter": "workspace.ts", "workspace.integrate": "workspace.ts", "workspace.discard": "workspace.ts", "workspace.revert": "workspace.ts", "workspace.undo": "workspace.ts",
  "side.open": "side.ts", "side.prompt": "side.ts", "side.draft": "side.ts", "side.reset": "side.ts", "side.abort": "side.ts", "side.select": "side.ts", "side.delete": "side.ts",
  "bash.list": "access-mode.ts", "bash.status": "access-mode.ts", "bash.join": "access-mode.ts", "bash.stop": "access-mode.ts", "bash.cancel-wait": "access-mode.ts",
  "spawn.join": "spawn.ts", "spawn.stop": "spawn.ts", "title.generate": "auto-title.ts",
  "notifications.set": "notifications.ts", "usage.refresh": "codex-usage.ts",
} as const;
export const OPERATION_RESULT = "pi-console-operation-result";
export const operationCommand = (operation: BundledOperation["operation"]): string => `pi-console-${operation.replaceAll(".", "-")}`;
export function validBundled(operation: unknown, p: Record<string, unknown>): boolean {
  return typeof operation === "string" && Object.hasOwn(BUNDLED_SOURCES, operation) && validPublicBundled(operation, p);
}
export function isBundled(value: { operation: string }): value is BundledOperation { return Object.hasOwn(BUNDLED_SOURCES, value.operation); }
export type OperationResult = { version: 1; invocationId: string; runtimeId: string; sessionId: string; sessionFile: string;
  status: "completed" | "failed" | "uncertain"; data?: { bash?: BashServiceResult; mode?: string; changed?: boolean; sessionFile?: string; cwd?: string; workspaceId?: string;
    lifecycle?: string; integration?: string; commit?: string; reverts?: string; disposition?: "accepted"; status?: string; title?: string; enabled?: boolean; editorText?: string }; code?: string; diagnostic?: string };
export function operationResult(text: string | undefined): OperationResult {
  const v: unknown = JSON.parse(text ?? "null");
  if (!object(v) || Object.keys(v).some((key) => !["version", "invocationId", "runtimeId", "sessionId", "sessionFile", "status", "data", "code", "diagnostic"].includes(key))
    || v.version !== 1 || ![v.invocationId, v.runtimeId, v.sessionId, v.sessionFile].every((p) => typeof p === "string" && !!p && Buffer.byteLength(p) <= 4096)
    || typeof v.status !== "string" || !["completed", "failed", "uncertain"].includes(v.status)
    || (v.status === "completed" ? !object(v.data) : typeof v.code !== "string")
    || (v.diagnostic !== undefined && (typeof v.diagnostic !== "string" || Buffer.byteLength(v.diagnostic) > 8192))
    || (v.code !== undefined && (typeof v.code !== "string" || !/^[\w-]{1,128}$/.test(v.code)))) throw new Error("Invalid managed operation result");
  if (v.data !== undefined) {
    if (!object(v.data) || Object.keys(v.data).some((key) => !["bash", "mode", "changed", "sessionFile", "cwd", "workspaceId", "lifecycle", "integration", "commit", "reverts", "disposition", "status", "title", "enabled", "editorText"].includes(key))
      || ["changed", "enabled"].some((key) => v.data && object(v.data) && v.data[key] !== undefined && typeof v.data[key] !== "boolean")
      || (v.data.bash !== undefined && !validBashResult(v.data.bash))
      || Object.entries(v.data).some(([key, value]) => !["bash", "changed", "enabled"].includes(key) && (typeof value !== "string" || Buffer.byteLength(value) > (key === "editorText" ? 16 * 1024 * 1024 : 4096)))) {
      throw new Error("Invalid managed operation result data");
    }
  }
  return v as OperationResult;
}
