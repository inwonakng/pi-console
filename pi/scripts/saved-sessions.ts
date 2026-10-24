// Fixed owner-only helper. No conversation, provider calls, or host editor UI.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { constants, accessSync, lstatSync, openSync, closeSync, fstatSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { delimiter, join, resolve } from "node:path";
import { removeWorkspace, sameSessionFile, sessionWorkspacesForDeletion } from "../extensions/shared/workspace";

function trashCommand(): string[] | undefined {
  for (const [binary, args] of [["trash", []], ["gio", ["trash"]]] as const) {
    for (const directory of (process.env.PATH ?? "").split(delimiter)) {
      if (!directory) continue;
      const path = join(directory, binary);
      try { accessSync(path, constants.X_OK); return [path, ...args]; } catch { /* next host executable */ }
    }
  }
}
function linked(path: string) {
  return sessionWorkspacesForDeletion([path]);
}
function stamp(path: string): string {
  const info = lstatSync(path, { bigint: true });
  if (!info.isFile() || info.nlink !== 1n || info.uid !== BigInt(process.getuid!()) || (info.mode & 0o077n) !== 0n) throw new Error("Invalid managed session file");
  return [info.dev, info.ino, info.mode, info.size, info.mtimeNs, info.ctimeNs].join(":");
}
function preview(path: string) {
  const fileVersion = stamp(path);
  const records = linked(path);
  if (records.length > 128) throw new Error("Too many linked workspaces");
  const command = trashCommand();
  const mode = command ? "trash" : "permanent";
  const version = createHash("sha256").update(JSON.stringify([fileVersion, records, command])).digest("hex");
  return { version, fileVersion, mode, command, archiveBlocked: records.some(record => record.retained && (sameSessionFile(record.sourceSessionFile, path) || record.kind === "child")), workspaces: records.map(record => ({ id: record.id, label: record.label,
    retained: record.retained, worktreePath: record.worktreePath, resultPatchPath: record.resultPatchPath })) };
}
export default function savedSessions(pi: ExtensionAPI) {
  if (process.env.PI_CONSOLE_SERVICE !== "1") return;
  pi.registerCommand("pi-saved-session", {
    description: "Owner-only saved session preview and confirmed deletion",
    handler: async (args, ctx) => {
      let mutated = false;
      try {
        const input: unknown = JSON.parse(args);
        if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid saved-session request");
        const p = input as Record<string, unknown>;
        // Session paths are derived from the catalog by the owner, never forwarded from a frontend.
        const directory = process.env.PI_CONSOLE_SAVED_SESSION_DIR;
        if (!directory || typeof p.sessionId !== "string" || !/^[\w-]{1,128}$/.test(p.sessionId)
          || typeof p.action !== "string" || !["preview", "delete"].includes(p.action)
          || Object.keys(p).some(key => !["action", "sessionId", "expectedVersion", "mode", "confirmed"].includes(key))) throw new Error("Invalid saved-session request");
        const path = join(resolve(directory), p.sessionId + ".jsonl");
        const current = preview(path);
        if (p.action === "preview") {
          const { command: _command, fileVersion: _fileVersion, ...data } = current;
          ctx.ui.setStatus("pi-saved-session-result", JSON.stringify({ success: true, ...data }));
          return;
        }
        if (p.confirmed !== true || p.expectedVersion !== current.version || p.mode !== current.mode) throw new Error("Saved session or linked workspaces changed while confirming; select it again.");
        // Recovery patches remain in the workspace store, including after partial cleanup.
        // Copied/ignored files have the same explicit loss warning as the legacy picker.
        const records = linked(path);
        mutated = records.length > 0;
        if (stamp(path) !== current.fileVersion) throw new Error("Session file changed during workspace preparation; kept.");
        const ids = records.map(record => record.id).sort();
        if (JSON.stringify(linked(path).map(record => record.id).sort()) !== JSON.stringify(ids)) throw new Error("Linked workspaces changed during preparation; session file kept.");
        for (const record of records) {
          const removed = await removeWorkspace(record.id, record.integration === "applied" || record.integration === "none" ? "integrated" : "discarded", true);
          if (removed.lifecycle === "cleanup_failed") throw new Error(`Could not remove ${record.label}; session file kept. Earlier cleanup may have succeeded. ${removed.integrationReason ?? ""}`);
        }
        if (linked(path).length || stamp(path) !== current.fileVersion) throw new Error("Session/workspaces changed during cleanup; session file kept.");
        // No await between the final inode check and filesystem mutation.
        const file = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const info = fstatSync(file, { bigint: true });
          if ([info.dev, info.ino, info.mode, info.size, info.mtimeNs, info.ctimeNs].join(":") !== current.fileVersion) throw new Error("Session file replaced; kept.");
          mutated = true;
          if (current.command) execFileSync(current.command[0], [...current.command.slice(1), path], { stdio: "pipe", timeout: 10000 });
          else unlinkSync(path);
          try { lstatSync(path); throw new Error("Trash command left the session file in place"); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        } finally { closeSync(file); }
        ctx.ui.setStatus("pi-saved-session-result", JSON.stringify({ success: true, deleted: true, mode: current.mode }));
      } catch (error) {
        ctx.ui.setStatus("pi-saved-session-result", JSON.stringify({ success: false, mutated, error: error instanceof Error ? error.message : String(error) }));
      }
    },
  });
}
