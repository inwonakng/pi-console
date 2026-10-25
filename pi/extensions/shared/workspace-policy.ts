import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { getAccessMode } from "./access-state";
import { resolveToolPath } from "./paths";
import { canonicalPath } from "./permissions";
import { subagentWriteBlock } from "./subagent-state";
import { findGitRoot, getExpectedWorkspaceMissing, getPendingWorkspaceId, isWorkspaceFinalized,
  listWorkspaces, pathInside, sameSessionFile, workspaceForContext } from "./workspace";

const TRANSITION_ACTIONS = new Set(["enter", "integrate", "discard", "revert"]);

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
      return typeof action === "string" && TRANSITION_ACTIONS.has(action);
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

  const active = workspaceForContext(ctx.cwd, ctx.sessionManager.getSessionFile());
  if (active && existsSync(active.worktreePath)) {
    if (active.kind === "task" && !sameSessionFile(active.sourceSessionFile, ctx.sessionManager.getSessionFile())) {
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

/** Managed children have write authority only during an unfinished revision. */
export function childWorkspaceWriteBlock(ctx: ExtensionContext): string | undefined {
  const active = workspaceForContext(ctx.cwd, ctx.sessionManager.getSessionFile())
    ?? listWorkspaces().filter((record) => record.kind === "child" && pathInside(record.worktreePath, canonicalPath(ctx.cwd)))
      .sort((left, right) => right.worktreePath.length - left.worktreePath.length)[0];
  if (active?.kind !== "child") return undefined;
  if (isWorkspaceFinalized(active) || !active.retained || active.lifecycle === "discarded") {
    return `Workspace ${active.id} is finalized or disposed; further writes are forbidden.`;
  }
  if (active.runId && !active.managedCleanupPending) {
    return `Workspace ${active.id} is waiting for review; only a correction assignment can re-enable writing.`;
  }
  return undefined;
}

/** Run before approval and again before execution; extension load order is not policy. */
export function workspaceToolBlock(toolName: string, input: Record<string, unknown>, ctx: ExtensionContext):
  { block: true; reason: string; terminate?: boolean } | undefined {
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
  if (toolName === "edit" || toolName === "write") {
    const childBlock = childWorkspaceWriteBlock(ctx);
    const target = typeof input.path === "string" ? canonicalPath(resolveToolPath(input.path, ctx.cwd)) : canonicalPath(ctx.cwd);
    const reason = childBlock ?? subagentWriteBlock(target);
    if (reason) return { block: true, reason };
  }
  if (getAccessMode() === "full") return undefined;
  const reason = workspaceBlockReason(toolName, input, ctx);
  return reason ? { block: true, reason } : undefined;
}
