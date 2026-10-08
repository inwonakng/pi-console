import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter, type ExtensionAPI, type ExtensionContext, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn as spawnProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAccessMode } from "./shared/access-state";
import { registerSubagentRuntime, retireSubagentRuntime } from "./shared/subagent-state";
import {
  createWorkspace,
  integrateWorkspace,
  isWorkspaceFinalized,
  loadWorkspace,
  prepareWorkspaceDiscard,
  removeWorkspace,
  sameSessionFile,
  updateWorkspace,
  workspaceForContext,
  workspaceStorageRoot,
  type WorkspaceRecord,
} from "./shared/workspace";

const ACCESS_MODES = ["readonly", "ask", "edit", "full"] as const;
type AccessMode = (typeof ACCESS_MODES)[number];

const SPAWN_MODES = ["background", "foreground"] as const;
type SpawnMode = (typeof SPAWN_MODES)[number];

const ISOLATION_MODES = ["none", "worktree"] as const;
type IsolationMode = (typeof ISOLATION_MODES)[number];

type RunStatus = "running" | "completed" | "error" | "aborted";
type IntegrationStatus = "pending" | "not_applicable" | "none" | "applied" | "needs_parent" | "failed";

const MAX_BACKGROUND_RUNS = 4;
const RESULT_CONTEXT_LIMIT = 6000;
const BUNDLED_AGENTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../agents");

type RpcEvent = Record<string, unknown>;

type PendingRequest = {
  resolve: (event: RpcEvent) => void;
  reject: (error: Error) => void;
};

type SubagentProfile = {
  name: string;
  description: string;
  systemPrompt: string;
  source: "bundled" | "user" | "project";
  filePath: string;
  tools?: string[];
  model?: string;
  accessMode?: AccessMode;
};

type IntegrationBlock = {
  integration: "needs_parent" | "failed";
  reason: string;
};

type RunWorkspace = {
  workspaceId: string;
  // Recovery artifacts can outlive the record/worktree. This is not authority
  // for workspace existence or permission to integrate.
  recoveryPatchPath?: string;
};

type WorktreeInfo = {
  workspaceId: string;
  gitRoot: string | null;
  path: string | null;
  baseRef: string | null;
  patchPath: string | null;
  changedFiles: string[];
  unpreservedFiles?: string[];
  integration: IntegrationStatus;
  integrationReason?: string;
  retained: boolean;
};

type SpawnRun = {
  id: string;
  mode: SpawnMode;
  prompt: string;
  role?: string;
  profile?: SubagentProfile;
  requestedAgent?: string;
  accessMode: AccessMode;
  isolation: IsolationMode;
  status: RunStatus;
  startedAt: string;
  completedAt?: string;
  error?: string;
  resultText?: string;
  progress?: string;
  runDir: string;
  briefPath: string;
  transcriptPath: string;
  resultPath: string;
  statusPath: string;
  agentPromptPath?: string;
  child?: PiRpcChild;
  childCwd: string;
  parentSessionFile?: string;
  worktree?: RunWorkspace;
  integrationBlock?: IntegrationBlock;
  timeout?: NodeJS.Timeout;
  abortListener?: () => void;
  abortSignal?: AbortSignal;
  stopReason?: string;
  notified: boolean;
  joined: boolean;
  joinRequested?: boolean;
  finished: Promise<SpawnRun>;
  resolveFinished: (run: SpawnRun) => void;
};

class PiRpcChild {
  private proc: ChildProcessWithoutNullStreams;
  private pending = new Map<string, PendingRequest>();
  private nextId = 0;
  private stdoutBuffer = "";
  private stderrBuffer = "";
  private ended = false;
  private agentEndResolver: ((event: RpcEvent) => void) | undefined;
  private agentEndRejecter: ((error: Error) => void) | undefined;
  private lastAgentEnd: RpcEvent | undefined;
  private killTimer: NodeJS.Timeout | undefined;

  constructor(
    argv: string[],
    options: { cwd: string; env: NodeJS.ProcessEnv; onEvent: (event: RpcEvent) => void },
  ) {
    this.proc = spawnProcess(argv[0], argv.slice(1), {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.proc.stdout.on("data", (chunk) => {
      this.stdoutBuffer += chunk.toString("utf8");
      this.drainLines(this.stdoutBuffer, (remaining) => {
        this.stdoutBuffer = remaining;
      }, (line) => this.handleStdoutLine(line, options.onEvent));
    });

    this.proc.stderr.on("data", (chunk) => {
      this.stderrBuffer += chunk.toString("utf8");
      this.drainLines(this.stderrBuffer, (remaining) => {
        this.stderrBuffer = remaining;
      }, (line) => {
        options.onEvent({ type: "child_stderr", text: line });
      });
    });

    this.proc.on("error", (error) => {
      this.rejectAll(error);
      this.agentEndRejecter?.(error);
    });

    this.proc.on("exit", (code, signal) => {
      this.ended = true;
      if (this.killTimer) {
        clearTimeout(this.killTimer);
        this.killTimer = undefined;
      }
      const error = new Error(`spawned pi exited before completion: code=${code ?? "null"} signal=${signal ?? "null"}`);
      this.rejectAll(error);
      this.agentEndRejecter?.(error);
      options.onEvent({ type: "child_exit", code, signal });
    });
  }

  abort(): void {
    if (!this.ended) {
      this.proc.kill("SIGTERM");
      if (!this.killTimer) {
        this.killTimer = setTimeout(() => {
          if (!this.ended) {
            this.proc.kill("SIGKILL");
          }
        }, 5000);
      }
    }
  }

  dispose(): void {
    this.abort();
  }

  send(command: RpcEvent): Promise<RpcEvent> {
    if (this.ended) {
      return Promise.reject(new Error("spawned pi process already exited"));
    }
    const id = `spawn-${++this.nextId}`;
    command.id = id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc.stdin.write(`${JSON.stringify(command)}\n`, (error) => {
        if (error) {
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }

  waitForAgentEnd(): Promise<RpcEvent> {
    return new Promise((resolve, reject) => {
      this.agentEndResolver = resolve;
      this.agentEndRejecter = reject;
    });
  }

  private drainLines(
    buffer: string,
    setRemaining: (value: string) => void,
    onLine: (line: string) => void,
  ): void {
    while (true) {
      const index = buffer.indexOf("\n");
      if (index === -1) {
        setRemaining(buffer);
        return;
      }
      let line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.endsWith("\r")) {
        line = line.slice(0, -1);
      }
      if (line !== "") {
        onLine(line);
      }
    }
  }

  private handleStdoutLine(line: string, onEvent: (event: RpcEvent) => void): void {
    let event: RpcEvent;
    try {
      event = JSON.parse(line) as RpcEvent;
    } catch (error) {
      onEvent({ type: "child_bad_json", line, error: String(error) });
      return;
    }

    onEvent(event);

    if (event.type === "response" && typeof event.id === "string") {
      const pending = this.pending.get(event.id);
      if (pending) {
        this.pending.delete(event.id);
        pending.resolve(event);
      }
      return;
    }

    if (event.type === "extension_ui_request" && typeof event.id === "string") {
      this.handleExtensionUiRequest(event);
      return;
    }

    if (event.type === "agent_end") {
      this.lastAgentEnd = event;
      return;
    }
    if (event.type === "agent_settled") {
      this.agentEndResolver?.(this.lastAgentEnd ?? event);
      this.agentEndResolver = undefined;
      this.agentEndRejecter = undefined;
      this.lastAgentEnd = undefined;
    }
  }

  private handleExtensionUiRequest(event: RpcEvent): void {
    const id = event.id;
    if (typeof id !== "string") {
      return;
    }
    const method = event.method;
    const response: RpcEvent = { type: "extension_ui_response", id };
    if (method === "confirm") {
      response.confirmed = false;
    } else {
      response.cancelled = true;
    }
    this.proc.stdin.write(`${JSON.stringify(response)}\n`);
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}

class SubagentTerminalError extends Error {
  readonly status: Extract<RunStatus, "error" | "aborted">;

  constructor(status: Extract<RunStatus, "error" | "aborted">, message: string) {
    super(message);
    this.name = "SubagentTerminalError";
    this.status = status;
  }
}

function textFromLastAssistantResponse(event: RpcEvent): string | undefined {
  const data = event.data as { text?: unknown } | undefined;
  return typeof data?.text === "string" ? data.text : undefined;
}

function terminalAssistantError(event: RpcEvent): SubagentTerminalError | undefined {
  const messages = Array.isArray(event.messages) ? event.messages : [];
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index] as { role?: unknown; stopReason?: unknown; errorMessage?: unknown } | undefined;
    if (message?.role !== "assistant") {
      continue;
    }
    if (message.stopReason !== "error" && message.stopReason !== "aborted") {
      return undefined;
    }
    const detail = typeof message.errorMessage === "string" && message.errorMessage.trim()
      ? message.errorMessage.trim()
      : `Subagent assistant stopped with ${String(message.stopReason)}.`;
    return new SubagentTerminalError(message.stopReason === "aborted" ? "aborted" : "error", detail);
  }
  return undefined;
}

function assertSuccess(event: RpcEvent, action: string): void {
  if (event.success === false) {
    throw new Error(`${action} failed: ${String(event.error ?? "unknown error")}`);
  }
}

function compactOneLine(value: unknown, maxLength = 96): string {
  if (typeof value !== "string") {
    return "";
  }
  const compact = value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n/g, " ⏎ ").replace(/\s+/g, " ").trim();
  return compact.length > maxLength ? `${compact.slice(0, Math.max(0, maxLength - 1))}…` : compact;
}

function truncateText(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, Math.max(0, maxLength - 30))}\n\n[truncated]` : value;
}

function pathBasename(path: unknown): string | undefined {
  if (typeof path !== "string" || path === "") {
    return undefined;
  }
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function previewToolArgs(toolName: unknown, args: unknown): string {
  if (typeof toolName !== "string" || typeof args !== "object" || args === null) {
    return "";
  }
  const input = args as Record<string, unknown>;
  if (toolName === "read") {
    const path = pathBasename(input.path);
    return path ? ` ${path}` : "";
  }
  if (toolName === "bash") {
    const command = compactOneLine(input.command, 72);
    return command ? ` ${command}` : "";
  }
  if (toolName === "web_fetch") {
    const url = compactOneLine(input.url, 72);
    return url ? ` ${url}` : "";
  }
  if (toolName === "web_search") {
    const query = compactOneLine(input.query, 72);
    return query ? ` ${query}` : "";
  }
  return "";
}

function parseCsv(value: string | undefined): string[] | undefined {
  const items = value?.split(",").map((item) => item.trim()).filter(Boolean) ?? [];
  return items.length > 0 ? items : undefined;
}

function parseAccessMode(value: string | undefined): AccessMode | undefined {
  const trimmed = value?.trim();
  return ACCESS_MODES.find((mode) => mode === trimmed);
}

function parseSpawnMode(value: unknown): SpawnMode {
  return value === "foreground" ? "foreground" : "background";
}

function parseIsolationMode(value: unknown, accessMode: AccessMode): IsolationMode {
  if (value === "none" || value === "worktree") {
    return value;
  }
  return accessMode === "edit" ? "worktree" : "none";
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function findNearestProjectAgentsDir(cwd: string): string | undefined {
  let current = cwd;

  while (true) {
    const candidate = join(current, CONFIG_DIR_NAME, "agents");
    if (isDirectory(candidate)) {
      return candidate;
    }
    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

function loadSubagentProfilesFromDir(dir: string, source: SubagentProfile["source"]): SubagentProfile[] {
  if (!existsSync(dir)) {
    return [];
  }

  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const profiles: SubagentProfile[] = [];
  for (const entry of entries) {
    if (!entry.name.endsWith(".md") || (!entry.isFile() && !entry.isSymbolicLink())) {
      continue;
    }

    const filePath = join(dir, entry.name);
    let content: string;
    try {
      content = readFileSync(filePath, "utf8");
    } catch {
      continue;
    }

    const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);
    const name = frontmatter.name?.trim();
    const description = frontmatter.description?.trim();
    if (!name || !description) {
      continue;
    }

    profiles.push({
      name,
      description,
      systemPrompt: body.trim(),
      source,
      filePath,
      tools: parseCsv(frontmatter.tools),
      model: frontmatter.model?.trim() || undefined,
      accessMode: parseAccessMode(frontmatter.accessMode) ?? parseAccessMode(frontmatter.defaultAccessMode),
    });
  }

  return profiles;
}

function discoverSubagentProfiles(cwd: string, includeProject: boolean): SubagentProfile[] {
  const profileMap = new Map<string, SubagentProfile>();

  for (const profile of loadSubagentProfilesFromDir(BUNDLED_AGENTS_DIR, "bundled")) {
    profileMap.set(profile.name, profile);
  }

  for (const profile of loadSubagentProfilesFromDir(join(getAgentDir(), "agents"), "user")) {
    profileMap.set(profile.name, profile);
  }

  if (includeProject) {
    const projectAgentsDir = findNearestProjectAgentsDir(cwd);
    if (projectAgentsDir) {
      for (const profile of loadSubagentProfilesFromDir(projectAgentsDir, "project")) {
        profileMap.set(profile.name, profile);
      }
    }
  }

  return Array.from(profileMap.values());
}

function formatProfileList(profiles: SubagentProfile[]): string {
  if (profiles.length === 0) {
    return "none discovered";
  }
  return profiles.map((profile) => `${profile.name} (${profile.source}): ${profile.description}`).join("; ");
}

function resolveSubagentProfile(input: {
  agent?: string;
  role?: string;
  profiles: SubagentProfile[];
}): SubagentProfile | undefined {
  const explicitAgent = input.agent?.trim();
  const role = input.role?.trim();
  const requested = explicitAgent || role;
  if (!requested) {
    return undefined;
  }

  const profile = input.profiles.find((candidate) => candidate.name === requested);
  if (!profile && explicitAgent) {
    throw new Error(`Unknown subagent profile: ${explicitAgent}. Available profiles: ${formatProfileList(input.profiles)}`);
  }
  return profile;
}

function subagentSystemPrompt(profile: SubagentProfile): string {
  return `You are the ${profile.name} subagent in a pi parent session.

Description: ${profile.description}
Source: ${profile.source} (${profile.filePath})

${profile.systemPrompt}`;
}

function spawnPrompt(input: {
  prompt: string;
  role?: string;
  agent?: SubagentProfile;
  accessMode: AccessMode;
  briefPath: string;
  agentPromptPath?: string;
}): string {
  const role = input.role?.trim() || input.agent?.name || "general subagent";
  const agentSection = input.agent
    ? `Subagent profile: ${input.agent.name}
Description: ${input.agent.description}
Profile path: ${input.agent.filePath}${input.agentPromptPath ? `\nLoaded prompt artifact: ${input.agentPromptPath}` : ""}`
    : "Subagent profile: none (generic spawned subagent)";

  return `You are a subagent working inside a pi parent session.

Role: ${role}
${agentSection}
Access mode: ${input.accessMode}
Interaction mode: noninteractive
Task brief path: ${input.briefPath}

Instructions:
- Read the task carefully and do only that task.
- Keep exploration targeted.
- Do not ask the parent for permission. If access is blocked or information is missing, stop and report BLOCKED.
- If access mode is readonly, do not attempt to modify files.
- If access mode is ask, approval-required actions will be blocked because spawned subagents cannot prompt the parent.
- Return a concise final report with one of these statuses: DONE, BLOCKED, or NEEDS_CONTEXT.
- Include key evidence: files inspected, commands run, findings, and any artifact paths.

Task:
${input.prompt}`;
}

function runLabel(run: SpawnRun): string {
  return run.profile?.name ? `${run.profile.name} subagent` : "Subagent";
}

function unavailableWorkspaceReason(record: WorkspaceRecord | undefined, id: string): string | undefined {
  if (!record) return `Workspace data is missing for ${id}; automatic integration is unavailable.`;
  if (isWorkspaceFinalized(record)) return undefined;
  if (record.lifecycle === "discarded") {
    return `Workspace ${id} was intentionally discarded and is not eligible for automatic integration.`;
  }
  if (!record.retained || !existsSync(record.worktreePath)) {
    return `Worktree is missing for workspace ${id}; automatic integration is unavailable.`;
  }
  return undefined;
}

function worktreeInfo(run: SpawnRun): WorktreeInfo | undefined {
  const workspace = run.worktree;
  if (!workspace) return undefined;
  const record = loadWorkspace(workspace.workspaceId);
  const unavailable = unavailableWorkspaceReason(record, workspace.workspaceId);
  const finalizedIntegration = record?.integration === "applied" || record?.integration === "none" ? record.integration : undefined;
  const block = record?.integration === "pending" && !unavailable ? run.integrationBlock : undefined;
  const patchPath = record?.resultPatchPath ?? workspace.recoveryPatchPath;
  const unavailableReason = unavailable && record?.lifecycle === "cleanup_failed" && record.integrationReason
    ? `${unavailable}\nCleanup warning: ${record.integrationReason}` : unavailable;
  return {
    workspaceId: workspace.workspaceId,
    gitRoot: record?.destinationRoot ?? null,
    path: record?.worktreePath ?? null,
    baseRef: record?.baselineCommit ?? null,
    patchPath: patchPath && existsSync(patchPath) ? patchPath : null,
    changedFiles: record?.changedFiles ?? [],
    unpreservedFiles: record?.unpreservedFiles ?? [],
    integration: finalizedIntegration ?? (unavailable ? "needs_parent"
      : block?.integration ?? (record?.integration === "conflict" ? "needs_parent" : record?.integration ?? "needs_parent")),
    integrationReason: finalizedIntegration ? record?.integrationReason : unavailableReason ?? block?.reason ?? record?.integrationReason,
    retained: record?.retained ?? false,
  };
}

function workspaceDetails(worktree: WorktreeInfo | undefined) {
  // Lua merges run updates and accepts both forms. Publish them together so
  // clearing a flat artifact cannot fall back to stale nested metadata (or vice versa).
  return {
    workspaceId: worktree?.workspaceId,
    worktreePath: worktree?.path,
    patchPath: worktree?.patchPath,
    integration: worktree?.integration,
    integrationReason: worktree?.integrationReason ?? null,
    changedFiles: worktree?.changedFiles,
    unpreservedFiles: worktree?.unpreservedFiles,
    worktree: worktree ? { ...worktree, integrationReason: worktree.integrationReason ?? null } : null,
  };
}

function artifactDetails(run: SpawnRun): Record<string, unknown> {
  return {
    runId: run.id,
    runDir: run.runDir,
    briefPath: run.briefPath,
    resultPath: run.resultPath,
    transcriptPath: run.transcriptPath,
    statusPath: run.statusPath,
    agentPromptPath: run.agentPromptPath,
    ...workspaceDetails(worktreeInfo(run)),
    accessMode: run.accessMode,
    isolation: run.isolation,
    mode: run.mode,
    role: run.role ?? null,
    agent: run.profile?.name ?? run.requestedAgent ?? null,
    agentSource: run.profile?.source ?? null,
    agentProfilePath: run.profile?.filePath ?? null,
    status: run.status,
    progress: run.progress ?? null,
    joined: run.joined,
    joinRequested: run.joinRequested ?? false,
  };
}

function statusJson(run: SpawnRun): Record<string, unknown> {
  return {
    status: run.status,
    runId: run.id,
    ownerPid: process.pid,
    prompt: run.prompt,
    parentSessionFile: run.parentSessionFile ?? null,
    accessMode: run.accessMode,
    isolation: run.isolation,
    mode: run.mode,
    role: run.role ?? null,
    agent: run.profile?.name ?? run.requestedAgent ?? null,
    agentSource: run.profile?.source ?? null,
    agentProfilePath: run.profile?.filePath ?? null,
    startedAt: run.startedAt,
    completedAt: run.completedAt ?? null,
    error: run.error ?? null,
    progress: run.progress ?? null,
    notified: run.notified,
    joined: run.joined,
    joinRequested: run.joinRequested ?? false,
    integrationBlock: run.integrationBlock,
    briefPath: run.briefPath,
    resultPath: run.resultPath,
    transcriptPath: run.transcriptPath,
    agentPromptPath: run.agentPromptPath,
    ...workspaceDetails(worktreeInfo(run)),
  };
}

function writeStatus(run: SpawnRun): void {
  const temporary = `${run.statusPath}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(statusJson(run), null, 2), "utf8");
  renameSync(temporary, run.statusPath);
}

function resultSummary(run: SpawnRun): string {
  const resultText = run.resultText?.trim() || (run.status === "completed" ? "Subagent produced no final text." : `Subagent ${run.status}: ${run.error ?? run.stopReason ?? "unknown"}`);
  const agentPromptLine = run.agentPromptPath ? `\n- Subagent prompt: ${run.agentPromptPath}` : "";
  const worktree = worktreeInfo(run);
  const patchLine = worktree?.patchPath ? `\n- Patch: ${worktree.patchPath}` : "";
  const worktreeLine = worktree?.retained && worktree.path ? `\n- Worktree: ${worktree.path}` : "";
  const integrationLine = formatIntegrationLine(worktree);
  return `${resultText}${integrationLine}\n\nArtifacts:\n- Brief: ${run.briefPath}\n- Result: ${run.resultPath}\n- Transcript: ${run.transcriptPath}\n- Status: ${run.statusPath}${agentPromptLine}${patchLine}${worktreeLine}`;
}

function formatIntegrationLine(worktree: WorktreeInfo | undefined): string {
  if (!worktree) {
    return "";
  }
  if (worktree.integration === "applied") {
    const files = worktree.changedFiles.length > 0 ? `\n\nApplied isolated worktree changes to parent worktree:\n${worktree.changedFiles.map((file) => `- ${file}`).join("\n")}` : "\n\nApplied isolated worktree changes to parent worktree.";
    return `${files}${worktree.integrationReason ? `\n\nCleanup warning: ${worktree.integrationReason}` : ""}`;
  }
  if (worktree.integration === "needs_parent" || worktree.integration === "failed") {
    const recovery = worktree.patchPath ? ` Recovery patch: ${worktree.patchPath}` : "";
    const outcome = worktree.integration === "failed"
      ? "Isolated worktree integration failed."
      : "Isolated worktree changes were not applied.";
    return `\n\n${outcome} Reason: ${worktree.integrationReason ?? worktree.integration}${recovery}`;
  }
  if (worktree.integration === "none") {
    return `\n\nNo isolated worktree changes to apply.${worktree.integrationReason ? `\n\nCleanup warning: ${worktree.integrationReason}` : ""}`;
  }
  return "";
}

function createWorktree(
  ctxCwd: string,
  runId: string,
  parentSessionFile: string | undefined,
): WorkspaceRecord {
  const parentWorkspace = workspaceForContext(ctxCwd, parentSessionFile);
  const record = createWorkspace({
    kind: "child",
    destinationCwd: ctxCwd,
    sourceSessionFile: parentSessionFile,
    parentWorkspaceId: parentWorkspace?.id,
    runId,
    label: `subagent-${runId.slice(-8)}`,
  });
  return record;
}

async function prepareWorktreePatch(run: SpawnRun): Promise<void> {
  if (!run.worktree) return;
  const record = loadWorkspace(run.worktree.workspaceId);
  if (unavailableWorkspaceReason(record, run.worktree.workspaceId) || !record || isWorkspaceFinalized(record)) return;
  await prepareWorkspaceDiscard(record.id);
}

async function applyWorktreeChanges(run: SpawnRun, signal?: AbortSignal): Promise<void> {
  if (!run.worktree) return;
  const record = loadWorkspace(run.worktree.workspaceId);
  if (record && isWorkspaceFinalized(record)) {
    run.integrationBlock = undefined;
    return;
  }
  const unavailable = unavailableWorkspaceReason(record, run.worktree.workspaceId);
  if (unavailable) return; // Reports derive unavailability from the record, never stale run paths.
  if (run.status !== "completed") {
    run.integrationBlock = { integration: "needs_parent", reason: `subagent status is ${run.status}` };
    return;
  }
  const accessMode = getAccessMode();
  if (accessMode !== "edit" && accessMode !== "full") {
    run.integrationBlock = { integration: "needs_parent", reason: `parent access mode is ${accessMode}; not applying isolated worktree changes` };
    return;
  }

  run.integrationBlock = undefined;
  try {
    const integrated = await integrateWorkspace(run.worktree.workspaceId, signal);
    if (isWorkspaceFinalized(integrated)) await removeWorkspace(integrated.id, "integrated");
  } catch (error) {
    // Removal can happen while integration waits for the destination queue.
    if (unavailableWorkspaceReason(loadWorkspace(run.worktree.workspaceId), run.worktree.workspaceId)) return;
    throw error;
  }
}

function formatSpawnStarted(run: SpawnRun): string {
  const worktree = worktreeInfo(run);
  const worktreeLine = worktree?.retained && worktree.path ? `\n- Worktree: ${worktree.path}` : "";
  return `Spawned subagent.\n- id: ${run.id}\n- status: ${run.status}\n- agent: ${run.profile?.name ?? run.requestedAgent ?? "generic"}\n- accessMode: ${run.accessMode}\n- isolation: ${run.isolation}\n- brief: ${run.briefPath}\n- result: ${run.resultPath}\n- transcript: ${run.transcriptPath}\n- status file: ${run.statusPath}${worktreeLine}\n\nUse spawn_control with action=join/status/stop. If your answer depends on this result, call spawn_control join or join_all before answering.`;
}

function formatRunStatus(run: SpawnRun): string {
  const worktree = worktreeInfo(run);
  const changed = worktree?.changedFiles.length ? `\n- changed files: ${worktree.changedFiles.join(", ")}` : "";
  const integration = worktree ? `\n- integration: ${worktree.integration}${worktree.integrationReason ? ` (${worktree.integrationReason})` : ""}` : "";
  return `- id: ${run.id}\n  status: ${run.status}\n  agent: ${run.profile?.name ?? run.requestedAgent ?? "generic"}\n  accessMode: ${run.accessMode}\n  isolation: ${run.isolation}\n  startedAt: ${run.startedAt}${run.completedAt ? `\n  completedAt: ${run.completedAt}` : ""}${run.error ? `\n  error: ${run.error}` : ""}${changed}${integration}`;
}

function completionContext(run: SpawnRun): string {
  const result = truncateText(run.resultText?.trim() || run.error || "(no final text)", RESULT_CONTEXT_LIMIT);
  const worktree = worktreeInfo(run);
  const integration = worktree ? `\n- integration: ${worktree.integration}${worktree.integrationReason ? ` (${worktree.integrationReason})` : ""}` : "";
  return `Subagent completed:\n- id: ${run.id}\n- agent: ${run.profile?.name ?? run.requestedAgent ?? "generic"}\n- status: ${run.status}\n- accessMode: ${run.accessMode}\n- isolation: ${run.isolation}${integration}\n- result: ${run.resultPath}\n- transcript: ${run.transcriptPath}\n- status: ${run.statusPath}${worktree?.patchPath ? `\n- patch: ${worktree.patchPath}` : ""}\n\nFinal output:\n${result}`;
}

function restoredRun(statusPath: string, parentSessionFile: string | undefined): SpawnRun | undefined {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(readFileSync(statusPath, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const storedParentSessionFile = typeof data.parentSessionFile === "string" ? data.parentSessionFile : undefined;
  if (typeof data.runId !== "string" || storedParentSessionFile !== parentSessionFile) {
    return undefined;
  }
  const runDir = dirname(statusPath);
  const worktreeData = typeof data.worktree === "object" && data.worktree !== null
    ? data.worktree as Record<string, unknown>
    : undefined;
  const worktree: RunWorkspace | undefined = worktreeData && typeof worktreeData.workspaceId === "string"
    ? {
        workspaceId: worktreeData.workspaceId,
        recoveryPatchPath: typeof worktreeData.patchPath === "string" ? worktreeData.patchPath : undefined,
      }
    : undefined;
  const record = worktree ? loadWorkspace(worktree.workspaceId) : undefined;
  const blockData = typeof data.integrationBlock === "object" && data.integrationBlock !== null
    ? data.integrationBlock as Record<string, unknown> : undefined;
  let integrationBlock: IntegrationBlock | undefined;
  if ((blockData?.integration === "needs_parent" || blockData?.integration === "failed") && typeof blockData.reason === "string") {
    integrationBlock = { integration: blockData.integration, reason: blockData.reason };
  } else if (record?.integration === "pending"
    && (worktreeData?.integration === "needs_parent" || worktreeData?.integration === "failed")
    && typeof worktreeData.integrationReason === "string") {
    // Old files stored run-specific refusals in the workspace mirror.
    integrationBlock = { integration: worktreeData.integration, reason: worktreeData.integrationReason };
  }
  const storedStatus = data.status === "completed" || data.status === "error" || data.status === "aborted"
    ? data.status
    : "aborted";
  const briefPath = join(runDir, "brief.md");
  let resolveFinished: (run: SpawnRun) => void = () => undefined;
  const finished = new Promise<SpawnRun>((resolvePromise) => { resolveFinished = resolvePromise; });
  const run: SpawnRun = {
    id: data.runId,
    mode: data.mode === "foreground" ? "foreground" : "background",
    prompt: typeof data.prompt === "string" ? data.prompt : existsSync(briefPath) ? readFileSync(briefPath, "utf8") : "",
    role: typeof data.role === "string" ? data.role : undefined,
    requestedAgent: typeof data.agent === "string" ? data.agent : undefined,
    accessMode: parseAccessMode(typeof data.accessMode === "string" ? data.accessMode : undefined) ?? "readonly",
    isolation: data.isolation === "worktree" ? "worktree" : "none",
    status: storedStatus,
    startedAt: typeof data.startedAt === "string" ? data.startedAt : new Date().toISOString(),
    completedAt: typeof data.completedAt === "string" ? data.completedAt : new Date().toISOString(),
    error: storedStatus === "aborted" && data.status === "running"
      ? "Subagent process ended before this run was restored."
      : typeof data.error === "string" ? data.error : undefined,
    resultText: existsSync(join(runDir, "result.md")) ? readFileSync(join(runDir, "result.md"), "utf8") : undefined,
    progress: typeof data.progress === "string" ? data.progress : undefined,
    runDir,
    briefPath,
    transcriptPath: join(runDir, "transcript.jsonl"),
    resultPath: join(runDir, "result.md"),
    statusPath,
    agentPromptPath: existsSync(join(runDir, "subagent-prompt.md")) ? join(runDir, "subagent-prompt.md") : undefined,
    childCwd: record?.workspaceCwd ?? "",
    parentSessionFile,
    worktree,
    integrationBlock,
    notified: data.notified === true,
    joined: data.joined === true,
    // No join operation survives a runtime restart.
    joinRequested: false,
    finished,
    resolveFinished,
  };
  resolveFinished(run);
  if (data.status === "running" || data.joinRequested === true) {
    writeStatus(run);
  }
  return run;
}

function restoreRuns(parentSessionFile: string | undefined): SpawnRun[] {
  const root = join(workspaceStorageRoot(), "runs");
  if (!existsSync(root)) {
    return [];
  }
  const runs: SpawnRun[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const run = restoredRun(join(root, entry.name, "status.json"), parentSessionFile);
    if (run) runs.push(run);
  }
  return runs;
}

export default function spawnExtension(pi: ExtensionAPI) {
  if (process.env.PI_SPAWN_AGENT === "1") {
    return;
  }

  const runs = new Map<string, SpawnRun>();
  const owner = Symbol("spawn runtime");
  let retired = false;
  let runtimeCancellation = new AbortController();
  const announcedCompletions = new Set<string>();
  let sessionManager: ExtensionContext["sessionManager"] | undefined;
  let ui: Pick<ExtensionUIContext, "notify" | "setStatus"> | undefined;

  const spawnStatusPayload = () => {
    const allRuns = Array.from(runs.values()).map(statusJson);
    return {
      sessionFile: sessionManager?.getSessionFile() ?? null,
      running: allRuns.filter((run) => run.status === "running").length,
      runs: allRuns,
    };
  };

  const publishSpawnStatus = () => {
    ui?.setStatus("pi-spawn-runs", JSON.stringify(spawnStatusPayload()));
  };

  const branchHasSpawn = (runId: string): boolean => sessionManager?.getBranch().some((entry) => {
    if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.toolName !== "spawn" || entry.message.isError) return false;
    const details = entry.message.details as { runId?: unknown } | undefined;
    return details?.runId === runId;
  }) ?? false;

  const reconcileCompletionDelivery = () => {
    const delivered = new Set<string>();
    for (const entry of sessionManager?.getBranch() ?? []) {
      if (entry.type !== "custom_message" || entry.customType !== "spawn_completion") continue;
      const details = entry.details as { runId?: unknown; runs?: { runId?: unknown }[] } | undefined;
      if (typeof details?.runId === "string") delivered.add(details.runId);
      if (Array.isArray(details?.runs)) {
        for (const run of details.runs) {
          if (typeof run?.runId === "string") delivered.add(run.runId);
        }
      }
    }
    for (const run of runs.values()) {
      const notified = delivered.has(run.id);
      if (run.notified !== notified) {
        run.notified = notified;
        writeStatus(run);
      }
    }
  };

  const completionEligible = (run: SpawnRun): boolean => !retired && run.mode === "background"
    && run.status !== "running" && !run.notified && !run.joined && !run.joinRequested && branchHasSpawn(run.id);

  const announceCompletion = (run: SpawnRun) => {
    if (!ui || !completionEligible(run) || announcedCompletions.has(run.id)) return;
    ui.notify(`Subagent ${run.id} ${run.status}${run.profile?.name ? ` (${run.profile.name})` : ""}.`, run.status === "completed" ? "info" : run.status === "aborted" ? "warning" : "error");
    announcedCompletions.add(run.id);
  };

  pi.on("before_agent_start", () => {
    if (retired) return;
    reconcileCompletionDelivery();
    const completed = Array.from(runs.values()).filter(completionEligible);
    if (!completed.length) return;
    // Pi appends these messages alongside the next user prompt, like nextTurn,
    // but nothing remains queued after an idle manual join or branch change.
    // History, not this hook returning, is the durable delivery evidence.
    return {
      message: {
        customType: "spawn_completion",
        content: completed.length === 1 ? completionContext(completed[0]!)
          : completed.map((run) => `## ${run.id}\n\n${completionContext(run)}`).join("\n\n---\n\n"),
        display: false,
        details: completed.length === 1 ? artifactDetails(completed[0]!)
          : { runs: completed.map(artifactDetails) },
      },
    };
  });

  pi.on("session_start", (_event, ctx) => {
    ui = ctx.ui;
    retired = false;
    runtimeCancellation = new AbortController();
    sessionManager = ctx.sessionManager;
    runs.clear();
    announcedCompletions.clear();
    registerSubagentRuntime(owner, () => Array.from(runs.values()).some((run) => run.status === "running"), historyBlockReason);
    for (const run of restoreRuns(ctx.sessionManager.getSessionFile())) {
      if (!runs.has(run.id)) runs.set(run.id, run);
    }
    reconcileCompletionDelivery();
    for (const run of runs.values()) announceCompletion(run);
    publishSpawnStatus();
  });

  pi.on("agent_end", (_event, ctx) => {
    if (retired) return;
    ui = ctx.ui;
    // Pi persists message_end after extension handlers. agent_end is after
    // those writes, and also catches completion before a spawn ack persisted.
    reconcileCompletionDelivery();
    for (const run of runs.values()) announceCompletion(run);
    publishSpawnStatus();
  });

  pi.on("session_tree", () => {
    if (retired) return;
    reconcileCompletionDelivery();
    // Explicit joins continue to suppress completion delivery on other branches.
  });

  pi.on("session_shutdown", () => {
    // Child cleanup is asynchronous; drop the old UI before triggering it.
    ui = undefined;
    retired = true;
    runtimeCancellation.abort();
    const ownedRuntime = retireSubagentRuntime(owner);
    const failures: string[] = [];
    for (const run of runs.values()) {
      run.joinRequested = false;
      if (run.status === "running") {
        run.stopReason = "session_shutdown";
        run.child?.abort();
      }
      if (ownedRuntime) {
        // Preserve a terminal execution status even if artifact finalization is
        // still awaiting the child. A stale owner must not overwrite a replacement.
        try { writeStatus(run); } catch (error) {
          failures.push(error instanceof Error ? error.message : String(error));
        }
      }
    }
    if (failures.length) throw new Error(`Could not save subagent shutdown state: ${failures.join("; ")}`);
  });

  const stopRun = (run: SpawnRun, reason: string) => {
    if (run.status !== "running") {
      return;
    }
    run.stopReason = reason;
    run.child?.abort();
    publishSpawnStatus();
  };

  const waitForRun = async (run: SpawnRun, signal: AbortSignal | undefined, stopOnAbort: boolean): Promise<SpawnRun> => {
    // Execution status can settle before asynchronous artifact finalization.
    // Always await the owning completion promise, including for restored runs.
    if (!signal) {
      return run.finished;
    }
    if (signal.aborted) {
      if (stopOnAbort) {
        stopRun(run, "parent_abort");
      }
      throw new Error("spawn_control aborted");
    }
    return new Promise<SpawnRun>((resolve, reject) => {
      const abort = () => {
        if (stopOnAbort) {
          stopRun(run, "parent_abort");
        }
        reject(new Error("spawn_control aborted"));
      };
      signal.addEventListener("abort", abort, { once: true });
      run.finished.then(resolve, reject).finally(() => {
        signal.removeEventListener("abort", abort);
      });
    });
  };

  const waitForRuns = async (selected: SpawnRun[], signal: AbortSignal | undefined, stopOnAbort: boolean): Promise<void> => {
    await Promise.all(selected.map((run) => waitForRun(run, signal, stopOnAbort)));
  };

  const finalizeJoin = async <T>(
    selected: SpawnRun[],
    signal: AbortSignal | undefined,
    report: () => T,
    onWaiting?: () => void,
  ): Promise<T> => {
    signal = signal ? AbortSignal.any([signal, runtimeCancellation.signal]) : runtimeCancellation.signal;
    const previouslyJoined = new Map(selected.map((run) => [run.id, run.joined]));
    try {
      if (retired) throw new Error("Spawn runtime was retired.");
      for (const run of selected) {
        run.joinRequested = true;
        writeStatus(run);
      }
      publishSpawnStatus();
      onWaiting?.();
      await waitForRuns(selected, signal, true);
      if (retired) throw new Error("Spawn runtime was retired.");
      for (const run of selected) {
        if (signal.aborted) throw new Error("spawn_control aborted before integration.");
        await applyWorktreeChanges(run, signal);
        if (retired) throw new Error("Spawn runtime was retired.");
        // Integration owns the cancellation boundary. Once applied, report the
        // actual result rather than implying cancellation left files untouched.
      }
      // A join-all result is not available until every integration attempt
      // finishes. Do not leave early members joined if a later attempt throws.
      for (const run of selected) {
        run.joinRequested = false;
        run.joined = true;
        writeStatus(run);
      }
      publishSpawnStatus();
      return report();
    } catch (error) {
      const failures: unknown[] = [error];
      for (const run of selected) {
        run.joinRequested = false;
        run.joined = previouslyJoined.get(run.id) ?? false;
        // A replacement may already have restored and finalized this run.
        if (retired) continue;
        try { writeStatus(run); } catch (failure) { failures.push(failure); }
        // Completion may have occurred while this join suppressed notification.
        try { announceCompletion(run); } catch (failure) { failures.push(failure); }
      }
      publishSpawnStatus();
      const outcomes = selected.flatMap((run) => {
        const worktree = worktreeInfo(run);
        if (worktree?.integration !== "applied" && worktree?.integration !== "failed") return [];
        return [`Subagent ${run.id}:${formatIntegrationLine(worktree)}`];
      });
      if (failures.length === 1 && outcomes.length === 0) throw error;
      const reason = failures.map((failure) => failure instanceof Error ? failure.message : String(failure)).join("; ");
      throw new Error(`${reason}${outcomes.length ? `\n\n${outcomes.join("\n\n")}` : ""}`, { cause: error });
    }
  };

  function historyBlockReason(): string | undefined {
    const all = Array.from(runs.values());
    if (all.some((run) => run.status === "running" || run.joinRequested)) {
      return "There are active subagents that haven't completed. Join them before changing history, or stop them and collect their results. Open <leader>ps to manage them.";
    }
    if (all.some((run) => !run.joined)) {
      return "There are subagent results that haven't been collected. Join them before changing history. Open <leader>ps to manage them.";
    }
    return undefined;
  }

  const blockHistoryChange = (_event: unknown, ctx: ExtensionContext) => {
    const reason = historyBlockReason();
    if (!reason) return;
    ctx.ui.notify(reason, "warning");
    return { cancel: true };
  };
  pi.on("session_before_tree", blockHistoryChange);
  pi.on("session_before_fork", blockHistoryChange);

  pi.on("session_before_switch", async (event, ctx) => {
    const running = Array.from(runs.values()).filter((run) => run.status === "running");
    if (!running.length) return;
    const action = event.reason === "new" ? "starting a new session" : "switching sessions";
    try {
      const choice = await ctx.ui.select(
        `There are running subagents. Continuing will stop them. Continue ${action}?`,
        ["Cancel", "Continue and stop subagents"],
      );
      if (choice !== "Continue and stop subagents") return { cancel: true };
      for (const run of running) stopRun(run, "session_switch");
      await waitForRuns(running, undefined, false);
    } catch (error) {
      ctx.ui.notify(`Could not stop subagents: ${error instanceof Error ? error.message : String(error)}`, "error");
      return { cancel: true };
    }
  });

  const getRunById = (id: string | undefined): SpawnRun => {
    if (!id) {
      throw new Error("spawn id is required");
    }
    const run = runs.get(id);
    if (!run) {
      throw new Error(`Unknown spawn id: ${id}`);
    }
    return run;
  };

  const emitCommandResult = (text: string, details?: Record<string, unknown>) => {
    if (!ui) throw new Error("Spawn runtime has no active UI for command results.");
    pi.sendMessage({
      customType: "spawn_control_result",
      content: text,
      display: true,
      details,
    }, { triggerTurn: false });
  };

  const createRun = (input: {
    prompt: string;
    role?: string;
    requestedAgent?: string;
    profile?: SubagentProfile;
    accessMode: AccessMode;
    isolation: IsolationMode;
    mode: SpawnMode;
    cwd: string;
    parentSessionFile?: string;
    signal?: AbortSignal;
  }): SpawnRun => {
    const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
    const spawnRoot = join(workspaceStorageRoot(), "runs");
    const runDir = join(spawnRoot, id);
    mkdirSync(runDir, { recursive: true });

    const briefPath = join(runDir, "brief.md");
    const transcriptPath = join(runDir, "transcript.jsonl");
    const resultPath = join(runDir, "result.md");
    const statusPath = join(runDir, "status.json");
    const agentPromptPath = input.profile ? join(runDir, "subagent-prompt.md") : undefined;

    let resolveFinished: (run: SpawnRun) => void = () => undefined;
    const finished = new Promise<SpawnRun>((resolvePromise) => {
      resolveFinished = resolvePromise;
    });

    const run: SpawnRun = {
      id,
      mode: input.mode,
      prompt: input.prompt,
      role: input.role,
      requestedAgent: input.requestedAgent,
      profile: input.profile,
      accessMode: input.accessMode,
      isolation: input.isolation,
      status: "running",
      startedAt: new Date().toISOString(),
      runDir,
      briefPath,
      transcriptPath,
      resultPath,
      statusPath,
      agentPromptPath,
      childCwd: input.cwd,
      parentSessionFile: input.parentSessionFile,
      notified: false,
      joined: false,
      joinRequested: false,
      finished,
      resolveFinished,
    };

    writeFileSync(briefPath, input.prompt, "utf8");
    if (input.profile && agentPromptPath) {
      writeFileSync(agentPromptPath, subagentSystemPrompt(input.profile), "utf8");
    }

    if (input.isolation === "worktree") {
      const record = createWorktree(input.cwd, id, input.parentSessionFile);
      run.worktree = { workspaceId: record.id, recoveryPatchPath: record.resultPatchPath };
      run.childCwd = record.workspaceCwd;
    }

    const abortListener = () => stopRun(run, "parent_abort");
    if (input.signal) {
      run.abortSignal = input.signal;
      run.abortListener = abortListener;
      input.signal.addEventListener("abort", abortListener, { once: true });
    }

    runs.set(id, run);
    writeStatus(run);
    publishSpawnStatus();
    return run;
  };

  const startRun = (run: SpawnRun, params: { model?: string; timeoutSeconds?: number }) => {
    const binary = process.env.PI_BINARY || "pi";
    const argv = [binary, "--mode", "rpc", "--session-dir", join(run.runDir, "sessions")];
    const model = params.model ?? (run.profile?.model && run.profile.model !== "inherit" ? run.profile.model : undefined);
    if (model) {
      argv.push("--model", model);
    }
    if (run.profile?.tools && run.profile.tools.length > 0) {
      argv.push("--tools", run.profile.tools.join(","));
    }
    if (run.agentPromptPath) {
      argv.push("--append-system-prompt", run.agentPromptPath);
    }

    const label = runLabel(run);
    let assistantPreview = "";
    let progressPublishTimer: NodeJS.Timeout | undefined;
    let lastProgressPublishAt = 0;
    const publishProgress = (immediate = false) => {
      if (immediate) {
        if (progressPublishTimer) {
          clearTimeout(progressPublishTimer);
          progressPublishTimer = undefined;
        }
        lastProgressPublishAt = Date.now();
        publishSpawnStatus();
        return;
      }
      if (progressPublishTimer) {
        return;
      }
      const now = Date.now();
      const delay = Math.max(0, 250 - (now - lastProgressPublishAt));
      progressPublishTimer = setTimeout(() => {
        progressPublishTimer = undefined;
        lastProgressPublishAt = Date.now();
        publishSpawnStatus();
      }, delay);
    };
    const transcript = (event: RpcEvent) => {
      appendFileSync(run.transcriptPath, `${JSON.stringify({ timestamp: new Date().toISOString(), event })}\n`, "utf8");
    };
    const summarizeChildEvent = (event: RpcEvent): string | undefined => {
      if (event.type === "agent_start") {
        return `${label} ${run.id} started (${run.accessMode}).`;
      }
      if (event.type === "turn_start") {
        return `${label} thinking…`;
      }
      if (event.type === "tool_execution_start") {
        const toolName = typeof event.toolName === "string" ? event.toolName : "tool";
        return `${label} running ${toolName}${previewToolArgs(toolName, event.args)}.`;
      }
      if (event.type === "tool_execution_end") {
        const toolName = typeof event.toolName === "string" ? event.toolName : "tool";
        return `${label} completed ${toolName}.`;
      }
      if (event.type === "message_update") {
        const update = event.assistantMessageEvent as { type?: unknown; delta?: unknown } | undefined;
        if (update?.type === "text_delta" && typeof update.delta === "string") {
          assistantPreview = compactOneLine(`${assistantPreview}${update.delta}`, 120);
          if (assistantPreview) {
            return `${label} writing final report: ${assistantPreview}`;
          }
        }
      }
      if (event.type === "child_stderr") {
        const text = compactOneLine(event.text, 120);
        return text ? `${label} stderr: ${text}` : undefined;
      }
      if (event.type === "child_exit") {
        return `${label} process exited: code=${String(event.code ?? "null")} signal=${String(event.signal ?? "null")}.`;
      }
      return undefined;
    };

    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      PI_SPAWN_AGENT: "1",
      PI_SPAWN_ACCESS_MODE: run.accessMode,
      PI_INTERACTION_MODE: "noninteractive",
      PI_SUBAGENT_NAME: run.profile?.name ?? run.requestedAgent ?? run.role ?? "",
      PI_WORKSPACE_ID: run.worktree?.workspaceId ?? "",
    };
    if (process.env.PI_CODING_AGENT_DIR) {
      childEnv.PI_CODING_AGENT_DIR = process.env.PI_CODING_AGENT_DIR;
    }

    const child = new PiRpcChild(argv, {
      cwd: run.childCwd,
      env: childEnv,
      onEvent: (event) => {
        transcript(event);
        const progress = summarizeChildEvent(event);
        if (run.status === "running" && progress && progress !== run.progress) {
          run.progress = progress;
          if (!retired) writeStatus(run);
          publishProgress();
        }
      },
    });
    run.child = child;

    const timeoutMs = Math.max(1, params.timeoutSeconds ?? 1800) * 1000;
    run.timeout = setTimeout(() => stopRun(run, "timeout"), timeoutMs);

    void (async () => {
      try {
        const agentEnd = child.waitForAgentEnd();
        const [, terminalEnd] = await Promise.all([
          child.send({
            type: "prompt",
            message: spawnPrompt({
              prompt: run.prompt,
              role: run.role,
              agent: run.profile,
              accessMode: run.accessMode,
              briefPath: run.briefPath,
              agentPromptPath: run.agentPromptPath,
            }),
          }).then((response) => assertSuccess(response, "subagent prompt")),
          agentEnd,
        ]);
        const terminalError = terminalAssistantError(terminalEnd);
        if (terminalError) {
          throw terminalError;
        }
        const lastAssistant = await child.send({ type: "get_last_assistant_text" });
        assertSuccess(lastAssistant, "get subagent result");
        run.resultText = textFromLastAssistantResponse(lastAssistant) ?? "";
        run.status = "completed";
        run.progress = compactOneLine(run.resultText, 160) || "completed";
        writeFileSync(run.resultPath, run.resultText, "utf8");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (run.stopReason) {
          run.status = "aborted";
          run.error = run.stopReason === "timeout" ? "Subagent timed out." : `Subagent aborted: ${run.stopReason}.`;
        } else if (error instanceof SubagentTerminalError) {
          run.status = error.status;
          run.error = message;
        } else {
          run.status = "error";
          run.error = message;
        }
        run.resultText = run.error;
        run.progress = compactOneLine(run.error, 160) || run.status;
        writeFileSync(run.resultPath, `${run.error}\n`, "utf8");
      } finally {
        run.completedAt = new Date().toISOString();
        if (run.timeout) {
          clearTimeout(run.timeout);
          run.timeout = undefined;
        }
        if (run.abortSignal && run.abortListener) {
          run.abortSignal.removeEventListener("abort", run.abortListener);
        }
        if (run.worktree) {
          try {
            const state = await child.send({ type: "get_state" });
            const data = state.data as { sessionFile?: unknown } | undefined;
            if (typeof data?.sessionFile === "string") {
              const childSessionFile = data.sessionFile;
              await updateWorkspace(run.worktree.workspaceId, (record) => {
                record.targetSessionFile = childSessionFile;
              });
            }
          } catch {
            // A terminated child may not be able to report its session path; run artifacts still retain its session directory.
          }
        }
        try {
          await prepareWorktreePatch(run);
        } catch (error) {
          if (run.worktree) {
            run.integrationBlock = { integration: "failed", reason: `failed to create patch: ${error instanceof Error ? error.message : String(error)}` };
          }
        }
        if (run.worktree && !run.integrationBlock && run.status !== "completed") {
          run.integrationBlock = { integration: "needs_parent", reason: `subagent status is ${run.status}` };
        }
        if (progressPublishTimer) {
          clearTimeout(progressPublishTimer);
          progressPublishTimer = undefined;
        }
        child.dispose();
        // Retired callbacks may finish artifacts but must not overwrite status
        // already restored by a replacement runtime or publish to its UI.
        if (!retired) {
          writeStatus(run);
          publishProgress(true);
          announceCompletion(run);
        }
        run.resolveFinished(run);
      }
    })().catch((error: unknown) => {
      child.dispose();
      const failure = error instanceof Error ? error : new Error(String(error));
      // A failed status write/send is reported, but must not strand all later
      // joins. Their own writes can retry durable finalization.
      run.resolveFinished(run);
      ui?.notify(`Could not finalize subagent ${run.id}: ${failure.message}`, "error");
    });
  };

  pi.registerCommand("spawn-control", {
    description: "Control spawned subagents: /spawn-control list|status|join|stop <id>",
    handler: async (args, ctx) => {
      ui = ctx.ui;
      const parts = (args || "").trim().split(/\s+/).filter(Boolean);
      const action = parts[0] || "list";
      const id = parts[1];
      try {
        if (action === "list") {
          publishSpawnStatus();
          emitCommandResult(Array.from(runs.values()).map(formatRunStatus).join("\n\n") || "No spawned subagents in this session.", spawnStatusPayload());
          return;
        }
        if (action === "status") {
          const run = getRunById(id);
          emitCommandResult(formatRunStatus(run), artifactDetails(run));
          return;
        }
        if (action === "join") {
          const run = getRunById(id);
          await finalizeJoin([run], ctx.signal, () => emitCommandResult(resultSummary(run), artifactDetails(run)));
          return;
        }
        if (action === "stop") {
          const run = getRunById(id);
          stopRun(run, "stopped_by_parent");
          await waitForRun(run, ctx.signal, false);
          publishSpawnStatus();
          emitCommandResult(`Stopped ${run.id}: ${run.status}${run.error ? ` (${run.error})` : ""}`, artifactDetails(run));
          return;
        }
        ui?.notify("Usage: /spawn-control list|status|join|stop <id>", "warning");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ui?.notify(message, "error");
        emitCommandResult(`spawn-control ${action} failed: ${message}`);
      }
    },
  });

  pi.registerTool({
    name: "spawn",
    label: "Spawn Subagent",
    description: "Spawn a bounded isolated pi subagent. Defaults to background mode and returns a handle immediately. If the parent answer depends on the result, call spawn_control join or join_all. Named profiles load from ~/.pi/agent/agents/*.md and trusted .pi/agents/*.md; run artifacts are stored with Pi workspace state.",
    promptSnippet: "Spawn background or foreground pi subagents, primarily for read-heavy research, investigation, summarization, review, and verification; worker handles self-contained tasks requiring file changes.",
    promptGuidelines: [
      "Use spawn when the user asks for subagents or when bounded read-heavy work would help: research, investigation, summarization, review, or verification.",
      "The main agent normally implements changes. Delegate writing only when the user approved implementation, requirements are settled, ownership is non-overlapping, the result can be verified independently, and the benefit outweighs briefing and integration overhead. Keep tightly coupled changes and evolving design decisions in the main session.",
      "spawn defaults to background. If your response depends on the subagent result, call spawn_control with action=join or join_all before answering.",
      "Prefer researcher for investigation and summarization, reviewer for review, verifier for verification, and worker for self-contained tasks requiring file changes.",
      "Use accessMode=readonly for research/planning/investigation/summarization/review/verification. Use accessMode=edit for approved writing tasks that meet the delegation criteria; edit agents use isolated git worktrees and their changes are reconciled at join. Use accessMode=full only when the parent is in full mode and unrestricted host access is required.",
    ],
    parameters: Type.Object({
      prompt: Type.String({ description: "The complete bounded prompt/task for the subagent." }),
      agent: Type.Optional(Type.String({ description: "Named subagent profile to load from ~/.pi/agent/agents/*.md or trusted .pi/agents/*.md, e.g. researcher, reviewer, verifier, worker." })),
      role: Type.Optional(Type.String({ description: "Backward-compatible role/instructions label. If it matches a subagent profile and agent is omitted, that profile is loaded." })),
      mode: Type.Optional(Type.Union([
        Type.Literal("background"),
        Type.Literal("foreground"),
      ], { description: "Execution mode. Defaults to background. Foreground blocks until the subagent finishes." })),
      accessMode: Type.Optional(Type.Union([
        Type.Literal("readonly"),
        Type.Literal("ask"),
        Type.Literal("edit"),
        Type.Literal("full"),
      ], { description: "Subagent access mode. Defaults to the profile accessMode, otherwise readonly." })),
      isolation: Type.Optional(Type.Union([
        Type.Literal("none"),
        Type.Literal("worktree"),
      ], { description: "Isolation mode. Defaults to worktree for edit access and none otherwise." })),
      model: Type.Optional(Type.String({ description: "Optional pi --model value for the subagent. Defaults to the profile model, otherwise inherits the parent invocation default." })),
      timeoutSeconds: Type.Optional(Type.Number({ description: "Optional timeout in seconds. Defaults to 1800." })),
    }),
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      ui = ctx.ui;
      const mode = parseSpawnMode(params.mode);
      if (mode === "background") {
        const running = Array.from(runs.values()).filter((run) => run.mode === "background" && run.status === "running").length;
        if (running >= MAX_BACKGROUND_RUNS) {
          return {
            content: [{ type: "text", text: `Too many background subagents running (${running}). Limit is ${MAX_BACKGROUND_RUNS}. Use spawn_control list/join/stop before spawning more.` }],
            isError: true,
            details: { status: "error", running, limit: MAX_BACKGROUND_RUNS },
          };
        }
      }

      const includeProjectAgents = typeof ctx.isProjectTrusted === "function" ? ctx.isProjectTrusted() : false;
      const profiles = discoverSubagentProfiles(ctx.cwd, includeProjectAgents);
      const subagent = resolveSubagentProfile({ agent: params.agent, role: params.role, profiles });
      const accessMode = (params.accessMode ?? subagent?.accessMode ?? "readonly") as AccessMode;
      if (!ACCESS_MODES.includes(accessMode)) {
        throw new Error(`Invalid accessMode: ${String(params.accessMode)}`);
      }
      if (accessMode === "edit" && getAccessMode() !== "edit" && getAccessMode() !== "full") {
        throw new Error("edit-mode spawned subagents require parent access mode edit or full. Run /pi-mode edit before delegating edit work.");
      }
      if (accessMode === "full" && getAccessMode() !== "full") {
        throw new Error("full-mode spawned subagents require parent access mode full. Run /pi-mode full before delegating unrestricted work.");
      }
      const isolation = parseIsolationMode(params.isolation, accessMode);
      if (accessMode === "edit" && isolation !== "worktree") {
        throw new Error("edit-mode spawned subagents must use worktree isolation");
      }
      if (isolation === "worktree") {
        const parentWorkspace = workspaceForContext(ctx.cwd, ctx.sessionManager.getSessionFile());
        if (!parentWorkspace) {
          throw new Error("Isolated writing subagents require an active parent task workspace. Call workspace with action=enter first.");
        }
        if (parentWorkspace.kind === "task" && !sameSessionFile(parentWorkspace.sourceSessionFile, ctx.sessionManager.getSessionFile())) {
          throw new Error(`Workspace ${parentWorkspace.id} belongs to another conversation; do not spawn writers from a fork of its session.`);
        }
        if (isWorkspaceFinalized(parentWorkspace)) {
          throw new Error(
            `Workspace ${parentWorkspace.id} has a finalized contribution and cannot host writing subagents.`,
          );
        }
      }

      const run = createRun({
        prompt: params.prompt,
        role: params.role,
        requestedAgent: params.agent,
        profile: subagent,
        accessMode,
        isolation,
        mode,
        cwd: ctx.cwd,
        parentSessionFile: ctx.sessionManager.getSessionFile(),
        signal,
      });

      startRun(run, { model: params.model, timeoutSeconds: params.timeoutSeconds });

      if (mode === "background") {
        onUpdate?.({ content: [{ type: "text", text: `${runLabel(run)} ${run.id} started (${accessMode}).` }], details: artifactDetails(run) });
        return {
          content: [{ type: "text", text: formatSpawnStarted(run) }],
          details: artifactDetails(run),
        };
      }

      onUpdate?.({ content: [{ type: "text", text: `${runLabel(run)} ${run.id} running in foreground (${accessMode}).` }], details: artifactDetails(run) });
      return finalizeJoin([run], signal, () => ({
        content: [{ type: "text" as const, text: resultSummary(run) }],
        isError: run.status !== "completed",
        details: artifactDetails(run),
      }));
    },
  });

  pi.registerTool({
    name: "spawn_control",
    label: "Control Subagents",
    description: "Inspect, join, join_all, or stop background subagents created with spawn. join is a normal blocking tool call. For edit agents, join applies isolated worktree changes automatically only when safe; conflicts or overlapping parent changes are returned for parent handling.",
    promptSnippet: "Control spawned subagents: list, status, join, join_all, or stop.",
    promptGuidelines: [
      "Use spawn_control join or join_all before answering if your response depends on background subagent results.",
      "Use status/list to inspect outstanding background work. Use stop to cancel unneeded background subagents.",
      "If join reports integration=needs_parent, inspect the returned patch/worktree and integrate manually only if appropriate.",
    ],
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("list"),
        Type.Literal("status"),
        Type.Literal("join"),
        Type.Literal("join_all"),
        Type.Literal("stop"),
      ], { description: "Lifecycle action to perform." }),
      id: Type.Optional(Type.String({ description: "Spawn id for status/join/stop." })),
      ids: Type.Optional(Type.Array(Type.String(), { description: "Optional spawn ids for join_all or stop." })),
    }),
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      ui = ctx.ui;
      const allRuns = Array.from(runs.values());
      const getRun = (id: string | undefined): SpawnRun => {
        if (!id) {
          throw new Error(`action=${params.action} requires id`);
        }
        const run = runs.get(id);
        if (!run) {
          throw new Error(`Unknown spawn id: ${id}`);
        }
        return run;
      };

      if (params.action === "list") {
        const text = allRuns.length === 0 ? "No spawned subagents in this session." : allRuns.map(formatRunStatus).join("\n\n");
        return { content: [{ type: "text", text }], details: { runs: allRuns.map(statusJson) } };
      }

      if (params.action === "status") {
        const run = getRun(params.id);
        return { content: [{ type: "text", text: formatRunStatus(run) }], details: artifactDetails(run) };
      }

      if (params.action === "stop") {
        const selected = params.ids?.length ? params.ids.map((id: string) => getRun(id)) : [getRun(params.id)];
        for (const run of selected) {
          stopRun(run, "stopped_by_parent");
        }
        await waitForRuns(selected, signal, false);
        const text = selected.map((run) => `Stopped ${run.id}: ${run.status}${run.error ? ` (${run.error})` : ""}`).join("\n");
        return { content: [{ type: "text", text }], details: { runs: selected.map(statusJson) } };
      }

      if (params.action === "join") {
        const run = getRun(params.id);
        return finalizeJoin([run], signal, () => ({
          content: [{ type: "text" as const, text: resultSummary(run) }],
          isError: run.status !== "completed" || worktreeInfo(run)?.integration === "failed",
          details: artifactDetails(run),
        }), () => {
          if (run.status === "running") {
            onUpdate?.({ content: [{ type: "text", text: `Waiting for subagent ${run.id}…` }], details: artifactDetails(run) });
          }
        });
      }

      if (params.action === "join_all") {
        const selected = params.ids?.length
          ? params.ids.map((id: string) => getRun(id))
          : allRuns.filter((run) => run.status === "running" || !run.joined);
        if (selected.length === 0) {
          return { content: [{ type: "text", text: "No spawned subagents to join." }], details: { runs: [] } };
        }
        return finalizeJoin(selected, signal, () => ({
          content: [{ type: "text" as const, text: selected.map((run) => `## ${run.id}\n\n${resultSummary(run)}`).join("\n\n---\n\n") }],
          isError: selected.some((run) => run.status !== "completed" || worktreeInfo(run)?.integration === "failed"),
          details: { runs: selected.map(statusJson) },
        }), () => onUpdate?.({ content: [{ type: "text", text: `Waiting for ${selected.length} subagent(s)…` }], details: { runs: selected.map(statusJson) } }));
      }

      return { content: [{ type: "text", text: `Unknown action: ${String(params.action)}` }], isError: true };
    },
  });
}
