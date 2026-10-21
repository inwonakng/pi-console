import { object } from "./pi-records.js";

/** Private bundled protocol, not a generic extension-command tunnel. */
export const RENAME_COMMAND = "pi-console-rename";
export const RENAME_RESULT = "pi-console-rename-result";

// Keep these input bounds in step with the bundled managed rename handler.
export function validRenameTitle(value: unknown): value is string {
  return typeof value === "string" && !!value.trim() && Buffer.byteLength(value) <= 4096
    && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value);
}
export function validEffectiveTitle(value: unknown): value is string {
  return validRenameTitle(value) && value === value.trim() && value.length <= 80;
}

type Identity = { version: 1; invocationId: string; runtimeId: string; sessionId: string; sessionFile: string };
export type RenameResult = Identity & (
  | { status: "completed"; title: string }
  | { status: "failed"; code: "invalid_title" | "context_unavailable" }
  | { status: "uncertain"; code: "mutation_failed" }
);

export function renameResult(text: string | undefined): RenameResult {
  if (typeof text !== "string" || Buffer.byteLength(text) > 16384) throw new Error("Invalid managed rename result");
  const value: unknown = JSON.parse(text);
  if (!object(value) || value.version !== 1
    || ![value.invocationId, value.runtimeId, value.sessionId, value.sessionFile].every((part) => typeof part === "string" && !!part)
    || !Object.keys(value).every((key) => ["version", "invocationId", "runtimeId", "sessionId", "sessionFile", "status",
      value.status === "completed" ? "title" : "code"].includes(key))) throw new Error("Invalid managed rename result");
  if (value.status === "completed" ? !validEffectiveTitle(value.title)
    : value.status === "failed" ? typeof value.code !== "string" || !["invalid_title", "context_unavailable"].includes(value.code)
      : value.status !== "uncertain" || value.code !== "mutation_failed") throw new Error("Invalid managed rename outcome");
  return value as RenameResult;
}
