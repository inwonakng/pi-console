import { createHash } from "node:crypto";
import { identifier } from "./host-commands.js";
import { object } from "./pi-records.js";
import { validBundled, type BundledOperation } from "./session-bundled.js";
import { CommandError, commandFingerprint } from "./session-commands.js";

export type ManagementOperation = Extract<BundledOperation, { operation: "access.set" | "access.cycle" | "integration.set" | "integration.cycle" | "notifications.set" }>
  | { operation: "session.kill"; payload: { confirmed: true } }
  | { operation: "turn.abort"; payload: Record<string, never> };
export type ManagementCommand = { version: 1; id: string; sessionId: string; serviceEpoch: string; runtimeRevision: number } & ManagementOperation;
const settings = new Set(["access.set", "access.cycle", "integration.set", "integration.cycle", "notifications.set"]);

/** Authenticated session management, settings and interruption without control transfer. */
export function managementCommand(value: unknown): ManagementCommand {
  if (!object(value) || value.version !== 1 || !identifier(value.id) || !identifier(value.sessionId)
    || !identifier(value.serviceEpoch) || !Number.isSafeInteger(value.runtimeRevision) || (value.runtimeRevision as number) < 0
    || !object(value.payload) || Object.keys(value).some((key) => !["version", "id", "sessionId", "serviceEpoch", "runtimeRevision", "operation", "payload"].includes(key))
    || !(value.operation === "session.kill"
      ? Object.keys(value.payload).length === 1 && value.payload.confirmed === true
      : value.operation === "turn.abort" ? Object.keys(value.payload).length === 0
      : typeof value.operation === "string" && settings.has(value.operation) && validBundled(value.operation, value.payload))) {
    throw new CommandError("invalid_command", "Invalid session management request");
  }
  return structuredClone(value) as ManagementCommand;
}

export function managementFingerprint(command: ManagementCommand): string {
  return createHash("sha256").update("management:" + commandFingerprint(command)).digest("hex");
}
