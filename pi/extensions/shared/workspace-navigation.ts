import type { ExtensionCommandContext, ExtensionContext, SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { assertManagedResources } from "../../scripts/managed-process.mjs";
import { beginWorkspaceContinuation, clearWorkspaceContinuation, getWorkspaceContinuation, getWorkspaceTransitionError, getPendingWorkspaceId, loadWorkspace, setExpectedWorkspaceMissing, setPendingWorkspace, setWorkspaceTransitionError, workspaceDisplayState, WORKSPACE_CONTINUATION_STATUS, type WorkspaceRecord } from "./workspace";
import { hasRunningSubagents, subagentHistoryBlockReason } from "./subagent-state";
import { prepareProjectTrust, projectTrustReady } from "./project-trust";
import { modelReady, preserveModelForSwitch } from "./model-readiness";

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

export function publishWorkspaceState(ctx: ExtensionContext): void {
  const state = {
    ...workspaceDisplayState(ctx.cwd, ctx.sessionManager.getSessionFile()),
    transitionPending: getPendingWorkspaceId() !== undefined,
    transitionError: getWorkspaceTransitionError(ctx.sessionManager.getSessionFile()),
  };
  const branch = state.branch ? ` (${state.branch})` : "";
  ctx.ui.setStatus(
    "pi-workspace",
    ctx.mode === "rpc" ? JSON.stringify(state) : `Workspace: ${state.name}${branch}`,
  );
  if (ctx.mode === "rpc") {
    ctx.ui.setStatus(WORKSPACE_CONTINUATION_STATUS, getWorkspaceContinuation(ctx.sessionManager.getSessionFile())?.phase);
  }
}

/** Change Pi's cwd-bound runtime without forking its session. The cursor survives a later reopen. */
export async function moveToLocation(
  ctx: ExtensionCommandContext,
  cwd: string,
  leafId: string | null,
  options: { workspaceId?: string; workspaceLabel?: string; markLocation?: boolean; navigateTo?: string; reload?: boolean; saveCursor?: boolean; continueWith?: string; beforeSwitch?: () => void | Promise<void>; onArrival?: (ctx: ExtensionCommandContext) => void | Promise<void> } = {},
): Promise<boolean> {
  const file = ctx.sessionManager.getSessionFile();
  if (!file) throw new Error("Workspace switching requires a persisted session.");
  const pendingWorkspaceId = getPendingWorkspaceId();
  const ownsPending = (ctx.cwd !== cwd || options.reload === true) && !pendingWorkspaceId;
  const previousCwd = ctx.cwd;
  const previousModel = ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined;
  const continuation = options.continueWith ? getWorkspaceContinuation(file) ?? beginWorkspaceContinuation(file) : undefined;
  let currentCtx = ctx;
  // Captured UI methods can report closure even if runtime creation leaves no live ctx.
  const rpcUi = ctx.mode === "rpc" ? ctx.ui : undefined;
  const releaseContinuation = () => {
    if (continuation && getWorkspaceContinuation(file) === continuation) {
      clearWorkspaceContinuation(continuation);
      rpcUi?.setStatus(WORKSPACE_CONTINUATION_STATUS, undefined);
    }
  };
  const arrival = async (nextCtx: ExtensionCommandContext, sendMessage?: MoveContext["sendMessage"]) => {
    currentCtx = nextCtx;
    const manager = nextCtx.sessionManager as SessionManager;
    try {
      if (options.navigateTo) {
        const result = await nextCtx.navigateTree(options.navigateTo);
        if (result.cancelled) throw new Error("Workspace navigation was cancelled.");
      } else if (leafId === null) {
        manager.resetLeaf();
      } else if (manager.getLeafId() !== leafId) {
        // Restore finalized transcript context through Pi's navigation API.
        const result = await nextCtx.navigateTree(leafId);
        if (result.cancelled) throw new Error("Workspace navigation was cancelled.");
      }
      if (options.markLocation) {
        manager.appendCustomEntry(LOCATION_ENTRY, {
          workspaceId: options.workspaceId ?? null,
          label: options.workspaceLabel ?? "Origin checkout",
          cwd,
        });
      } else if (options.saveCursor !== false) {
        manager.appendCustomEntry(CURSOR_ENTRY, {});
      }
      setExpectedWorkspaceMissing(undefined);
      await options.onArrival?.(nextCtx);
    } finally {
      if (ownsPending) {
        setPendingWorkspace(undefined);
        publishWorkspaceState(nextCtx);
      }
    }
    const selected = nextCtx.model;
    const registered = selected && selected.provider !== "unknown" && selected.id !== "unknown" && selected.api !== "unknown"
      ? nextCtx.modelRegistry.find(selected.provider, selected.id) : undefined;
    const configured = registered ? nextCtx.modelRegistry.hasConfiguredAuth(registered) : false;
    const blocked = !!options.continueWith && !modelReady(nextCtx);
    manager.appendCustomEntry("pi-workspace-runtime", {
      version: 1, previousCwd, cwd: nextCtx.cwd, previousModel,
      model: selected ? { provider: selected.provider, id: selected.id } : undefined,
      registered: !!registered, configured,
      continuation: options.continueWith ? blocked ? "blocked" : "ready" : "none",
    });
    if (blocked) {
      releaseContinuation();
      nextCtx.ui.notify("Workspace switch completed, but automatic continuation stopped because the selected model is unavailable or its provider is not configured. Select a valid model (in pi-console: <leader>m), then explicitly continue. No prompt was sent or queued.", "error");
      return;
    }
    if (options.continueWith && continuation) {
      if (!sendMessage) throw new Error("The switched session cannot resume the agent.");
      continuation.phase = "starting";
      publishWorkspaceState(nextCtx);
      await sendMessage({ customType: "workspace-continuation", content: options.continueWith, display: false }, { triggerTurn: true });
      // A pre-start abort can finish without agent_start. Never clear a newer handoff.
      releaseContinuation();
    }
  };
  // Pi's runtime supports cwdOverride in RPC mode; the extension-context type omits it.
  const switchWithCwd = ctx.switchSession as (path: string, options: {
    cwdOverride: string;
    withSession: (nextCtx: MoveContext) => Promise<void>;
  }) => Promise<{ cancelled: boolean }>;
  if (ownsPending) setPendingWorkspace("navigation");
  let arrived = false;
  let releaseSelection: (() => void) | undefined;
  try {
    setWorkspaceTransitionError(file, undefined);
    if (ctx.cwd !== cwd || options.reload) assertManagedResources();
    if (leafId !== null && !options.reload && !ctx.sessionManager.getEntry(leafId)) throw new Error(`Unknown session entry: ${leafId}`);
    if (!existsSync(cwd)) throw new Error(`Working directory is unavailable: ${cwd}`);
    if ((ctx.cwd !== cwd || options.reload) && ctx.mode !== "rpc"
      && (ctx.cwd !== cwd || ctx.sessionManager.getHeader()?.cwd !== ctx.cwd)) {
      throw new Error("Changing the workspace cwd requires Pi RPC mode; this Pi host does not forward cwdOverride.");
    }
    if ((ctx.cwd !== cwd || options.reload) && hasRunningSubagents()) {
      throw new Error("Wait for running subagents before switching workspaces; replacing Pi's runtime would abort them.");
    }
    if (ctx.cwd !== cwd || options.reload || options.navigateTo) {
      const blocked = subagentHistoryBlockReason();
      if (blocked) throw new Error(blocked);
    }
    if (!projectTrustReady()) throw new Error("Resolve project trust before switching workspaces");
    if (ctx.cwd !== cwd || options.reload) await prepareProjectTrust(ctx, cwd);
    publishWorkspaceState(ctx);
    if (ctx.cwd === cwd && !options.reload) {
      await arrival(ctx);
      return true;
    }
    await options.beforeSwitch?.();
    assertManagedResources();
    releaseSelection = preserveModelForSwitch(ctx);
    const result = await switchWithCwd(file, {
      cwdOverride: cwd,
      withSession: async (nextCtx) => {
        arrived = true;
        await arrival(nextCtx, nextCtx.sendMessage.bind(nextCtx));
      },
    });
    if (result.cancelled) {
      if (ownsPending) setPendingWorkspace(undefined);
      releaseContinuation();
      setWorkspaceTransitionError(file, "Workspace switch was cancelled. Resolve the cause, then restart the session to retry.");
      publishWorkspaceState(ctx);
    }
    return !result.cancelled;
  } catch (error) {
    const pendingContinuation = getWorkspaceContinuation(file);
    if (!pendingContinuation || pendingContinuation === continuation) {
      if ((ownsPending && !arrived) || getPendingWorkspaceId() === pendingWorkspaceId) setPendingWorkspace(undefined);
      setWorkspaceTransitionError(file, `Workspace switch failed: ${error instanceof Error ? error.message : String(error)} Resolve the cause, then restart the session to retry.`);
      try {
        releaseContinuation();
        publishWorkspaceState(currentCtx);
      } catch {
        // Runtime creation can fail after disposing ctx, before a fresh context
        // exists. Publish failure through the captured UI so startup stops waiting.
        try {
          rpcUi?.setStatus("pi-workspace", JSON.stringify({
            cwd: previousCwd, sessionFile: file, transitionPending: false,
            transitionError: getWorkspaceTransitionError(file),
          }));
        } catch { /* Preserve the original switch error if the transport is gone. */ }
      }
    }
    throw error;
  } finally {
    releaseSelection?.();
    if (ownsPending && getPendingWorkspaceId() === "navigation") setPendingWorkspace(undefined);
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
