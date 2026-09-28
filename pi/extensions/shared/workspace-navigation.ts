import type { ExtensionCommandContext, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { getPendingWorkspaceId, loadWorkspace, setExpectedWorkspaceMissing, setPendingWorkspace, type WorkspaceRecord } from "./workspace";
import { hasRunningSubagents } from "../spawn";

const LOCATION_ENTRY = "pi-workspace-location";
const CURSOR_ENTRY = "pi-workspace-cursor";

type Location = { cwd: string; workspace?: WorkspaceRecord };
type MoveContext = ExtensionCommandContext & {
  sendMessage(message: { customType: string; content: string; display: boolean }, options: { triggerTurn: boolean }): Promise<void>;
};

export function locationForEntry(ctx: ExtensionContext, entryId: string | null): Location {
  const branch = entryId === null ? [] : ctx.sessionManager.getBranch(entryId);
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (entry.type !== "custom" || entry.customType !== LOCATION_ENTRY) continue;
    const data = entry.data as { workspaceId?: string } | undefined;
    if (data?.workspaceId) {
      const workspace = loadWorkspace(data.workspaceId);
      if (!workspace || !workspace.retained || !existsSync(workspace.worktreePath)) {
        throw new Error(`Workspace ${data.workspaceId} is no longer available. Its history can be viewed, but not resumed there.`);
      }
      return { cwd: workspace.workspaceCwd, workspace };
    }
    break;
  }
  const cwd = ctx.sessionManager.getHeader()?.cwd;
  if (!cwd || !existsSync(cwd)) throw new Error(`Original checkout is unavailable: ${cwd ?? "unknown"}`);
  return { cwd };
}

export function activeLocation(ctx: ExtensionContext): Location {
  return locationForEntry(ctx, ctx.sessionManager.getLeafId());
}

/** Change Pi's cwd-bound runtime without forking its session. The cursor survives a later reopen. */
export async function moveToLocation(
  ctx: ExtensionCommandContext,
  cwd: string,
  leafId: string | null,
  options: { workspaceId?: string; workspaceLabel?: string; markLocation?: boolean; navigateTo?: string; reload?: boolean; saveCursor?: boolean; continueWith?: string; onArrival?: (ctx: ExtensionCommandContext) => void } = {},
): Promise<boolean> {
  if (leafId !== null && !options.reload && !ctx.sessionManager.getEntry(leafId)) throw new Error(`Unknown session entry: ${leafId}`);
  const file = ctx.sessionManager.getSessionFile();
  if (!file) throw new Error("Workspace switching requires a persisted session.");
  if (!existsSync(cwd)) throw new Error(`Working directory is unavailable: ${cwd}`);
  if ((ctx.cwd !== cwd || options.reload) && ctx.mode !== "rpc"
    && (ctx.cwd !== cwd || ctx.sessionManager.getHeader()?.cwd !== ctx.cwd)) {
    throw new Error("Changing the workspace cwd requires Pi RPC mode; this Pi host does not forward cwdOverride.");
  }
  if ((ctx.cwd !== cwd || options.reload) && hasRunningSubagents()) {
    throw new Error("Wait for running subagents before switching workspaces; replacing Pi's runtime would abort them.");
  }
  const arrival = async (nextCtx: ExtensionCommandContext, sendMessage?: MoveContext["sendMessage"]) => {
    if (options.navigateTo) {
      const result = await nextCtx.navigateTree(options.navigateTo);
      if (result.cancelled) throw new Error("Workspace navigation was cancelled.");
    } else if (leafId === null) {
      nextCtx.sessionManager.resetLeaf();
    } else if (nextCtx.sessionManager.getLeafId() !== leafId) {
      // Call Pi's navigation API to restore the finalized model context, not just the JSONL leaf.
      const result = await nextCtx.navigateTree(leafId);
      if (result.cancelled) throw new Error("Workspace navigation was cancelled.");
    }
    if (options.markLocation) {
      nextCtx.sessionManager.appendCustomEntry(LOCATION_ENTRY, {
        workspaceId: options.workspaceId ?? null,
        label: options.workspaceLabel ?? "Origin checkout",
        cwd,
      });
    } else if (options.saveCursor !== false) {
      nextCtx.sessionManager.appendCustomEntry(CURSOR_ENTRY, {});
    }
    setExpectedWorkspaceMissing(undefined);
    options.onArrival?.(nextCtx);
    if (options.continueWith) {
      if (!sendMessage) throw new Error("The switched session cannot resume the agent.");
      await sendMessage({ customType: "workspace-continuation", content: options.continueWith, display: false }, { triggerTurn: true });
    }
  };
  if (ctx.cwd === cwd && !options.reload) {
    await arrival(ctx);
    return true;
  }
  // Pi's runtime supports cwdOverride in RPC mode; the extension-context type omits it.
  const switchWithCwd = ctx.switchSession as (path: string, options: {
    cwdOverride: string;
    withSession: (nextCtx: MoveContext) => Promise<void>;
  }) => Promise<{ cancelled: boolean }>;
  const ownsPending = !getPendingWorkspaceId();
  if (ownsPending) setPendingWorkspace("navigation");
  try {
    const result = await switchWithCwd(file, {
      cwdOverride: cwd,
      withSession: async (nextCtx) => arrival(nextCtx, nextCtx.sendMessage.bind(nextCtx)),
    });
    return !result.cancelled;
  } finally {
    if (ownsPending) setPendingWorkspace(undefined);
  }
}

export function locationEntry(entry: SessionEntry): boolean {
  return entry.type === "custom" && entry.customType === LOCATION_ENTRY;
}

export function workspaceIdAt(ctx: ExtensionContext, entryId: string | null): string | undefined {
  const branch = entryId === null ? [] : ctx.sessionManager.getBranch(entryId);
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (!locationEntry(entry)) continue;
    return (entry.data as { workspaceId?: string } | undefined)?.workspaceId;
  }
  return undefined;
}
