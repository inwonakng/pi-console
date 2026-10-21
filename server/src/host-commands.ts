import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { CommandError } from "./session-commands.js";
import { object } from "./pi-records.js";

export type HostCommand = { id: string; serviceEpoch: string } & (
  | { operation: "host.create"; payload: { cwd: string } }
  | { operation: "host.resume"; payload: { sessionId: string } }
);
export type HostReceipt = {
  id: string; serviceEpoch: string; operation: HostCommand["operation"];
  status: "accepted" | "completed" | "failed" | "uncertain";
  result?: { sessionId: string }; error?: { code: string; message: string };
};
export const identifier = (value: unknown): value is string => typeof value === "string" && /^[\w-]{1,128}$/.test(value);
export function hostCommand(value: unknown): HostCommand {
  if (!object(value) || !identifier(value.id) || !identifier(value.serviceEpoch) || !object(value.payload)
    || Object.keys(value).some((key) => !["id", "serviceEpoch", "operation", "payload"].includes(key))) {
    throw new CommandError("invalid_command", "Invalid host command");
  }
  const p = value.payload;
  if (value.operation === "host.create" ? Object.keys(p).length !== 1 || typeof p.cwd !== "string" || !isAbsolute(p.cwd) || Buffer.byteLength(p.cwd) > 4096
    : value.operation === "host.resume" ? Object.keys(p).length !== 1 || !identifier(p.sessionId) : true) {
    throw new CommandError("unsupported_command", "Only typed host.create/host.resume are supported");
  }
  return value as HostCommand;
}
export function hostFingerprint(command: HostCommand): string {
  return createHash("sha256").update(JSON.stringify([command.serviceEpoch, command.operation,
    command.operation === "host.create" ? command.payload.cwd : command.payload.sessionId])).digest("hex");
}
