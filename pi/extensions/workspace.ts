import {
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAccessMode } from "./shared/access-state";
import { resolveToolPath } from "./shared/paths";
import {
  getIntegrationMode,
  parseIntegrationMode,
  setIntegrationMode,
  type IntegrationMode,
} from "./shared/integration-state";
import { getInteractionMode } from "./shared/interaction-mode";
import { notifyPiWorkspaceIntegration, suppressNextInputNotification } from "./shared/notifications";
import { loadSessionSetting, saveSessionSetting } from "./shared/session-settings";
import { activeLocation, moveToLocation, publishWorkspaceState } from "./shared/workspace-navigation";
import {
  createWorkspace,
  findGitRoot,
  formatWorkspaceRecord,
  getExpectedWorkspaceMissing,
  getPendingWorkspaceId,
  integrateWorkspace,
  isWorkspaceFinalized,
  taskWorkspacesForSession,
  listWorkspaces,
  loadWorkspace,
  pathInside,
  prepareWorkspaceDiscard,
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

const WORKSPACE_ACTIONS = ["enter", "status", "list", "integrate", "discard"] as const;
type WorkspaceAction = (typeof WORKSPACE_ACTIONS)[number];
const TRANSITION_ACTIONS = new Set<WorkspaceAction>(["enter", "integrate", "discard"]);

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
  setIntegrationMode(parseIntegrationMode(typeof stored === "string" ? stored : undefined) ?? "ask");
  publishIntegrationMode(ctx);
}

function queueCommand(pi: ExtensionAPI, command: string): void {
  pi.sendUserMessage(command, {
    deliverAs: "followUp",
    expandPromptTemplates: true,
  });
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

function managedRepositoryPath(path: string): boolean {
  return listWorkspaces().some((record) =>
    record.retained
    && (pathInside(record.worktreePath, path) || pathInside(record.destinationRoot, path))
  );
}

function hasMixedWorkspaceTransition(ctx: ExtensionContext): boolean {
  const branch = ctx.sessionManager.getBranch();
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (entry.type !== "message" || entry.message.role !== "assistant") {
      continue;
    }
    const content = Array.isArray(entry.message.content) ? entry.message.content : [];
    const calls = content.filter((item) => item.type === "toolCall");
    return calls.length > 1 && calls.some((call) => {
      if (call.name !== "workspace" || typeof call.arguments !== "object" || !call.arguments) {
        return false;
      }
      const action = (call.arguments as Record<string, unknown>).action;
      return typeof action === "string" && TRANSITION_ACTIONS.has(action as WorkspaceAction);
    });
  }
  return false;
}

function workspaceBlockReason(
  toolName: string,
  input: Record<string, unknown>,
  ctx: ExtensionContext,
): string | undefined {
  let repositoryEdit = false;
  let mutationPath: string | undefined;
  if (toolName === "edit" || toolName === "write") {
    const gitRoot = findGitRoot(ctx.cwd);
    mutationPath = typeof input.path === "string" ? resolveToolPath(input.path, ctx.cwd) : undefined;
    repositoryEdit = !mutationPath
      || (!!gitRoot && pathInside(gitRoot, mutationPath))
      || managedRepositoryPath(mutationPath);
  }
  if (!repositoryEdit) {
    return undefined;
  }

  const active = workspaceForContext(ctx.cwd, sessionFile(ctx));
  if (active && existsSync(active.worktreePath)) {
    if (active.kind === "task" && !sameSessionFile(active.sourceSessionFile, sessionFile(ctx))) {
      return `Workspace ${active.id} belongs to a different Pi session; edits in this worktree are blocked.`;
    }
    if (isWorkspaceFinalized(active)) {
      return `Workspace ${active.id} has a finalized contribution and is retained only for cleanup; it cannot be edited.`;
    }
    if (mutationPath && !pathInside(active.worktreePath, mutationPath)) {
      return `Repository mutations for workspace ${active.id} must target its worktree. Use a path relative to ${active.workspaceCwd}.`;
    }
    return undefined;
  }

  const missing = getExpectedWorkspaceMissing();
  if (missing) {
    return `Expected Pi workspace ${missing} is missing. Inspect or discard the retained workspace record before editing.`;
  }
  return undefined;
}

async function confirmDestructive(
  ctx: ExtensionContext,
  title: string,
  message: string,
  approved: boolean | undefined,
): Promise<boolean> {
  if (getIntegrationMode() === "allowed") return true;
  if (getInteractionMode(ctx) === "interactive") {
    return ctx.ui.confirm(title, message, { signal: ctx.signal });
  }
  return approved === true;
}

export default function workspaceExtension(pi: ExtensionAPI) {
  let runtimeCancellation = new AbortController();
  pi.on("session_shutdown", () => runtimeCancellation.abort());
  pi.on("session_start", (event, ctx) => {
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
          setPendingWorkspace(workspaceId);
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
    publishWorkspaceState(ctx);
  });

  pi.on("session_tree", (_event, ctx) => {
    restoreIntegrationMode(ctx);
  });

  pi.on("session_before_fork", (_event, ctx) => {
    if (!workspaceForContext(ctx.cwd, sessionFile(ctx))) return;
    ctx.ui.notify("A workspace belongs to one conversation. Use the tree for another branch, or return to the origin checkout before forking.", "warning");
    return { cancel: true };
  });

  pi.on("before_agent_start", (event) => {
    const guidance = getIntegrationMode() === "allowed"
      ? "Workspace integration mode is allowed. Top-level integration and workspace discard, including child-workspace discard, are pre-authorized. After completing and verifying requested work, call workspace with action=integrate; no user confirmation is required."
      : "Workspace integration mode is ask. Top-level integration and workspace discard, including child-workspace discard, require confirmation. After completing and verifying requested work, call workspace with action=integrate; Pi will request user confirmation before applying it.";
    return { systemPrompt: `${event.systemPrompt}\n\n${guidance}` };
  });

  pi.on("tool_call", (event, ctx) => {
    const input = event.input as Record<string, unknown>;
    if (hasMixedWorkspaceTransition(ctx)) {
      return {
        block: true,
        reason: "Workspace transition actions must be the only tool call in their assistant response. Retry the transition by itself.",
      };
    }
    const pendingWorkspaceId = getPendingWorkspaceId();
    if (pendingWorkspaceId) {
      return {
        block: true,
        reason: `Workspace transition to ${pendingWorkspaceId} is queued. Wait for the cwd switch before using more tools.`,
        terminate: true,
      };
    }
    if (getAccessMode() === "full") return undefined;
    const reason = workspaceBlockReason(event.toolName, input, ctx);
    return reason ? { block: true, reason } : undefined;
  });

  pi.registerCommand("pi-workspace-enter", {
    description: "Internal command that moves the current session into its task worktree",
    handler: async (args, ctx) => {
      const record = loadWorkspace(args.trim());
      if (!record || record.kind !== "task" || !record.retained || isWorkspaceFinalized(record)
        || !sameSessionFile(record.sourceSessionFile, sessionFile(ctx))) {
        setPendingWorkspace(undefined);
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
      } catch (error) {
        const transitionPending = getPendingWorkspaceId() !== undefined;
        setPendingWorkspace(undefined);
        if (transitionPending) publishWorkspaceState(ctx);
        await updateWorkspace(record.id, (current) => {
          current.lifecycle = "retained";
          current.integrationReason = error instanceof Error ? error.message : String(error);
        });
        throw error;
      }
    },
  });

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

  pi.registerCommand("pi-workspace-return", {
    description: "Internal command that returns this session to its origin checkout",
    handler: async (args, ctx) => {
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
      } catch (error) {
        const transitionPending = getPendingWorkspaceId() !== undefined;
        setPendingWorkspace(undefined);
        if (transitionPending) publishWorkspaceState(ctx);
        const retained = loadWorkspace(id);
        if (retained?.retained && !isWorkspaceFinalized(retained)) {
          await updateWorkspace(id, (current) => {
            current.integrationReason = error instanceof Error ? error.message : String(error);
          });
        }
        throw error;
      }
    },
  });

  pi.registerCommand("pi-workspace-publish", {
    description: "Publish the current workspace state to the active host",
    handler: async (_args, ctx) => {
      publishWorkspaceState(ctx);
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
      publishIntegrationMode(ctx);
      ctx.ui.notify(`Integration mode: ${getIntegrationMode()}`, "info");
    },
  });

  pi.registerCommand("pi-workspace", {
    description: "Show Pi workspace status or list retained workspaces",
    handler: async (args, ctx) => {
      const action = args.trim() || "status";
      if (action === "status") {
        publishWorkspaceState(ctx);
        ctx.ui.notify(formatStatus(ctx), "info");
        return;
      }
      if (action === "list") {
        const records = listWorkspaces();
        ctx.ui.notify(records.length > 0 ? records.map(formatWorkspaceRecord).join("\n\n") : "No Pi workspaces.", "info");
        return;
      }
      ctx.ui.notify("Usage: /pi-workspace status|list", "warning");
    },
  });

  pi.registerTool({
    name: "workspace",
    label: "Workspace",
    description: "Create/reuse a task worktree, optionally copying named ignored files on entry, inspect workspace state, integrate or discard. Status includes full workspace paths.",
    promptSnippet: "Manage the current task's isolated Git worktree and integration lifecycle.",
    promptGuidelines: [
      "Before making implementation changes with edit or write inside the git repository containing the current session cwd, call workspace with action=enter as the only tool call in that assistant response, unless the current session is already in an associated workspace. To edit existing ignored files, provide their paths relative to the original cwd in ignoredFiles on the first enter call; only those files are copied and later integrated. Wait for the cwd switch before using more tools.",
      "Temporary probes, scripts, and generated artifacts may be created under $TMPDIR without entering a workspace; keep them outside the repository and remove them when finished.",
      "Call workspace with action=status when the expected workspace is missing or its lifecycle is unclear.",
      "Top-level workspace integration and workspace discard, including child-workspace discard, follow the active integration mode: ask requests confirmation and allowed is pre-authorized.",
      "Call workspace with action=integrate or action=discard as the only tool call in that assistant response when the action will leave the active workspace. Wait for the cwd switch before using more tools.",
    ],
    parameters: Type.Object({
      action: StringEnum(WORKSPACE_ACTIONS, { description: "Workspace lifecycle action." }),
      id: Type.Optional(Type.String({ description: "Workspace id for enter, status, integration, or discard; enter creates a new task workspace unless an id is specified." })),
      ignoredFiles: Type.Optional(Type.Array(Type.String(), { description: "Existing ignored file paths relative to the original cwd, copied into a new task worktree on enter and copied back on integration." })),
      approved: Type.Optional(Type.Boolean({ description: "Required for integration or discard in ask mode when no interactive UI is available; does not bypass interactive confirmation." })),
    }),
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const action = params.action as WorkspaceAction;
      if (action === "status") {
        const record = params.id ? loadWorkspace(params.id) : workspaceForContext(ctx.cwd, sessionFile(ctx));
        const text = record ? formatWorkspaceRecord(record) : formatStatus(ctx);
        publishWorkspaceState(ctx);
        return { content: [{ type: "text", text }], details: record ?? workspaceDisplayState(ctx.cwd, sessionFile(ctx)) };
      }
      if (action === "list") {
        const records = listWorkspaces();
        return {
          content: [{ type: "text", text: records.length > 0 ? records.map(formatWorkspaceRecord).join("\n\n") : "No Pi workspaces." }],
          details: { records },
        };
      }
      if (params.ignoredFiles !== undefined && action !== "enter") {
        throw new Error("ignoredFiles only applies to action=enter.");
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
        setPendingWorkspace(record.id);
        publishWorkspaceState(ctx);
        queueCommand(pi, `/pi-workspace-enter ${record.id}`);
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
        const integrationMode = getIntegrationMode();
        let decision = integrationMode === "allowed" || params.approved === true
          ? INTEGRATE_ACTION
          : RETURN_ACTION;
        if (integrationMode === "ask" && getInteractionMode(ctx) === "interactive") {
          while (true) {
            notifyPiWorkspaceIntegration(ctx);
            const prompt = `Apply ${selected.label} to ${selected.destinationRoot}?${ignoredReviewNote(selected)}`;
            decision = await ctx.ui.select(
              ctx.mode === "rpc" ? JSON.stringify({ kind: "pi_compact_select", prompt }) : prompt,
              [INTEGRATE_ACTION, REVIEW_ACTION, RETURN_ACTION],
              { signal: ctx.signal },
            ) ?? RETURN_ACTION;
            if (decision !== REVIEW_ACTION) {
              break;
            }
            const review = launchWorkspaceReview(selected);
            if (!review.launched) {
              return retainedForManualReview(selected, review.reason);
            }
            // The loop immediately reopens the same picker after Review; only its first appearance should ping.
            suppressNextInputNotification();
          }
        }
        if (decision !== INTEGRATE_ACTION) {
          return {
            content: [{ type: "text", text: "Workspace retained without integration." }],
            details: selected,
            terminate: true,
          };
        }
        const operationSignal = signal ? AbortSignal.any([signal, runtimeCancellation.signal]) : runtimeCancellation.signal;
        const integrated = await integrateWorkspace(selected.id, operationSignal);
        if (integrated.integration !== "applied" && integrated.integration !== "none") {
          return {
            content: [{ type: "text", text: `Workspace was retained; integration=${integrated.integration}.\n${formatWorkspaceRecord(integrated)}` }],
            details: integrated,
          };
        }
        setPendingWorkspace(integrated.id);
        publishWorkspaceState(ctx);
        queueCommand(pi, `/pi-workspace-return ${integrated.id}`);
        return {
          content: [{
            type: "text",
            text: `Applied the task contribution to ${integrated.destinationRoot}. The return cwd switch is queued; wait before using more tools.`,
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
        setPendingWorkspace(prepared.id);
        publishWorkspaceState(ctx);
        queueCommand(pi, `/pi-workspace-return ${prepared.id}`);
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
          ? `Discard cleanup failed; workspace retained: ${discarded.integrationReason ?? discarded.worktreePath}`
          : `Discarded ${discarded.label}. Recovery patch: ${discarded.resultPatchPath}` }],
        details: discarded,
      };
    },
  });
}
