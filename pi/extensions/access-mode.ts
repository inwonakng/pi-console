import {
  createBashToolDefinition,
  generateUnifiedPatch,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import assert from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { Type } from "typebox";
import { getAccessMode, parseAccessMode, setAccessMode } from "./shared/access-state";
import {
  createAccessControlledBashOperations,
  initializeBashSandbox,
  shutdownBashSandbox,
} from "./shared/bash-sandbox";
import {
  canonicalPath,
  getSessionGrants,
  pathInside,
  requestPermission,
  resolveToolPath,
  restorePermissionGrants,
  type Permission,
} from "./shared/permissions";
import { getInteractionMode } from "./shared/interaction-mode";
import { loadSessionSetting, saveSessionSetting } from "./shared/session-settings";

const READONLY_TOOLS = new Set(["web_search", "web_fetch", "todowrite", "question"]);
const PATH_READ_TOOLS = new Set(["read", "grep", "find", "ls"]);
const MUTATION_TOOLS = new Set(["edit", "write"]);
const KNOWN_TOOLS = new Set([
  ...READONLY_TOOLS,
  ...PATH_READ_TOOLS,
  ...MUTATION_TOOLS,
  "bash",
  "workspace",
  "spawn",
  "spawn_control",
]);
const READONLY_WORKSPACE_ACTIONS = new Set(["status", "list"]);
const READONLY_SPAWN_CONTROL_ACTIONS = new Set(["list", "status", "join", "join_all"]);
const ACCESS_SETTING = "access";

type PersistedAccessState = {
  mode?: string;
  grants?: unknown[];
  readPaths?: unknown[];
  permissions?: unknown[];
};

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

  const original = readFileSync(resolveToolPath(path, cwd), "utf-8");
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

  const absolutePath = resolveToolPath(path, cwd);
  if (!existsSync(absolutePath)) {
    return {
      text: content,
      filetype: "text",
    };
  }
  const original = readFileSync(absolutePath, "utf-8");
  return { text: generateUnifiedPatch(path, original, content), filetype: "diff" };
}

function previewForTool(event: ToolCallEvent, ctx: ExtensionContext): { text: string; filetype: string } {
  const input = event.input as Record<string, unknown>;
  try {
    if (event.toolName === "edit") return { text: exactEditPreview(ctx.cwd, input), filetype: "diff" };
    if (event.toolName === "write") return writePreview(ctx.cwd, input);
  } catch (error) {
    // Preview errors can reveal existing file contents (for example, edit match
    // counts). Show them only to the user, never as a pre-approval tool error.
    return { text: `Preview unavailable: ${error instanceof Error ? error.message : String(error)}\n\n${jsonPreview(input)}`, filetype: "text" };
  }
  return { text: jsonPreview(input), filetype: "json" };
}

function workspaceManagesApproval(input: Record<string, unknown>): boolean {
  return input.action === "integrate" || input.action === "discard";
}

function readonlyToolBlockReason(toolName: string, input: Record<string, unknown>): string | undefined {
  if (READONLY_TOOLS.has(toolName) || PATH_READ_TOOLS.has(toolName) || toolName === "bash") return undefined;
  if (toolName === "workspace") {
    return typeof input.action === "string" && READONLY_WORKSPACE_ACTIONS.has(input.action)
      ? undefined : "workspace action is not read-only";
  }
  if (toolName === "spawn") {
    if (input.accessMode !== "readonly") return "spawn requires explicit accessMode=readonly";
    return input.isolation === undefined || input.isolation === "none"
      ? undefined : "spawn worktree isolation is not read-only";
  }
  if (toolName === "spawn_control") {
    return typeof input.action === "string" && READONLY_SPAWN_CONTROL_ACTIONS.has(input.action)
      ? undefined : "spawn_control action is not read-only";
  }
  return `tool "${toolName}" is not read-only`;
}

function setStatus(ctx: ExtensionContext): void {
  ctx.ui.setStatus("pi-access-mode", `Mode: ${getAccessMode()}`);
}

function saveAccessState(pi: ExtensionAPI): void {
  saveSessionSetting(pi, ACCESS_SETTING, {
    mode: getAccessMode(),
    permissions: getSessionGrants(),
  });
}

function restoreAccessState(ctx: ExtensionContext, restoreGrants = true): void {
  const stored = loadSessionSetting(ctx, ACCESS_SETTING) as PersistedAccessState | undefined;
  const spawnMode = parseAccessMode(process.env.PI_SPAWN_ACCESS_MODE);
  setAccessMode(spawnMode ?? parseAccessMode(stored?.mode) ?? "ask");
  const legacy: Permission[] = [];
  for (const path of Array.isArray(stored?.readPaths) ? stored.readPaths : []) {
    if (typeof path === "string" && path.startsWith("/")) legacy.push({ kind: "read", scope: path });
  }
  for (const grant of Array.isArray(stored?.grants) ? stored.grants : []) {
    if (typeof grant !== "string" || !grant) continue;
    legacy.push(grant.startsWith("workspace-files:")
      ? { kind: "write", scope: grant.slice("workspace-files:".length) }
      : { kind: "tool", scope: grant });
  }
  restorePermissionGrants(!spawnMode && restoreGrants ? stored?.permissions ?? legacy : undefined);
  setStatus(ctx);
}

export default function accessModeExtension(pi: ExtensionAPI) {
  const defaultBash = createBashToolDefinition(process.cwd());
  pi.registerTool({
    ...defaultBash,
    label: "bash (sandboxed)",
    executionMode: "sequential",
    description: `${defaultBash.description} Request needed access before execution with readPaths, writePaths, or networkAccess. networkAccess requests outbound access to any host for this command only, without lifting filesystem restrictions. Unknown read scopes can request broadReadAccess for this command only. workspaceWriteAccess requests writing the current directory. If granular sandbox permissions cannot support the operation, request unsandboxed for unrestricted access for this invocation only. Omit timeout by default; use it for a user-requested execution deadline.`,
    outputSchema: Type.Intersect([defaultBash.outputSchema!, Type.Object({
      sandbox_blocked: Type.Optional(Type.Boolean({ description: "The sandbox detected denied access; output may be partial even when exit_code is zero." })),
    })]),
    parameters: Type.Object({
      ...defaultBash.parameters.properties,
      timeout: Type.Optional(Type.Number({
        description: "Harness-enforced execution deadline in seconds, starting after approvals. Omit by default; set when the user requests a deadline.",
      })),
      networkAccess: Type.Optional(Type.Boolean({
        description: "Request outbound network access to any host for this command only. Prompts before execution; never remembered. The command can send data it can read, including inherited environment values. Filesystem restrictions and sandbox network safeguards remain in place.",
      })),
      readPaths: Type.Optional(Type.Array(Type.String({ minLength: 1 }), {
        description: "External files or directories needed by this command. Prompts before execution; directory approval covers descendants. Session grants are shared with file tools.",
      })),
      writePaths: Type.Optional(Type.Array(Type.String({ minLength: 1 }), {
        description: "Files or directories this command needs to read and write, including outside the working directory. Requests approval before execution; session grants are shared with edit/write tools.",
      })),
      broadReadAccess: Type.Optional(Type.Boolean({
        description: "Request all filesystem reads for this command only when required paths are unknown. Does not grant writes or network access. No credential-path exclusions.",
      })),
      workspaceWriteAccess: Type.Optional(Type.Boolean({
        description: "Request reading and writing the current working directory before execution; equivalent to including it in writePaths.",
      })),
      unsandboxed: Type.Optional(Type.Boolean({
        description: "Ask to execute this command outside the sandbox once, with unrestricted host filesystem, environment, and network access. Never remembered; does not change the session's access mode.",
      })),
    }),
    promptGuidelines: [
      ...(defaultBash.promptGuidelines ?? []),
      "Declare readPaths and writePaths before shell inspection or mutation. All paths, including session logs and credential files, can be approved. In ask mode, workspaceWriteAccess=true requests writing the current directory. Unknown read paths can request broadReadAccess=true for this command only.",
      "Request networkAccess=true upfront for commands that need outbound connections, such as dependency downloads or remote API calls. It grants access to any host for that command only, not filesystem access. Undeclared access is denied during execution; the proxy never opens a permission prompt. Existing saved host grants still apply.",
      "Omit bash.timeout by default. Do not add command-level timeouts such as curl --max-time, curl --connect-timeout, or the timeout utility unless the user requested them or you are specifically testing timeout behavior. For a user-requested execution deadline, use bash.timeout instead.",
      "If an operation cannot be supported by granular sandbox permissions, request unsandboxed=true to ask for unrestricted host access for one command, without changing the session's mode.",
      "Denied access is not task completion. A sandbox-blocked command may have partially executed and written files, even when its exit code is zero. Inspect partial output and state, then request needed access with an appropriate continuation. Do not blindly rerun. Permissions are requested through tool arguments, not the question tool.",
    ],
    async execute(id, params, signal, onUpdate, ctx) {
      let sandboxBlocked = false;
      const sandboxedBash = createBashToolDefinition(ctx.cwd, {
        operations: createAccessControlledBashOperations(ctx, params, () => saveAccessState(pi), () => {
          sandboxBlocked = true;
        }),
      });
      const result = await sandboxedBash.execute(id, params, signal, onUpdate, ctx);
      return sandboxBlocked ? {
        ...result,
        isError: true,
        details: { ...result.details, sandboxBlocked: true },
        structuredContent: result.structuredContent && typeof result.structuredContent === "object" && !Array.isArray(result.structuredContent)
          ? { ...result.structuredContent, sandbox_blocked: true }
          : result.structuredContent,
      } : result;
    },
  });

  pi.on("user_bash", (_event, ctx) => {
    const mode = getAccessMode();
    const interactive = getInteractionMode(ctx) === "interactive";
    // User shell input has no path declaration fields. Ask upfront rather than
    // retrying a partially executed command after a filesystem denial.
    return { operations: createAccessControlledBashOperations(ctx, {
      broadReadAccess: interactive && (mode === "ask" || mode === "edit"),
      networkAccess: interactive && (mode === "ask" || mode === "edit"),
      workspaceWriteAccess: interactive && mode === "ask",
    }, () => saveAccessState(pi)) };
  });

  pi.on("session_start", async (event, ctx) => {
    const startsAnotherSession = event.reason === "new" || event.reason === "fork";
    restoreAccessState(ctx, !startsAnotherSession);
    if (event.reason === "fork" && !process.env.PI_SPAWN_ACCESS_MODE) saveAccessState(pi);
    await initializeBashSandbox(ctx);
  });

  pi.on("session_tree", (_event, ctx) => {
    restoreAccessState(ctx);
  });

  pi.on("session_shutdown", async () => {
    await shutdownBashSandbox();
  });

  pi.on("tool_call", async (event, ctx) => {
    setStatus(ctx);
    const mode = getAccessMode();
    if (mode === "full" || event.toolName === "bash") return undefined;

    const input = event.input as Record<string, unknown>;
    if (event.toolName === "workspace" && workspaceManagesApproval(input)) {
      return mode === "readonly"
        ? { block: true, reason: `Tool "workspace" is blocked in readonly mode (${String(input.action)} mutates the workspace).` }
        : undefined;
    }

    if (PATH_READ_TOOLS.has(event.toolName) || MUTATION_TOOLS.has(event.toolName)) {
      try {
        const path = canonicalPath(resolveToolPath(typeof input.path === "string" ? input.path : ".", ctx.cwd));
        // Execute against the same target that was approved, not a retargeted alias.
        input.path = path;
        const writing = MUTATION_TOOLS.has(event.toolName);
        const scope = writing && pathInside(canonicalPath(ctx.cwd), path) ? canonicalPath(ctx.cwd) : path;
        await requestPermission(ctx, { kind: writing ? "write" : "read", scope }, event.toolName,
          () => previewForTool(event, ctx), () => saveAccessState(pi));
      } catch (error) {
        return { block: true, reason: error instanceof Error ? error.message : String(error) };
      }
      return undefined;
    }

    if (event.toolName === "spawn") {
      if (input.accessMode === "full") {
        return {
          block: true,
          reason: "Full-mode subagents require parent access mode full. Run /pi-mode full before delegating unrestricted work.",
        };
      }
      if ((input.accessMode === "edit" || input.isolation === "worktree") && mode !== "edit") {
        return {
          block: true,
          reason: "Spawning edit-mode or isolated subagents requires parent access mode edit or full. Run /pi-mode edit before delegating edit work.",
        };
      }
    }

    if (mode === "edit" && KNOWN_TOOLS.has(event.toolName)) return undefined;
    if (!readonlyToolBlockReason(event.toolName, input)) return undefined;
    try {
      const action = typeof input.action === "string" ? `:${input.action}` : "";
      await requestPermission(ctx, { kind: "tool", scope: `${event.toolName}${action}` }, event.toolName,
        () => previewForTool(event, ctx), () => saveAccessState(pi));
      return undefined;
    } catch (error) {
      return { block: true, reason: error instanceof Error ? error.message : String(error) };
    }
  });

  pi.registerCommand("pi-mode", {
    description: "Set access mode: /pi-mode readonly|ask|edit|full",
    handler: async (args, ctx) => {
      const requestedMode = parseAccessMode(args);
      if (!requestedMode) {
        ctx.ui.notify("Usage: /pi-mode readonly|ask|edit|full", "warning");
        setStatus(ctx);
        return;
      }
      const changed = requestedMode !== getAccessMode();
      setAccessMode(requestedMode);
      if (changed) saveAccessState(pi);
      setStatus(ctx);
      ctx.ui.notify(`Access mode: ${getAccessMode()}`, "info");
    },
  });
}
