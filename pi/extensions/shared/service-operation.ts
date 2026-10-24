import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { serviceManaged, serviceRuntimeId } from "./service-ui";

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
export const OPERATION_RESULT = "pi-console-operation-result";
export const operationCommand = (operation: BundledOperation["operation"]): string => `pi-console-${operation.replaceAll(".", "-")}`;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const exact = (p: Record<string, unknown>, keys: string[]) => Object.keys(p).length === keys.length && keys.every((key) => key in p);
export function validBundled(operation: unknown, p: Record<string, unknown>): boolean {
  switch (operation) {
    case "access.set": return exact(p, ["mode"]) && typeof p.mode === "string" && ["readonly", "ask", "edit", "full"].includes(p.mode);
    case "integration.set": return exact(p, ["mode"]) && typeof p.mode === "string" && ["ask", "allowed"].includes(p.mode);
    case "access.cycle": case "integration.cycle": {
      const allowed = operation === "access.cycle" ? ["readonly", "ask", "edit", "full"] : ["ask", "allowed"];
      return exact(p, ["modes"]) && Array.isArray(p.modes) && p.modes.length > 0 && p.modes.length <= allowed.length
        && new Set(p.modes).size === p.modes.length && p.modes.every((mode) => typeof mode === "string" && allowed.includes(mode));
    }
    case "history.navigate": return exact(p, ["entryId", "summarize"]) && typeof p.entryId === "string" && /^[\w-]{1,128}$/.test(p.entryId) && typeof p.summarize === "boolean";
    case "history.clone": case "history.fork": case "history.delete": return exact(p, ["entryId"]) && typeof p.entryId === "string" && /^[\w-]{1,128}$/.test(p.entryId);
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
export type OperationData = { mode?: string; changed?: boolean; sessionFile?: string; cwd?: string;
  workspaceId?: string; lifecycle?: string; integration?: string; commit?: string; reverts?: string; disposition?: "accepted"; status?: string; title?: string; enabled?: boolean; editorText?: string };
export type OperationResult = {
  version: 1; invocationId: string; runtimeId: string; sessionId: string; sessionFile: string;
  status: "completed" | "failed" | "uncertain"; data?: OperationData; code?: string;
};
/** Each fixed command owns a typed payload and must explicitly report success.
 * Returning undefined means a pre-mutation refusal/cancellation, never `handled`
 * success. An exception is conservatively uncertain (possibly partial writes).
 */
type Payloads = { [O in BundledOperation as O["operation"]]: O["payload"] };
export function registerServiceOperation<O extends keyof Payloads>(pi: ExtensionAPI, operation: O,
  run: (payload: Payloads[O], ctx: ExtensionCommandContext) => Promise<OperationData | undefined>): void {
  if (process.env.PI_CONSOLE_SERVICE !== "1") return;
  pi.registerCommand(operationCommand(operation), { description: "Internal typed owner operation", handler: async (args, ctx) => {
    const v: unknown = JSON.parse(args);
    if (!serviceManaged(ctx) || !object(v) || !exact(v, ["version", "invocationId", "runtimeId", "sessionId", "sessionFile", "payload"])
      || v.version !== 1 || ![v.invocationId, v.runtimeId, v.sessionId, v.sessionFile].every((part) => typeof part === "string" && !!part)
      || !object(v.payload) || !validBundled(operation, v.payload)) throw new Error("Invalid managed operation");
    const identity = { version: 1 as const, invocationId: v.invocationId as string, runtimeId: v.runtimeId as string,
      sessionId: v.sessionId as string, sessionFile: v.sessionFile as string };
    // Capture the outgoing UI: runtime-changing handlers may dispose ctx.
    const ui = ctx.ui;
    const reply = (result: Omit<OperationResult, keyof typeof identity>) => ui.setStatus(OPERATION_RESULT, JSON.stringify({ ...identity, ...result }));
    if (serviceRuntimeId(ctx) !== v.runtimeId || ctx.sessionManager.getSessionId() !== v.sessionId || ctx.sessionManager.getSessionFile() !== v.sessionFile) {
      reply({ status: "failed", code: "stale_context" }); return;
    }
    try {
      const data = await run(v.payload as Payloads[O], ctx);
      reply(data ? { status: "completed", data } : { status: "failed", code: "not_applied" });
    } catch { reply({ status: "uncertain", code: "operation_uncertain" }); }
  } });
}
