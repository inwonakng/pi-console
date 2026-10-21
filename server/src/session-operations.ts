import type { RpcCommand } from "@earendil-works/pi-coding-agent";
import { object } from "./pi-records.js";

/** Application operations, not client-selected RPC types or command names. */
export type NativeOperation =
  | { operation: "model.set"; payload: { provider: string; modelId: string } }
  | { operation: "thinking.set"; payload: { level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" } }
  | { operation: "steering.mode" | "followUp.mode"; payload: { mode: "all" | "one-at-a-time" } }
  | { operation: "compaction.auto" | "retry.auto"; payload: { enabled: boolean } }
  | { operation: "retry.abort" | "shell.abort"; payload: Record<string, never> }
  | { operation: "compaction.run"; payload: { instructions: string } }
  | { operation: "steering.submit" | "followUp.submit"; payload: { text: string } }
  | { operation: "shell.run"; payload: { command: string; excludeFromContext: boolean } };

export const NATIVE_OPERATIONS = ["model.set", "thinking.set", "steering.mode", "followUp.mode", "compaction.auto", "retry.auto", "retry.abort", "shell.abort", "compaction.run", "steering.submit", "followUp.submit", "shell.run"] as const;
const exact = (p: Record<string, unknown>, keys: string[]) => Object.keys(p).length === keys.length && keys.every((key) => key in p);
const string = (v: unknown, max = 4096): v is string => typeof v === "string" && !!v.trim() && Buffer.byteLength(v) <= max;
export function validNative(operation: unknown, p: Record<string, unknown>): boolean {
  switch (operation) {
    case "model.set": return exact(p, ["provider", "modelId"]) && string(p.provider) && string(p.modelId);
    case "thinking.set": return exact(p, ["level"]) && typeof p.level === "string" && ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(p.level);
    case "steering.mode": case "followUp.mode": return exact(p, ["mode"]) && typeof p.mode === "string" && ["all", "one-at-a-time"].includes(p.mode);
    case "compaction.auto": case "retry.auto": return exact(p, ["enabled"]) && typeof p.enabled === "boolean";
    case "retry.abort": case "shell.abort": return exact(p, []);
    case "compaction.run": return exact(p, ["instructions"]) && typeof p.instructions === "string" && Buffer.byteLength(p.instructions) <= 65536;
    case "steering.submit": case "followUp.submit": return exact(p, ["text"]) && string(p.text, 1024 * 1024) && !p.text.trimStart().startsWith("/");
    case "shell.run": return exact(p, ["command", "excludeFromContext"]) && string(p.command, 1024 * 1024) && typeof p.excludeFromContext === "boolean";
    default: return false;
  }
}
export function nativeCommand(command: NativeOperation): RpcCommand {
  switch (command.operation) {
    case "model.set": return { type: "set_model", ...command.payload };
    case "thinking.set": return { type: "set_thinking_level", ...command.payload };
    case "steering.mode": return { type: "set_steering_mode", ...command.payload };
    case "followUp.mode": return { type: "set_follow_up_mode", ...command.payload };
    case "compaction.auto": return { type: "set_auto_compaction", ...command.payload };
    case "retry.auto": return { type: "set_auto_retry", ...command.payload };
    case "retry.abort": return { type: "abort_retry" };
    case "shell.abort": return { type: "abort_bash" };
    case "compaction.run": return { type: "compact", customInstructions: command.payload.instructions };
    case "steering.submit": return { type: "steer", message: command.payload.text };
    case "followUp.submit": return { type: "follow_up", message: command.payload.text };
    case "shell.run": return { type: "bash", ...command.payload };
  }
}
export function isNative(value: { operation: string }): value is NativeOperation { return (NATIVE_OPERATIONS as readonly string[]).includes(value.operation); }
export const SESSION_READS = ["models", "thinking", "entries", "tree", "stats", "forkMessages"] as const;
export type SessionRead = typeof SESSION_READS[number];
export function readCommand(kind: unknown): RpcCommand | undefined {
  switch (kind) {
    case "models": return { type: "get_available_models" };
    case "thinking": return { type: "get_available_thinking_levels" };
    case "entries": return { type: "get_entries" };
    case "tree": return { type: "get_tree" };
    case "stats": return { type: "get_session_stats" };
    case "forkMessages": return { type: "get_fork_messages" };
  }
}
export function validRead(value: unknown): value is { kind: SessionRead; runtimeRevision: number } {
  return object(value) && exact(value, ["kind", "runtimeRevision"]) && (SESSION_READS as readonly unknown[]).includes(value.kind)
    && Number.isSafeInteger(value.runtimeRevision) && Number(value.runtimeRevision) >= 0;
}
