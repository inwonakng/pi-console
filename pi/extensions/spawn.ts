import { serviceUi } from "./shared/service-ui";
import { compactOrchestration } from "./shared/spawn-compaction";
import { registerServiceOperation } from "./shared/service-operation";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter, type ExtensionAPI, type ExtensionContext, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { beginEpoch, managedSpawn, managedResult, stopManaged } from "../scripts/managed-process.mjs";
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
import { accessRevision, getAccessMode, onAccessInvalidated } from "./shared/access-state";
import { canonicalPath, getSessionGrants, hasPermission, requestPermission, validPermissionAttempt, permissionWasDenied, type PermissionAuthorization, type PermissionPreview } from "./shared/permissions";
import { loadExtensionSettings, type SubagentModelSetting } from "./shared/extension-settings";
import { saveSessionSetting } from "./shared/session-settings";
import { assertRepositoryIdle, registerSubagentRuntime, retireSubagentRuntime } from "./shared/subagent-state";
import { spawnRunIds } from "./shared/session-deletion";
import { agentContext, newAssignment, registerWorkerProtocol, SPAWN_PROTOCOL_TITLE, SPAWN_PERMISSION_CANCEL, SPAWN_PERMISSION_FINISH, WORKER_TOOLS, type Assignment, type WorkerExecution, type WorkerLifetime, type WorkerOperation, type WorkerRequest, type WorkerPermissionOperation, type WorkerPermissionRequest } from "./shared/spawn-protocol";
import {
  createWorkspace,
  findGitRoot,
  integrateWorkspace,
  isWorkspaceFinalized,
  loadWorkspace,
  prepareWorkspaceDiscard,
  removeWorkspace,
  repositoryWriteRoots,
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

type ModelIdentity = { provider: string; id: string };
type ModelSelection = ModelIdentity & { source: "override" | "settings" | "profile" | "parent" };

type SpawnRun = {
  id: string;
  parentId: string;
  lifetime: WorkerLifetime;
  execution: WorkerExecution;
  assignments: Assignment[];
  requests: WorkerRequest[];
  permissionRequests: WorkerPermissionRequest[];
  runtimeId?: string;
  deliveredEvents: string[];
  pendingDialog?: string;
  changed: Set<() => void>;
  resume?: () => void;
  armTimeout?: () => void;
  closing?: boolean;
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
  ownerEntryId?: string;
  cancellationRequested?: boolean;
  settled: boolean;
  worktree?: RunWorkspace;
  integrationBlock?: IntegrationBlock;
  cleanupError?: string;
  protectedRoots?: string[];
  childSessionFile?: string;
  modelSelection?: ModelSelection;
  selectedModel?: ModelIdentity;
  launch?: { model: string; provider: string; timeoutSeconds?: number };
  accepting?: boolean;
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
  private readonly closed: Promise<void>;
  private closing?: Promise<void>;

  constructor(
    argv: string[],
    options: { cwd: string; env: NodeJS.ProcessEnv; onEvent: (event: RpcEvent) => void; onDialog: (event: RpcEvent) => boolean },
  ) {
    this.proc = managedSpawn(argv[0], argv.slice(1), {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.closed = new Promise((resolve, reject) => {
      this.proc.once("error", reject);
      this.proc.once("close", () => {
        try {
          if (managedResult(this.proc)?.managedUnresolved) reject(new Error("Spawned managed work remains unresolved"));
          else resolve();
        } catch (error) { reject(error); }
      });
    });
    void this.closed.catch(() => undefined);

    this.proc.stdout.on("data", (chunk) => {
      this.stdoutBuffer += chunk.toString("utf8");
      this.drainLines(this.stdoutBuffer, (remaining) => {
        this.stdoutBuffer = remaining;
      }, (line) => this.handleStdoutLine(line, options.onEvent, options.onDialog));
    });

    this.proc.stderr.on("data", (chunk) => {
      this.stderrBuffer += chunk.toString("utf8");
      this.drainLines(this.stderrBuffer, (remaining) => {
        this.stderrBuffer = remaining;
      }, (line) => {
        options.onEvent({ type: "child_stderr", text: line });
      });
    });

    this.proc.stdin.on("error", (error) => {
      this.rejectAll(error);
      this.agentEndRejecter?.(error);
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

  abort(): void { void this.dispose().catch(() => undefined); }

  dispose(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      if (!this.ended) {
        this.proc.stdin.end();
        if (!stopManaged(this.proc)) {
          this.proc.kill("SIGTERM");
          this.killTimer = setTimeout(() => { if (!this.ended) this.proc.kill("SIGKILL"); }, 5000);
        }
      }
      try { await this.closed; }
      finally { if (this.killTimer) clearTimeout(this.killTimer); }
    })();
    return this.closing;
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

  respond(id: string, value?: string): void {
    if (this.ended) throw new Error("Child process has exited");
    this.proc.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id, ...(value === undefined ? { cancelled: true } : { value }) })}\n`);
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

  private handleStdoutLine(line: string, onEvent: (event: RpcEvent) => void, onDialog: (event: RpcEvent) => boolean): void {
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
      if (!onDialog(event)) this.handleExtensionUiRequest(event);
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
  return accessMode !== "readonly" ? "worktree" : "none";
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

// Resolve against the live registry, never the CLI's fuzzy/custom-ID fallback.
function resolveWorkerModel(ctx: ExtensionContext, input: {
  override?: string;
  role?: string;
  profile?: SubagentProfile;
  defaults: Record<string, SubagentModelSetting>;
}): ModelSelection {
  if (ctx.modelRegistry.getError()) throw new Error("Subagent model registry is unavailable; correct provider configuration before spawning.");
  let identity: ModelIdentity;
  let source: ModelSelection["source"];
  const configured = input.role && Object.hasOwn(input.defaults, input.role) ? input.defaults[input.role] : undefined;
  const reference = input.override ?? (configured ? undefined : input.profile?.model);
  if (input.override !== undefined || (reference && reference !== "inherit")) {
    source = input.override !== undefined ? "override" : "profile";
    const models = ctx.modelRegistry.getAll();
    const qualified = models.filter(model => `${model.provider}/${model.id}` === reference);
    const prefix = reference?.split("/", 1)[0];
    const providerQualified = reference?.includes("/") && models.some(model => model.provider === prefix);
    const matches = providerQualified || qualified.length ? qualified : models.filter(model => model.id === reference);
    if (matches.length !== 1) throw new Error(matches.length
      ? `Ambiguous subagent model ${reference}; use an exact provider/model-id reference.`
      : `Unknown subagent model ${reference}; use an exact registered provider/model-id reference.`);
    identity = { provider: matches[0].provider, id: matches[0].id };
  } else if (configured) {
    source = "settings";
    identity = { provider: configured.provider, id: configured.model };
  } else {
    source = "parent";
    if (!ctx.model) throw new Error("Cannot inherit a subagent model: the parent has no selected model.");
    identity = { provider: ctx.model.provider, id: ctx.model.id };
  }
  const model = ctx.modelRegistry.find(identity.provider, identity.id);
  if (!model || model.api === "unknown") throw new Error(`Unknown subagent model ${identity.provider}/${identity.id} (${source}).`);
  if (!ctx.modelRegistry.hasConfiguredAuth(model)) throw new Error(`Unavailable subagent model ${identity.provider}/${identity.id} (${source}); configure its provider before spawning. No alternative was selected.`);
  return { ...identity, source };
}

function subagentSystemPrompt(profile: SubagentProfile): string {
  return `You are the ${profile.name} subagent in a pi parent session.

**Description:** ${profile.description}

**Source:** ${profile.source}

**Profile path:** ${profile.filePath}

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
    ? `**Subagent profile:** ${input.agent.name}

**Description:** ${input.agent.description}

**Profile path:** ${input.agent.filePath}${input.agentPromptPath ? `\n\n**Loaded prompt artifact:** ${input.agentPromptPath}` : ""}`
    : "**Subagent profile:** none (generic spawned subagent)";

  return `You are a subagent working inside a pi parent session.

## Subagent

**Role:** ${role}

${agentSection}

**Access mode:** ${input.accessMode}

**Interaction mode:** noninteractive

**Task brief path:** ${input.briefPath}

## Instructions

- Read the task carefully and do only that task.
- Keep exploration targeted.
- Ask for missing information with spawn_question. Parent answers are agent-authored, not user consent.
- Request permissions through tool arguments. The runtime routes requests to the parent and, when needed, the existing user approval UI. Clarification replies never grant authority. Denial or cancellation ends that attempt; do not bypass it through another agent or path.
- If access mode is readonly, do not attempt to modify files.
- Call spawn_report exactly once with outcome=completed or blocked, summary, findings, verification, and uncertainty. Final text, DONE, or process exit does not complete the assignment.
- Do not delegate to other workers.
- Include key evidence: files inspected, commands run, findings, and any artifact paths.

## Task

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
    patchPath: run.settled && patchPath && existsSync(patchPath) ? patchPath : null,
    changedFiles: record?.changedFiles ?? [],
    unpreservedFiles: record?.unpreservedFiles ?? [],
    integration: finalizedIntegration ?? (unavailable ? "needs_parent"
      : block?.integration ?? (record?.integration === "conflict" ? "needs_parent" : record?.integration ?? "needs_parent")),
    integrationReason: finalizedIntegration ? record?.integrationReason : unavailableReason ?? block?.reason ?? record?.integrationReason,
    retained: record?.retained ?? false,
  };
}

const FILE_SAMPLE_COUNT = 32;
const FILE_SAMPLE_BYTES = 8 * 1024;
function fileSample(files: string[]): { files: string[]; total: number; omitted: number } {
  const sample: string[] = [];
  let bytes = 2;
  for (const file of files) {
    const next = Buffer.byteLength(JSON.stringify(file)) + (sample.length ? 1 : 0);
    if (sample.length >= FILE_SAMPLE_COUNT || bytes + next > FILE_SAMPLE_BYTES) break;
    sample.push(file);
    bytes += next;
  }
  return { files: sample, total: files.length, omitted: files.length - sample.length };
}

function workspaceDetails(worktree: WorktreeInfo | undefined, durable = false) {
  const changed = fileSample(worktree?.changedFiles ?? []);
  const unpreserved = fileSample(worktree?.unpreservedFiles ?? []);
  // Keep nested scalars (including null clearing) without repeating file lists.
  const { changedFiles: _changed, unpreservedFiles: _unpreserved, ...scalars } = worktree ?? {};
  return {
    workspaceId: worktree?.workspaceId,
    worktreePath: worktree?.path,
    patchPath: worktree?.patchPath,
    integration: worktree?.integration ?? "not_applicable",
    integrationReason: worktree?.integrationReason ?? null,
    changedFiles: durable ? worktree?.changedFiles : changed.files,
    changedFilesTotal: changed.total,
    changedFilesOmitted: durable ? 0 : changed.omitted,
    unpreservedFiles: durable ? worktree?.unpreservedFiles : unpreserved.files,
    unpreservedFilesTotal: unpreserved.total,
    unpreservedFilesOmitted: durable ? 0 : unpreserved.omitted,
    worktree: worktree ? { ...(durable ? worktree : scalars), integrationReason: worktree.integrationReason ?? null } : null,
  };
}

function ownsWriter(run: SpawnRun): boolean {
  if (run.accessMode === "readonly" && run.isolation === "none") return false;
  if (!run.worktree) return !run.settled || !!run.cleanupError;
  const record = loadWorkspace(run.worktree.workspaceId);
  // Missing records and failed cleanup are uncertainty, never released ownership.
  return !run.settled || !!run.cleanupError || !record || record.retained
    || !(isWorkspaceFinalized(record) || record.lifecycle === "discarded");
}

function artifactDetails(run: SpawnRun): Record<string, unknown> {
  return {
    version: 1,
    runId: run.id,
    parentId: run.parentId,
    lifetime: run.lifetime,
    execution: run.execution,
    assignment: run.assignments.at(-1),
    writerOwned: ownsWriter(run),
    quiescent: run.settled && !run.cleanupError,
    readyForReview: run.settled && !run.cleanupError && run.assignments.at(-1)?.outcome === "completed" && ownsWriter(run),
    assignments: run.assignments,
    permissionRequests: run.permissionRequests,
    runtimeId: run.runtimeId,
    requests: run.requests,
    deliveredEvents: run.deliveredEvents,
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
    modelSelection: run.modelSelection ?? null,
    selectedModel: run.selectedModel ?? null,
    status: run.status,
    progress: run.progress ?? null,
    joined: run.joined,
    cancellationRequested: run.cancellationRequested ?? false,
    settled: run.settled,
    joinRequested: run.joinRequested ?? false,
  };
}

function statusJson(run: SpawnRun, durable = false): Record<string, unknown> {
  return {
    version: 1,
    status: run.status,
    runId: run.id,
    parentId: run.parentId,
    lifetime: run.lifetime,
    execution: run.execution,
    assignments: run.assignments,
    permissionRequests: run.permissionRequests,
    runtimeId: run.runtimeId,
    requests: run.requests,
    deliveredEvents: run.deliveredEvents,
    ownerPid: process.pid,
    writerOwned: ownsWriter(run),
    quiescent: run.settled && !run.cleanupError,
    readyForReview: run.settled && !run.cleanupError && run.assignments.at(-1)?.outcome === "completed" && ownsWriter(run),
    protectedRoots: run.protectedRoots,
    childSessionFile: run.childSessionFile,
    prompt: run.prompt,
    parentSessionFile: run.parentSessionFile ?? null,
    ownerEntryId: run.ownerEntryId,
    cancellationRequested: run.cancellationRequested ?? false,
    settled: run.settled,
    stopReason: run.stopReason,
    accessMode: run.accessMode,
    isolation: run.isolation,
    mode: run.mode,
    role: run.role ?? null,
    agent: run.profile?.name ?? run.requestedAgent ?? null,
    agentSource: run.profile?.source ?? null,
    agentProfilePath: run.profile?.filePath ?? null,
    modelSelection: run.modelSelection ?? null,
    selectedModel: run.selectedModel ?? null,
    startedAt: run.startedAt,
    completedAt: run.completedAt ?? null,
    error: run.error ?? null,
    progress: run.progress ?? null,
    notified: run.notified,
    joined: run.joined,
    joinRequested: run.joinRequested ?? false,
    integrationBlock: run.integrationBlock,
    cleanupError: run.cleanupError,
    briefPath: run.briefPath,
    resultPath: run.resultPath,
    transcriptPath: run.transcriptPath,
    agentPromptPath: run.agentPromptPath,
    statusPath: run.statusPath,
    ...workspaceDetails(worktreeInfo(run), durable),
  };
}

function writeStatus(run: SpawnRun): void {
  const temporary = `${run.statusPath}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(statusJson(run, true), null, 2), "utf8");
  renameSync(temporary, run.statusPath);
}

function pendingRequestSummary(run: SpawnRun): string | undefined {
  const permissions = run.permissionRequests.filter((request) => request.state === "pending");
  const questions = run.requests.filter((request) => request.state === "pending");
  if (!permissions.length && !questions.length) return;
  const instructions: string[] = [];
  if (permissions.length) {
    instructions.push(run.execution === "waiting_user"
      ? "Worker blocked: awaiting the user's permission decision in the existing approval UI. Do not submit another decision while it is pending."
      : "Worker blocked: awaiting your permission decision. Use spawn_control action=approve or deny with id=workerId, assignmentId, requestId=id, runtimeId, parentRuntimeId from the permission request. Approval beyond your authority opens the existing user approval UI; reply cannot grant permission.");
  }
  if (questions.length) instructions.push("Worker blocked: awaiting your clarification reply. Use spawn_control action=reply with id=workerId, assignmentId, requestId=id from the question, and message containing your answer. Read needed context or ask the user if a decision is missing; do not invent consent.");
  instructions.push("Resolve the request before observing this worker again, or explicitly stop the worker if abandoning the assignment. status and join cannot resolve it or resume the worker. After responding, use join to wait for the next request or result.");
  return `${instructions.join("\n")}\n${agentContext({ kind: "worker", id: run.id }, { pendingPermissions: permissions, pendingQuestions: questions })}`;
}

function resultSummary(run: SpawnRun): string {
  const pending = pendingRequestSummary(run);
  if (pending) return pending;
  const resultText = run.resultText?.trim() || `Worker ${run.id}: execution=${run.execution}, assignment=${run.assignments.at(-1)?.outcome ?? "unknown"}.`;
  const agentPromptLine = run.agentPromptPath ? `\n- Subagent prompt: ${run.agentPromptPath}` : "";
  const worktree = worktreeInfo(run);
  const patchLine = worktree?.patchPath ? `\n- Patch: ${worktree.patchPath}` : "";
  const worktreeLine = worktree?.retained && worktree.path ? `\n- Worktree: ${worktree.path}` : "";
  const integrationLine = formatIntegrationLine(worktree);
  return `${agentContext({ kind: "worker", id: run.id }, { assignmentId: run.assignments.at(-1)?.id, execution: run.execution, outcome: run.assignments.at(-1)?.outcome, output: resultText })}${integrationLine}\n\nArtifacts:\n- Brief: ${run.briefPath}\n- Result: ${run.resultPath}\n- Transcript: ${run.transcriptPath}\n- Status: ${run.statusPath}${agentPromptLine}${patchLine}${worktreeLine}`;
}

function formatIntegrationLine(worktree: WorktreeInfo | undefined): string {
  if (!worktree) {
    return "";
  }
  if (worktree.integration === "applied") {
    const sample = fileSample(worktree.changedFiles);
    const files = sample.total > 0 ? `\n\nApplied isolated worktree changes to parent worktree:\n${sample.files.map((file) => `- ${file}`).join("\n")}${sample.omitted ? `\n(${sample.omitted} more files; full list in the status artifact.)` : ""}` : "\n\nApplied isolated worktree changes to parent worktree.";
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
  return worktree.integration === "pending" ? "\n\nNot accepted. Inspect with report/diff; use spawn_control action=accept with the worker and assignment IDs to integrate explicitly." : "";
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
  if (!run.settled || run.child || !["closed", "idle"].includes(run.execution)) throw new Error("Worker must be quiescent and cleanup settled before acceptance");
  if (run.assignments.at(-1)?.outcome !== "completed") throw new Error("Acceptance requires explicit assignment completion");
  if (run.cleanupError) throw new Error(`Managed child cleanup unresolved: ${run.cleanupError}`);
  if (!run.worktree) return;
  const record = loadWorkspace(run.worktree.workspaceId);
  if (record && isWorkspaceFinalized(record)) {
    run.integrationBlock = undefined;
    if (record.retained && (getAccessMode() === "edit" || getAccessMode() === "full")) await removeWorkspace(record.id, "integrated");
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
  return `Spawned subagent.\n- id: ${run.id}\n- execution: ${run.execution}\n- lifecycle status: ${run.status}\n- model: ${run.selectedModel ? `${run.selectedModel.provider}/${run.selectedModel.id}` : `awaiting confirmation of ${run.modelSelection?.provider}/${run.modelSelection?.id}`}\n- agent: ${run.profile?.name ?? run.requestedAgent ?? "generic"}\n- accessMode: ${run.accessMode}\n- isolation: ${run.isolation}\n- brief: ${run.briefPath}\n- result: ${run.resultPath}\n- transcript: ${run.transcriptPath}\n- status file: ${run.statusPath}${worktreeLine}\n\nUse spawn_control join to wait, not repeated status checks. join and foreground spawn return when a worker needs a response or finishes. Handle a returned question with reply, or permission with approve/deny using the exact request and runtime IDs, before joining again. Read needed context or obtain missing user input; polling cannot resume a blocked worker. Use status/report/diff for inspection, not waiting. accept explicitly integrates completed, quiescent workers. Conversational workers support followup corrections before acceptance and close. Only one unresolved writer is allowed; discard explicitly disposes an unwanted contribution.`;
}

function runHasError(run: SpawnRun): boolean {
  return !!run.cleanupError || run.execution === "failed" || run.execution === "cancelled" || worktreeInfo(run)?.integration === "failed"
    || (run.execution !== "working" && run.execution !== "waiting_parent" && run.execution !== "waiting_user" && run.assignments.at(-1)?.outcome !== "completed");
}

function formatRunStatus(run: SpawnRun): string {
  const worktree = worktreeInfo(run);
  const sample = fileSample(worktree?.changedFiles ?? []);
  const changed = sample.total ? `\n- changed files: ${sample.files.join(", ")}${sample.omitted ? ` (${sample.omitted} more; full list: ${run.statusPath})` : ""}` : "";
  const integration = worktree ? `\n- integration: ${worktree.integration}${worktree.integrationReason ? ` (${worktree.integrationReason})` : ""}` : "";
  const pending = pendingRequestSummary(run);
  const assignment = run.assignments.at(-1);
  const outcome = assignment?.outcome === "pending" ? "awaiting final report" : assignment?.outcome;
  return `${pending ? `${pending}\n\n` : ""}- id: ${run.id}\n  execution: ${run.execution}\n  model: ${run.selectedModel ? `${run.selectedModel.provider}/${run.selectedModel.id}` : "not confirmed"}\n  requested model: ${run.modelSelection ? `${run.modelSelection.provider}/${run.modelSelection.id} (${run.modelSelection.source})` : "unknown"}\n  pending permissions: ${run.permissionRequests.filter((request) => request.state === "pending").length}\n  pending questions: ${run.requests.filter((request) => request.state === "pending").length}\n  lifetime: ${run.lifetime}\n  assignment: ${assignment?.id}\n  assignment outcome: ${outcome}\n  lifecycle status: ${run.status}${run.status === "running" ? " (not terminated; see execution for whether the worker is working or waiting)" : ""}\n  agent: ${run.profile?.name ?? run.requestedAgent ?? "generic"}\n  accessMode: ${run.accessMode}\n  isolation: ${run.isolation}\n  startedAt: ${run.startedAt}${run.completedAt ? `\n  completedAt: ${run.completedAt}` : ""}${run.error ? `\n  error: ${run.error}` : ""}${changed}${integration}`;
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
  // Persisted records are history, never evidence of a live process. Legacy
  // success fields did not mean explicit completion under this protocol.
  const assignments: Assignment[] = [];
  if (data.version === 1 && Array.isArray(data.assignments)) {
    for (const value of data.assignments) {
      if (!value || typeof value.id !== "string" || typeof value.prompt !== "string" || typeof value.startedAt !== "string") continue;
      const report = value.report;
      const validReport = report && (report.outcome === "completed" || report.outcome === "blocked")
        && [report.summary, report.findings, report.verification, report.uncertainty].every((field) => typeof field === "string");
      assignments.push({ id: value.id, prompt: value.prompt, startedAt: value.startedAt,
        outcome: validReport ? report.outcome : value.outcome === "incomplete" ? "incomplete" : "interrupted",
        ...(validReport ? { report } : {}), endedAt: typeof value.endedAt === "string" ? value.endedAt : new Date().toISOString() });
    }
  }
  if (!assignments.length) assignments.push({ id: `legacy-${data.runId}`, prompt: "Historical assignment", outcome: "incomplete", startedAt: typeof data.startedAt === "string" ? data.startedAt : "unknown" });
  const requests: WorkerRequest[] = [];
  if (data.version === 1 && Array.isArray(data.requests) && typeof data.parentId === "string") {
    for (const value of data.requests) {
      if (!value || typeof value.id !== "string" || value.workerId !== data.runId || !assignments.some((assignment) => assignment.id === value.assignmentId)
        || typeof value.question !== "string" || typeof value.createdAt !== "string") continue;
      const answered = value.state === "answered" && value.reply?.sender?.kind === "parent" && value.reply.sender.id === data.parentId && typeof value.reply.text === "string";
      requests.push({ id: value.id, workerId: data.runId, assignmentId: value.assignmentId,
        sender: { kind: "worker", id: data.runId }, recipient: { kind: "parent", id: data.parentId }, question: value.question,
        state: answered ? "answered" : "cancelled", createdAt: value.createdAt,
        resolvedAt: typeof value.resolvedAt === "string" ? value.resolvedAt : new Date().toISOString(), ...(answered ? { reply: value.reply } : {}) });
    }
  }
  const permissionRequests: WorkerPermissionRequest[] = [];
  if (data.version === 1 && Array.isArray(data.permissionRequests)) {
    for (const value of data.permissionRequests) {
      if (!value || value.workerId !== data.runId || !assignments.some((assignment) => assignment.id === value.assignmentId)
        || ![value.id, value.runtimeId, value.parentRuntimeId, value.cwd, value.tool, value.createdAt, value.permission?.scope,
          value.preview?.text, value.preview?.filetype].every((field) => typeof field === "string")
        || !["read", "write", "network", "tool", "unix-socket", "unsandboxed"].includes(value.permission?.kind)) continue;
      // Preserve provenance, never a live handle or a pending executable approval.
      permissionRequests.push({
        permission: value.permission, tool: value.tool, cwd: value.cwd, remember: value.remember === true,
        // Older records did not distinguish private file diffs from action text.
        preview: { text: `${value.tool}: ${value.permission.kind} ${value.permission.scope}`, filetype: "text" },
        id: value.id, workerId: value.workerId, assignmentId: value.assignmentId, runtimeId: value.runtimeId,
        parentRuntimeId: value.parentRuntimeId, attemptId: value.attemptId, workspaceId: value.workspaceId,
        authorityRevision: value.authorityRevision, createdAt: value.createdAt, consumedAt: value.consumedAt,
        state: ["consumed", "denied"].includes(value.state) ? value.state : "cancelled", decision: value.decision,
        resolvedAt: typeof value.resolvedAt === "string" ? value.resolvedAt : new Date().toISOString(),
      });
    }
  }
  const storedStatus: RunStatus = data.status === "completed" && assignments.at(-1)?.outcome === "completed" ? "completed"
    : data.status === "error" ? "error" : "aborted";
  const storedModel = (value: unknown): ModelIdentity | undefined => {
    if (!value || typeof value !== "object") return undefined;
    const model = value as Record<string, unknown>;
    return typeof model.provider === "string" && !!model.provider && typeof model.id === "string" && !!model.id
      ? { provider: model.provider, id: model.id } : undefined;
  };
  const requestedModel = storedModel(data.modelSelection);
  const source = data.modelSelection && typeof data.modelSelection === "object"
    ? (data.modelSelection as Record<string, unknown>).source : undefined;
  const modelSelection = requestedModel && ["override", "settings", "profile", "parent"].includes(String(source))
    ? { ...requestedModel, source: source as ModelSelection["source"] } : undefined;
  const briefPath = join(runDir, "brief.md");
  let resolveFinished: (run: SpawnRun) => void = () => undefined;
  const finished = new Promise<SpawnRun>((resolvePromise) => { resolveFinished = resolvePromise; });
  const run: SpawnRun = {
    id: data.runId,
    parentId: typeof data.parentId === "string" ? data.parentId : `legacy-parent-${data.runId}`,
    lifetime: data.lifetime === "conversational" ? "conversational" : "bounded",
    execution: storedStatus === "completed" || (data.version === 1 && data.execution === "closed" && assignments.at(-1)?.report?.outcome === "blocked")
      ? "closed" : storedStatus === "error" ? "failed" : "cancelled",
    assignments,
    requests,
    permissionRequests,
    deliveredEvents: Array.isArray(data.deliveredEvents) ? data.deliveredEvents.filter((id): id is string => typeof id === "string") : [],
    changed: new Set(),
    mode: data.mode === "foreground" ? "foreground" : "background",
    prompt: typeof data.prompt === "string" ? data.prompt : existsSync(briefPath) ? readFileSync(briefPath, "utf8") : "",
    role: typeof data.role === "string" ? data.role : undefined,
    requestedAgent: typeof data.agent === "string" ? data.agent : undefined,
    accessMode: parseAccessMode(typeof data.accessMode === "string" ? data.accessMode : undefined) ?? "readonly",
    isolation: data.isolation === "worktree" ? "worktree" : "none",
    status: storedStatus,
    modelSelection,
    selectedModel: storedModel(data.selectedModel),
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
    protectedRoots: Array.isArray(data.protectedRoots) ? data.protectedRoots.filter((path): path is string => typeof path === "string" && path.startsWith("/"))
      : record ? [record.destinationRoot, record.worktreePath] : ["/"],
    parentSessionFile,
    ownerEntryId: typeof data.ownerEntryId === "string" ? data.ownerEntryId : undefined,
    cancellationRequested: data.cancellationRequested === true
      || data.cancellationRequested === undefined && (data.error === "Subagent aborted: parent_abort." || data.error === "Subagent aborted: stopped_by_parent." || data.error === "Subagent aborted: session_switch."),
    stopReason: typeof data.stopReason === "string" ? data.stopReason : undefined,
    settled: true,
    worktree,
    integrationBlock,
    cleanupError: typeof data.cleanupError === "string" ? data.cleanupError
      : data.settled === false ? "Subagent cleanup did not finish before the runtime ended." : undefined,
    notified: data.notified === true,
    // Disposal resolves the collection obligation, including records written
    // before discard persisted joined=true. Cleanup/ownership guards still apply.
    joined: data.joined === true || record?.lifecycle === "discarded" && !record.retained,
    // No join operation survives a runtime restart.
    joinRequested: false,
    finished,
    resolveFinished,
  };
  resolveFinished(run);
  if (data.version !== 1 || data.status === "running" || data.joinRequested === true || run.joined !== (data.joined === true)
    || requests.some((request) => request.state === "cancelled")) {
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
    registerWorkerProtocol(pi);
    return;
  }

  const runs = new Map<string, SpawnRun>();
  const owner = Symbol("spawn runtime");
  let retired = false;
  let runtimeCancellation = new AbortController();
  let parentRuntimeId = randomUUID();
  let unsubscribeAuthority: (() => void) | undefined;
  const permissionDialogs = new Set<string>();
  type PermissionWait = {
    run: SpawnRun; request: WorkerPermissionRequest; dialog: string; revision: number;
    userPreview: PermissionPreview; // Live user UI only, never status/history/model context.
    cancellation: AbortController; authorization?: PermissionAuthorization; deciding?: boolean; responded?: boolean; checking?: boolean;
    executionId?: string;
  };
  const permissionWaits = new Map<string, PermissionWait>();
  const permissionExecutions = new Map<string, PermissionWait>();
  const permissionRecords = () => [...permissionWaits, ...permissionExecutions];
  const pendingJoins = new Set<{ runIds: Set<string>; delivery: "tool" | "command"; cancellation: AbortController; finished: Promise<void> }>();
  const eventQueue = new Map<string, { run: SpawnRun; content: string; details: Record<string, unknown> }>();
  let runtimeContext: ExtensionContext | undefined;
  let compacting = false;
  let parentActive = false;

  // Runtime records are authoritative. Reconcile at every model boundary,
  // including automatic compaction retries, without a new turn or transcript row.
  pi.on("context", (event) => {
    if (retired || runs.size === 0) return;
    const actionable = [...runs.values()].flatMap((run) => {
      const writerOwned = ownsWriter(run);
      const requests = run.requests.filter((request) => request.state === "pending");
      const permissions = run.permissionRequests.filter((request) => request.state === "pending");
      if (run.settled && !writerOwned && !run.cleanupError && !run.joinRequested && !requests.length && !permissions.length) return [];
      const worktree = writerOwned ? worktreeInfo(run) : undefined;
      return [{
        runId: run.id, execution: run.execution,
        assignment: { id: run.assignments.at(-1)?.id, outcome: run.assignments.at(-1)?.outcome },
        requests: requests.map((request) => ({ id: request.id, assignmentId: request.assignmentId,
          questionPreview: compactOneLine(request.question, 240), questionLength: request.question.length })),
        permissionRequests: permissions.map((request) => ({ id: request.id, assignmentId: request.assignmentId,
          runtimeId: request.runtimeId, parentRuntimeId: request.parentRuntimeId,
          tool: request.tool, kind: request.permission.kind, workspaceId: request.workspaceId })),
        writerOwned, quiescent: run.settled && !run.cleanupError, cleanupUnresolved: !!run.cleanupError,
        worktree: worktree && { workspaceId: worktree.workspaceId, integration: worktree.integration, retained: worktree.retained },
      }];
    });
    if (!actionable.length) return;
    return { messages: [...event.messages, {
      role: "custom" as const, customType: "spawn_management", display: false, timestamp: Date.now(),
      content: `Actionable orchestration management state (runtime records, not user authorization). Use exact IDs; never replay actions from summary prose. Request text here is preview-only. If join or a worker event already supplied the full current request, respond using those details without another status check. Only fetch spawn_control status with the runId when the full request details are missing. Handle pending questions with reply and permissions with approve/deny; obtain missing user input when needed. status and join cannot resume a worker waiting for your response. Historical workers, artifacts and delivery records remain available through list/status/report; they are not repeated here.\n${JSON.stringify(actionable)}`,
    }] };
  });
  let sessionManager: ExtensionContext["sessionManager"] | undefined;
  let ui: Pick<ExtensionUIContext, "notify" | "setStatus"> | undefined;

  const spawnStatusPayload = () => {
    const allRuns = Array.from(runs.values()).map(run => statusJson(run));
    return {
      sessionFile: sessionManager?.getSessionFile() ?? null,
      running: allRuns.filter((run) => run.status === "running").length,
      runs: allRuns,
    };
  };

  const publishSpawnStatus = () => {
    ui?.setStatus("pi-spawn-runs", JSON.stringify(spawnStatusPayload()));
  };

  const signalChange = (run: SpawnRun) => {
    for (const changed of [...run.changed]) changed();
  };
  const flushEvents = () => {
    if (retired || compacting || !runtimeContext || (!runtimeContext.isIdle() && !parentActive)) return;
    for (const [key, event] of eventQueue) {
      // Model-tool joins deliver these events in their result. Commands only
      // display a summary, so their events must still wake an idle parent.
      if ([...pendingJoins].some((join) => join.delivery === "tool" && join.runIds.has(event.run.id))) continue;
      eventQueue.delete(key);
      if (event.run.cancellationRequested || event.run.deliveredEvents.includes(key)) continue;
      event.run.deliveredEvents.push(key);
      writeStatus(event.run);
      // Pi queues followUp while busy and starts a custom (not user) run while
      // idle. No poll, reminder, sendUserMessage, or overlapping prompt.
      pi.sendMessage({ customType: "spawn_event", content: event.content, display: false,
        details: { ...event.details, eventId: key, version: 1, sender: { kind: "worker", id: event.run.id } },
      }, { triggerTurn: true, deliverAs: "followUp" });
    }
  };
  const queueEvent = (run: SpawnRun, key: string, content: string) => {
    signalChange(run);
    if (retired || run.cancellationRequested || run.deliveredEvents.includes(key)) return;
    eventQueue.set(key, { run, content, details: artifactDetails(run) });
    flushEvents();
  };
  const announceCompletion = (run: SpawnRun) => {
    if (run.execution === "working" || run.execution === "waiting_parent" || run.execution === "waiting_user" || run.execution === "closing") return;
    const failed = run.execution === "failed";
    const key = failed ? `${run.id}:execution:failed` : `${run.id}:${run.assignments.at(-1)?.id}:result`;
    queueEvent(run, key, agentContext({ kind: "worker", id: run.id }, {
      event: failed ? "execution_failure" : "assignment_result", runId: run.id,
      assignmentId: run.assignments.at(-1)?.id, execution: run.execution, report: resultSummary(run),
      next: "Inspect with join/report/diff. Acceptance is explicit. Request corrections with followup before acceptance, or close the conversation. Discard explicitly disposes an unwanted contribution. Incomplete turns are not success.",
    }));
  };

  pi.on("before_agent_start", (event, ctx) => {
    if (retired) return;
    refreshSpawnTool(ctx);
    // Keep this run's prompt snapshot in sync with the registered tool guidance.
    event.systemPromptOptions.toolGuidelines.spawn = pi.getActiveTools().includes("spawn")
      ? pi.getAllTools().find((tool) => tool.name === "spawn")?.promptGuidelines ?? []
      : [];
    runtimeContext = ctx;
    parentActive = true;
    flushEvents();
  });

  pi.on("session_start", (_event, ctx) => {
    ui = ctx.ui;
    retired = false;
    runtimeCancellation = new AbortController();
    parentRuntimeId = randomUUID();
    unsubscribeAuthority ??= onAccessInvalidated(() => {
      if (retired) return;
      for (const run of runs.values()) if (!run.settled) stopRun(run, "authority_changed");
    });
    permissionWaits.clear();
    permissionExecutions.clear();
    permissionDialogs.clear();
    sessionManager = ctx.sessionManager;
    refreshSpawnTool(ctx);
    runs.clear();
    runtimeContext = ctx;
    compacting = false;
    parentActive = false;
    eventQueue.clear();
    registerSubagentRuntime(owner, () => Array.from(runs.values()).some((run) => !run.settled || run.status === "running" || run.joinRequested || run.cleanupError || ownsWriter(run)), historyBlockReason,
      () => [...new Set([...runs.values()].filter(ownsWriter).flatMap((run) => run.protectedRoots ?? [run.childCwd]))]);
    const references = new Map<string, string>();
    for (const entry of ctx.sessionManager.getEntries()) {
      for (const runId of spawnRunIds(entry)) {
        if (!references.has(runId)) references.set(runId, entry.id);
      }
    }
    for (const run of restoreRuns(ctx.sessionManager.getSessionFile())) {
      // Known ownership follows all surviving history, not only the active branch.
      // Unknown legacy ownership is retained rather than guessed.
      const reference = references.get(run.id);
      if (run.ownerEntryId && !reference) continue;
      if (!run.ownerEntryId && reference) {
        run.ownerEntryId = reference;
        writeStatus(run);
      }
      if (!runs.has(run.id)) runs.set(run.id, run);
    }
    // Historical workers remain terminal; never wake/replay them at startup.
    publishSpawnStatus();
  });

  pi.on("agent_end", (_event, ctx) => {
    if (retired) return;
    ui = ctx.ui;
    runtimeContext = ctx;
    publishSpawnStatus();
  });

  pi.on("agent_settled", async (event) => {
    parentActive = false;
    if (!retired && event.aborted) await cancelRuns();
    else flushEvents();
  });
  pi.on("session_before_compact", async (event, ctx) => {
    compacting = true;
    if (retired || runs.size === 0) return;
    try {
      return await compactOrchestration(event, ctx, pi.getThinkingLevel());
    } catch (error) {
      if (event.signal.aborted) return { cancel: true };
      // Hook errors are extension failures to the service. Leave ordinary Pi
      // compaction responsible for its normal failure/retry outcome instead of
      // retiring a healthy orchestrator and its children on a summary failure.
      ctx.ui.notify(`Orchestration summary failed; falling back to ordinary Pi compaction: ${error instanceof Error ? error.message : String(error)}`, "warning");
    }
  });
  const afterCompaction = () => {
    compacting = false;
    if (!retired) publishSpawnStatus();
    // session_compact precedes clearing Pi's manual-compaction busy flag.
    // A single deferred delivery crosses that boundary without polling.
    setImmediate(() => { if (runtimeContext?.isIdle()) flushEvents(); });
  };
  pi.on("session_compact", afterCompaction);
  pi.on("session_compact_failed", afterCompaction);

  pi.on("session_shutdown", async () => {
    // Child cleanup is asynchronous; drop the old UI before triggering it.
    ui = undefined;
    retired = true;
    eventQueue.clear();
    runtimeContext = undefined;
    runtimeCancellation.abort();
    const ownedRuntime = retireSubagentRuntime(owner);
    const failures: string[] = [];
    for (const run of runs.values()) {
      run.joinRequested = false;
      if (run.status === "running") {
        stopRun(run, "session_shutdown");
      }
      if (ownedRuntime) {
        // Preserve a terminal execution status even if artifact finalization is
        // still awaiting the child. A stale owner must not overwrite a replacement.
        try { writeStatus(run); } catch (error) {
          failures.push(error instanceof Error ? error.message : String(error));
        }
      }
    }
    await Promise.all([...runs.values()].map((run) => run.finished));
    if (ownedRuntime) {
      for (const run of runs.values()) {
        try { writeStatus(run); } catch (error) {
          failures.push(error instanceof Error ? error.message : String(error));
        }
      }
    }
    if (failures.length) throw new Error(`Could not save subagent shutdown state: ${failures.join("; ")}`);
  });

  const stopRun = (run: SpawnRun, reason: string) => {
    if (run.settled) {
      if (run.execution === "idle") {
        run.stopReason = reason;
        run.closing = true;
        run.execution = reason === "closed_by_parent" ? "closed" : "cancelled";
        run.cancellationRequested = reason !== "closed_by_parent";
        writeStatus(run);
        signalChange(run);
        publishSpawnStatus();
      }
      return;
    }
    if (reason === "parent_abort" || reason === "stopped_by_parent" || reason === "session_switch") run.cancellationRequested = true;
    run.stopReason ??= reason;
    for (const [id, wait] of permissionRecords()) {
      if (wait.run !== run) continue;
      wait.cancellation.abort();
      wait.request.state = "cancelled";
      wait.request.resolvedAt = new Date().toISOString();
      wait.request.decision = { actor: "parent", outcome: "cancelled", reason };
      if (!wait.responded) {
        wait.responded = true;
        try { run.child?.respond(wait.dialog); } catch { /* Process disposal settles the wait. */ }
      }
      permissionWaits.delete(id);
      permissionExecutions.delete(id);
      eventQueue.delete(wait.request.id);
    }
    run.closing = true;
    run.execution = "closing";
    const assignment = run.assignments.at(-1);
    if (assignment?.outcome === "pending") assignment.outcome = "interrupted";
    for (const request of run.requests.filter((request) => request.state === "pending")) {
      request.state = "cancelled";
      request.resolvedAt = new Date().toISOString();
    }
    if (run.pendingDialog) {
      try { run.child?.respond(run.pendingDialog); } catch { /* Disposal below settles the transport. */ }
      run.pendingDialog = undefined;
    }
    run.resume?.();
    signalChange(run);
    run.child?.abort();
    if (run.cancellationRequested) {
      for (const join of pendingJoins) {
        if (join.runIds.has(run.id)) join.cancellation.abort();
      }
    }
    try {
      writeStatus(run);
      publishSpawnStatus();
    } catch (error) {
      // Abort listeners must not throw or prevent cancellation of sibling runs.
      run.cleanupError ??= `Could not record cancellation: ${error instanceof Error ? error.message : String(error)}`;
    }
  };

  pi.on("session_shutdown", () => { unsubscribeAuthority?.(); unsubscribeAuthority = undefined; });

  async function cancelRuns(): Promise<void> {
    const pending = Array.from(runs.values()).filter((run) => !run.settled);
    // Command joins have no parent-turn signal.
    const joins = [...pendingJoins];
    for (const join of joins) join.cancellation.abort();
    for (const run of pending) stopRun(run, "parent_abort");
    await Promise.all([...pending.map((run) => run.finished), ...joins.map((join) => join.finished)]);
    const failures = Array.from(runs.values()).filter((run) => run.cancellationRequested && run.cleanupError);
    if (failures.length) throw new Error(failures.map((run) => `${run.id}: ${run.cleanupError}`).join("; "));
  }

  // The owner invokes this even while the parent is idle or waiting on a join.
  registerServiceOperation(pi, "spawn.cancel", async (_payload, ctx) => {
    const cleanup = cancelRuns();
    ctx.abort();
    await cleanup;
    return { changed: true };
  });

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

  const waitForActions = (selected: SpawnRun[], signal?: AbortSignal): Promise<void> => {
    const actionable = () => selected.some((run) => run.execution === "waiting_parent" || run.execution === "waiting_user")
      || selected.every((run) => run.settled || run.execution === "idle");
    if (actionable()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const cleanup = () => { for (const run of selected) run.changed.delete(changed); signal?.removeEventListener("abort", abort); };
      const changed = () => { if (actionable()) { cleanup(); resolve(); } };
      const abort = () => { cleanup(); for (const run of selected) stopRun(run, "parent_abort"); reject(new Error("spawn_control aborted")); };
      for (const run of selected) run.changed.add(changed);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      else changed();
    });
  };

  const finalizeJoin = async <T>(
    selected: SpawnRun[],
    signal: AbortSignal | undefined,
    delivery: "tool" | "command",
    report: () => T,
    onWaiting?: () => void,
  ): Promise<T> => {
    const cancellation = new AbortController();
    signal = AbortSignal.any([runtimeCancellation.signal, cancellation.signal, ...(signal ? [signal] : [])]);
    const previouslyJoined = new Map(selected.map((run) => [run.id, run.joined]));
    let finishJoin!: () => void;
    const join = { runIds: new Set(selected.map((run) => run.id)), delivery, cancellation,
      finished: new Promise<void>((resolve) => { finishJoin = resolve; }) };
    pendingJoins.add(join);
    try {
      if (retired) throw new Error("Spawn runtime was retired.");
      for (const run of selected) {
        run.joinRequested = true;
        writeStatus(run);
      }
      publishSpawnStatus();
      onWaiting?.();
      // Yield as soon as any worker needs the parent's attention, including a
      // question while join_all's other workers are still running.
      await waitForActions(selected, signal);
      if (retired) throw new Error("Spawn runtime was retired.");
      // Collection is observation only. A yielded question leaves that worker
      // uncollected; other running members remain visible to later joins.
      for (const run of selected) {
        run.joinRequested = false;
        run.joined = run.settled || run.execution === "idle";
        writeStatus(run);
      }
      const result = report();
      if (delivery === "tool") {
        // Consume only after collection succeeds. Failed joins leave events
        // queued for automatic delivery once the tool stops owning them.
        for (const [key, event] of eventQueue) {
          if (!join.runIds.has(event.run.id)) continue;
          eventQueue.delete(key);
          event.run.deliveredEvents.push(key);
          writeStatus(event.run);
        }
      }
      publishSpawnStatus();
      return result;
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
    } finally {
      pendingJoins.delete(join);
      finishJoin();
      flushEvents();
    }
  };

  function historyBlockReason(): string | undefined {
    const all = Array.from(runs.values());
    if (all.some((run) => run.cleanupError)) {
      return "Subagent cleanup is unresolved. Inspect its cleanup error before changing history. Open <leader>ps to manage it.";
    }
    if (all.some((run) => !run.settled || run.status === "running" || run.joinRequested)) {
      return "Subagents or their cleanup are still active. Wait for them, join them, or stop them before changing history. Open <leader>ps to manage them.";
    }
    if (all.some(ownsWriter)) {
      return "A writer still owns an unaccepted contribution. Accept or explicitly discard it before changing history or workspaces.";
    }
    if (all.some((run) => !run.joined && !run.cancellationRequested)) {
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
    if ([...runs.values()].some(ownsWriter)) {
      ctx.ui.notify("Resolve writing contributions with accept or explicit discard before switching sessions. Stop active workers first if cancellation is needed.", "warning");
      return { cancel: true };
    }
    const running = Array.from(runs.values()).filter((run) => run.status === "running");
    if (!running.length) return;
    const action = event.reason === "new" ? "starting a new session" : "switching sessions";
    try {
      const choice = await serviceUi(ctx).select(
        JSON.stringify({
          kind: "pi_compact_select",
          prompt: `There are running subagents. Continuing will stop them. Continue ${action}?`,
          notify: false,
        }),
        ["Continue and stop subagents", "Cancel"],
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
    modelSelection: ModelSelection;
    accessMode: AccessMode;
    isolation: IsolationMode;
    mode: SpawnMode;
    lifetime: WorkerLifetime;
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
      parentId: sessionManager?.getSessionId() ?? randomUUID(),
      lifetime: input.lifetime,
      execution: "working",
      assignments: [newAssignment(input.prompt)],
      requests: [],
      permissionRequests: [],
      runtimeId: randomUUID(),
      deliveredEvents: [],
      changed: new Set(),
      mode: input.mode,
      prompt: input.prompt,
      role: input.role,
      requestedAgent: input.requestedAgent,
      profile: input.profile,
      modelSelection: input.modelSelection,
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
      protectedRoots: input.isolation === "worktree" ? repositoryWriteRoots(input.cwd) : undefined,
      settled: false,
      notified: false,
      joined: false,
      joinRequested: false,
      finished,
      resolveFinished,
    };

    runs.set(id, run);
    try {
      writeFileSync(briefPath, input.prompt, "utf8");
      if (input.profile && agentPromptPath) {
        writeFileSync(agentPromptPath, subagentSystemPrompt(input.profile), "utf8");
      }

      if (input.isolation === "worktree") {
        const record = createWorktree(input.cwd, id, input.parentSessionFile);
        run.worktree = { workspaceId: record.id, recoveryPatchPath: record.resultPatchPath };
        run.childCwd = record.workspaceCwd;
        run.protectedRoots = repositoryWriteRoots(record.workspaceCwd);
      }

      const abortListener = () => stopRun(run, "parent_abort");
      if (input.signal) {
        run.abortSignal = input.signal;
        run.abortListener = abortListener;
        input.signal.addEventListener("abort", abortListener, { once: true });
        if (input.signal.aborted) abortListener();
      }

      pi.appendEntry("pi-spawn-owner", { runId: id, workspaceId: run.worktree?.workspaceId });
      run.ownerEntryId = sessionManager?.getLeafId() ?? undefined;
      writeStatus(run);
      publishSpawnStatus();
    } catch (error) {
      run.status = "error";
      run.execution = "failed";
      run.settled = true;
      run.cleanupError = `Could not initialize worker artifacts: ${error instanceof Error ? error.message : String(error)}`;
      run.assignments[0].outcome = "interrupted";
      run.resolveFinished(run);
      throw error;
    }
    return run;
  };

  const permissionCurrent = (wait: NonNullable<ReturnType<typeof permissionWaits.get>>) => {
    const { run, request } = wait;
    if (retired || run.closing || run.settled || !run.child || wait.cancellation.signal.aborted
      || wait.revision !== accessRevision() || request.parentRuntimeId !== parentRuntimeId
      || request.runtimeId !== run.runtimeId || request.assignmentId !== run.assignments.at(-1)?.id
      || run.assignments.at(-1)?.outcome !== "pending" || canonicalPath(run.childCwd) !== request.cwd
      || run.accessMode === "readonly" || (wait.executionId && permissionExecutions.get(wait.executionId) !== wait)) throw new Error("Worker permission authority expired or request context changed");
    if (run.worktree) {
      const workspace = loadWorkspace(run.worktree.workspaceId);
      if (!workspace?.retained || workspace.runId !== run.id || workspace.workspaceCwd !== request.cwd || isWorkspaceFinalized(workspace)) {
        throw new Error("Worker workspace authority ended or changed");
      }
    }
  };
  const permissionResponse = (wait: NonNullable<ReturnType<typeof permissionWaits.get>>, allowed: boolean) => {
    const { run, request } = wait;
    if (!wait.responded) {
      wait.responded = true; // Never retry an ambiguous transport write.
      run.child?.respond(wait.dialog, JSON.stringify({ version: 1, sender: { kind: "parent", id: run.parentId },
        workerId: run.id, assignmentId: request.assignmentId, requestId: request.id,
        runtimeId: request.runtimeId, parentRuntimeId: request.parentRuntimeId, allowed, decision: request.state,
        executionId: wait.executionId }));
    }
    run.execution = run.pendingDialog || run.permissionRequests.some((request) => request.state === "pending") ? "waiting_parent" : "working";
    writeStatus(run);
    publishSpawnStatus();
    signalChange(run);
  };
  const cancelWorkerPermission = (run: SpawnRun, event: RpcEvent) => {
    if (event.type !== "extension_ui_request" || event.method !== "setStatus"
      || (event.statusKey !== SPAWN_PERMISSION_CANCEL && event.statusKey !== SPAWN_PERMISSION_FINISH) || typeof event.statusText !== "string") return;
    let address: WorkerPermissionOperation;
    try { address = JSON.parse(event.statusText) as WorkerPermissionOperation; } catch { return; }
    if (address.version !== 1 || address.workerId !== run.id || address.runtimeId !== run.runtimeId
      || address.parentRuntimeId !== parentRuntimeId || address.assignmentId !== run.assignments.at(-1)?.id) return;
    for (const [id, wait] of permissionRecords()) {
      if (wait.run !== run || wait.request.attemptId !== address.attemptId) continue;
      if (event.statusKey === SPAWN_PERMISSION_FINISH) {
        if (address.executionId === wait.executionId && permissionExecutions.get(id) === wait) {
          permissionExecutions.delete(id);
          wait.cancellation.abort();
        }
        return;
      }
      wait.request.state = "cancelled";
      wait.request.resolvedAt = new Date().toISOString();
      wait.request.decision = { actor: "worker", outcome: "cancelled", reason: "Worker permission attempt aborted." };
      permissionWaits.delete(id);
      permissionExecutions.delete(id);
      eventQueue.delete(wait.request.id);
      wait.cancellation.abort();
      if (!run.closing) permissionResponse(wait, false);
      break;
    }
  };
  const handlePermissionDialog = (run: SpawnRun, event: RpcEvent, operation: WorkerPermissionOperation): boolean => {
    const reject = () => { run.child?.respond(event.id as string); return true; };
    const dialogKey = JSON.stringify([run.id, run.runtimeId, event.id]);
    if (permissionDialogs.has(dialogKey)) return true; // Never cancel or deliver the original dialog twice.
    permissionDialogs.add(dialogKey);
    const assignment = run.assignments.at(-1);
    if (retired || run.closing || run.settled || operation.version !== 1 || operation.workerId !== run.id
      || operation.assignmentId !== assignment?.id || assignment.outcome !== "pending" || run.accessMode === "readonly"
      || operation.runtimeId !== run.runtimeId || operation.parentRuntimeId !== parentRuntimeId || typeof operation.attemptId !== "string" || !operation.attemptId
      || !validPermissionAttempt(operation.attempt) || operation.attempt.cwd !== canonicalPath(run.childCwd)
      || (operation.continuing !== undefined && (operation.operation !== "permission_execute" || typeof operation.continuing !== "boolean"))
      || (operation.executionId !== undefined && (operation.operation !== "permission_recheck" || typeof operation.executionId !== "string"))
      || (operation.operation !== "permission" && operation.userPreview !== undefined)) return reject();
    if (operation.operation === "permission_execute" || operation.operation === "permission_recheck") {
      const rechecking = operation.operation === "permission_recheck";
      const wait = rechecking ? permissionExecutions.get(operation.executionId ?? "") : permissionWaits.get(operation.requestId ?? "");
      if (!wait || wait.run !== run || wait.request.id !== operation.requestId || wait.request.state !== (rechecking ? "consumed" : "approved")
        || !wait.authorization || wait.checking || wait.request.attemptId !== operation.attemptId
        || (operation.continuing && (wait.request.permission.kind !== "write" || !["write", "edit"].includes(wait.request.tool)))
        || JSON.stringify(operation.attempt) !== JSON.stringify({ permission: wait.request.permission, tool: wait.request.tool,
          preview: wait.request.preview, cwd: wait.request.cwd, remember: wait.request.remember })) return reject();
      if (!rechecking) permissionWaits.delete(wait.request.id); // Admission is consumed exactly once, including failed validation.
      wait.checking = true;
      wait.dialog = event.id as string;
      wait.responded = false;
      void (async () => {
        try {
          permissionCurrent(wait);
          await wait.authorization!.validate();
          permissionCurrent(wait);
          if (!rechecking) {
            wait.request.state = "consumed";
            wait.request.consumedAt = new Date().toISOString();
            if (operation.continuing) {
              wait.executionId = randomUUID();
              permissionExecutions.set(wait.executionId, wait);
            }
          }
          wait.checking = false;
          permissionResponse(wait, true);
        } catch (error) {
          wait.checking = false;
          if (wait.executionId) permissionExecutions.delete(wait.executionId);
          wait.request.state = "cancelled";
          wait.request.decision = { actor: "parent", outcome: "cancelled", reason: String(error) };
          if (!run.closing) permissionResponse(wait, false);
        }
      })().catch(() => stopRun(run, "permission_transport_failure"));
      return true;
    }
    if (operation.requestId !== undefined || run.permissionRequests.some((request) => request.attemptId === operation.attemptId)) return reject();
    if (!operation.userPreview || typeof operation.userPreview.text !== "string" || typeof operation.userPreview.filetype !== "string") return reject();
    const { permission, tool, preview, cwd, remember } = operation.attempt;
    const request: WorkerPermissionRequest = { permission, tool, preview, cwd, remember, id: randomUUID(), workerId: run.id, assignmentId: assignment.id,
      runtimeId: run.runtimeId!, parentRuntimeId, attemptId: operation.attemptId,
      workspaceId: run.worktree?.workspaceId ?? workspaceForContext(run.childCwd, run.parentSessionFile)?.id,
      authorityRevision: accessRevision(), state: "pending", createdAt: new Date().toISOString() };
    run.permissionRequests.push(request);
    permissionWaits.set(request.id, { run, request, userPreview: operation.userPreview, dialog: event.id as string, revision: accessRevision(), cancellation: new AbortController() });
    run.execution = "waiting_parent";
    writeStatus(run);
    publishSpawnStatus();
    queueEvent(run, request.id, agentContext({ kind: "worker", id: run.id }, { event: "permission", ...request,
      next: "Worker blocked: awaiting your permission decision. Use spawn_control approve or deny with id=workerId, assignmentId, requestId=id, runtimeId, parentRuntimeId from this request before observing this worker again. Insufficient authority opens the existing user approval UI; clarification replies cannot grant it. status and join cannot resume the worker; join after responding." }));
    return true;
  };

  const handleWorkerDialog = (run: SpawnRun, event: RpcEvent): boolean => {
    if (event.method !== "input" || typeof event.title !== "string" || !event.title.startsWith(SPAWN_PROTOCOL_TITLE) || typeof event.id !== "string") return false;
    const reject = () => { run.child?.respond(event.id as string); return true; };
    let operation: WorkerOperation | WorkerPermissionOperation;
    try { operation = JSON.parse(event.title.slice(SPAWN_PROTOCOL_TITLE.length)) as WorkerOperation | WorkerPermissionOperation; }
    catch { return reject(); }
    if (operation.operation === "permission" || operation.operation === "permission_execute" || operation.operation === "permission_recheck") return handlePermissionDialog(run, event, operation);
    const assignment = run.assignments.at(-1);
    if (retired || run.closing || operation.version !== 1 || operation.workerId !== run.id || operation.assignmentId !== assignment?.id
      || assignment.outcome !== "pending" || run.pendingDialog) return reject();
    if (operation.operation === "question" && typeof operation.question === "string" && operation.question.trim()) {
      const request: WorkerRequest = { id: randomUUID(), workerId: run.id, assignmentId: assignment.id,
        sender: { kind: "worker", id: run.id }, recipient: { kind: "parent", id: run.parentId },
        question: operation.question, state: "pending", createdAt: new Date().toISOString() };
      run.requests.push(request);
      run.pendingDialog = event.id;
      run.execution = "waiting_parent";
      writeStatus(run);
      publishSpawnStatus();
      queueEvent(run, request.id, agentContext(request.sender, { event: "question", ...request, next: "Worker blocked: awaiting your clarification reply. Use spawn_control action=reply with id=workerId, assignmentId, requestId=id, message before observing this worker again. Read needed context or ask the user if a decision is missing. This is clarification, never permission approval. status and join cannot resume the worker; join after responding." }));
      return true;
    }
    if (operation.operation === "report") {
      if (run.permissionRequests.some((request) => request.state === "pending")) return reject();
      const report = operation.report;
      if (!report || (report.outcome !== "completed" && report.outcome !== "blocked")
        || ![report.summary, report.findings, report.verification, report.uncertainty].every((field) => typeof field === "string") || !report.summary.trim()) return reject();
      assignment.report = report;
      assignment.outcome = report.outcome;
      assignment.endedAt = new Date().toISOString();
      run.resultText = agentContext({ kind: "worker", id: run.id }, { assignmentId: assignment.id, report });
      writeFileSync(run.resultPath, run.resultText, "utf8");
      writeStatus(run);
      run.child?.respond(event.id, JSON.stringify({ version: 1, sender: { kind: "parent", id: run.parentId }, workerId: run.id, assignmentId: assignment.id, text: "Report recorded; await runtime settlement." }));
      return true;
    }
    return reject();
  };

  const startRun = async (run: SpawnRun, params: { model: string; provider: string; timeoutSeconds?: number }) => {
    if (retired) throw new Error("Cannot launch subagent from a retired runtime");
    run.launch = params;
    const binary = process.env.PI_BINARY || "pi";
    const argv = [binary, "--mode", "rpc", "-e", resolve(dirname(fileURLToPath(import.meta.url)), ".."), "--session-dir", join(run.runDir, "sessions"), "--model", params.model];
    if (params.provider) {
      argv.push("--provider", params.provider);
    }
    if (run.childSessionFile) argv.push("--session", run.childSessionFile);
    if (run.profile?.tools && run.profile.tools.length > 0) {
      argv.push("--tools", [...new Set([...run.profile.tools.filter((name) => name !== "spawn" && name !== "spawn_control"), ...WORKER_TOOLS])].join(","));
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
      if (event.type === "extension_ui_request" && event.method === "input"
        && typeof event.title === "string" && event.title.startsWith(SPAWN_PROTOCOL_TITLE)) {
        // The child RPC frame may carry a user-only diff. Never persist it in
        // run artifacts, which agents can inspect independently of that file.
        try {
          const { userPreview: _privatePreview, ...operation } = JSON.parse(event.title.slice(SPAWN_PROTOCOL_TITLE.length));
          if (["permission", "permission_execute", "permission_recheck"].includes(operation.operation)) {
            // Raw protocol frames are not a model-preview channel, including
            // frames from older workers that used preview for private diffs.
            const attempt = operation.attempt;
            event = { ...event, title: SPAWN_PROTOCOL_TITLE + JSON.stringify({ version: operation.version,
              operation: operation.operation, workerId: operation.workerId, assignmentId: operation.assignmentId,
              runtimeId: operation.runtimeId, parentRuntimeId: operation.parentRuntimeId, attemptId: operation.attemptId,
              requestId: operation.requestId, executionId: operation.executionId,
              attempt: attempt && { permission: attempt.permission, tool: attempt.tool, cwd: attempt.cwd, remember: attempt.remember },
            }) };
          } else event = { ...event, title: SPAWN_PROTOCOL_TITLE + JSON.stringify(operation) };
        } catch { event = { ...event, title: SPAWN_PROTOCOL_TITLE + "[invalid frame omitted]" }; }
      }
      appendFileSync(run.transcriptPath, `${JSON.stringify({ version: 1, sender: { kind: "worker", id: run.id }, assignmentId: run.assignments.at(-1)?.id, timestamp: new Date().toISOString(), event })}\n`, "utf8");
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
      PI_SPAWN_WORKER_ID: run.id,
      PI_SPAWN_PARENT_ID: run.parentId,
      PI_SPAWN_RUNTIME_ID: run.runtimeId,
      PI_SPAWN_PARENT_RUNTIME_ID: parentRuntimeId,
      PI_SPAWN_ACCESS_MODE: run.accessMode,
      PI_INTERACTION_MODE: "noninteractive",
      PI_SUBAGENT_NAME: run.profile?.name ?? run.requestedAgent ?? run.role ?? "",
      PI_WORKSPACE_ID: run.worktree?.workspaceId ?? "",
      PI_CONSOLE_SESSION_FILE: "",
    };
    if (process.env.PI_CODING_AGENT_DIR) {
      childEnv.PI_CODING_AGENT_DIR = process.env.PI_CODING_AGENT_DIR;
    }

    let child: PiRpcChild;
    try {
      if (run.stopReason) throw new Error(`Subagent aborted before launch: ${run.stopReason}.`);
      if (run.worktree) {
        const record = loadWorkspace(run.worktree.workspaceId);
        if (!record?.retained || isWorkspaceFinalized(record) || record.managedCleanupPending !== run.id) throw new Error("Child workspace is not writable for this revision");
      }
      if (run.worktree && (!childEnv.PI_CONSOLE_PROCESS_REGISTRY || !childEnv.PI_CONSOLE_OWNER_EPOCH)) {
        childEnv.PI_CONSOLE_PROCESS_REGISTRY = join(run.runDir, "processes.sqlite");
        childEnv.PI_CONSOLE_OWNER_EPOCH = randomUUID();
        delete childEnv.PI_CONSOLE_PROCESS_JOB;
        beginEpoch(childEnv.PI_CONSOLE_PROCESS_REGISTRY, childEnv.PI_CONSOLE_OWNER_EPOCH);
      }
      child = new PiRpcChild(argv, {
        cwd: run.childCwd,
        env: childEnv,
        onDialog: (event) => {
          try { return handleWorkerDialog(run, event); }
          catch (error) {
            run.cleanupError ??= `Worker protocol failed: ${error instanceof Error ? error.message : String(error)}`;
            stopRun(run, "process_failure");
            return true;
          }
        },
        onEvent: (event) => {
          try {
            transcript(event);
            cancelWorkerPermission(run, event);
            if (event.type === "extension_error" && !run.closing) {
              run.error = `Worker extension failed: ${String(event.error ?? event.message ?? "unknown error")}`;
              stopRun(run, "process_failure");
            }
            if (event.type === "child_exit" && run.execution === "idle" && !run.closing) stopRun(run, "process_failure");
            const progress = summarizeChildEvent(event);
            if (run.status === "running" && progress && progress !== run.progress) {
              run.progress = progress;
              if (!retired) writeStatus(run);
              publishProgress();
            }
          } catch (error) {
            // Process callbacks cannot throw into the owner's event loop. Retain
            // the failure and finish disposal before allowing history changes.
            run.cleanupError ??= `Could not record child activity: ${error instanceof Error ? error.message : String(error)}`;
            run.child?.abort();
          }
        },
      });
    } catch (error) {
      run.status = run.stopReason ? "aborted" : "error";
      run.error = `Subagent was not launched: ${error instanceof Error ? error.message : String(error)}`;
      const assignment = run.assignments.at(-1);
      if (assignment?.outcome === "pending") { assignment.outcome = "interrupted"; assignment.endedAt = new Date().toISOString(); }
      run.completedAt = new Date().toISOString();
      try {
        if (run.worktree) await updateWorkspace(run.worktree.workspaceId, (record) => { delete record.managedCleanupPending; });
        writeFileSync(run.resultPath, run.error + "\n", "utf8");
        await prepareWorktreePatch(run);
      } catch (failure) {
        run.cleanupError = failure instanceof Error ? failure.message : String(failure);
      } finally {
        if (run.abortSignal && run.abortListener) run.abortSignal.removeEventListener("abort", run.abortListener);
        run.abortSignal = undefined;
        run.abortListener = undefined;
        run.settled = true;
        run.execution = run.status === "aborted" ? "cancelled" : "failed";
        signalChange(run);
        try {
          writeStatus(run);
          publishSpawnStatus();
        } catch (error) {
          run.cleanupError ??= error instanceof Error ? error.message : String(error);
          throw error;
        } finally { run.resolveFinished(run); }
      }
      return;
    }
    run.child = child;
    // Cancellation can arrive before the child handle exists.
    if (run.stopReason || run.abortSignal?.aborted) stopRun(run, run.stopReason ?? "parent_abort");

    const timeoutMs = Math.max(1, params.timeoutSeconds ?? 1800) * 1000;
    run.armTimeout = () => {
      if (run.timeout) clearTimeout(run.timeout);
      run.timeout = setTimeout(() => stopRun(run, "timeout"), timeoutMs);
    };
    run.armTimeout();

    void (async () => {
      try {
        while (!run.closing) {
          const assignment = run.assignments.at(-1)!;
          const state = await child.send({ type: "get_state" });
          assertSuccess(state, "get selected subagent model");
          const selected = (state.data as { model?: ModelIdentity } | undefined)?.model;
          run.selectedModel = selected && typeof selected.provider === "string" && typeof selected.id === "string"
            ? { provider: selected.provider, id: selected.id } : undefined;
          if (!run.selectedModel || run.selectedModel.provider !== params.provider || run.selectedModel.id !== params.model) {
            throw new Error(`Subagent model selection mismatch: requested ${params.provider}/${params.model}, selected ${run.selectedModel ? `${run.selectedModel.provider}/${run.selectedModel.id}` : "none"}. No assignment was sent.`);
          }
          writeStatus(run);
          publishSpawnStatus();
          const agentEnd = child.waitForAgentEnd();
          const [, terminalEnd] = await Promise.all([
            child.send({ type: "prompt", message: `/spawn-assignment ${JSON.stringify({ workerId: run.id, parentId: run.parentId, assignmentId: assignment.id,
              prompt: spawnPrompt({ prompt: assignment.prompt, role: run.role, agent: run.profile, accessMode: run.accessMode, briefPath: run.briefPath, agentPromptPath: run.agentPromptPath }),
            })}` }).then((response) => assertSuccess(response, "subagent assignment")), agentEnd,
          ]);
          if (run.stopReason) throw new Error(run.stopReason);
          const terminalError = terminalAssistantError(terminalEnd);
          if (terminalError) throw terminalError;
          if (assignment.outcome === "pending") {
            assignment.outcome = "incomplete";
            assignment.endedAt = new Date().toISOString();
            const lastAssistant = await child.send({ type: "get_last_assistant_text" });
            assertSuccess(lastAssistant, "get incomplete subagent output");
            run.resultText = `Assignment incomplete: turn ended without spawn_report.\n${textFromLastAssistantResponse(lastAssistant) ?? ""}`;
            writeFileSync(run.resultPath, run.resultText, "utf8");
          }
          run.progress = `Assignment ${assignment.outcome}`;
          if (run.lifetime === "bounded" || run.worktree) {
            run.status = assignment.outcome === "completed" ? "completed" : "error";
            if (assignment.outcome !== "completed") run.error = `Assignment ${assignment.outcome}`;
            break;
          }
          // Readonly conversations can stay live. Writers instead leave this
          // loop and stop their entire managed tree before review. Corrections
          // resume the persisted conversation, never recycle its workspace.
          run.execution = "idle";
          if (run.timeout) { clearTimeout(run.timeout); run.timeout = undefined; }
          const next = new Promise<void>((resolve) => { run.resume = resolve; });
          writeStatus(run);
          publishSpawnStatus();
          announceCompletion(run);
          await next;
          run.resume = undefined;
        }
        if (run.stopReason && run.stopReason !== "closed_by_parent") throw new Error(run.stopReason);
        if (run.stopReason === "closed_by_parent") run.status = run.assignments.at(-1)?.outcome === "completed" ? "completed" : "error";
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const assignment = run.assignments.at(-1);
        if (assignment?.outcome === "pending") { assignment.outcome = "interrupted"; assignment.endedAt = new Date().toISOString(); }
        if (run.stopReason) {
          run.status = run.stopReason === "process_failure" ? "error" : "aborted";
          run.error = run.stopReason === "timeout" ? "Subagent timed out."
            : run.stopReason === "process_failure" ? run.error ?? message : `Subagent aborted: ${run.stopReason}.`;
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
        run.execution = "closing";
        for (const [id, wait] of permissionRecords()) {
          if (wait.run !== run) continue;
          wait.cancellation.abort();
          wait.request.state = "cancelled";
          wait.request.resolvedAt = new Date().toISOString();
          permissionWaits.delete(id);
          permissionExecutions.delete(id);
          eventQueue.delete(wait.request.id);
        }
        run.armTimeout = undefined;
        for (const request of run.requests.filter((request) => request.state === "pending")) {
          request.state = "cancelled";
          request.resolvedAt = new Date().toISOString();
        }
        run.pendingDialog = undefined;
        run.completedAt = new Date().toISOString();
        if (run.timeout) {
          clearTimeout(run.timeout);
          run.timeout = undefined;
        }
        if (run.abortSignal && run.abortListener) {
          run.abortSignal.removeEventListener("abort", run.abortListener);
        }
        run.abortSignal = undefined;
        run.abortListener = undefined;
        if (run.worktree) {
          try {
            const state = await child.send({ type: "get_state" });
            const data = state.data as { sessionFile?: unknown } | undefined;
            if (typeof data?.sessionFile === "string") {
              const childSessionFile = data.sessionFile;
              run.childSessionFile = childSessionFile;
              await updateWorkspace(run.worktree.workspaceId, (record) => {
                record.targetSessionFile = childSessionFile;
              });
            }
          } catch {
            // A terminated child may not be able to report its session path; run artifacts still retain its session directory.
          }
        }
        try {
          // Final patches must include shutdown writes from tracked writers.
          // Unknown escaped processes remain outside the best-effort guarantee.
          try { await child.dispose(); }
          catch (error) { run.cleanupError = error instanceof Error ? error.message : String(error); throw error; }
          run.child = undefined;
          if (run.worktree) await updateWorkspace(run.worktree.workspaceId, (record) => { delete record.managedCleanupPending; });
          await prepareWorktreePatch(run);
        } catch (error) {
          run.cleanupError = error instanceof Error ? error.message : String(error);
          if (run.worktree) {
            run.integrationBlock = { integration: "failed", reason: `managed cleanup/patch failed: ${run.cleanupError}` };
          }
        }
        if (run.worktree && !run.integrationBlock && run.status !== "completed") {
          run.integrationBlock = { integration: "needs_parent", reason: `subagent status is ${run.status}` };
        }
        if (progressPublishTimer) {
          clearTimeout(progressPublishTimer);
          progressPublishTimer = undefined;
        }
        // dispose was awaited before capture; failed cleanup remains persisted
        // and blocks every later join and shared workspace mutation.
        run.settled = true;
        run.execution = run.cleanupError ? "failed"
          : run.worktree && run.lifetime === "conversational" && !run.stopReason && run.childSessionFile ? "idle"
          : run.status === "completed" || run.stopReason === "closed_by_parent" || (!run.stopReason && run.assignments.at(-1)?.outcome === "blocked")
            ? "closed" : run.status === "aborted" ? "cancelled" : "failed";
        signalChange(run);
        if (run.cleanupError) writeStatus(run);
        // Retired callbacks may finish artifacts but must not overwrite status
        // already restored by a replacement runtime or publish to its UI.
        if (!retired) {
          writeStatus(run);
          publishProgress(true);
          announceCompletion(run);
        }
        run.resolveFinished(run);
      }
    })().catch(async (error: unknown) => {
      try { await child.dispose(); }
      catch (cleanup) { run.cleanupError = cleanup instanceof Error ? cleanup.message : String(cleanup); }
      const failure = error instanceof Error ? error : new Error(String(error));
      run.cleanupError ??= failure.message;
      run.settled = true;
      run.execution = "failed";
      signalChange(run);
      try { writeStatus(run); } catch { /* In-memory state still blocks history. */ }
      // A failed status write/send is reported, but must not strand all later
      // joins. Their own writes can retry durable finalization.
      run.resolveFinished(run);
      ui?.notify(`Could not finalize subagent ${run.id}: ${failure.message}`, "error");
    });
  };

  for (const operation of ["spawn.join", "spawn.stop"] as const) {
    registerServiceOperation(pi, operation, async ({ id }, ctx) => {
      ui = ctx.ui;
      const run = runs.get(id);
      if (!run || retired) return;
      if (operation === "spawn.join") {
        await finalizeJoin([run], ctx.signal, "command", () => emitCommandResult(resultSummary(run), artifactDetails(run)));
      } else {
        stopRun(run, "stopped_by_parent");
        await waitForRun(run, undefined, false);
        publishSpawnStatus();
        emitCommandResult(`Stopped ${run.id}: ${run.status}`, artifactDetails(run));
      }
      return { changed: true, status: run.status, integration: worktreeInfo(run)?.integration };
    });
  }

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
          await finalizeJoin([run], ctx.signal, "command", () => emitCommandResult(resultSummary(run), artifactDetails(run)));
          return;
        }
        if (action === "stop") {
          const run = getRunById(id);
          stopRun(run, "stopped_by_parent");
          await waitForRun(run, undefined, false);
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

  const registerSpawnTool = (writingGuidance: string) => pi.registerTool({
    name: "spawn",
    defaultActive: false,
    label: "Spawn Subagent",
    description: "Spawn a worker, bounded by default; conversational lifetime supports readonly workers and isolated edit workers. Workers explicitly report outcomes and may ask questions or request permissions. Foreground/join yield actionable requests without accepting changes. Named profiles and artifacts use existing Pi locations.",
    promptSnippet: "Delegate approved implementation, research, review, or verification to a worker; inspect and explicitly accept its result.",
    promptGuidelines: [
      "Use the packaged orchestration skill when delegating a task or coordinating an approved project. Keep trivial tasks and discussion in the parent; delegation is not mandatory for every change.",
      "Delegate approved implementation with sufficient context, settled behavior, explicit file ownership, acceptance criteria, and evidence requirements. Keep user decisions and overall scope in the parent.",
      "Discover profiles and resolved model identities with spawn_control action=models. Use defaults without asking; obtain user authorization before selecting alternatives unless already authorized for this scope. Never inspect credentials or guess provider IDs. Unknown/unavailable selections fail without substitution; model configuration changes apply only to new workers.",
      "spawn defaults to background. If your response depends on the subagent result, call spawn_control with action=join or join_all before answering.",
      "Prefer researcher for investigation and summarization, reviewer for review, verifier for verification, and worker for self-contained tasks requiring file changes.",
      "Use accessMode=readonly for research, planning, review, and verification. Delegate file changes with accessMode=edit and worktree isolation. One writer owns the slot through input waits, completion and review until acceptance/cleanup or explicit discard resolves it. Parent repository writes and unsandboxed Bash are blocked during ownership; sandboxed read commands remain available. There is no concurrent-writer override.",
      "For implementation tasks in a Git repository, enter the task workspace before spawning any subagents, including read-only researchers.",
      writingGuidance,
    ],
    parameters: Type.Object({
      prompt: Type.String({ description: "The complete bounded prompt/task for the subagent." }),
      agent: Type.Optional(Type.String({ description: "Named bundled, user, or trusted project profile. Discover roles and exact model identities with spawn_control action=models." })),
      role: Type.Optional(Type.String({ description: "Backward-compatible role/instructions label. If it matches a subagent profile and agent is omitted, that profile is loaded." })),
      lifetime: Type.Optional(Type.Union([Type.Literal("bounded"), Type.Literal("conversational")], { description: "Bounded by default. Conversational keeps the same conversation for follow-up. Isolated edit workers stop all tracked processes for review and resume that conversation only for corrections before acceptance." })),
      mode: Type.Optional(Type.Union([
        Type.Literal("background"),
        Type.Literal("foreground"),
      ], { description: "Execution mode. Defaults to background. Foreground waits until a result or actionable question/permission request." })),
      accessMode: Type.Optional(Type.Union([
        Type.Literal("readonly"),
        Type.Literal("ask"),
        Type.Literal("edit"),
        Type.Literal("full"),
      ], { description: "Subagent access mode. Defaults to the profile accessMode, otherwise readonly." })),
      isolation: Type.Optional(Type.Union([
        Type.Literal("none"),
        Type.Literal("worktree"),
      ], { description: "Isolation mode. Defaults to worktree for writing access and none for readonly." })),
      model: Type.Optional(Type.String({ description: "User-authorized exact provider/model-id override (or unique exact bare ID). Otherwise: YAML subagents.models role default, profile model, then parent. No fuzzy matching or silent substitution. Existing workers retain their model for corrections." })),
      timeoutSeconds: Type.Optional(Type.Number({ description: "Assignment timeout in seconds, including question waits. Defaults to 1800. Conversational review/idle time does not consume the timeout; each follow-up starts a new deadline." })),
    }),
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      if (retired) throw new Error("Cannot launch subagent from a retired runtime");
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
      const lifetime = params.lifetime ?? "bounded";
      if (lifetime === "conversational" && !((accessMode === "readonly" && isolation === "none") || (accessMode === "edit" && isolation === "worktree"))) {
        throw new Error("Conversational workers require readonly/no isolation or edit/worktree isolation.");
      }
      if (accessMode !== "readonly" && isolation !== "worktree") {
        throw new Error("Writing subagents must use worktree isolation");
      }
      if (accessMode !== "readonly" || isolation === "worktree") {
        const writer = [...runs.values()].find(ownsWriter);
        if (writer) throw new Error(`Writer ${writer.id} owns an unresolved contribution. Accept or explicitly discard it before starting another writer. Concurrent writers are unavailable.`);
        // Existing commands may have a writable ancestor (for example /tmp)
        // covering the not-yet-created child tree, despite denying current trees.
        assertRepositoryIdle([...repositoryWriteRoots(ctx.cwd), canonicalPath(join(workspaceStorageRoot(), "trees"))]);
      }
      if (isolation === "worktree") {
        if (getAccessMode() !== "edit" && getAccessMode() !== "full") throw new Error("Isolated workers require parent edit or full access mode");
        if (!findGitRoot(ctx.cwd)) {
          throw new Error("Isolated writing subagents require a Git repository. Use read-only subagents; the parent applies edits directly.");
        }
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

      const modelSelection = resolveWorkerModel(ctx, {
        override: params.model, role: subagent?.name ?? params.role?.trim(), profile: subagent,
        defaults: loadExtensionSettings().subagents?.models ?? {},
      });

      const run = createRun({
        prompt: params.prompt,
        role: params.role,
        requestedAgent: params.agent,
        profile: subagent,
        modelSelection,
        accessMode,
        isolation,
        mode,
        lifetime,
        cwd: ctx.cwd,
        parentSessionFile: ctx.sessionManager.getSessionFile(),
        signal,
      });

      await startRun(run, { model: modelSelection.id, provider: modelSelection.provider, timeoutSeconds: params.timeoutSeconds });

      if (mode === "background") {
        onUpdate?.({ content: [{ type: "text", text: `${runLabel(run)} ${run.id} started (${accessMode}).` }], details: artifactDetails(run) });
        return {
          content: [{ type: "text", text: formatSpawnStarted(run) }],
          details: artifactDetails(run),
        };
      }

      onUpdate?.({ content: [{ type: "text", text: `${runLabel(run)} ${run.id} running in foreground (${accessMode}).` }], details: artifactDetails(run) });
      return finalizeJoin([run], signal, "tool", () => ({
        content: [{ type: "text" as const, text: resultSummary(run) }],
        isError: runHasError(run),
        details: artifactDetails(run),
      }));
    },
  });

  let currentWritingGuidance: string | undefined;
  function refreshSpawnTool(ctx: ExtensionContext): void {
    const active = workspaceForContext(ctx.cwd, ctx.sessionManager.getSessionFile());
    const writingGuidance = !findGitRoot(ctx.cwd)
      ? "This directory is not a Git repository. Use read-only subagents for parallel work; the parent applies edits directly."
      : !active
        ? "Before spawning writing subagents, enter a task workspace with workspace action=enter."
        : isWorkspaceFinalized(active)
          ? "This workspace is finalized. Do not spawn writing subagents here."
          : "Writing subagents use isolated child worktrees of the active workspace. Use spawn_control join/report/diff to inspect; accept explicitly integrates their changes.";
    if (writingGuidance === currentWritingGuidance) return;
    registerSpawnTool(writingGuidance);
    currentWritingGuidance = writingGuidance;
  }

  registerSpawnTool("Writing subagents require an active Git task workspace.");

  pi.registerTool({
    name: "spawn_control",
    defaultActive: false,
    label: "Control Subagents",
    description: "Discover configured roles and resolved provider/model identities with models. Wait with join/join_all; use list/status/report/diff for inspection, not polling. A returned question or permission request requires a response before waiting on that worker again. Use approve/deny with exact worker, assignment, request and both runtime IDs for permissions. Approval beyond the parent's current authority requires the existing user approval UI. Use reply only for clarification. Followup requests corrections from an idle unaccepted conversational edit worker, or another assignment from a readonly worker. Close ends the conversation; stop cancels but retains writer ownership. Discard disposes a quiescent contribution. Only accept integrates the current explicitly completed, quiescent revision. After acceptance, implementation requires a new worker and baseline.",
    promptSnippet: "Inspect worker results; reply to questions; followup or close conversational workers; accept changes explicitly.",
    promptGuidelines: [
      "Use models to discover current role defaults, resolved provider/model identities, availability errors, and profile sources without reading credentials. Use configured defaults without asking; alternatives require user authorization for the relevant scope.",
      "Use spawn_control join or join_all before answering if your response depends on background subagent results.",
      "Use join/join_all to wait and list/status/report/diff only for inspection. When join, status, or a worker event returns a pending request, respond before observing that worker again: reply to clarification, approve/deny permission, or obtain missing user input. Read context if needed; do not poll. status and join cannot resolve the request or resume the worker. After responding, join again. Never interpret an agent's reply as user consent or a permission grant.",
      "Use followup for corrections to an idle unaccepted conversational edit worker, or further readonly assignments. After acceptance, start a new writer with a fresh workspace. Close ends the conversation; stop cancels work but does not release its contribution. Use discard to dispose a quiescent unwanted contribution. accept is the only integration action; inspection never applies a patch.",
      "If accept reports integration=needs_parent, inspect the retained patch/worktree before deciding how to resolve it. Acceptance retains existing parent-mode, baseline, cleanup, and conflict safeguards.",
    ],
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("models"),
        Type.Literal("list"),
        Type.Literal("status"),
        Type.Literal("join"),
        Type.Literal("join_all"),
        Type.Literal("stop"),
        Type.Literal("reply"),
        Type.Literal("approve"),
        Type.Literal("deny"),
        Type.Literal("followup"),
        Type.Literal("close"),
        Type.Literal("report"),
        Type.Literal("diff"),
        Type.Literal("accept"),
        Type.Literal("discard"),
      ], { description: "Lifecycle action to perform." }),
      assignmentId: Type.Optional(Type.String({ description: "Current assignment ID, required for reply/approve/deny/followup/accept/discard." })),
      requestId: Type.Optional(Type.String({ description: "Exact pending request ID for reply/approve/deny." })),
      runtimeId: Type.Optional(Type.String({ description: "Exact child runtime ID for approve/deny." })),
      parentRuntimeId: Type.Optional(Type.String({ description: "Exact parent runtime ID for approve/deny." })),
      message: Type.Optional(Type.String({ minLength: 1, description: "Agent-authored answer or follow-up assignment. Never user consent or permission approval." })),
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

      if (params.action === "models") {
        const profiles = discoverSubagentProfiles(ctx.cwd, typeof ctx.isProjectTrusted === "function" && ctx.isProjectTrusted());
        const defaults = loadExtensionSettings().subagents?.models ?? {};
        const roles = [...new Set([...profiles.map(profile => profile.name), ...Object.keys(defaults)])].sort().map(role => {
          const profile = profiles.find(profile => profile.name === role);
          const configuredModel = Object.hasOwn(defaults, role) ? defaults[role] : undefined;
          const description = { role, profile: profile ? { source: profile.source, path: profile.filePath,
            description: profile.description, accessMode: profile.accessMode ?? "readonly", model: profile.model ?? "inherit" } : null,
            configuredModel: configuredModel ?? null };
          try {
            return { ...description, resolvedModel: resolveWorkerModel(ctx, { role, profile, defaults }), available: true };
          } catch (error) {
            return { ...description, resolvedModel: null, available: false, error: error instanceof Error ? error.message : String(error) };
          }
        });
        const details = { parentModel: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : null, roles,
          precedence: ["authorized override", "YAML role default", "profile model", "parent model"], appliesTo: "new workers only" };
        return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
      }

      if (params.action === "list") {
        const text = allRuns.length === 0 ? "No spawned subagents in this session." : allRuns.map(formatRunStatus).join("\n\n");
        return { content: [{ type: "text", text }], details: { runs: allRuns.map(run => statusJson(run)) } };
      }

      if (params.action === "status") {
        const run = getRun(params.id);
        return { content: [{ type: "text", text: formatRunStatus(run) }], details: artifactDetails(run) };
      }

      if (params.action === "approve" || params.action === "deny") {
        if (Object.keys(params).some((key) => !["action", "id", "assignmentId", "requestId", "runtimeId", "parentRuntimeId"].includes(key))) {
          throw new Error("Permission decisions accept only the exact request address; scopes and messages cannot change authority");
        }
        const run = getRun(params.id);
        const wait = permissionWaits.get(params.requestId ?? "");
        if (!wait || wait.run !== run || wait.request.state !== "pending" || wait.deciding
          || params.assignmentId !== wait.request.assignmentId || params.runtimeId !== wait.request.runtimeId
          || params.parentRuntimeId !== wait.request.parentRuntimeId) throw new Error("Stale, duplicate, or incorrectly addressed permission decision");
        permissionCurrent(wait);
        wait.deciding = true;
        const { request } = wait;
        try {
          if (params.action === "deny") {
            request.state = "denied";
            request.decision = { actor: "parent", outcome: "denied" };
            permissionWaits.delete(request.id);
            wait.cancellation.abort();
          } else {
            const authorityCwd = request.permission.kind === "unsandboxed" ? request.cwd : ctx.cwd;
            const covered = hasPermission(request.permission, authorityCwd);
            if (!covered) {
              run.execution = "waiting_user";
              writeStatus(run);
              publishSpawnStatus();
            }
            // Only the existing user picker can add authority. Its session grant
            // belongs to the parent; children receive a single execution handle.
            wait.authorization = await requestPermission({ ...ctx, cwd: request.cwd,
              signal: AbortSignal.any([runtimeCancellation.signal, wait.cancellation.signal, ...(signal ? [signal] : [])]) },
              request.permission, request.tool, wait.userPreview, () => saveSessionSetting(pi, "access", {
                mode: getAccessMode(), permissions: getSessionGrants().filter((grant) => grant.kind !== "unsandboxed" && grant.kind !== "unix-socket"),
              }), request.remember, { authorityCwd, modelPreview: request.preview, provenance: {
                workerId: run.id, parentId: run.parentId, assignmentId: request.assignmentId, requestId: request.id,
                runtimeId: request.runtimeId, parentRuntimeId, workspaceId: request.workspaceId, directory: request.cwd,
              } });
            permissionCurrent(wait);
            await wait.authorization.validate();
            permissionCurrent(wait);
            request.state = "approved";
            request.decision = { actor: covered ? "parent" : "user", outcome: "approved" };
          }
        } catch (error) {
          const denied = permissionWasDenied(error);
          request.state = denied ? "denied" : "cancelled";
          request.resolvedAt = new Date().toISOString();
          request.decision ??= { actor: denied ? "user" : "parent", outcome: denied ? "denied" : "cancelled", reason: String(error) };
          permissionWaits.delete(request.id);
          if (!run.closing) permissionResponse(wait, false);
          throw error;
        }
        request.resolvedAt = new Date().toISOString();
        eventQueue.delete(request.id);
        // Audit before releasing the worker. Audit is never read as authority.
        writeStatus(run);
        appendFileSync(run.transcriptPath, `${JSON.stringify({ timestamp: request.resolvedAt, event: { type: "permission_decision", ...request } })}\n`);
        permissionResponse(wait, request.state === "approved");
        return { content: [{ type: "text", text: `Permission ${request.id}: ${request.state}.` }], details: artifactDetails(run) };
      }

      if (["reply", "followup", "accept", "report", "diff", "close", "discard"].includes(params.action)) {
        const run = getRun(params.id);
        const assignment = run.assignments.at(-1)!;
        if (params.action === "reply") {
          const request = run.requests.find((request) => request.id === params.requestId);
          if (retired || run.closing || !run.child || run.settled || run.execution !== "waiting_parent" || !run.pendingDialog
            || params.assignmentId !== assignment.id || !request || request.assignmentId !== assignment.id
            || request.workerId !== run.id || request.recipient.id !== run.parentId || request.state !== "pending" || !params.message?.trim()) {
            throw new Error("Stale, duplicate, incorrectly addressed, or invalid worker reply");
          }
          // Resolve durably before releasing the child; never retry an ambiguous
          // transport write and deliver the same answer twice.
          request.state = "answered";
          request.resolvedAt = new Date().toISOString();
          request.reply = { sender: { kind: "parent", id: run.parentId }, text: params.message };
          const dialog = run.pendingDialog;
          run.execution = run.permissionRequests.some((request) => request.state === "pending") ? "waiting_parent" : "working";
          const reply = { version: 1, ...request.reply, workerId: run.id, assignmentId: assignment.id, requestId: request.id };
          try {
            writeStatus(run);
            appendFileSync(run.transcriptPath, `${JSON.stringify({ timestamp: request.resolvedAt, event: { type: "parent_reply", ...reply } })}\n`);
            run.child.respond(dialog, JSON.stringify(reply));
            run.pendingDialog = undefined;
          } catch (error) {
            request.state = "cancelled";
            stopRun(run, "process_failure");
            throw error;
          }
          publishSpawnStatus();
          return { content: [{ type: "text", text: agentContext(request.reply.sender, reply) }], details: artifactDetails(run) };
        }
        if (params.action === "followup") {
          const writer = !!run.worktree;
          const record = writer ? loadWorkspace(run.worktree!.workspaceId) : undefined;
          if (retired || run.closing || run.accepting || run.lifetime !== "conversational" || run.execution !== "idle"
            || params.assignmentId !== assignment.id || !params.message?.trim()
            || (writer ? !run.settled || !!run.cleanupError || !run.childSessionFile || !run.launch || !record?.retained || isWorkspaceFinalized(record) || !!record.managedCleanupPending
              : run.settled || !run.resume)) throw new Error("Followup requires an idle, unaccepted conversational worker and its current assignment ID. Later implementation tasks require a new worker.");
          if (writer && getAccessMode() !== "edit" && getAccessMode() !== "full") throw new Error("Corrections require parent edit or full access mode");
          run.assignments.push(newAssignment(params.message));
          run.execution = "working";
          run.joined = false;
          run.error = undefined;
          run.resultText = undefined;
          run.integrationBlock = undefined;
          if (writer) {
            run.settled = false;
            run.status = "running";
            run.completedAt = undefined;
            run.runtimeId = randomUUID();
            run.finished = new Promise<SpawnRun>((resolve) => { run.resolveFinished = resolve; });
            run.abortSignal = signal;
            run.abortListener = () => stopRun(run, "parent_abort");
            signal?.addEventListener("abort", run.abortListener, { once: true });
            if (signal?.aborted) run.abortListener();
          }
          try {
            if (writer) await updateWorkspace(record!.id, (record) => { record.managedCleanupPending = run.id; });
            writeStatus(run);
            appendFileSync(run.transcriptPath, `${JSON.stringify({ timestamp: new Date().toISOString(), event: { type: "parent_assignment", sender: { kind: "parent", id: run.parentId }, workerId: run.id, assignment: run.assignments.at(-1) } })}\n`);
            if (writer) await startRun(run, run.launch!);
            else { run.armTimeout?.(); run.resume!(); }
          } catch (error) {
            stopRun(run, "process_failure");
            if (writer && !run.child) {
              run.cleanupError ??= error instanceof Error ? error.message : String(error);
              run.settled = true;
              run.execution = "failed";
              run.resolveFinished(run);
            }
            throw error;
          }
          publishSpawnStatus();
          return { content: [{ type: "text", text: formatSpawnStarted(run) }], details: artifactDetails(run) };
        }
        if (params.action === "close") {
          if (!run.settled && run.execution !== "idle") throw new Error("Close requires an idle worker; use stop to cancel active work");
          stopRun(run, "closed_by_parent");
          await waitForRun(run, undefined, false);
          if (!run.cleanupError) { run.closing = true; run.execution = "closed"; writeStatus(run); }
        }
        if (params.action === "discard") {
          if (run.worktree && getAccessMode() !== "edit" && getAccessMode() !== "full") throw new Error("Contribution disposal requires parent edit or full access mode");
          if (params.assignmentId !== assignment.id || !run.settled || run.child || run.cleanupError || run.accepting) throw new Error("Discard requires the current assignment and resolved process cleanup; stop active work first");
          run.closing = true;
          run.execution = "closed";
          if (run.worktree) {
            await prepareWorktreePatch(run);
            const removed = await removeWorkspace(run.worktree.workspaceId, "discarded");
            if (removed.retained) throw new Error(`Contribution cleanup unresolved: ${removed.integrationReason}`);
          }
          run.joined = true;
          writeStatus(run);
        }
        if (params.action === "accept") {
          if (params.assignmentId !== assignment.id || run.accepting) throw new Error("accept requires the current assignment ID and no acceptance in progress");
          run.accepting = true;
          try {
            await applyWorktreeChanges(run, signal);
            const record = run.worktree ? loadWorkspace(run.worktree.workspaceId) : undefined;
            if (record && isWorkspaceFinalized(record)) { run.closing = true; run.execution = "closed"; }
            writeStatus(run);
          } finally { run.accepting = false; }
        }
        if (params.action === "diff") {
          const patch = run.settled && !run.cleanupError ? worktreeInfo(run)?.patchPath : undefined;
          return { content: [{ type: "text", text: patch && existsSync(patch) ? truncateText(readFileSync(patch, "utf8"), 24000) : "No prepared recovery patch. Inspection does not snapshot or integrate live workers." }], details: artifactDetails(run) };
        }
        publishSpawnStatus();
        return { content: [{ type: "text", text: resultSummary(run) }], details: artifactDetails(run) };
      }

      if (params.action === "stop") {
        const selected = params.ids?.length ? params.ids.map((id: string) => getRun(id)) : [getRun(params.id)];
        for (const run of selected) {
          stopRun(run, "stopped_by_parent");
        }
        await waitForRuns(selected, undefined, false);
        const text = selected.map((run) => `Stopped ${run.id}: ${run.status}${run.error ? ` (${run.error})` : ""}`).join("\n");
        return { content: [{ type: "text", text }], details: { runs: selected.map(run => statusJson(run)) } };
      }

      if (params.action === "join") {
        const run = getRun(params.id);
        return finalizeJoin([run], signal, "tool", () => ({
          content: [{ type: "text" as const, text: resultSummary(run) }],
          isError: runHasError(run),
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
        return finalizeJoin(selected, signal, "tool", () => ({
          content: [{ type: "text" as const, text: selected.map((run) => `## ${run.id}\n\n${resultSummary(run)}`).join("\n\n---\n\n") }],
          isError: selected.some(runHasError),
          details: { runs: selected.map(run => statusJson(run)) },
        }), () => onUpdate?.({ content: [{ type: "text", text: `Waiting for ${selected.length} subagent(s)…` }], details: { runs: selected.map(run => statusJson(run)) } }));
      }

      return { content: [{ type: "text", text: `Unknown action: ${String(params.action)}` }], isError: true, details: undefined };
    },
  });
}
