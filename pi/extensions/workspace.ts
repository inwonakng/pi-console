import { serviceUi } from "./shared/service-ui";
import { registerServiceOperation } from "./shared/service-operation";
import {
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { workspaceToolBlock } from "./shared/workspace-policy";
import { projectTrustReady } from "./shared/project-trust";
import { hasRunningSubagents } from "./shared/subagent-state";
import {
  getIntegrationMode,
  parseIntegrationMode,
  setIntegrationMode,
  type IntegrationMode,
} from "./shared/integration-state";
import { getInteractionMode } from "./shared/interaction-mode";
import { notifyPiWorkspaceIntegration } from "./shared/notifications";
import { loadSessionSetting, saveSessionSetting } from "./shared/session-settings";
import { loadExtensionSettings } from "./shared/extension-settings";
import { activeLocation, moveToLocation, publishWorkspaceState } from "./shared/workspace-navigation";
import {
  createWorkspace,
  createRevertWorkspace,
  beginWorkspaceContinuation,
  clearWorkspaceContinuation,
  getWorkspaceContinuation,
  findGitRoot,
  formatWorkspaceRecord,
  formatIntegrationSummary,
  getExpectedWorkspaceMissing,
  getPendingWorkspaceId,
  integrateWorkspace,
  isWorkspaceFinalized,
  taskWorkspacesForSession,
  listWorkspaces,
  loadWorkspace,
  prepareWorkspaceDiscard,
  previewWorkspaceIntegration,
  removeWorkspace,
  retainedChildWorkspaces,
  sameSessionFile,
  updateWorkspace,
  setExpectedWorkspaceMissing,
  setPendingWorkspace,
  workspaceDisplayState,
  workspaceForContext,
  workspaceStorageRoot,
  type WorkspaceDisplayState,
  type WorkspaceRecord,
} from "./shared/workspace";

const WORKSPACE_ACTIONS = ["enter", "status", "list", "integrate", "discard", "revert"] as const;
type WorkspaceAction = (typeof WORKSPACE_ACTIONS)[number];
const TRANSITION_ACTIONS = new Set<WorkspaceAction>(["enter", "integrate", "discard", "revert"]);

const REVIEW_ACTION = "Review / modify";
const INTEGRATE_ACTION = "Integrate and return";
const RETURN_ACTION = "Not yet — return to conversation";
const INTEGRATION_ICONS: Record<IntegrationMode, string> = {
  ask: "?",
  allowed: "✓",
};
const INTEGRATION_SETTING = "integration";
const REVIEW_SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "../scripts/review-workspace.sh");

type ProcessResult = {
  status: number;
  stdout: string;
  stderr: string;
};

function runProcess(command: string, args: string[]): ProcessResult {
  const result = spawnSync(command, args, { encoding: "utf8" });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? result.error?.message ?? "",
  };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function reviewCommand(record: WorkspaceRecord): string {
  return ["bash", shellQuote(REVIEW_SCRIPT), shellQuote(record.worktreePath), shellQuote(record.baselineCommit)].join(" ");
}

function ignoredReviewNote(record: WorkspaceRecord): string {
  return record.includedIgnoredFiles?.length
    ? `\nIncluded ignored files are not shown in the Git diff; review them directly in the worktree:\n${record.includedIgnoredFiles.map((file) => `- ${join(record.worktreePath, file.path)}`).join("\n")}`
    : "";
}

function tmuxPane(): string | undefined {
  const pane = process.env.TMUX_PANE;
  if (!process.env.TMUX || !pane) {
    return undefined;
  }
  const result = runProcess("tmux", ["display-message", "-p", "-t", pane, "#{pane_id}"]);
  return result.status === 0 && result.stdout.trim() === pane ? pane : undefined;
}

function launchWorkspaceReview(record: WorkspaceRecord): { launched: boolean; reason?: string } {
  const sourcePane = tmuxPane();
  if (!sourcePane) {
    return { launched: false };
  }

  const splitResult = runProcess("tmux", [
    "split-window",
    "-h",
    "-P",
    "-F",
    "#{pane_id}",
    "-t",
    sourcePane,
    "-c",
    record.worktreePath,
    reviewCommand(record),
  ]);
  const reviewPane = splitResult.stdout.trim();
  if (splitResult.status !== 0 || !reviewPane.startsWith("%")) {
    return { launched: false, reason: splitResult.stderr.trim() || "tmux did not return the reviewer pane id" };
  }

  runProcess("tmux", ["select-pane", "-t", reviewPane]);
  return { launched: true };
}

function retainedForManualReview(record: WorkspaceRecord, reason?: string) {
  const prefix = reason ? `Could not open a tmux reviewer: ${reason}\n\n` : "";
  return {
    content: [{
      type: "text" as const,
      text: `${prefix}Workspace retained without integration. Review it from another terminal with:\n\n\`\`\`sh\n${reviewCommand(record)}\n\`\`\`${ignoredReviewNote(record)}\n\nRequest integration again when the review is complete.`,
    }],
    details: record,
  };
}

function sessionFile(ctx: ExtensionContext): string | undefined {
  return ctx.sessionManager.getSessionFile();
}

function displayLabel(state: WorkspaceDisplayState): string {
  const branch = state.branch ? ` (${state.branch})` : "";
  return `${state.name}${branch}`;
}

function publishIntegrationMode(ctx: ExtensionContext): void {
  const mode = getIntegrationMode();
  ctx.ui.setStatus(
    "pi-integration-mode",
    ctx.mode === "rpc" ? `Integration: ${mode}` : INTEGRATION_ICONS[mode],
  );
}

function restoreIntegrationMode(ctx: ExtensionContext): void {
  const stored = loadSessionSetting(ctx, INTEGRATION_SETTING);
  setIntegrationMode(parseIntegrationMode(typeof stored === "string" ? stored : undefined)
    ?? loadExtensionSettings()["integration-mode"]?.default ?? "ask");
  publishIntegrationMode(ctx);
}

function queueCommand(pi: ExtensionAPI, command: string): void {
  pi.sendUserMessage(command, {
    deliverAs: "followUp",
    expandPromptTemplates: true,
  });
}

function publishWorkspaceContinuation(ctx: ExtensionContext, workspaceId: string): void {
  const file = sessionFile(ctx);
  if (!file) throw new Error("Workspace switching requires a persisted session.");
  setPendingWorkspace(workspaceId);
  beginWorkspaceContinuation(file);
  publishWorkspaceState(ctx);
}

function taskForCurrentContext(ctx: ExtensionContext): WorkspaceRecord | undefined {
  const active = workspaceForContext(ctx.cwd, sessionFile(ctx));
  return active?.kind === "task" && sameSessionFile(active.sourceSessionFile, sessionFile(ctx)) ? active : undefined;
}

function returnPending(record: WorkspaceRecord | undefined): record is WorkspaceRecord {
  return record?.kind === "task"
    && (record.lifecycle === "integration_pending" || record.lifecycle === "discard_pending");
}

function checkRequestedIgnoredFiles(record: WorkspaceRecord, paths: string[] | undefined): void {
  if (!paths?.length) return;
  const requested = paths.map((path) => relative(record.destinationRoot, resolve(record.destinationCwd, path))).sort();
  const included = (record.includedIgnoredFiles ?? []).map((file) => file.path).sort();
  if (paths.some((path) => !path || path.startsWith("/") || path.includes("\0"))
    || JSON.stringify(requested) !== JSON.stringify(included)) {
    throw new Error("Ignored files are selected when the workspace is created; this workspace already exists. Resume it without ignoredFiles or discard and enter a new workspace.");
  }
}

function formatStatus(ctx: ExtensionContext): string {
  const state = workspaceDisplayState(ctx.cwd, sessionFile(ctx));
  const lines = [
    `Workspace: ${displayLabel(state)}`,
    `- lifecycle: ${state.lifecycle}`,
    `- cwd: ${state.cwd}`,
    `- path: ${state.path}`,
    `- session: ${state.sessionFile ?? "ephemeral"}`,
    `- storage: ${workspaceStorageRoot()}`,
  ];
  if (state.id) lines.push(`- id: ${state.id}`);
  for (const linked of taskWorkspacesForSession(sessionFile(ctx))) {
    if (linked.id === state.id) continue;
    lines.push(`- retained task: ${linked.id} (${linked.lifecycle}) at ${linked.worktreePath}`);
  }
  const pendingWorkspaceId = getPendingWorkspaceId();
  if (pendingWorkspaceId) lines.push(`- transition queued: ${pendingWorkspaceId}`);
  const missing = getExpectedWorkspaceMissing();
  if (missing) lines.push(`- missing expected workspace: ${missing}`);
  return lines.join("\n");
}

function workspaceList(offset = 0, limit = 20) {
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new Error("Workspace list offset must be a non-negative safe integer.");
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
    throw new Error("Workspace list limit must be an integer between 1 and 50.");
  }
  const all = listWorkspaces();
  const records = all.slice(offset, offset + limit).map((record) => {
    const file = record.targetSessionFile ?? record.sourceSessionFile;
    // Pi uses timestamp_id.jsonl; owner-managed sessions use id.jsonl.
    const sessionId = file ? basename(file, ".jsonl").replace(/^\d{4}-\d{2}-\d{2}T[^_]+_/, "") : undefined;
    return { id: record.id, sessionId };
  });
  const nextOffset = offset + records.length < all.length ? offset + records.length : null;
  const lines = records.length > 0
    ? [`Workspaces ${offset + 1}-${offset + records.length} of ${all.length} (newest first):`,
      ...records.map((record) => `${record.id} | session: ${record.sessionId ?? "unknown"}`)]
    : [all.length === 0 ? "No Pi workspaces." : `No workspaces at offset ${offset} (${all.length} total).`];
  lines.push("Details: workspace action=status id=<workspace-id>, or /pi-workspace status <workspace-id>.");
  if (nextOffset !== null) {
    lines.push(`Next page: workspace action=list offset=${nextOffset} limit=${limit}, or /pi-workspace list ${nextOffset} ${limit}.`);
  }
  return { text: lines.join("\n"), details: { records, total: all.length, offset, limit, nextOffset } };
}

async function confirmDestructive(
  ctx: ExtensionContext,
  title: string,
  message: string,
  approved: boolean | undefined,
): Promise<boolean> {
  if (getIntegrationMode() === "allowed") return true;
  if (getInteractionMode(ctx) === "interactive") {
    const dialogTitle = ctx.mode === "rpc"
      ? JSON.stringify({ kind: "pi_confirmation", prompt: title, resumable: true })
      : title;
    return serviceUi(ctx).confirm(dialogTitle, message, { signal: ctx.signal });
  }
  return approved === true;
}

export default function workspaceExtension(pi: ExtensionAPI) {
  let runtimeCancellation = new AbortController();
  pi.on("session_shutdown", () => runtimeCancellation.abort());
  pi.on("agent_start", (_event, ctx) => {
    const continuation = getWorkspaceContinuation(sessionFile(ctx));
    if (continuation?.phase === "starting") {
      clearWorkspaceContinuation(continuation);
      // Hooks precede the public event. The owner clears its handoff atomically
      // with agent_start; publishing a clear here would introduce an idle gap.
    }
  });
  const restoreWorkspace = (event: { reason: string }, ctx: ExtensionContext) => {
    if (!projectTrustReady()) {
      publishWorkspaceState(ctx);
      return;
    }
    runtimeCancellation = new AbortController();
    restoreIntegrationMode(ctx);
    const envWorkspaceId = process.env.PI_WORKSPACE_ID;
    if (envWorkspaceId) {
      const record = loadWorkspace(envWorkspaceId);
      const missing = !record || !record.retained || !existsSync(record.worktreePath);
      setExpectedWorkspaceMissing(missing ? envWorkspaceId : undefined);
    } else {
      setExpectedWorkspaceMissing(undefined);
      try {
        const location = activeLocation(ctx);
        const pendingId = getPendingWorkspaceId();
        const recoveringReturn = (event.reason === "startup" || event.reason === "resume")
          && returnPending(location.workspace)
          && sameSessionFile(location.workspace.sourceSessionFile, sessionFile(ctx))
          && location.cwd === ctx.cwd;
        if (recoveringReturn && (!pendingId || pendingId === location.workspace.id)) {
          const workspaceId = location.workspace.id;
          publishWorkspaceContinuation(ctx, workspaceId);
          // A restore switch emits session_start before its replacement callback returns.
          // Defer the return so it does not start a nested session replacement.
          setTimeout(() => queueCommand(pi, `/pi-workspace-return ${workspaceId}`), 0);
        } else if (!pendingId && location.cwd !== ctx.cwd) {
          setPendingWorkspace(location.workspace?.id ?? "restore");
          queueCommand(pi, "/pi-workspace-restore");
        }
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
        setExpectedWorkspaceMissing("unavailable");
      }
    }
    refreshWorkspaceTool(ctx);
    publishWorkspaceState(ctx);
  };
  pi.on("session_start", restoreWorkspace);

  pi.on("session_tree", (_event, ctx) => {
    restoreIntegrationMode(ctx);
    refreshWorkspaceTool(ctx);
  });

  pi.on("session_before_fork", (_event, ctx) => {
    if (!workspaceForContext(ctx.cwd, sessionFile(ctx))) return;
    ctx.ui.notify("A workspace belongs to one conversation. Use the tree for another branch, or return to the origin checkout before forking.", "warning");
    return { cancel: true };
  });

  pi.on("before_agent_start", (event, ctx) => {
    refreshWorkspaceTool(ctx);
    // This event holds a prompt snapshot from before tool registration refreshed it.
    event.systemPromptOptions.toolGuidelines.workspace = pi.getActiveTools().includes("workspace")
      ? pi.getAllTools().find((tool) => tool.name === "workspace")?.promptGuidelines ?? []
      : [];
  });

  pi.on("tool_call", (event, ctx) => {
    return workspaceToolBlock(event.toolName, event.input as Record<string, unknown>, ctx);
  });

  const enterWorkspace = async (args: string, ctx: ExtensionCommandContext) => {
      const file = sessionFile(ctx);
      const continuation = getWorkspaceContinuation(file);
      const record = loadWorkspace(args.trim());
      if (!record || record.kind !== "task" || !record.retained || isWorkspaceFinalized(record)
        || !sameSessionFile(record.sourceSessionFile, sessionFile(ctx))) {
        setPendingWorkspace(undefined);
        if (continuation) clearWorkspaceContinuation(continuation);
        publishWorkspaceState(ctx);
        throw new Error(`Task workspace is unavailable: ${args.trim()}`);
      }
      try {
        await ctx.waitForIdle();
        const moved = await moveToLocation(ctx, record.workspaceCwd, ctx.sessionManager.getLeafId(), {
          markLocation: true,
          workspaceId: record.id,
          workspaceLabel: record.label,
          continueWith: "Continue the task in the new workspace.",
          onArrival: (nextCtx) => {
            setPendingWorkspace(undefined);
            setExpectedWorkspaceMissing(undefined);
            publishWorkspaceState(nextCtx);
            nextCtx.ui.notify(`Entered workspace ${record.label}.`, "info");
          },
        });
        if (!moved) throw new Error("Workspace switch was cancelled.");
        return moved;
      } catch (error) {
        const pendingContinuation = getWorkspaceContinuation(file);
        if (!pendingContinuation || pendingContinuation === continuation) {
          const transitionPending = getPendingWorkspaceId() !== undefined;
          setPendingWorkspace(undefined);
          if (pendingContinuation) clearWorkspaceContinuation(pendingContinuation);
          if (transitionPending || pendingContinuation) publishWorkspaceState(ctx);
        }
        await updateWorkspace(record.id, (current) => {
          current.lifecycle = "retained";
          current.integrationReason = error instanceof Error ? error.message : String(error);
        });
        throw error;
      }
  };
  pi.registerCommand("pi-workspace-enter", { description: "Internal command that moves the current session into its task worktree",
    handler: async (args, ctx) => { await enterWorkspace(args, ctx); } });

  pi.registerCommand("pi-workspace-restore", {
    description: "Restore the current branch's execution workspace after resuming Pi",
    handler: async (_args, ctx) => {
      try {
        await ctx.waitForIdle();
        const location = activeLocation(ctx);
        if (location.cwd !== ctx.cwd) {
          const moved = await moveToLocation(ctx, location.cwd, ctx.sessionManager.getLeafId(), {
            saveCursor: false,
            onArrival: (nextCtx) => {
              setPendingWorkspace(undefined);
              publishWorkspaceState(nextCtx);
            },
          });
          if (!moved) throw new Error("Workspace restoration was cancelled.");
        } else {
          setPendingWorkspace(undefined);
          publishWorkspaceState(ctx);
        }
      } catch (error) {
        const transitionPending = getPendingWorkspaceId() !== undefined;
        setPendingWorkspace(undefined);
        if (transitionPending) publishWorkspaceState(ctx);
        throw error;
      }
    },
  });

  const returnWorkspace = async (args: string, ctx: ExtensionCommandContext) => {
      const file = sessionFile(ctx);
      const continuation = getWorkspaceContinuation(file);
      const id = args.trim();
      try {
        const record = loadWorkspace(id);
        if (!record || record.kind !== "task" || !sameSessionFile(record.sourceSessionFile, sessionFile(ctx))
          || (record.lifecycle !== "integration_pending" && record.lifecycle !== "discard_pending")
          || taskForCurrentContext(ctx)?.id !== id) {
          throw new Error(`No completed return transition for task workspace: ${id}`);
        }
        await ctx.waitForIdle();
        const lifecycle = record.lifecycle === "discard_pending" ? "discarded" : "integrated";
        const moved = await moveToLocation(ctx, record.destinationCwd, ctx.sessionManager.getLeafId(), {
          markLocation: true,
          continueWith: lifecycle === "integrated"
            ? "Report the integration result, then continue any remaining work in the origin checkout."
            : "Report that the workspace was discarded and continue only if work remains.",
          onArrival: async (nextCtx) => {
            const cleaned = await removeWorkspace(id, lifecycle);
            setPendingWorkspace(undefined);
            publishWorkspaceState(nextCtx);
            nextCtx.ui.notify(cleaned.lifecycle === "cleanup_failed"
              ? `Returned to the origin checkout, but cleanup failed: ${cleaned.integrationReason ?? cleaned.worktreePath}`
              : `${lifecycle === "integrated" ? "Integrated" : "Discarded"} ${record.label} and returned to the origin checkout.`,
              cleaned.lifecycle === "cleanup_failed" ? "warning" : "info");
          },
        });
        if (!moved) throw new Error("Return to the origin checkout was cancelled; the workspace was retained.");
        return moved;
      } catch (error) {
        const pendingContinuation = getWorkspaceContinuation(file);
        if (!pendingContinuation || pendingContinuation === continuation) {
          const transitionPending = getPendingWorkspaceId() !== undefined;
          setPendingWorkspace(undefined);
          if (pendingContinuation) clearWorkspaceContinuation(pendingContinuation);
          if (transitionPending || pendingContinuation) publishWorkspaceState(ctx);
        }
        const retained = loadWorkspace(id);
        if (retained?.retained && !isWorkspaceFinalized(retained)) {
          await updateWorkspace(id, (current) => {
            current.integrationReason = error instanceof Error ? error.message : String(error);
          });
        }
        throw error;
      }
  };
  pi.registerCommand("pi-workspace-return", { description: "Internal command that returns this session to its origin checkout",
    handler: async (args, ctx) => { await returnWorkspace(args, ctx); } });

  pi.registerCommand("pi-workspace-publish", {
    description: "Publish the current workspace state to the active host",
    handler: async (_args, ctx) => {
      restoreWorkspace({ reason: "resume" }, ctx);
    },
  });

  pi.registerCommand("pi-workspace-review", {
    description: "Review the current session's workspace diff",
    handler: async (_args, ctx) => {
      const record = workspaceForContext(ctx.cwd, sessionFile(ctx));
      if (!record) {
        ctx.ui.notify("No workspace is available for the current session.", "warning");
        return;
      }
      if (!existsSync(record.worktreePath)) {
        ctx.ui.notify(`Workspace path is missing: ${record.worktreePath}`, "warning");
        return;
      }

      const note = ignoredReviewNote(record);
      if (note) ctx.ui.notify(note.trim(), "warning");
      const review = launchWorkspaceReview(record);
      if (!review.launched) {
        const prefix = review.reason ? `Could not open a tmux reviewer: ${review.reason}\n\n` : "";
        ctx.ui.notify(
          `${prefix}Review the workspace from another terminal with:\n\n${reviewCommand(record)}${note}`,
          review.reason ? "warning" : "info",
        );
      }
    },
  });

  const applyIntegrationMode = async (mode: IntegrationMode, ctx: ExtensionContext) => {
    const changed = mode !== getIntegrationMode();
    setIntegrationMode(mode);
    if (changed) saveSessionSetting(pi, INTEGRATION_SETTING, mode);
    refreshWorkspaceTool(ctx);
    publishIntegrationMode(ctx);
    return { mode: getIntegrationMode() };
  };
  registerServiceOperation(pi, "integration.set", ({ mode }, ctx) => applyIntegrationMode(mode, ctx));
  registerServiceOperation(pi, "integration.cycle", ({ modes }, ctx) => applyIntegrationMode(modes[(modes.indexOf(getIntegrationMode()) + 1) % modes.length]!, ctx));

  pi.registerCommand("pi-integration-mode", {
    description: "Set approval mode for top-level workspace integration and workspace discard: /pi-integration-mode ask|allowed",
    handler: async (args, ctx) => {
      const requestedMode = parseIntegrationMode(args);
      if (!requestedMode) {
        ctx.ui.notify("Usage: /pi-integration-mode ask|allowed", "warning");
        publishIntegrationMode(ctx);
        return;
      }

      const changed = requestedMode !== getIntegrationMode();
      setIntegrationMode(requestedMode);
      if (changed) saveSessionSetting(pi, INTEGRATION_SETTING, requestedMode);
      refreshWorkspaceTool(ctx);
      publishIntegrationMode(ctx);
      ctx.ui.notify(`Integration mode: ${getIntegrationMode()}`, "info");
    },
  });

  pi.registerCommand("pi-workspace", {
    description: "Show workspace details (status [id]) or a compact page (list [offset] [limit])",
    handler: async (args, ctx) => {
      const [action = "status", first, second, ...extra] = args.trim() ? args.trim().split(/\s+/) : [];
      if (action === "status" && second === undefined) {
        const record = first ? loadWorkspace(first) : undefined;
        if (first && !record) {
          ctx.ui.notify(`Unknown workspace: ${first}`, "warning");
          return;
        }
        publishWorkspaceState(ctx);
        ctx.ui.notify(record ? formatWorkspaceRecord(record) : formatStatus(ctx), "info");
        return;
      }
      if (action === "list" && extra.length === 0) {
        try {
          ctx.ui.notify(workspaceList(first === undefined ? undefined : Number(first), second === undefined ? undefined : Number(second)).text, "info");
        } catch (error) {
          ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
        }
        return;
      }
      ctx.ui.notify("Usage: /pi-workspace status [id] | list [offset] [limit]", "warning");
    },
  });

  type WorkspaceParams = { action: WorkspaceAction; id?: string; offset?: number; limit?: number; ignoredFiles?: string[]; approved?: boolean; commitMessage?: string; reason?: string };
  type Move = (action: "enter" | "return", id: string) => Promise<void>;
  let executeWorkspace: (callId: string, params: WorkspaceParams, signal: AbortSignal | undefined, update: unknown, ctx: ExtensionContext, move?: Move) => Promise<{ content: { type: "text"; text: string }[]; details: unknown; terminate?: boolean; cleanupAttempted?: boolean }>;
  const registerWorkspaceTool = (available: boolean, guidance: string[]) => pi.registerTool({
    name: "workspace",
    defaultActive: false,
    label: "Workspace",
    exposure: available ? "direct" : "hidden",
    description: "Create/reuse a task worktree, inspect, integrate or discard. Revert prepares a recorded integration's reversal in a new workspace for review; it never resets history. List returns workspace/session IDs, newest first (default 20, max 50); status shows commit metadata and paths.",
    promptSnippet: "Manage the current task's isolated Git worktree and integration lifecycle.",
    promptGuidelines: [
      "Before making implementation changes with edit or write inside the git repository containing the current session cwd, call workspace with action=enter as the only tool call in that assistant response, unless the current session is already in an associated workspace. To edit existing ignored files, provide their paths relative to the original cwd in ignoredFiles on the first enter call; only those files are copied and later integrated. Wait for the cwd switch before using more tools.",
      "Temporary probes, scripts, and generated artifacts may be created under $TMPDIR without entering a workspace; keep them outside the repository and remove them when finished.",
      "Call workspace with action=status when the expected workspace is missing or its lifecycle is unclear.",
      "Join running subagents, or stop them and wait for cleanup, before switching workspaces.",
      "When integration commits are enabled, supply commitMessage describing what changed and why. Never push automatically.",
      "If committing could expose sensitive files, secrets, or has another safety concern, use question to ask the user before integration, even when integration is pre-authorized. Describe the concern without exposing secret values. If question is unavailable, cancelled, or the user declines, retain the workspace without integrating or committing. Integration permission does not approve a questionable commit.",
      "To undo a managed integration, use action=revert with its workspace id and a reason from the origin checkout. Review and verify the prepared reversal, then integrate it to create a new revert commit. Do not use reset/amend/history rewriting for undo; fix requests normally use a new corrective workspace and commit instead.",
      "Revert reverses committed changes only; included ignored-file updates are outside Git and require separate explicit handling.",
      ...guidance,
      "Call workspace with action=integrate, action=discard, or action=revert as the only tool call in that assistant response when the action changes the active workspace. Wait for the cwd switch before using more tools.",
    ],
    parameters: Type.Object({
      action: StringEnum(WORKSPACE_ACTIONS, { description: "Workspace lifecycle action." }),
      id: Type.Optional(Type.String({ description: "Workspace id for enter, status, integration, or discard; revert requires the original integration's workspace id. Enter creates a new task workspace unless an id is specified." })),
      offset: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description: "List only: zero-based offset (default 0). Use nextOffset from the previous page." })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "List only: number of entries per page (default 20, maximum 50)." })),
      ignoredFiles: Type.Optional(Type.Array(Type.String(), { description: "Existing ignored file paths relative to the original cwd, copied into a new task worktree on enter and copied back on integration." })),
      approved: Type.Optional(Type.Boolean({ description: "Required for integration or discard in ask mode when no interactive UI is available; does not bypass interactive confirmation." })),
      commitMessage: Type.Optional(Type.String({ minLength: 1, maxLength: 16384, description: "Integration commit message: describe the changes and why. Required when automatic commits are enabled; reverts get a default message." })),
      reason: Type.Optional(Type.String({ minLength: 1, maxLength: 8192, description: "Revert only: why the recorded integration should be undone. id identifies that integration's workspace." })),
    }),
    executionMode: "sequential",
    execute: executeWorkspace = async (_toolCallId, params, signal, _onUpdate, ctx, move: Move | undefined = undefined): ReturnType<typeof executeWorkspace> => {
      const action = params.action as WorkspaceAction;
      if (action === "status") {
        const record = params.id ? loadWorkspace(params.id) : workspaceForContext(ctx.cwd, sessionFile(ctx));
        if (params.id && !record) throw new Error(`Unknown workspace: ${params.id}`);
        const text = record ? formatWorkspaceRecord(record) : formatStatus(ctx);
        publishWorkspaceState(ctx);
        return { content: [{ type: "text", text }], details: record ?? workspaceDisplayState(ctx.cwd, sessionFile(ctx)) };
      }
      if (action === "list") {
        const { text, details } = workspaceList(params.offset, params.limit);
        return { content: [{ type: "text", text }], details };
      }
      if (params.commitMessage !== undefined && action !== "integrate") throw new Error("commitMessage only applies to action=integrate.");
      if (params.reason !== undefined && action !== "revert") throw new Error("reason only applies to action=revert.");
      if (params.ignoredFiles !== undefined && action !== "enter") {
        throw new Error("ignoredFiles only applies to action=enter.");
      }
      if (TRANSITION_ACTIONS.has(action) && hasRunningSubagents()) {
        throw new Error("Cannot change workspaces while subagents or their cleanup are active. Use spawn_control join/join_all, or stop them and wait for cleanup, then retry this workspace action.");
      }
      if (action === "revert") {
        if (!params.id || !params.reason) throw new Error("Revert requires the recorded integration's workspace id and a reason.");
        const source = sessionFile(ctx);
        if (!source) throw new Error("Revert requires a persisted Pi session.");
        const record = await createRevertWorkspace({ workspaceId: params.id, reason: params.reason,
          destinationCwd: ctx.cwd, sourceSessionFile: source }, signal);
        if (!record.reverts?.prepared) return {
          content: [{ type: "text", text: `Revert was not prepared; the destination was not changed. Inspect or discard the retained workspace.\n${formatWorkspaceRecord(record)}` }],
          details: record,
        };
        publishWorkspaceContinuation(ctx, record.id);
        if (move) await move("enter", record.id);
        else queueCommand(pi, `/pi-workspace-enter ${record.id}`);
        return { content: [{ type: "text", text: `Prepared reversal of ${record.reverts.commit}. Review and verify before integrating; integration creates a new commit, never rewrites history. Ignored-file changes from the original integration are not reversed.\n\n${formatWorkspaceRecord(record)}\n\nCwd switch queued; wait before using repository tools.` }], details: record, terminate: true };
      }
      if (action === "enter") {
        const active = taskForCurrentContext(ctx);
        const unrelated = workspaceForContext(ctx.cwd, sessionFile(ctx));
        if (unrelated && !active) throw new Error(`This worktree belongs to a different conversation: ${unrelated.id}`);
        if (active && existsSync(active.worktreePath)) {
          checkRequestedIgnoredFiles(active, params.ignoredFiles);
          if (isWorkspaceFinalized(active)) {
            throw new Error(
              `Workspace ${active.id} has a finalized contribution and is retained only for cleanup; it cannot be re-entered.`,
            );
          }
          publishWorkspaceState(ctx);
          return {
            content: [{ type: "text", text: `Already in task workspace.\n${formatWorkspaceRecord(active)}` }],
            details: active,
          };
        }
        const source = sessionFile(ctx);
        if (!source) throw new Error("Task workspaces require a persisted Pi session.");
        let record = params.id ? loadWorkspace(params.id) : undefined;
        if (record && record.kind !== "task") {
          throw new Error(`Workspace ${record.id} is a child workspace; resume it through spawn_control.`);
        }
        if (record && !sameSessionFile(record.sourceSessionFile, source)) throw new Error(`Workspace ${record.id} belongs to a different conversation.`);
        if (record) checkRequestedIgnoredFiles(record, params.ignoredFiles);
        if (record && isWorkspaceFinalized(record)) {
          throw new Error(
            `Workspace ${record.id} has a finalized contribution and is retained only for cleanup; it cannot be re-entered.`,
          );
        }
        if (!record) {
          if (params.id) {
            throw new Error(`Unknown task workspace: ${params.id}`);
          }
          record = createWorkspace({
            kind: "task",
            destinationCwd: ctx.cwd,
            sourceSessionFile: source,
            ignoredFiles: params.ignoredFiles,
          });
        }
        if (!existsSync(record.worktreePath)) {
          setExpectedWorkspaceMissing(record.id);
          throw new Error(`Retained workspace record points to a missing path: ${record.worktreePath}`);
        }
        publishWorkspaceContinuation(ctx, record.id);
        if (move) await move("enter", record.id);
        else queueCommand(pi, `/pi-workspace-enter ${record.id}`);
        return {
          content: [{
            type: "text",
            text: `Workspace ${record.label} is ready. Cwd switch to ${record.workspaceCwd} is queued; wait before using repository tools.`,
          }],
          details: record,
          terminate: true,
        };
      }

      const selected = params.id ? loadWorkspace(params.id) : workspaceForContext(ctx.cwd, sessionFile(ctx));
      if (!selected) {
        throw new Error(`No workspace available for action=${action}.`);
      }
      if (action === "integrate") {
        if (selected.kind !== "task") {
          throw new Error("Top-level workspace integration only applies to task workspaces; child workspaces integrate through spawn_control.");
        }
        const active = taskForCurrentContext(ctx);
        if (retainedChildWorkspaces(selected.id).length) {
          throw new Error(`Join or discard child workspaces before integrating ${selected.id}.`);
        }
        if (!active || active.id !== selected.id) {
          throw new Error(`Enter task workspace ${selected.id} before integrating it.`);
        }
        const shouldCommit = selected.integrationCommit !== undefined || selected.reverts !== undefined
          || loadExtensionSettings().workspace?.["auto-commit"] === true;
        let commitMessage = selected.integrationCommit?.message ?? (shouldCommit ? params.commitMessage : undefined);
        if (!commitMessage && selected.reverts) {
          commitMessage = `Revert ${selected.reverts.commit.slice(0, 12)}\n\n${selected.reverts.reason}`;
        }
        if (shouldCommit && !commitMessage) {
          if (getInteractionMode(ctx) !== "interactive") throw new Error("Automatic integration commits require commitMessage; retain the workspace until one is provided.");
          commitMessage = await serviceUi(ctx).input(JSON.stringify({ kind: "pi_input", prompt: "Commit message: what changed and why?", resumable: true }), undefined, { signal: ctx.signal });
          if (!commitMessage?.trim()) return { content: [{ type: "text", text: "No commit message supplied. Workspace retained without integration." }], details: selected, terminate: true };
        }
        const integrationMode = getIntegrationMode();
        let decision = integrationMode === "allowed" || params.approved === true
          ? INTEGRATE_ACTION
          : RETURN_ACTION;
        const operationSignal = signal ? AbortSignal.any([signal, runtimeCancellation.signal]) : runtimeCancellation.signal;
        if (integrationMode === "ask" && getInteractionMode(ctx) === "interactive") {
          let firstPrompt = true;
          while (true) {
            const preview = await previewWorkspaceIntegration(selected.id, operationSignal);
            if (firstPrompt) {
              notifyPiWorkspaceIntegration(ctx);
              firstPrompt = false;
            }
            const prompt = `Apply ${selected.label} to ${selected.destinationRoot}?${commitMessage ? `\n\nCreate local commit:\n${commitMessage}` : ""}${ignoredReviewNote(selected)}${selected.includedIgnoredFiles?.length ? "\nIgnored-file updates stay outside the commit and Git undo." : ""}`;
            decision = await serviceUi(ctx).select(
              JSON.stringify({
                kind: "pi_compact_select", prompt, notify: false, resumable: true,
                preview, preview_kind: "workspace_summary",
              }),
              [INTEGRATE_ACTION, REVIEW_ACTION, RETURN_ACTION],
              { signal: ctx.signal },
            ) ?? RETURN_ACTION;
            if (decision === INTEGRATE_ACTION && await previewWorkspaceIntegration(selected.id, operationSignal) !== preview) {
              ctx.ui.notify("Workspace or destination changes updated the integration summary. Review the refreshed preview before integrating.", "warning");
              continue;
            }
            if (decision !== REVIEW_ACTION) {
              break;
            }
            const review = launchWorkspaceReview(selected);
            if (!review.launched) {
              return retainedForManualReview(selected, review.reason);
            }
          }
        }
        if (decision !== INTEGRATE_ACTION) {
          return {
            content: [{ type: "text", text: "Workspace retained without integration." }],
            details: selected,
            terminate: true,
          };
        }
        const integrated = await integrateWorkspace(selected.id, operationSignal, { commitMessage });
        if (integrated.integration !== "applied" && integrated.integration !== "none") {
          return {
            content: [{
              type: "text",
              text: `Workspace was retained; integration=${integrated.integration}.\n${formatWorkspaceRecord(integrated)}${integrated.integrationReview?.applied ? `\n\nAlready applied in this attempt:\n${formatIntegrationSummary(integrated)}` : ""}`,
            }],
            details: integrated,
          };
        }
        publishWorkspaceContinuation(ctx, integrated.id);
        if (move) await move("return", integrated.id);
        else queueCommand(pi, `/pi-workspace-return ${integrated.id}`);
        return {
          content: [{
            type: "text",
            text: `${integrated.integration === "none" ? "No changes needed in" : "Applied the task contribution to"} ${integrated.destinationRoot}.\n\n${formatIntegrationSummary(integrated)}\n\nThe return cwd switch is queued; wait before using more tools.`,
          }],
          details: integrated,
          terminate: true,
        };
      }

      if (selected.kind === "task" && retainedChildWorkspaces(selected.id).length) {
        throw new Error(`Join or discard child workspaces before discarding ${selected.id}.`);
      }
      const prepared = await prepareWorkspaceDiscard(selected.id);
      const changed = prepared.changedFiles.length > 0 ? prepared.changedFiles.join("\n") : "(no changed files)";
      const included = prepared.includedIgnoredFiles?.length
        ? `\n\nIncluded ignored files (not in the recovery patch):\n${prepared.includedIgnoredFiles.map((file) => file.path).join("\n")}`
        : "";
      const unpreserved = prepared.unpreservedFiles && prepared.unpreservedFiles.length > 0
        ? `\n\nIgnored untracked files not included in the recovery patch:\n${prepared.unpreservedFiles.join("\n")}`
        : "";
      const confirmed = await confirmDestructive(
        ctx,
        "Discard workspace?",
        `Discard ${prepared.label} and remove its worktree?\n\nWorkspace changes:\n${changed}${included}${unpreserved}\n\nRecovery patch: ${prepared.resultPatchPath}`,
        params.approved,
      );
      if (!confirmed) {
        return { content: [{ type: "text", text: "Workspace discard was not approved." }], details: prepared };
      }
      const active = workspaceForContext(ctx.cwd, sessionFile(ctx));
      if (prepared.kind === "task" && active?.id === prepared.id) {
        await updateWorkspace(prepared.id, (current) => {
          current.lifecycle = "discard_pending";
        });
        publishWorkspaceContinuation(ctx, prepared.id);
        if (move) await move("return", prepared.id);
        else queueCommand(pi, `/pi-workspace-return ${prepared.id}`);
        return {
          content: [{
            type: "text",
            text: "Discard approved. The return cwd switch is queued; wait before using more tools.",
          }],
          details: prepared,
          terminate: true,
        };
      }
      const discarded = await removeWorkspace(prepared.id, "discarded");
      return {
        content: [{ type: "text", text: discarded.lifecycle === "cleanup_failed"
          ? `Discard cleanup incomplete (${discarded.retained ? "worktree retained" : "worktree removed"}): ${discarded.integrationReason ?? discarded.worktreePath}. Recovery patch: ${discarded.resultPatchPath}`
          : `Discarded ${discarded.label}. Recovery patch: ${discarded.resultPatchPath}` }],
        details: discarded,
        cleanupAttempted: true,
      };
    },
  });

  let toolContext: string | undefined;
  function refreshWorkspaceTool(ctx: ExtensionContext): void {
    const active = workspaceForContext(ctx.cwd, sessionFile(ctx));
    // Keep recovery available when a previously assigned workspace is missing.
    const available = !!findGitRoot(ctx.cwd) || !!getExpectedWorkspaceMissing();
    const guidance = [
      active?.kind === "child"
        ? "Reuse the assigned child workspace. Do not enter or integrate a task workspace; the parent integrates your changes through spawn_control."
        : "After completing and verifying changes in an active task workspace, call workspace with action=integrate. Direct edits outside a task workspace need no integration.",
      loadExtensionSettings().workspace?.["auto-commit"] === true || active?.reverts || active?.integrationCommit
        ? "Integration commits are enabled. Supply a descriptive commitMessage; commits remain local. Revert integrations always create a commit."
        : "Automatic integration commits are disabled by user configuration; normal integration applies changes uncommitted.",
      getIntegrationMode() === "allowed"
        ? "Integration mode: allowed. Task integration and workspace discard are pre-authorized."
        : "Integration mode: ask. Task integration and workspace discard require confirmation.",
    ];
    const nextContext = JSON.stringify([available, guidance]);
    if (nextContext === toolContext) return;
    registerWorkspaceTool(available, guidance);
    toolContext = nextContext;
  }

  // Let native defaultTools select it at startup. session_start resolves whether
  // the directory supports workspaces before any model request is made.
  registerWorkspaceTool(true, []);
  for (const operation of ["workspace.enter", "workspace.integrate", "workspace.discard", "workspace.revert"] as const) {
    registerServiceOperation(pi, operation, async (payload, ctx) => {
      if (!ctx.isIdle() || hasRunningSubagents()) return;
      const action = operation.slice("workspace.".length) as "enter" | "integrate" | "discard" | "revert";
      const selected = payload.id ? loadWorkspace(payload.id) : workspaceForContext(ctx.cwd, sessionFile(ctx));
      if (payload.id && !selected) return;
      if (selected && (selected.kind !== "task" || action !== "revert" && !sameSessionFile(selected.sourceSessionFile, sessionFile(ctx)))) return;
      let moved = false;
      const result = await executeWorkspace("service", { ...payload, action }, ctx.signal, undefined, ctx, async (transition, id) => {
        if (transition === "enter") await enterWorkspace(id, ctx);
        else await returnWorkspace(id, ctx);
        moved = true;
      });
      const record = result.details as WorkspaceRecord;
      const current = record?.id ? loadWorkspace(record.id) : undefined;
      const cleanupIncomplete = current?.lifecycle === "cleanup_failed" && (moved || result.cleanupAttempted === true);
      const changed = moved || current?.lifecycle === "discarded" || cleanupIncomplete && !current.retained;
      const commitData = { commit: current?.integrationCommit?.oid, reverts: current?.reverts?.commit };
      if (cleanupIncomplete) {
        return { changed, workspaceId: current.id, lifecycle: current.lifecycle, integration: current.integration, status: "cleanup_incomplete", ...commitData };
      }
      if (action === "revert" && current && !moved) return { changed: true, workspaceId: current.id, lifecycle: current.lifecycle, integration: current.integration, status: "revert_not_prepared", ...commitData };
      if (!changed && !(action === "enter" && current?.lifecycle === "active")) {
        if (current?.integrationReview?.applied) throw new Error("Workspace integration may be partially applied; inspect retained review data");
        return;
      }
      return { changed, workspaceId: current?.id, lifecycle: current?.lifecycle, integration: current?.integration, ...commitData };
    });
  }
}
