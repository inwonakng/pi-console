import { object } from "./pi-records.js";

// Keep payload validation in step with pi/extensions/shared/service-operation.ts.
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
  | { operation: "workspace.discard"; payload: { id?: string } }
  | { operation: "side.open"; payload: Record<string, never> }
  | { operation: "side.prompt"; payload: { text: string } }
  | { operation: "side.draft"; payload: { text: string } }
  | { operation: "side.reset"; payload: Record<string, never> }
  | { operation: "side.abort"; payload: Record<string, never> }
  | { operation: "spawn.join"; payload: { id: string } }
  | { operation: "spawn.stop"; payload: { id: string } }
  | { operation: "title.generate"; payload: Record<string, never> }
  | { operation: "notifications.set"; payload: { enabled: boolean } }
  | { operation: "usage.refresh"; payload: Record<string, never> };
export const BUNDLED_SOURCES = {
  "access.set": "access-mode.ts", "access.cycle": "access-mode.ts",
  "integration.set": "workspace.ts", "integration.cycle": "workspace.ts",
  "history.navigate": "tree.ts", "history.clone": "tree.ts", "history.fork": "tree.ts", "history.delete": "tree.ts",
  "workspace.enter": "workspace.ts", "workspace.integrate": "workspace.ts", "workspace.discard": "workspace.ts", "workspace.revert": "workspace.ts",
  "side.open": "side.ts", "side.prompt": "side.ts", "side.draft": "side.ts", "side.reset": "side.ts", "side.abort": "side.ts",
  "spawn.join": "spawn.ts", "spawn.stop": "spawn.ts", "title.generate": "auto-title.ts",
  "notifications.set": "notifications.ts", "usage.refresh": "codex-usage.ts",
} as const;
export const OPERATION_RESULT = "pi-console-operation-result";
export const operationCommand = (operation: BundledOperation["operation"]): string => `pi-console-${operation.replaceAll(".", "-")}`;
const exact = (p: Record<string, unknown>, keys: string[]) => Object.keys(p).length === keys.length && keys.every((key) => key in p);
const entry = (v: unknown) => typeof v === "string" && /^[\w-]{1,128}$/.test(v);
export function validBundled(operation: unknown, p: Record<string, unknown>): boolean {
  switch (operation) {
    case "access.set": return exact(p, ["mode"]) && typeof p.mode === "string" && ["readonly", "ask", "edit", "full"].includes(p.mode);
    case "integration.set": return exact(p, ["mode"]) && typeof p.mode === "string" && ["ask", "allowed"].includes(p.mode);
    case "access.cycle": case "integration.cycle": {
      const allowed = operation === "access.cycle" ? ["readonly", "ask", "edit", "full"] : ["ask", "allowed"];
      return exact(p, ["modes"]) && Array.isArray(p.modes) && p.modes.length > 0 && p.modes.length <= allowed.length
        && new Set(p.modes).size === p.modes.length && p.modes.every((mode) => typeof mode === "string" && allowed.includes(mode));
    }
    case "history.navigate": return exact(p, ["entryId", "summarize"]) && entry(p.entryId) && typeof p.summarize === "boolean";
    case "history.clone": case "history.fork": case "history.delete": return exact(p, ["entryId"]) && entry(p.entryId);
    case "workspace.enter": case "workspace.integrate": case "workspace.discard":
      return Object.keys(p).every((key) => key === "id" || operation === "workspace.enter" && key === "ignoredFiles" || operation === "workspace.integrate" && key === "commitMessage")
        && (p.commitMessage === undefined || typeof p.commitMessage === "string" && !!p.commitMessage.trim() && !p.commitMessage.includes("\0") && Buffer.byteLength(p.commitMessage) <= 16384)
        && (p.id === undefined || typeof p.id === "string" && /^[\w-]{1,128}$/.test(p.id))
        && (p.ignoredFiles === undefined || Array.isArray(p.ignoredFiles) && p.ignoredFiles.length <= 128 && p.ignoredFiles.every((v) => typeof v === "string" && v.length <= 4096));
    case "workspace.revert": return exact(p, ["id", "reason"]) && typeof p.id === "string" && /^[\w-]{1,128}$/.test(p.id)
      && typeof p.reason === "string" && !!p.reason.trim() && !p.reason.includes("\0") && Buffer.byteLength(p.reason) <= 8192;
    case "usage.refresh": case "title.generate": case "side.open": case "side.reset": case "side.abort": return exact(p, []);
    case "notifications.set": return exact(p, ["enabled"]) && typeof p.enabled === "boolean";
    case "side.prompt": return exact(p, ["text"]) && typeof p.text === "string" && !!p.text.trim() && Buffer.byteLength(p.text) <= 1024 * 1024;
    case "side.draft": return exact(p, ["text"]) && typeof p.text === "string" && Buffer.byteLength(p.text) <= 1024 * 1024;
    case "spawn.join": case "spawn.stop": return exact(p, ["id"]) && typeof p.id === "string" && /^[\w-]{1,128}$/.test(p.id);
    default: return false;
  }
}
export function isBundled(value: { operation: string }): value is BundledOperation { return Object.hasOwn(BUNDLED_SOURCES, value.operation); }
export type OperationResult = { version: 1; invocationId: string; runtimeId: string; sessionId: string; sessionFile: string;
  status: "completed" | "failed" | "uncertain"; data?: { mode?: string; changed?: boolean; sessionFile?: string; cwd?: string; workspaceId?: string;
    lifecycle?: string; integration?: string; commit?: string; reverts?: string; disposition?: "accepted"; status?: string; title?: string; enabled?: boolean; editorText?: string }; code?: string };
export function operationResult(text: string | undefined): OperationResult {
  const v: unknown = JSON.parse(text ?? "null");
  if (!object(v) || Object.keys(v).some((key) => !["version", "invocationId", "runtimeId", "sessionId", "sessionFile", "status", "data", "code"].includes(key))
    || v.version !== 1 || ![v.invocationId, v.runtimeId, v.sessionId, v.sessionFile].every((p) => typeof p === "string" && !!p && Buffer.byteLength(p) <= 4096)
    || typeof v.status !== "string" || !["completed", "failed", "uncertain"].includes(v.status)
    || (v.status === "completed" ? !object(v.data) : typeof v.code !== "string")
    || (v.code !== undefined && (typeof v.code !== "string" || !/^[\w-]{1,128}$/.test(v.code)))) throw new Error("Invalid managed operation result");
  if (v.data !== undefined) {
    if (!object(v.data) || Object.keys(v.data).some((key) => !["mode", "changed", "sessionFile", "cwd", "workspaceId", "lifecycle", "integration", "commit", "reverts", "disposition", "status", "title", "enabled", "editorText"].includes(key))
      || ["changed", "enabled"].some((key) => v.data && object(v.data) && v.data[key] !== undefined && typeof v.data[key] !== "boolean")
      || Object.entries(v.data).some(([key, value]) => !["changed", "enabled"].includes(key) && (typeof value !== "string" || Buffer.byteLength(value) > (key === "editorText" ? 16 * 1024 * 1024 : 4096)))) {
      throw new Error("Invalid managed operation result data");
    }
  }
  return v as OperationResult;
}
