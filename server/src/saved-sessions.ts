import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiProcess, type PiProcessOptions } from "./pi-process.js";
import { object } from "./pi-records.js";

export class SavedHelperUnresolved extends Error {}

export type SavedPreview = { success: true; version: string; archiveBlocked: boolean; mode: "trash" | "permanent";
  workspaces: { id: string; label: string; retained: boolean; worktreePath: string; resultPatchPath: string }[] };
export type SavedResult = SavedPreview | { success: true; deleted: true; mode: "trash" | "permanent" }
  | { success: false; mutated: boolean; error: string };

type HelperOptions = Omit<PiProcessOptions, "onEvent" | "onExit" | "cwd" | "session">;
type SavedPayload = { action: "preview" | "delete"; sessionId: string; expectedVersion?: string; mode?: string; confirmed?: true };
type CleanupPayload = { action: "cleanup"; cutoff: number; protectedSessions: string[]; protectedCwds: string[] };
export type CleanupResult = { success: true; workspaces: number; runs: number; failed: number } | Extract<SavedResult, { success: false }>;

/** Reuse the bounded, drained, managed Pi transport with a fixed unsaved helper.
 * The helper only loads the existing workspace primitives, never conversation UI. */
export function savedSessionHelper(options: HelperOptions, payload: SavedPayload): Promise<SavedResult>;
export function savedSessionHelper(options: HelperOptions, payload: CleanupPayload): Promise<CleanupResult>;
export async function savedSessionHelper(options: HelperOptions, payload: SavedPayload | CleanupPayload): Promise<SavedResult | CleanupResult> {
  const directory = await mkdtemp(join(tmpdir(), "pi-saved-"));
  let worker: PiProcess | undefined;
  let result: SavedResult | CleanupResult | undefined;
  try {
    worker = new PiProcess({ ...options, cwd: directory, session: { id: "sessionId" in payload ? payload.sessionId : "workspace-cleanup" }, savedSessionHelper: true,
      environment: { ...options.environment, PI_CODING_AGENT_DIR: directory, PI_CONSOLE_SAVED_SESSION_DIR: options.sessionDirectory },
      onExit: () => {}, onEvent: event => {
        if (event.type === "extension_ui_request" && event.method === "setStatus" && event.statusKey === "pi-saved-session-result") {
          if (result) throw new Error("Duplicate saved-session result");
          const data: unknown = JSON.parse(event.statusText ?? "null");
          if (!object(data) || typeof data.success !== "boolean" || !data.success && (typeof data.error !== "string" || typeof data.mutated !== "boolean")
            || data.success && (payload.action === "cleanup"
              ? !["workspaces", "runs", "failed"].every(key => Number.isSafeInteger(data[key]) && Number(data[key]) >= 0)
              : data.mode !== "trash" && data.mode !== "permanent"
                || !(data.deleted === true || typeof data.version === "string" && /^[a-f0-9]{64}$/.test(data.version)
                  && typeof data.archiveBlocked === "boolean" && Array.isArray(data.workspaces) && data.workspaces.length <= 128
                  && data.workspaces.every(workspace => object(workspace) && typeof workspace.retained === "boolean"
                    && ["id", "label", "worktreePath", "resultPatchPath"].every(key => typeof workspace[key] === "string"))))) throw new Error("Invalid saved-session result");
          result = data as SavedResult | CleanupResult;
        }
      } });
    const commands = await worker.request({ type: "get_commands" });
    if (commands.command !== "get_commands" || !commands.data.commands.some(command => command.name === "pi-saved-session"
      && command.source === "extension" && command.sourceInfo?.path === join(options.appRoot, "pi", "scripts", "saved-sessions.ts"))) throw new Error("Missing fixed saved-session helper capability");
    const response = await worker.request({ type: "prompt", message: "/pi-saved-session " + JSON.stringify(payload) });
    if (response.command !== "prompt" || response.data?.disposition !== "handled" || !result) throw new Error("Saved-session helper outcome is unproven; inspect before any new request");
    return result;
  } finally {
    if (worker) {
      try {
        const exit = await worker.stop();
        if (exit.descendantsUnresolved) throw new SavedHelperUnresolved("Saved-session helper cleanup is unresolved; retain the service lock and explicitly reconcile before further execution");
      } catch (error) { throw new SavedHelperUnresolved("Saved-session helper execution/cleanup is unresolved", { cause: error }); }
    }
    await rm(directory, { recursive: true, force: true });
  }
}
