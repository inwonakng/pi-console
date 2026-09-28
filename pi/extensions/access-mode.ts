import {
  generateUnifiedPatch,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import assert from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { getAccessMode, parseAccessMode, setAccessMode } from "./shared/access-state";
import { rememberCommand, readonlyBashBlockReason } from "./shared/bash-access";
import { getInteractionMode } from "./shared/interaction-mode";
import { notifyPiToolApproval } from "./shared/notifications";

export { readonlyBashBlockReason } from "./shared/bash-access";

const READONLY_TOOLS = new Set(["read", "grep", "find", "ls", "web_search", "web_fetch", "todowrite", "question"]);
const READONLY_WORKSPACE_ACTIONS = new Set(["status", "list"]);
const READONLY_SPAWN_CONTROL_ACTIONS = new Set(["list", "status", "join", "join_all"]);

function jsonPreview(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? String(value);
}

function assertEdit(value: unknown): asserts value is { oldText: string; newText: string } {
  assert(typeof value === "object" && value !== null, "invalid edit object");
  const edit = value as Record<string, unknown>;
  assert(typeof edit.oldText === "string", "edit.oldText must be a string");
  assert(edit.oldText.length > 0, "edit.oldText must not be empty");
  assert(typeof edit.newText === "string", "edit.newText must be a string");
}

function exactEditPreview(cwd: string, input: Record<string, unknown>): string {
  const path = input.path;
  const edits = input.edits;
  if (typeof path !== "string" || !Array.isArray(edits)) {
    return jsonPreview(input);
  }

  const original = readFileSync(resolve(cwd, path), "utf-8");
  const replacements: Array<{ index: number; oldText: string; newText: string }> = [];
  for (const edit of edits) {
    assertEdit(edit);
    const index = original.indexOf(edit.oldText);
    const matches = original.split(edit.oldText).length - 1;
    assert(matches === 1, `Cannot preview edit for ${path}: oldText matched ${matches} times.`);
    replacements.push({ index, oldText: edit.oldText, newText: edit.newText });
  }

  replacements.sort((left, right) => right.index - left.index);
  for (let index = 0; index < replacements.length - 1; index++) {
    const current = replacements[index];
    const next = replacements[index + 1];
    assert(next.index + next.oldText.length <= current.index, `Cannot preview edit for ${path}: edits overlap.`);
  }

  let nextContent = original;
  for (const replacement of replacements) {
    nextContent =
      nextContent.slice(0, replacement.index) +
      replacement.newText +
      nextContent.slice(replacement.index + replacement.oldText.length);
  }
  return generateUnifiedPatch(path, original, nextContent);
}

function writePreview(cwd: string, input: Record<string, unknown>): { text: string; filetype: string } {
  const path = input.path;
  const content = input.content;
  if (typeof path !== "string" || typeof content !== "string") {
    return { text: jsonPreview(input), filetype: "json" };
  }

  const absolutePath = resolve(cwd, path);
  if (!existsSync(absolutePath)) {
    return {
      text: `# New file: ${path}\n# Directory: ${dirname(absolutePath)}\n\n${content}`,
      filetype: "text",
    };
  }
  const original = readFileSync(absolutePath, "utf-8");
  return { text: generateUnifiedPatch(path, original, content), filetype: "diff" };
}

function previewForTool(event: ToolCallEvent, ctx: ExtensionContext): { text: string; filetype: string } {
  const input = event.input as Record<string, unknown>;
  if (event.toolName === "bash") {
    const command = typeof input.command === "string" ? input.command : jsonPreview(input);
    return {
      filetype: "sh",
      text: `# cwd: ${ctx.cwd}\n# mode: ${getAccessMode()}\n\n${command}`,
    };
  }
  if (event.toolName === "edit") {
    return { text: exactEditPreview(ctx.cwd, input), filetype: "diff" };
  }
  if (event.toolName === "write") {
    return writePreview(ctx.cwd, input);
  }
  return { text: jsonPreview(input), filetype: "json" };
}

function approvalPayload(event: ToolCallEvent, ctx: ExtensionContext): string {
  const preview = previewForTool(event, ctx);
  const input = event.input as Record<string, unknown>;
  const summary = event.toolName === "bash" && typeof input.command === "string"
    ? input.command
    : typeof input.path === "string"
      ? input.path
      : JSON.stringify(input);
  return JSON.stringify({
    kind: "pi_approval_preview",
    tool: event.toolName,
    mode: getAccessMode(),
    summary,
    preview_filetype: preview.filetype,
    preview: preview.text,
  });
}

function workspaceManagesApproval(input: Record<string, unknown>): boolean {
  return input.action === "integrate" || input.action === "discard";
}

function readonlyToolBlockReason(toolName: string, input: Record<string, unknown>): string | undefined {
  if (READONLY_TOOLS.has(toolName)) return undefined;
  if (toolName === "bash") {
    if (typeof input.command !== "string") return "bash requires a command that can be classified as read-only";
    const reason = readonlyBashBlockReason(input.command);
    return reason ? `bash command is not read-only: ${reason}` : undefined;
  }
  if (toolName === "workspace") {
    return typeof input.action === "string" && READONLY_WORKSPACE_ACTIONS.has(input.action)
      ? undefined : "workspace action is not whitelisted as read-only";
  }
  if (toolName === "spawn") {
    if (input.accessMode !== "readonly") return "spawn requires explicit accessMode=readonly";
    return input.isolation === undefined || input.isolation === "none"
      ? undefined : "spawn worktree isolation is not read-only";
  }
  if (toolName === "spawn_control") {
    return typeof input.action === "string" && READONLY_SPAWN_CONTROL_ACTIONS.has(input.action)
      ? undefined : "spawn_control action is not whitelisted as read-only";
  }
  return `tool "${toolName}" is not whitelisted as read-only`;
}

function setStatus(ctx: ExtensionContext): void {
  ctx.ui.setStatus("pi-access-mode", `Mode: ${getAccessMode()}`);
}

export default function accessModeExtension(pi: ExtensionAPI) {
  pi.on("session_start", (event, ctx) => {
    void event;
    setStatus(ctx);
  });

  pi.on("tool_call", async (event, ctx) => {
    setStatus(ctx);
    const mode = getAccessMode();
    if (mode === "edit") return undefined;

    const input = event.input as Record<string, unknown>;
    if (event.toolName === "workspace" && workspaceManagesApproval(input)) return undefined;

    const reason = readonlyToolBlockReason(event.toolName, input);
    if (!reason) return undefined;

    if (event.toolName === "spawn" && (input.accessMode === "edit" || input.isolation === "worktree")) {
      return {
        block: true,
        reason: "Spawning edit-mode or isolated subagents requires parent access mode edit. Run /pi-mode edit before delegating edit work.",
      };
    }
    if (mode === "readonly") return { block: true, reason: `Tool "${event.toolName}" is blocked in readonly mode (${reason}).` };
    if (getInteractionMode(ctx) === "noninteractive") {
      return {
        block: true,
        reason: `Tool "${event.toolName}" requires approval (${reason}), but interaction mode is noninteractive.`,
      };
    }

    if (event.toolName === "bash" && typeof input.command === "string") {
      const title = ctx.mode === "rpc" ? approvalPayload(event, ctx) : `Allow bash? ${input.command}`;
      while (true) {
        notifyPiToolApproval(ctx);
        const choice = await ctx.ui.select(title, ["Allow", "Deny", "Remember and allow", "Remember with comment and allow"]);
        if (choice === "Allow") return undefined;
        if (choice === "Deny" || !choice) {
          return { block: true, reason: `Tool "${event.toolName}" blocked by user.` };
        }

        let note = "";
        if (choice === "Remember with comment and allow") {
          const noteTitle = ctx.mode === "rpc"
            ? JSON.stringify({ kind: "pi_remember_note" })
            : "Reason for remembering command (cancel to return to approval)";
          const entered = await ctx.ui.input(noteTitle);
          if (entered === undefined) continue;
          if (!entered.trim()) {
            ctx.ui.notify("Enter a comment to remember, or choose Remember and allow instead.", "warning");
            continue;
          }
          note = entered;
        }
        try {
          rememberCommand(input.command, ctx.cwd, note);
          ctx.ui.notify("Command remembered for review and allowed.", "info");
          return undefined;
        } catch (error) {
          return { block: true, reason: `Could not remember bash command: ${String(error)}` };
        }
      }
    }

    notifyPiToolApproval(ctx);
    const confirmed = await ctx.ui.confirm(`Allow ${event.toolName}?`, approvalPayload(event, ctx), { signal: ctx.signal });
    return confirmed ? undefined : { block: true, reason: `Tool "${event.toolName}" blocked by user.` };
  });

  pi.registerCommand("pi-mode", {
    description: "Set access mode: /pi-mode readonly|ask|edit",
    handler: async (args, ctx) => {
      const requestedMode = parseAccessMode(args);
      if (!requestedMode) {
        ctx.ui.notify("Usage: /pi-mode readonly|ask|edit", "warning");
        setStatus(ctx);
        return;
      }
      setAccessMode(requestedMode);
      setStatus(ctx);
      ctx.ui.notify(`Access mode: ${getAccessMode()}`, "info");
    },
  });
}
