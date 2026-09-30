import {
  createBashToolDefinition,
  generateUnifiedPatch,
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import assert from "node:assert";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { getAccessMode, parseAccessMode, setAccessMode } from "./shared/access-state";
import {
  createAccessControlledBashOperations,
  initializeBashSandbox,
  shutdownBashSandbox,
} from "./shared/bash-sandbox";
import { getInteractionMode } from "./shared/interaction-mode";
import { notifyPiToolApproval } from "./shared/notifications";
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
const sessionCapabilityGrants = new Set<string>();
const ACCESS_SETTING = "access";

type PersistedAccessState = {
  mode?: string;
  grants?: unknown[];
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
      text: content,
      filetype: "text",
    };
  }
  const original = readFileSync(absolutePath, "utf-8");
  return { text: generateUnifiedPatch(path, original, content), filetype: "diff" };
}

function previewForTool(event: ToolCallEvent, ctx: ExtensionContext): { text: string; filetype: string } {
  const input = event.input as Record<string, unknown>;
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
  const summary = typeof input.path === "string" ? input.path : JSON.stringify(input);
  return JSON.stringify({
    kind: "pi_approval_preview",
    tool: event.toolName,
    mode: getAccessMode(),
    summary,
    request: MUTATION_TOOLS.has(event.toolName)
      ? "Workspace file writes"
      : `Run ${event.toolName}${typeof input.action === "string" ? `: ${input.action}` : ""}`,
    directory: ctx.cwd,
    path: typeof input.path === "string" ? input.path : undefined,
    preview_filetype: preview.filetype,
    preview: preview.text,
  });
}

function workspaceManagesApproval(input: Record<string, unknown>): boolean {
  return input.action === "integrate" || input.action === "discard";
}

function sessionCapabilityKey(event: ToolCallEvent, ctx: ExtensionContext): string {
  if (MUTATION_TOOLS.has(event.toolName)) return `workspace-files:${canonicalPath(ctx.cwd)}`;
  const input = event.input as Record<string, unknown>;
  const action = typeof input.action === "string" ? `:${input.action}` : "";
  return `${event.toolName}${action}`;
}

function resolveToolPath(path: string, cwd: string): string {
  const normalized = path.startsWith("@") ? path.slice(1) : path;
  if (normalized === "~") return homedir();
  if (normalized.startsWith("~/")) return join(homedir(), normalized.slice(2));
  return resolve(cwd, normalized);
}

function canonicalPath(path: string): string {
  let current = resolve(path);
  const suffix: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return resolve(path);
    suffix.unshift(basename(current));
    current = parent;
  }
  return resolve(realpathSync.native(current), ...suffix);
}

function pathInside(parent: string, child: string): boolean {
  const rel = relative(canonicalPath(parent), canonicalPath(child));
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep));
}

function agentPathReadable(path: string): boolean {
  const agentDir = getAgentDir();
  return [
    join(agentDir, "AGENTS.md"),
    join(agentDir, "agents"),
    join(agentDir, "prompts"),
    join(agentDir, "skills"),
  ].some((allowed) => pathInside(allowed, path));
}

function sensitiveReadPaths(): string[] {
  const home = homedir();
  const agentDir = getAgentDir();
  return [
    join(agentDir, "auth.json"),
    join(agentDir, "bash-access.json"),
    join(agentDir, "history"),
    join(agentDir, "models-store.json"),
    join(agentDir, "pi-console-config.yaml"),
    join(agentDir, "sessions"),
    join(agentDir, "settings.json"),
    join(home, ".pi", "sessions"),
    join(home, ".aws"),
    join(home, ".config", "gcloud"),
    join(home, ".config", "gh"),
    join(home, ".docker", "config.json"),
    join(home, ".netrc"),
    join(home, ".npmrc"),
    join(home, ".ssh"),
  ];
}

function sensitiveReadPath(path: string, recursive: boolean): boolean {
  return sensitiveReadPaths().some((sensitive) =>
    pathInside(sensitive, path) || (recursive && pathInside(path, sensitive)));
}

function installedResourceReadable(path: string): boolean {
  return ["/opt", "/usr/lib/node_modules", "/usr/local/lib/node_modules"]
    .some((allowed) => pathInside(allowed, path));
}

function pathBoundaryReason(toolName: string, input: Record<string, unknown>, cwd: string): string | undefined {
  if (!PATH_READ_TOOLS.has(toolName) && !MUTATION_TOOLS.has(toolName)) return undefined;
  const requested = typeof input.path === "string" ? input.path : ".";
  const path = resolveToolPath(requested, cwd);

  if (MUTATION_TOOLS.has(toolName) && !pathInside(cwd, path)) {
    return `writes outside the working directory require full mode: ${path}`;
  }
  if (PATH_READ_TOOLS.has(toolName)) {
    const recursive = toolName !== "read";
    if (sensitiveReadPath(path, recursive)) {
      return `sensitive credential paths require full mode: ${path}`;
    }
    if (!pathInside(cwd, path) && !agentPathReadable(path) && !installedResourceReadable(path)) {
      return `reads outside the project and approved Pi resource directories require full mode: ${path}`;
    }
  }
  return undefined;
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
    grants: [...sessionCapabilityGrants],
  });
}

function restoreAccessState(ctx: ExtensionContext, restoreGrants = true): void {
  const stored = loadSessionSetting(ctx, ACCESS_SETTING) as PersistedAccessState | undefined;
  const spawnMode = parseAccessMode(process.env.PI_SPAWN_ACCESS_MODE);
  setAccessMode(spawnMode ?? parseAccessMode(stored?.mode) ?? "ask");
  sessionCapabilityGrants.clear();
  if (!spawnMode && restoreGrants && Array.isArray(stored?.grants)) {
    for (const grant of stored.grants) {
      if (typeof grant === "string" && grant.length > 0) sessionCapabilityGrants.add(grant);
    }
  }
  setStatus(ctx);
}

export default function accessModeExtension(pi: ExtensionAPI) {
  const defaultBash = createBashToolDefinition(process.cwd());
  pi.registerTool({
    ...defaultBash,
    label: "bash (sandboxed)",
    executionMode: "sequential",
    async execute(id, params, signal, onUpdate, ctx) {
      const sandboxedBash = createBashToolDefinition(ctx.cwd, {
        operations: createAccessControlledBashOperations(ctx),
      });
      return sandboxedBash.execute(id, params, signal, onUpdate, ctx);
    },
  });

  pi.on("user_bash", (_event, ctx) => ({ operations: createAccessControlledBashOperations(ctx) }));

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

    const boundaryReason = pathBoundaryReason(event.toolName, input, ctx.cwd);
    if (boundaryReason) {
      return { block: true, reason: `Tool "${event.toolName}" is blocked in ${mode} mode (${boundaryReason}).` };
    }

    if (!KNOWN_TOOLS.has(event.toolName)) {
      return {
        block: true,
        reason: `Tool "${event.toolName}" is not covered by the ${mode} capability policy; use full mode to run it.`,
      };
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

    if (mode === "edit") return undefined;

    const reason = readonlyToolBlockReason(event.toolName, input);
    if (!reason) return undefined;
    if (mode === "readonly") {
      return { block: true, reason: `Tool "${event.toolName}" is blocked in readonly mode (${reason}).` };
    }
    const capabilityKey = sessionCapabilityKey(event, ctx);
    if (sessionCapabilityGrants.has(capabilityKey)) return undefined;
    if (getInteractionMode(ctx) === "noninteractive") {
      return {
        block: true,
        reason: `Tool "${event.toolName}" requires approval (${reason}), but interaction mode is noninteractive.`,
      };
    }

    notifyPiToolApproval(ctx);
    const title = ctx.mode === "rpc" ? approvalPayload(event, ctx) : `Allow ${event.toolName}?`;
    const choice = await ctx.ui.select(title, ["Allow once", "Allow for session", "Deny"]);
    if (choice === "Allow for session") {
      sessionCapabilityGrants.add(capabilityKey);
      saveAccessState(pi);
    }
    if (choice === "Allow once" || choice === "Allow for session") return undefined;
    return { block: true, reason: `Tool "${event.toolName}" blocked by user.` };
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
