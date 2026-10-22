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

/** Reuse the bounded, drained, managed Pi transport with a fixed unsaved helper.
 * The helper only loads the existing workspace primitives, never conversation UI. */
export async function savedSessionHelper(options: Omit<PiProcessOptions, "onEvent" | "onExit" | "cwd" | "session">,
  payload: { action: "preview" | "delete"; sessionId: string; expectedVersion?: string; mode?: string; confirmed?: true }): Promise<SavedResult> {
  const directory = await mkdtemp(join(tmpdir(), "pi-saved-"));
  let worker: PiProcess | undefined;
  let result: SavedResult | undefined;
  try {
    worker = new PiProcess({ ...options, cwd: directory, session: { id: payload.sessionId }, savedSessionHelper: true,
      environment: { ...options.environment, PI_CODING_AGENT_DIR: directory, PI_CONSOLE_SAVED_SESSION_DIR: options.sessionDirectory },
      onExit: () => {}, onEvent: event => {
        if (event.type === "extension_ui_request" && event.method === "setStatus" && event.statusKey === "pi-saved-session-result") {
          if (result) throw new Error("Duplicate saved-session result");
          const data: unknown = JSON.parse(event.statusText ?? "null");
          if (!object(data) || typeof data.success !== "boolean" || !data.success && (typeof data.error !== "string" || typeof data.mutated !== "boolean")
            || data.success && (data.mode !== "trash" && data.mode !== "permanent"
              || !(data.deleted === true || typeof data.version === "string" && /^[a-f0-9]{64}$/.test(data.version)
                && typeof data.archiveBlocked === "boolean" && Array.isArray(data.workspaces) && data.workspaces.length <= 128
                && data.workspaces.every(workspace => object(workspace) && typeof workspace.retained === "boolean"
                  && ["id", "label", "worktreePath", "resultPatchPath"].every(key => typeof workspace[key] === "string"))))) throw new Error("Invalid saved-session result");
          result = data as SavedResult;
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
        if (exit.descendantsUnresolved) throw new SavedHelperUnresolved("Saved-session helper cleanup is unresolved; retain the owner claim and explicitly reconcile before further execution");
      } catch (error) { throw new SavedHelperUnresolved("Saved-session helper execution/cleanup is unresolved", { cause: error }); }
    }
    await rm(directory, { recursive: true, force: true });
  }
}
