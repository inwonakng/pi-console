import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiProcess, type PiProcessOptions } from "./pi-process.js";
import { object } from "./pi-records.js";

export class SavedHelperUnresolved extends Error {}

export type SavedPreview = { success: true; version: string; archiveBlocked: boolean; mode: "trash" | "permanent";
  workspaces: { id: string; label: string; retained: boolean; worktreePath: string; resultPatchPath: string }[] };
type SavedFailure = { success: false; mutated: boolean; error: string };
export type SavedResult = SavedPreview | { success: true; deleted: true; mode: "trash" | "permanent" } | SavedFailure;
export type SavedBatchResult = { success: true; sessions: { sessionId: string; result: SavedPreview | SavedFailure }[] } | SavedFailure;

type HelperOptions = Omit<PiProcessOptions, "onEvent" | "onExit" | "cwd" | "session">;
type SavedPayload = { action: "preview" | "delete"; sessionId: string; expectedVersion?: string; mode?: string; confirmed?: true };
type BatchPayload = { action: "previews"; sessionIds: string[] };
type CleanupPayload = { action: "cleanup"; cutoff: number; protectedSessions: string[]; protectedCwds: string[] };
export type CleanupResult = { success: true; workspaces: number; runs: number; failed: number } | SavedFailure;
export type SavedSessionRequest = {
  (payload: SavedPayload): Promise<SavedResult>;
  (payload: BatchPayload): Promise<SavedBatchResult>;
  (payload: CleanupPayload): Promise<CleanupResult>;
};

function validFailure(data: Record<string, unknown>): boolean {
  return data.success === false && typeof data.error === "string" && typeof data.mutated === "boolean";
}
function validPreview(data: Record<string, unknown>): boolean {
  return data.success === true && (data.mode === "trash" || data.mode === "permanent")
    && typeof data.version === "string" && /^[a-f0-9]{64}$/.test(data.version)
    && typeof data.archiveBlocked === "boolean" && Array.isArray(data.workspaces) && data.workspaces.length <= 128
    && data.workspaces.every(workspace => object(workspace) && typeof workspace.retained === "boolean"
      && ["id", "label", "worktreePath", "resultPatchPath"].every(key => typeof workspace[key] === "string"));
}

/** One bounded operation owns the helper, including its drained managed cleanup.
 * Requests are sequential; no helper survives its operation or admission lane. */
export async function withSavedSessionHelper<T>(options: HelperOptions, run: (request: SavedSessionRequest) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "pi-saved-"));
  let worker: PiProcess | undefined;
  let pending: SavedPayload | BatchPayload | CleanupPayload | undefined;
  let result: SavedResult | SavedBatchResult | CleanupResult | undefined;
  try {
    const helper = worker = new PiProcess({ ...options, cwd: directory, session: { id: "saved-session-helper" }, savedSessionHelper: true,
      environment: { ...options.environment, PI_CODING_AGENT_DIR: directory, PI_CONSOLE_SAVED_SESSION_DIR: options.sessionDirectory },
      onExit: () => {}, onEvent: event => {
        if (event.type === "extension_ui_request" && event.method === "setStatus" && event.statusKey === "pi-saved-session-result") {
          if (!pending || result) throw new Error("Unexpected or duplicate saved-session result");
          const data: unknown = JSON.parse(event.statusText ?? "null");
          if (!object(data) || !(validFailure(data) || data.success === true && (pending.action === "cleanup"
            ? ["workspaces", "runs", "failed"].every(key => Number.isSafeInteger(data[key]) && Number(data[key]) >= 0)
            : pending.action === "previews"
              ? Array.isArray(data.sessions) && data.sessions.length === pending.sessionIds.length
                && data.sessions.every((entry, index) => object(entry) && pending?.action === "previews"
                  && entry.sessionId === pending.sessionIds[index] && object(entry.result) && (validPreview(entry.result) || validFailure(entry.result)))
              : pending.action === "preview" ? validPreview(data)
                : data.deleted === true && (data.mode === "trash" || data.mode === "permanent")))) throw new Error("Invalid saved-session result");
          result = data as SavedResult | SavedBatchResult | CleanupResult;
        }
      } });
    const commands = await helper.request({ type: "get_commands" });
    if (commands.command !== "get_commands" || !commands.data.commands.some(command => command.name === "pi-saved-session"
      && command.source === "extension" && command.sourceInfo?.path === join(options.appRoot, "pi", "scripts", "saved-sessions.ts"))) throw new Error("Missing fixed saved-session helper capability");
    const request = async (payload: SavedPayload | BatchPayload | CleanupPayload) => {
      if (pending) throw new Error("Saved-session helper requests must be sequential");
      pending = payload;
      result = undefined;
      try {
        const response = await helper.request({ type: "prompt", message: "/pi-saved-session " + JSON.stringify(payload) });
        if (response.command !== "prompt" || response.data?.disposition !== "handled" || !result) throw new Error("Saved-session helper outcome is unproven; inspect before any new request");
        return result;
      } finally { pending = undefined; }
    };
    return await run(request as SavedSessionRequest);
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

export function savedSessionHelper(options: HelperOptions, payload: SavedPayload): Promise<SavedResult>;
export function savedSessionHelper(options: HelperOptions, payload: CleanupPayload): Promise<CleanupResult>;
export function savedSessionHelper(options: HelperOptions, payload: SavedPayload | CleanupPayload): Promise<SavedResult | CleanupResult> {
  return withSavedSessionHelper<SavedResult | CleanupResult>(options, request => payload.action === "cleanup" ? request(payload) : request(payload));
}
