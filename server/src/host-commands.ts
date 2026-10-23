import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { CommandError } from "./session-commands.js";
import { object } from "./pi-records.js";

export type HostCommand = { id: string; serviceEpoch: string } & (
  | { operation: "host.create"; payload: { cwd: string } }
  | { operation: "host.resume"; payload: { sessionId: string } }
  | { operation: "host.recover"; payload: { sessionId: string } }
  | { operation: "host.archive"; payload: { sessionId: string; expectedVersion: string; archived: boolean; confirmed: true } }
  | { operation: "host.delete"; payload: { sessionId: string; expectedVersion: string; mode: "trash" | "permanent"; confirmed: true } }
);
export type HostReceipt = {
  id: string; serviceEpoch: string; operation: HostCommand["operation"];
  status: "accepted" | "completed" | "failed" | "uncertain";
  result?: { sessionId: string; archived?: boolean; deleted?: true; mode?: "trash" | "permanent" }; error?: { code: string; message: string };
};
export const identifier = (value: unknown): value is string => typeof value === "string" && /^[\w-]{1,128}$/.test(value);
export function hostCommand(value: unknown): HostCommand {
  if (!object(value) || !identifier(value.id) || !identifier(value.serviceEpoch) || !object(value.payload)
    || Object.keys(value).some((key) => !["id", "serviceEpoch", "operation", "payload"].includes(key))) {
    throw new CommandError("invalid_command", "Invalid host command");
  }
  const p = value.payload;
  if (value.operation === "host.create" ? Object.keys(p).length !== 1 || typeof p.cwd !== "string" || !isAbsolute(p.cwd) || Buffer.byteLength(p.cwd) > 4096
    : value.operation === "host.resume" || value.operation === "host.recover" ? Object.keys(p).length !== 1 || !identifier(p.sessionId)
    : value.operation === "host.archive" || value.operation === "host.delete"
      ? Object.keys(p).length !== 4 || !identifier(p.sessionId) || typeof p.expectedVersion !== "string" || !/^[a-f0-9]{64}$/.test(p.expectedVersion)
        || p.confirmed !== true || (value.operation === "host.archive" ? typeof p.archived !== "boolean" || !("archived" in p)
          : !["trash", "permanent"].includes(String(p.mode)))
    : true) {
    throw new CommandError("unsupported_command", "Invalid typed host operation or missing confirmation");
  }
  return value as HostCommand;
}
export function hostFingerprint(command: HostCommand): string {
  return createHash("sha256").update(JSON.stringify([command.serviceEpoch, command.operation,
    command.operation === "host.create" ? [command.payload.cwd] : command.operation === "host.resume" || command.operation === "host.recover" ? [command.payload.sessionId]
      : command.operation === "host.archive" ? [command.payload.sessionId, command.payload.expectedVersion, command.payload.archived, command.payload.confirmed]
      : [command.payload.sessionId, command.payload.expectedVersion, command.payload.mode, command.payload.confirmed]])).digest("hex");
}
