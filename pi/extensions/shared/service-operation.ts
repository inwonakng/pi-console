import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { serviceManaged, serviceRuntimeId } from "./service-ui";
import type { BashControlResult } from "./bash-jobs";

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
  | { operation: "spawn.cancel"; payload: Record<string, never> }
  | { operation: "bash.interrupt"; payload: { phase: "hold" | "confirm"; frontendAvailable: boolean } }
  | { operation: "bash.transition"; payload: { action: "acquire" | "release"; token: string } }
  | { operation: "bash.list"; payload: { offset?: number } }
  | { operation: "bash.status" | "bash.join" | "bash.stop"; payload: { jobId: string } }
  | { operation: "bash.cancel-wait"; payload: { invocationId: string } }
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
    case "workspace.undo": case "workspace.revert": return exact(p, ["id", "reason"]) && typeof p.id === "string" && /^[\w-]{1,128}$/.test(p.id)
      && typeof p.reason === "string" && !!p.reason.trim() && !p.reason.includes("\0") && Buffer.byteLength(p.reason) <= 8192;
    case "usage.refresh": case "title.generate": case "side.open": case "spawn.cancel": return exact(p, []);
    case "notifications.set": return exact(p, ["enabled"]) && typeof p.enabled === "boolean";
    case "bash.transition": return exact(p, ["action", "token"]) && ["acquire", "release"].includes(String(p.action))
      && typeof p.token === "string" && /^[\w-]{1,128}$/.test(p.token);
    case "bash.interrupt": return exact(p, ["phase", "frontendAvailable"]) && ["hold", "confirm"].includes(String(p.phase)) && typeof p.frontendAvailable === "boolean";
    case "side.reset": return exact(p, ["fromId", "abort"]) && typeof p.fromId === "string" && /^[\w-]{1,128}$/.test(p.fromId) && typeof p.abort === "boolean";
    case "side.select": return exact(p, ["id", "fromId", "abort"]) && typeof p.id === "string" && /^[\w-]{1,128}$/.test(p.id)
      && typeof p.fromId === "string" && /^[\w-]{1,128}$/.test(p.fromId) && typeof p.abort === "boolean";
    case "side.delete": case "side.abort": return exact(p, ["id"]) && typeof p.id === "string" && /^[\w-]{1,128}$/.test(p.id);
    case "side.prompt": return exact(p, ["id", "text"]) && typeof p.id === "string" && /^[\w-]{1,128}$/.test(p.id) && typeof p.text === "string" && !!p.text.trim() && Buffer.byteLength(p.text) <= 1024 * 1024;
    case "side.draft": return exact(p, ["id", "text"]) && typeof p.id === "string" && /^[\w-]{1,128}$/.test(p.id) && typeof p.text === "string" && Buffer.byteLength(p.text) <= 1024 * 1024;
    case "bash.list": return Object.keys(p).every(key => key === "offset") && (p.offset === undefined || Number.isSafeInteger(p.offset) && Number(p.offset) >= 0);
    case "bash.status": case "bash.join": case "bash.stop": return exact(p, ["jobId"]) && typeof p.jobId === "string" && /^[A-Za-z0-9_-]{22}$/.test(p.jobId);
    case "bash.cancel-wait": return exact(p, ["invocationId"]) && typeof p.invocationId === "string" && /^[\w-]{1,128}$/.test(p.invocationId);
    case "spawn.join": case "spawn.stop": return exact(p, ["id"]) && typeof p.id === "string" && /^[\w-]{1,128}$/.test(p.id);
    default: return false;
  }
}
export type BashServiceResult = Exclude<BashControlResult, { kind: "bash_job_output" }> | { kind: "bash_wait_cancelled"; invocationId: string; cancelled: boolean };
export type OperationData = { bash?: BashServiceResult; mode?: string; changed?: boolean; sessionFile?: string; cwd?: string;
  workspaceId?: string; lifecycle?: string; integration?: string; commit?: string; reverts?: string; disposition?: "accepted"; status?: string; title?: string; enabled?: boolean; editorText?: string };
export type OperationResult = {
  version: 1; invocationId: string; runtimeId: string; sessionId: string; sessionFile: string;
  status: "completed" | "failed" | "uncertain"; data?: OperationData; code?: string; diagnostic?: string;
};
/** Each fixed command owns a typed payload and must explicitly report success.
 * Returning undefined means a pre-mutation refusal/cancellation, never `handled`
 * success. An exception is conservatively uncertain (possibly partial writes).
 */
type Payloads = { [O in BundledOperation as O["operation"]]: O["payload"] };
export function registerServiceOperation<O extends keyof Payloads>(pi: ExtensionAPI, operation: O,
  run: (payload: Payloads[O], ctx: ExtensionCommandContext, identity: { invocationId: string; runtimeId: string }) => Promise<OperationData | undefined>): void {
  if (process.env.PI_CONSOLE_SERVICE !== "1") return;
  pi.registerCommand(operationCommand(operation), { description: "Internal typed service operation", handler: async (args, ctx) => {
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
      const data = await run(v.payload as Payloads[O], ctx, identity);
      reply(data ? { status: "completed", data } : { status: "failed", code: "not_applied" });
    } catch (error) {
      const refused = !!error && typeof error === "object" && "bashTransitionBlocked" in error && error.bashTransitionBlocked === true;
      // Job adapters never launch or mutate project files. Invalid ownership,
      // output failures and wait cancellation must not poison the whole session.
      const observational = ["bash.list", "bash.status", "bash.join", "bash.stop", "bash.cancel-wait"].includes(operation);
      reply({ status: refused || observational ? "failed" : "uncertain", code: refused ? "bash_transition_blocked" : observational ? "bash_operation_failed" : "operation_uncertain",
        diagnostic: (error instanceof Error ? error.stack ?? error.message : String(error)).slice(0, 2048) });
    }
  } });
}
