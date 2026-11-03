import {
  createBashToolDefinition,
  createEditToolDefinition,
  createWriteToolDefinition,
  generateUnifiedPatch,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import assert from "node:assert";
import { randomUUID } from "node:crypto";
import { beginRepositoryMutation } from "./shared/subagent-state";
import { constants, existsSync, readFileSync } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { Type } from "typebox";
import { accessGeneration, accessRuntimeGeneration, getAccessMode, parseAccessMode, setAccessMode, workerAccessCeiling } from "./shared/access-state";
import { registerServiceOperation } from "./shared/service-operation";
import {
  createAccessControlledBashOperations,
  initializeBashSandbox,
  shutdownBashSandbox,
} from "./shared/bash-sandbox";
import {
  canonicalPath,
  admitPermissionSnapshot,
  capturePermissionSnapshot,
  getSessionGrants,
  hasPermission,
  pathInside,
  requestPermission,
  registerPermissionHistory,
  resolveToolPath,
  restorePermissionGrants,
  type Permission,
  type PermissionExecution,
} from "./shared/permissions";
import { loadSessionSetting, saveSessionSetting } from "./shared/session-settings";
import { loadExtensionSettings } from "./shared/extension-settings";
import { workspaceToolBlock } from "./shared/workspace-policy";
import { bashJobs, initializeBashJobs, shutdownBashJobs, BashJobLaunchSchema, BashControlResultSchema, assertBashTransitionAllowed, reserveBashTransition, releaseBashTransition, type BashControlResult } from "./shared/bash-jobs";
import { BashDelivery } from "./shared/bash-delivery";
import { enrollCheckpointPath } from "./shared/checkpoint-enrollment";
import { serviceRuntimeId } from "./shared/service-ui";

const READONLY_TOOLS = new Set(["web_search", "web_fetch", "todowrite", "question", "bash_control"]);
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
const READONLY_SPAWN_CONTROL_ACTIONS = new Set(["models", "list", "status", "join", "join_all", "report", "diff", "reply", "followup", "close", "stop", "approve", "deny"]);
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
    if (event.toolName === "codemode" && typeof input.code === "string") {
      return { text: input.code, filetype: "javascript" };
    }
  } catch (error) {
    // Preview errors can reveal existing file contents (for example, edit match
    // counts). Show them only to the user, never as a pre-approval tool error.
    return { text: `Preview unavailable: ${error instanceof Error ? error.message : String(error)}\n\n${jsonPreview(input)}`, filetype: "text" };
  }
  return { text: jsonPreview(input), filetype: "json" };
}

function workspaceManagesApproval(input: Record<string, unknown>): boolean {
  return input.action === "integrate" || input.action === "discard" || input.action === "revert";
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
    permissions: getSessionGrants().filter((grant) => grant.kind !== "unsandboxed" && grant.kind !== "unix-socket"),
  });
}

function restoreAccessState(ctx: ExtensionContext, restoreGrants = true): void {
  const stored = loadSessionSetting(ctx, ACCESS_SETTING) as PersistedAccessState | undefined;
  const spawnMode = process.env.PI_SIDE_AGENT === "1" ? "ask" : parseAccessMode(process.env.PI_SPAWN_ACCESS_MODE);
  setAccessMode(workerAccessCeiling() ? getAccessMode() : spawnMode ?? parseAccessMode(stored?.mode) ?? loadExtensionSettings()["access-mode"]?.default ?? "ask");
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
  let delivery: BashDelivery | undefined;
  const jobWaits = new Map<string, { sessionId: string; controller: AbortController }>();
  const observeJoin = async (jobId: string, invocationId: string, ctx: ExtensionContext) => {
    if (jobWaits.size >= 16) throw new Error("Too many pending Bash joins");
    const controller = new AbortController();
    jobWaits.set(invocationId, { sessionId: ctx.sessionManager.getSessionId(), controller });
    try { return await bashJobs(ctx).observeJoin(jobId, controller.signal); }
    finally { jobWaits.delete(invocationId); }
  };
  registerServiceOperation(pi, "bash.list", async ({ offset }, ctx) => ({ bash: bashJobs(ctx).list(offset) }));
  registerServiceOperation(pi, "bash.status", async ({ jobId }, ctx) => ({ bash: { kind: "bash_job_status", job: bashJobs(ctx).status(jobId) } }));
  registerServiceOperation(pi, "bash.join", async ({ jobId }, ctx, { invocationId }) => ({ bash: await observeJoin(jobId, invocationId, ctx) }));
  registerServiceOperation(pi, "bash.stop", async ({ jobId }, ctx) => ({ bash: await bashJobs(ctx).stop(jobId) }));
  registerServiceOperation(pi, "bash.cancel-wait", async ({ invocationId }, ctx) => {
    const wait = jobWaits.get(invocationId);
    const cancelled = wait?.sessionId === ctx.sessionManager.getSessionId();
    if (cancelled) wait!.controller.abort();
    return { bash: { kind: "bash_wait_cancelled", invocationId, cancelled } };
  });
  // User viewing/waiting is observational: it does not consume the agent's
  // notification. Explicit stops cancel delivery as well as stopping the job.
  pi.registerCommand("pi-jobs", { description: "Bash jobs: list [offset], status/output/join/stop <jobId>, cancel-wait <waitId>", handler: async (args, ctx) => {
    const [action = "list", jobId, stream = "stdout", offset = "0"] = args.trim().split(/\s+/).filter(Boolean);
    try {
      const jobs = bashJobs(ctx);
      if (action === "cancel-wait") {
        const wait = jobWaits.get(jobId!);
        if (wait?.sessionId === jobs.sessionId) wait.controller.abort();
        ctx.ui.notify(wait ? "Bash join wait cancelled; command left running." : "No pending Bash wait.", "info");
        return;
      }
      let result: BashControlResult;
      if (action === "list") result = jobs.list(jobId === undefined ? 0 : Number(jobId));
      else if (action === "status") result = { kind: "bash_job_status", job: jobs.status(jobId!) };
      else if (action === "output") {
        if (stream !== "stdout" && stream !== "stderr") throw new Error("Choose stdout or stderr");
        result = { kind: "bash_job_output", output: jobs.output(jobId!, stream, Number(offset)) };
      } else if (action === "stop") result = await jobs.stop(jobId!);
      else if (action === "join") {
        const waitId = `native-${randomUUID()}`;
        ctx.ui.notify(`Waiting for ${jobId}. /pi-jobs stop ${jobId} stops it; /pi-jobs cancel-wait ${waitId} cancels only this wait.`, "info");
        void observeJoin(jobId!, waitId, ctx).then(result => ctx.ui.notify(JSON.stringify(result, null, 2), "info"))
          .catch(error => ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning"));
        return;
      } else throw new Error("Usage: /pi-jobs list [offset] | status/join/stop <jobId> | output <jobId> [stdout|stderr] [offset] | cancel-wait <waitId>");
      ctx.ui.notify(JSON.stringify(result, null, 2), "info");
    } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning"); }
  } });
  registerPermissionHistory(pi);
  pi.on("input", (event) => { delivery?.input(event.source); });
  pi.on("before_agent_start", (event, ctx) => { delivery?.starting(event, ctx); delivery?.watchSignal(ctx); });
  pi.on("agent_start", (_event, ctx) => { delivery?.watchSignal(ctx); });
  pi.on("message_start", (event) => { if (event.message.role === "user") delivery?.userMessage(); });
  pi.on("message_end", (event) => {
    if (event.message.role === "custom") delivery?.message(event.message.customType, event.message.details);
  });
  pi.on("context", () => { delivery?.reconcile(); });
  pi.on("agent_before_settle", (event, ctx) => delivery?.boundary(event, ctx));
  pi.on("agent_settled", (event) => { delivery?.settled(event.aborted); });
  // Private handshake, deliberately not a public Bash dashboard operation.
  registerServiceOperation(pi, "bash.interrupt", async ({ phase, frontendAvailable }, ctx) => {
    if (!delivery) return;
    if (phase === "hold") {
      try { delivery.interrupt(); } finally { ctx.abort(); }
    } else delivery.confirm(frontendAvailable);
    return { changed: true };
  });
  registerServiceOperation(pi, "bash.transition", async ({ action, token }, ctx) => {
    const ownerToken = `${serviceRuntimeId(ctx)}:${token}`;
    if (action === "acquire") reserveBashTransition(ownerToken);
    else if (!releaseBashTransition(ownerToken)) return;
    return { changed: true };
  });
  // Native gates reject current ownership. Pi exposes no cancellation-finally
  // hook for later native vetoes/summaries; pi-console's callers own the scoped
  // reservation across those waits. session_shutdown is cleanup, not a veto.
  const guardTransition = (_event: unknown, ctx: ExtensionContext) => {
    try { assertBashTransitionAllowed(); }
    catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
      return { cancel: true as const };
    }
  };
  pi.on("session_before_switch", guardTransition);
  pi.on("session_before_fork", guardTransition);
  pi.on("session_before_tree", guardTransition);
  // File mutations queue inside Pi. Authorize at their first filesystem
  // operation, after that queue, rather than releasing a stale hook approval.
  const mutationGuard = (ctx: ExtensionContext, name: "edit" | "write", input: Record<string, unknown>, signal?: AbortSignal) => {
    let execution: PermissionExecution | undefined;
    let releaseMutation: (() => void) | undefined;
    let enrolled = false;
    const generation = accessGeneration();
    const runtimeGeneration = accessRuntimeGeneration();
    const operationSignal = signal ?? ctx.signal;
    return { finish: () => { execution?.finish(); releaseMutation?.(); }, run: async <T>(target: string, operation: () => Promise<T>): Promise<T> => {
      if (operationSignal?.aborted) throw new Error("aborted");
      if (canonicalPath(target) !== target || target !== input.path) throw new Error("File target changed before execution");
      const blocked = workspaceToolBlock(name, input, ctx);
      if (blocked) throw new Error(blocked.reason);
      releaseMutation ??= beginRepositoryMutation([target]);
      if (accessGeneration() !== generation) throw new Error("File permission authority changed");
      if (!execution) {
        const scope = pathInside(canonicalPath(ctx.cwd), target) && !hasPermission({ kind: "write", scope: target }, ctx.cwd)
          ? canonicalPath(ctx.cwd) : target;
        const authorization = await requestPermission({ ...ctx, signal: operationSignal }, { kind: "write", scope }, name,
          () => previewForTool({ toolName: name, input } as ToolCallEvent, ctx), () => saveAccessState(pi), true,
          { modelPreview: { text: jsonPreview(input), filetype: "json" } });
        execution = await authorization.begin();
      }
      // Every operation checks the live action, including writes following an
      // awaited read/mkdir. Admission itself remains single-use.
      await execution.recheck();
      if (operationSignal?.aborted || accessGeneration() !== generation || canonicalPath(target) !== target) throw new Error("File operation cancelled or target changed");
      const snapshot = capturePermissionSnapshot();
      const parentAdmitted = await admitPermissionSnapshot({ ...ctx, signal: operationSignal }, snapshot);
      if (operationSignal?.aborted || (!parentAdmitted && accessGeneration() !== generation)
        || accessRuntimeGeneration() !== runtimeGeneration || target !== input.path || canonicalPath(target) !== target) throw new Error("File operation cancelled or target changed");
      if (!enrolled) {
        enrollCheckpointPath(ctx, target);
        enrolled = true;
      }
      if (operationSignal?.aborted || (!parentAdmitted && accessGeneration() !== generation)
        || accessRuntimeGeneration() !== runtimeGeneration || target !== input.path || canonicalPath(target) !== target) throw new Error("File operation cancelled or target changed");
      // Invoke the syscall in this continuation: awaiting a separate check
      // would reopen a microtask gap after the final teardown/path fence.
      return operation();
    } };
  };
  const defaultEdit = createEditToolDefinition(process.cwd());
  pi.registerTool({ ...defaultEdit, async execute(id, params, signal, update, ctx) {
    params.path = canonicalPath(resolveToolPath(params.path, ctx.cwd));
    const guard = mutationGuard(ctx, "edit", params, signal);
    try {
      return await createEditToolDefinition(ctx.cwd, { operations: {
        access: (path) => guard.run(path, () => access(path, constants.R_OK | constants.W_OK)),
        readFile: (path) => guard.run(path, () => readFile(path)),
        writeFile: (path, contents) => guard.run(path, () => writeFile(path, contents)),
      } }).execute(id, params, signal, update, ctx);
    } finally { guard.finish(); }
  } });
  const defaultWrite = createWriteToolDefinition(process.cwd());
  pi.registerTool({ ...defaultWrite, async execute(id, params, signal, update, ctx) {
    params.path = canonicalPath(resolveToolPath(params.path, ctx.cwd));
    const guard = mutationGuard(ctx, "write", params, signal);
    try {
      return await createWriteToolDefinition(ctx.cwd, { operations: {
        mkdir: (directory) => guard.run(params.path, async () => { await mkdir(directory, { recursive: true }); }),
        writeFile: (path, contents) => guard.run(path, () => writeFile(path, contents)),
      } }).execute(id, params, signal, update, ctx);
    } finally { guard.finish(); }
  } });
  const defaultBash = createBashToolDefinition(process.cwd());
  pi.registerTool({
    ...defaultBash,
    label: "bash (sandboxed)",
    executionMode: "sequential",
    description: `${defaultBash.description} With background=true, returns an owned job launch receipt instead of command output. Completion notifies the agent automatically; bash_control inspect returns status/output and consumes a finished result. Reads are unrestricted by default. Temporary space and configured write paths are writable without approval; edit mode also allows workspace writes. Request additional writePaths before execution, and narrow readPaths only when read access is configured to be restricted. networkAccess requests outbound access to any host, approved once or for this conversation without lifting filesystem restrictions. workspaceWriteAccess requests writing the current directory. unixSocketPaths requests path-scoped Unix-socket binding and connections on macOS while retaining other sandbox restrictions. If granular sandbox permissions cannot support the operation, request unsandboxed for unrestricted access, approved once or for this session: the exact command/CWD, any command from this CWD, or any command from any CWD. Normally sandboxed commands remain sandboxed. Use timeout for short diagnostic probes or a user-requested execution deadline; omit it otherwise. Execution deadlines start after approvals. When Git SSH fails because of sandbox proxy authentication, request one-time unsandboxed execution of the exact Git command.`,
    outputSchema: Type.Union([Type.Intersect([defaultBash.outputSchema!, Type.Object({
      sandbox_blocked: Type.Optional(Type.Boolean({ description: "The sandbox detected denied access; output may be partial even when exit_code is zero." })),
    })]), BashJobLaunchSchema]),
    parameters: Type.Object({
      ...defaultBash.parameters.properties,
      background: Type.Optional(Type.Boolean({ description: "Start an owned background command after approval. Returns a job identity, not an exit code. Use bash_control inspect to read status/output or wait, and stop to terminate it. No stdin or PTY; the job survives turn cancellation and frontend detach until its owner ends." })),
      timeout: Type.Optional(Type.Number({
        description: "Harness-enforced execution deadline in seconds, starting after approvals. Set for diagnostic probes expected to finish quickly or when the user requests a deadline; omit otherwise.",
      })),
      networkAccess: Type.Optional(Type.Boolean({
        description: "Request outbound network access to any host. Prompts before execution, with approval once or for this conversation (including resume). A conversation grant also allows later commands without this flag; new conversations, forks, and subagents do not inherit it. Commands can send data they can read, including inherited environment values. Filesystem restrictions and sandbox network safeguards remain in place.",
      })),
      readPaths: Type.Optional(Type.Array(Type.String({ minLength: 1 }), {
        description: "Specific additional read paths when configured read access is restricted. Unnecessary with the default unrestricted reads. Directory approval covers descendants; session grants are shared with file tools.",
      })),
      writePaths: Type.Optional(Type.Array(Type.String({ minLength: 1 }), {
        description: "Additional files or directories this command needs to write beyond configured paths, temporary space, and mode permissions. For multiple files in the same task directory, request the smallest covering directory once instead of listing each file. Keep unrelated directories separate; use file-level requests for isolated files or when directory access would expose sensitive unrelated contents. Directory approval covers descendants. Requests approval before execution; session grants are shared with edit/write tools.",
      })),
      broadReadAccess: Type.Optional(Type.Boolean({
        description: "Explicitly request all filesystem reads for one command when configured reads are restricted. Prefer specific readPaths; uncertainty about incidental reads is not a reason to request this. Unnecessary with the default unrestricted reads. Does not grant writes or network access.",
      })),
      workspaceWriteAccess: Type.Optional(Type.Boolean({
        description: "Request reading and writing the current working directory before execution; equivalent to including it in writePaths.",
      })),
      unixSocketPaths: Type.Optional(Type.Array(Type.String({ minLength: 1 }), {
        description: "Request Unix-socket binding and connections at literal paths on macOS. Directory approval includes descendants; may expose local services. Offers approval once or for this session, without granting filesystem or outbound-network access. Inspect $TMPDIR to find temporary socket directories. Unsupported on Linux; never silently widened to all sockets.",
      })),
      unsandboxed: Type.Optional(Type.Boolean({
        description: "Ask to execute outside the sandbox with unrestricted host filesystem, environment, and network access, including child processes. Offers approval once or for this session: the exact command text and canonical working directory, any command from that directory, or any command from any directory. Approval includes future script modifications. Directory scope limits eligible executions, not their access. Grants are not persisted or inherited, do not change the session's access mode, and never move normally sandboxed commands outside the sandbox.",
      })),
    }),
    promptGuidelines: [
      ...(defaultBash.promptGuidelines ?? []),
      "Run independent investigations in separate Bash calls so each result has its own exit status; use && for commands that depend on earlier success.",
      "Use git --no-optional-locks status --short for read-only Git inspection to avoid optional index-refresh writes.",
      "Nonzero exits are errors. rg returns 1 for no matches; when that outcome is acceptable, handle only exit code 1 explicitly and preserve other failures. Do not use blanket || true.",
      "Reads are unrestricted by default, including session logs and credential files; do not request read access for routine inspection. Scratch space and configured write paths are already writable; edit mode also permits workspace writes. Declare only additional writePaths before mutation. In ask mode, workspaceWriteAccess=true requests writing the current directory. If configured reads are restricted, request specific required readPaths rather than broadReadAccess for incidental configuration lookups.",
      "For operations affecting multiple files in the same task directory, request that directory once in writePaths (or readPaths when read access is restricted) instead of listing individual files. Choose the smallest directory covering the intended changes. Keep separate scopes for unrelated directories, and use file-level requests for isolated files or when directory access would expose sensitive unrelated contents.",
      "Request networkAccess=true upfront for commands that need outbound connections, such as dependency downloads or remote API calls. The user can approve once or for this conversation, including resume, without lifting filesystem restrictions. Existing network grants apply even without the flag. Without approval or a saved grant, network access is denied during execution; the proxy never opens a permission prompt. Network grants are not inherited by new conversations, forks, or subagents.",
      "Use bash.timeout for diagnostic probes expected to finish quickly and for user-requested execution deadlines. Choose a deadline appropriate to the expected execution time; approvals finish before the timer starts. Omit it otherwise, and do not impose arbitrary deadlines on builds, installs, or other legitimately long-running work. Do not add command-level timeouts such as curl --max-time, curl --connect-timeout, or the timeout utility unless the user requested them or you are specifically testing timeout behavior.",
      "Agent-written diagnostic scripts must terminate after collecting results and exit nonzero on initialization or execution failure. For headless Neovim probes, catch initialization errors and exit with cquit rather than leaving the editor running. Install any watchdog before plugin loading or other fallible initialization; a scheduled exit registered afterward cannot handle an earlier failure.",
      "For Unix-socket denials on macOS, prefer narrow unixSocketPaths over unsandboxed execution. Inspect $TMPDIR for temporary socket directories and pass literal paths, not shell variables. Socket permission does not grant filesystem writes, outbound connections, or TCP binding; Linux cannot enforce path-scoped socket grants.",
      "If granular sandbox permissions cannot support an operation, request unsandboxed=true. The user can approve once or for this session: the exact command text and canonical CWD, any command from that CWD, or any command from any CWD. All include modified scripts and child processes with unrestricted host access; CWD scope is not access containment. Keep script modifications in separate calls from the stable run command so exact-command approval can be reused. Prefer granular sandbox permissions even with a broad grant; normally sandboxed commands remain sandboxed. Grants expire on session/branch replacement or process exit and are not inherited by forks or subagents.",
      "Denied access is not task completion. A sandbox-blocked command may have partially executed and written files, even when its exit code is zero. Inspect partial output and state, then request needed access with an appropriate continuation. Do not blindly rerun. Permissions are requested through tool arguments, not the question tool.",
    ],
    async execute(id, params, signal, onUpdate, ctx) {
      if (params.background) {
        const launch = await bashJobs(ctx).start(params.command, ctx.cwd, params.timeout, signal,
          async ({ admissionSignal, lifetimeSignal, hooks, onBlocked, onDiagnostic }) => {
            const operations = createAccessControlledBashOperations(ctx, params, () => saveAccessState(pi), onBlocked,
              { signal: lifetimeSignal, hooks });
            return operations.exec(params.command, ctx.cwd, { signal: admissionSignal, timeout: params.timeout, onData: onDiagnostic });
          });
        return { content: [{ type: "text", text: JSON.stringify(launch) }], details: { background: launch, truncation: undefined }, structuredContent: launch };
      }
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

  pi.registerTool({
    name: "bash_control", label: "Bash jobs", executionMode: "parallel",
    description: "Control this session's owned background Bash commands. list shows running and historical jobs. inspect returns status plus bounded stdout/stderr; wait=true waits for completion without stopping the command. Reading a terminal result consumes its pending notification; no separate acknowledgment is needed. Completion otherwise notifies the agent automatically once. Interrupt cancels automatic notifications for existing jobs, not the jobs or their logs; later user input does not re-enable them. New jobs notify normally. completion=suppressed means automatic notification is cancelled, not that the process stopped. Cancelling inspection stops only its wait. stop terminates the job, waits for managed descendant cleanup, and prevents a later completion notification. Supervision is best-effort, not containment of arbitrary escaped descendants. Output uses independent stdoutOffset/stderrOffset byte-offset pages (at most 16 KiB/2000 lines each); full logs remain available. Restored jobs are inspection-only: no PID adoption or restart.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("list"), Type.Literal("inspect"), Type.Literal("stop")]),
      jobId: Type.Optional(Type.String()),
      wait: Type.Optional(Type.Boolean({ description: "inspect only: wait for completion. Cancellation leaves the job running." })),
      stdoutOffset: Type.Optional(Type.Integer({ minimum: 0 })),
      stderrOffset: Type.Optional(Type.Integer({ minimum: 0 })),
      offset: Type.Optional(Type.Integer({ minimum: 0, description: "list pagination offset" })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 16384 })),
    }),
    outputSchema: BashControlResultSchema,
    async execute(_id, params, signal, _update, ctx) {
      const jobs = bashJobs(ctx);
      if (params.action !== "list" && !params.jobId) throw new Error("jobId is required");
      const result: BashControlResult = params.action === "list" ? jobs.list(params.offset, params.limit)
        : params.action === "inspect" ? await jobs.inspectForAgent(params.jobId!, {
          wait: params.wait, stdoutOffset: params.stdoutOffset, stderrOffset: params.stderrOffset, limit: params.limit,
        }, signal)
        : await jobs.stopForAgent(params.jobId!, signal);
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result, structuredContent: result,
        isError: result.kind === "bash_job_result" && ["terminal", "unresolved"].includes(result.job.state)
          && (result.job.cleanup === "unresolved" || result.job.sandboxBlocked || result.job.error !== undefined || result.job.signal !== null || result.job.exitCode !== 0) };
    },
  });

  pi.on("session_start", async (event, ctx) => {
    delivery?.dispose();
    delivery = undefined;
    await shutdownBashJobs();
    const startsAnotherSession = event.reason === "new" || event.reason === "fork";
    restoreAccessState(ctx, !startsAnotherSession);
    if (event.reason === "fork" && !process.env.PI_SPAWN_ACCESS_MODE) saveAccessState(pi);
    await initializeBashSandbox(ctx);
    delivery = new BashDelivery(pi, initializeBashJobs(ctx), ctx);
  });

  pi.on("session_tree", (_event, ctx) => {
    restoreAccessState(ctx);
  });

  pi.on("session_shutdown", async () => {
    delivery?.dispose();
    delivery = undefined;
    await shutdownBashSandbox();
  });

  const authorizeTool = async (event: ToolCallEvent, ctx: ExtensionContext) => {
    setStatus(ctx);
    const blocked = workspaceToolBlock(event.toolName, event.input as Record<string, unknown>, ctx);
    if (blocked) return blocked;
    const mode = getAccessMode();
    // Codemode's nested tool calls pass through this hook and enforce their own permissions.
    if (mode === "full" || event.toolName === "bash" || event.toolName === "codemode") return undefined;

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
        const canonicalBlock = workspaceToolBlock(event.toolName, input, ctx);
        if (canonicalBlock) return canonicalBlock;
        if (MUTATION_TOOLS.has(event.toolName)) return undefined; // Execution operations own approval after the mutation queue.
        const authorization = await requestPermission(ctx, { kind: "read", scope: path }, event.toolName,
          () => previewForTool(event, ctx), () => saveAccessState(pi));
        await authorization.validate();
        return workspaceToolBlock(event.toolName, input, ctx);
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

    if (!KNOWN_TOOLS.has(event.toolName)) {
      const tool = pi.getAllTools().find((tool) => tool.name === event.toolName);
      if (tool?.annotations?.readOnlyHint === true) return undefined;
    }

    if (mode === "edit" && KNOWN_TOOLS.has(event.toolName)) return undefined;
    if (!readonlyToolBlockReason(event.toolName, input)) return undefined;
    try {
      const action = typeof input.action === "string" ? `:${input.action}` : "";
      const authorization = await requestPermission(ctx, { kind: "tool", scope: `${event.toolName}${action}` }, event.toolName,
        () => previewForTool(event, ctx), () => saveAccessState(pi));
      await authorization.validate();
      return undefined;
    } catch (error) {
      return { block: true, reason: error instanceof Error ? error.message : String(error) };
    }
  };
  pi.on("tool_call", async (event, ctx) => {
    const generation = accessGeneration();
    const runtimeGeneration = accessRuntimeGeneration();
    const input = event.input as Record<string, unknown>;
    try {
      // Retain the exact scope being authorized, not a newly resolved target
      // after an approval or parent-admission wait.
      const readPath = PATH_READ_TOOLS.has(event.toolName)
        ? canonicalPath(resolveToolPath(typeof input.path === "string" ? input.path : ".", ctx.cwd)) : undefined;
      if (readPath !== undefined) input.path = readPath;
      const result = await authorizeTool(event, ctx);
      if (result?.block || ["bash", "edit", "write"].includes(event.toolName)) return result;
      if (generation !== accessGeneration()) throw new Error("Tool authority changed before admission");
      const parentAdmitted = await admitPermissionSnapshot(ctx, capturePermissionSnapshot());
      if ((!parentAdmitted && generation !== accessGeneration()) || accessRuntimeGeneration() !== runtimeGeneration || ctx.signal?.aborted) {
        throw new Error("Tool authority changed before admission");
      }
      if (readPath !== undefined && (input.path !== readPath || canonicalPath(readPath) !== readPath)) {
        throw new Error("Read target changed before execution");
      }
      return result;
    } catch (error) {
      return { block: true, reason: error instanceof Error ? error.message : String(error) };
    }
  });

  const applyMode = async (mode: ReturnType<typeof getAccessMode>, ctx: ExtensionContext) => {
    if (process.env.PI_SIDE_AGENT === "1" && mode !== "ask") return;
    const changed = mode !== getAccessMode();
    setAccessMode(mode);
    if (changed) saveAccessState(pi);
    setStatus(ctx);
    return { mode: getAccessMode() };
  };
  registerServiceOperation(pi, "access.set", ({ mode }, ctx) => applyMode(mode, ctx));
  registerServiceOperation(pi, "access.cycle", ({ modes }, ctx) => applyMode(modes[(modes.indexOf(getAccessMode()) + 1) % modes.length]!, ctx));

  pi.registerCommand("pi-mode", {
    description: "Set access mode: /pi-mode readonly|ask|edit|full",
    handler: async (args, ctx) => {
      const requestedMode = parseAccessMode(args);
      if (!requestedMode) {
        ctx.ui.notify("Usage: /pi-mode readonly|ask|edit|full", "warning");
        setStatus(ctx);
        return;
      }
      if (process.env.PI_SIDE_AGENT === "1" && requestedMode !== "ask") {
        ctx.ui.notify("Side conversations have fixed ask access mode.", "warning");
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
