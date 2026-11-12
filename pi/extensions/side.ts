import { registerServiceOperation } from "./shared/service-operation";
import { SERVICE_DIALOG_STATUS, serviceDialogTag, serviceUi } from "./shared/service-ui";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  SessionManager,
  buildSessionProjection,
  sessionEntryToContextMessages,
  type ExtensionAPI,
  type ExtensionContext,
  type JsonAgentSessionEvent,
  type RpcExtensionUIRequest,
  type RpcExtensionUIResponse,
  type SessionEntry,
  type SessionHeader,
} from "@earendil-works/pi-coding-agent";
import { createHash, randomUUID } from "node:crypto";
import { messageKey, PERMISSION_HISTORY, permissionSnapshot } from "../scripts/permission-history.mjs";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SideRpc, updateSidePartial, type SideRpcEvent } from "./shared/side-rpc";
import { notifyPiNeedsInput, notifyPiOutcome } from "./shared/notifications";
import { deterministicTitle, modelTitle } from "./auto-title";

const JOURNAL = "pi-side-conversation";
const BOUNDARY = "pi-side-context-boundary";

type Source = {
  capturedAt: string;
  cwd: string;
  leafId: string | null;
  model?: { provider: string; id: string };
  thinkingLevel: string;
  systemPrompt: string;
};

type Reference = { source: Source; boundary: string; inheritedIds?: string[] };
// Read-only compatibility with the old embedded side journal.
type Seed = Reference & { header: SessionHeader; entries: SessionEntry[] };
type RecordBase = { version: 1; parentSessionFile: string; parentSessionId: string; id: string };
type JournalData =
  | { kind: "start"; seed?: Seed }
  | { kind: "seed"; seed: Seed }
  | { kind: "entries"; entries: SessionEntry[]; leafId: string | null }
  | { kind: "draft"; draft: string }
  | { kind: "state"; running: boolean; error?: string; pendingPrompt?: string; pendingAfter?: string };
type JournalRecord = RecordBase & JournalData;

type ToolStart = Extract<JsonAgentSessionEvent, { type: "tool_execution_start" }>;
type ToolEnd = Extract<JsonAgentSessionEvent, { type: "tool_execution_end" }>;
type SideTool = Omit<ToolStart, "type"> & {
  state: "running" | "completed" | "interrupted";
  messageKey?: string;
  startedAt: string;
  partialResult?: Extract<JsonAgentSessionEvent, { type: "tool_execution_update" }>["partialResult"];
  result?: ToolEnd["result"];
  isError?: boolean;
};

type Generation = {
  id: string;
  title?: string;
  createdAt: string;
  lastUsedAt: string;
  ctx: ExtensionContext;
  parentSessionFile: string;
  parentSessionId: string;
  reference?: Reference;
  /** Only the side's own entries, never the inherited main context. */
  entries: SessionEntry[];
  leafId: string | null;
  messages: AgentMessage[];
  tools: SideTool[];
  partialMessage?: AgentMessage;
  draft: string;
  pendingPrompt?: string;
  pendingAfter?: string;
  running: boolean;
  /** Stop reason of the latest assistant message in the current run. */
  stopReason?: string;
  error?: string;
  activity?: string;
  persisted: boolean;
  cancelled: boolean;
  dialogs: AbortController;
  dialogIds: Set<string>;
  dialogControllers: Map<string, AbortController>;
  child?: SideRpc;
  ready?: Promise<SideRpc>;
  initialized?: boolean;
  work?: Promise<void>;
  drain: Promise<void>;
  directory?: string;
  file?: string;
};

function reference(ctx: ExtensionContext, pi: ExtensionAPI): Reference {
  const source: Source = {
    capturedAt: new Date().toISOString(),
    cwd: ctx.cwd,
    leafId: ctx.sessionManager.getLeafId(),
    model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
    thinkingLevel: pi.getThinkingLevel(),
    systemPrompt: ctx.getSystemPrompt(),
  };
  return { source, boundary: randomUUID() };
}

function materialize(ctx: ExtensionContext, ref: Reference, sessionId: string): Seed {
  const { source } = ref;
  if (source.leafId && !ctx.sessionManager.getEntry(source.leafId)) throw new Error("Side context was deleted; start a new side conversation.");
  const manager = SessionManager.inMemory(source.cwd, { parentSession: ctx.sessionManager.getSessionFile() });
  // Reconstruct the captured branch, not today's active branch. Context edits
  // after the reference point must not change an existing side conversation.
  const branch = source.leafId ? ctx.sessionManager.getBranch(source.leafId) : [];
  for (const message of structuredClone(buildSessionProjection(branch, source.leafId).messages)) {
    if (message.role === "compactionSummary") manager.appendCompaction(message.summary, null, message.tokensBefore);
    else if (message.role === "branchSummary") manager.branchWithSummary(manager.getLeafId(), message.summary);
    else manager.appendMessage(message);
  }
  if (source.model) manager.appendModelChange(source.model.provider, source.model.id);
  manager.appendThinkingLevelChange(source.thinkingLevel);
  manager.appendCustomEntry(BOUNDARY, { capturedAt: source.capturedAt });
  const generated = manager.getEntries();
  if (ref.inheritedIds && ref.inheritedIds.length !== generated.length) throw new Error("Side context changed; start a new side conversation.");
  // Compactions and context edits in the side can refer into inherited context.
  // Keep those IDs stable too, not just the boundary. Legacy seeds retain only
  // their ID list; new references derive IDs without storing main content.
  const ids = new Map(generated.map((entry, index) => [entry.id, index === generated.length - 1 ? ref.boundary
    : ref.inheritedIds?.[index] ?? createHash("sha256").update(`${ref.boundary}:${index}`).digest("hex").slice(0, 32)]));
  const entries = generated.map(entry => {
    const mapped = { ...entry, id: ids.get(entry.id)!, parentId: entry.parentId ? ids.get(entry.parentId) ?? entry.parentId : null };
    if (mapped.type === "compaction") mapped.firstKeptEntryId = ids.get(mapped.firstKeptEntryId) ?? mapped.firstKeptEntryId;
    if (mapped.type === "branch_summary" && mapped.fromId) mapped.fromId = ids.get(mapped.fromId) ?? mapped.fromId;
    return mapped;
  });
  // The generation ID is persisted in the parent's side state. Reuse it as
  // the side session/Bash owner identity when rebuilding ephemeral RPC files.
  return { ...ref, header: { ...manager.getHeader()!, id: sessionId }, entries };
}

function userText(message: AgentMessage | undefined): string | undefined {
  if (message?.role !== "user") return undefined;
  return typeof message.content === "string" ? message.content
    : message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
}

type SavedGeneration = Pick<Generation, "id" | "title" | "createdAt" | "lastUsedAt" | "reference" | "entries" | "leafId"
  | "draft" | "running" | "error" | "pendingPrompt" | "pendingAfter">;

function preview(g: Generation): string {
  return g.messages.filter(message => message.role === "user" || message.role === "assistant").slice(-6).map(message => {
    const content = typeof message.content === "string" ? message.content
      : message.content.filter(block => block.type === "text").map(block => block.text).join("");
    return `${message.role === "user" ? "You" : "Assistant"}: ${content.slice(0, 2000)}`;
  }).join("\n\n");
}

function refreshMessages(g: Generation): void {
  g.messages = g.entries.flatMap(sessionEntryToContextMessages).filter((message) => message.role !== "system");
  if (g.pendingPrompt) {
    // Keep an accepted prompt visible even if the child dies before persisting it.
    const after = g.pendingAfter ? g.entries.findIndex((entry) => entry.id === g.pendingAfter) : -1;
    const persisted = g.entries.slice(after + 1).some((entry) =>
      entry.type === "message" && userText(entry.message) === g.pendingPrompt);
    if (persisted) g.pendingPrompt = undefined;
    else g.messages.push({ role: "user", content: g.pendingPrompt, timestamp: Date.now() });
  }
}

export default function sideExtension(pi: ExtensionAPI) {
  if (process.env.PI_SIDE_AGENT === "1" || process.env.PI_SPAWN_AGENT === "1") return;
  let current: Generation | undefined;
  let conversations = new Map<string, Generation>();
  let transition: Promise<void> | undefined;
  let shuttingDown = false;
  let storageError: string | undefined;
  let titles = new AbortController();

  function latest(): Generation[] {
    return [...conversations.values()].sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt)
      || Number(b === current) - Number(a === current));
  }

  function generateTitle(g: Generation): void {
    if (g.title) return;
    const prompt = g.messages.map(userText).find(text => text?.trim());
    if (!prompt) return;
    g.title = deterministicTitle(prompt);
    state(g);
    const signal = titles.signal;
    void modelTitle(prompt, g.ctx, signal).then(label => {
      if (signal.aborted || conversations.get(g.id) !== g || !owns(g)) return;
      g.title = label.title;
      state(g);
      if (current) publish(current);
    }).catch(error => {
      if (!signal.aborted && conversations.get(g.id) === g) {
        g.ctx.ui.notify(`Could not generate side chat title: ${String(error)}`, "warning");
      }
    });
  }

  function owns(g: Generation): boolean {
    return g.ctx.sessionManager.getSessionId() === g.parentSessionId;
  }

  function state(g: Generation): void {
    if (storageError || !current || conversations.get(g.id) !== g || !owns(g)
      || !g.parentSessionFile || !existsSync(g.parentSessionFile)) return;
    const path = `${g.parentSessionFile}.side.json`;
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      const saved: SavedGeneration[] = [...conversations.values()].map(chat => ({
        id: chat.id, title: chat.title, createdAt: chat.createdAt, lastUsedAt: chat.lastUsedAt,
        reference: chat.reference, entries: chat.entries, leafId: chat.leafId, draft: chat.draft,
        running: chat.running, error: chat.error, pendingPrompt: chat.pendingPrompt, pendingAfter: chat.pendingAfter,
      }));
      writeFileSync(temporary, JSON.stringify({ version: 3, parentSessionFile: g.parentSessionFile,
        parentSessionId: g.parentSessionId, currentId: current.id, conversations: saved }),
        { mode: 0o600, flag: "wx" });
      renameSync(temporary, path);
      g.persisted = true;
    } finally { rmSync(temporary, { force: true }); }
  }

  function publish(g: Generation): void {
    if (g !== current || shuttingDown || g.ctx.mode !== "rpc") return;
    // The frontend already coalesces streaming snapshots. Do not add another
    // timer before the owner can even observe a side update.
    const permissions = permissionSnapshot(g.entries);
    if (!g.running) {
      for (const tool of g.tools) if (tool.state === "running") tool.state = "interrupted";
      permissions.items = permissions.items.map(item => item.state === "pending"
        ? { ...item, state: "cancelled", reason: "Side conversation stopped without a recorded permission decision." } : item);
    }
    g.ctx.ui.setStatus("pi-side", JSON.stringify({
      parentSessionFile: g.parentSessionFile,
      id: g.id,
      title: g.title,
      conversations: latest().map(chat => ({ id: chat.id, title: chat.title || "New side chat",
        createdAt: chat.createdAt, lastUsedAt: chat.lastUsedAt, running: chat.running, preview: preview(chat) })),
      capturedAt: g.reference?.source.capturedAt,
      messages: g.messages,
      tools: g.tools,
      messageKeys: g.messages.map(messageKey),
      permissions,
      partialMessage: g.partialMessage,
      running: g.running,
      draft: g.draft,
      error: g.error,
      activity: g.activity,
      dialogIds: [...g.dialogIds],
    }));
  }

  function failure(g: Generation, error: unknown): void {
    g.error = error instanceof Error ? error.message : String(error);
    publish(g);
  }

  function addEntries(g: Generation, entries: SessionEntry[], leafId: string | null): void {
    const known = new Set(g.entries.map((entry) => entry.id));
    const delta = entries.filter((entry) => !known.has(entry.id));
    if (delta.length || leafId !== g.leafId) {
      g.entries.push(...delta);
      g.leafId = leafId;
      state(g);
    }
    refreshMessages(g);
  }

  function drain(g: Generation): Promise<void> {
    const next = g.drain.then(async () => {
      if (!g.child) return;
      // message_end is emitted before SessionManager appends that message.
      await new Promise<void>((resolve) => setImmediate(resolve));
      const data = await g.child.request<{ entries: SessionEntry[]; leafId: string | null }>({
        type: "get_entries", since: g.entries.at(-1)?.id ?? g.reference?.boundary,
      });
      addEntries(g, data.entries, data.leafId);
    });
    g.drain = next.catch((error) => failure(g, error));
    return next;
  }

  function recoverFile(g: Generation): void {
    if (!g.file) return;
    try {
      const lines = readFileSync(g.file, "utf8").trimEnd().split("\n");
      const entries: SessionEntry[] = [];
      for (const line of lines.slice(1)) {
        try { entries.push(JSON.parse(line) as SessionEntry); }
        catch { break; } // A killed child can leave a partial final line.
      }
      const boundary = entries.findIndex(entry => entry.id === g.reference?.boundary);
      if (boundary < 0) throw new Error("Missing side context boundary");
      addEntries(g, entries.slice(boundary + 1), entries.at(-1)?.id ?? g.leafId);
    } catch (error) {
      failure(g, `Unable to recover side transcript: ${String(error)}`);
    }
  }

  async function relay(g: Generation, child: SideRpc, request: RpcExtensionUIRequest): Promise<void> {
    if (request.method !== "select" && request.method !== "confirm"
      && request.method !== "input" && request.method !== "editor") return;
    const tag = serviceDialogTag(request.title);
    const controller = new AbortController();
    if (tag) g.dialogControllers.set(tag.id, controller);
    const signal = AbortSignal.any([g.dialogs.signal, controller.signal]);
    const valid = () => current === g && g.child === child && !g.cancelled && !signal.aborted && !shuttingDown;
    const respond = (data: { cancelled: true } | { confirmed: boolean } | { value: string }) => child.respond({
      type: "extension_ui_response", id: request.id, ...data,
    } as RpcExtensionUIResponse);
    if (!valid()) {
      if (tag) g.dialogControllers.delete(tag.id);
      respond({ cancelled: true });
      return;
    }
    const dialogId = randomUUID();
    let title: Record<string, unknown>;
    try { title = JSON.parse(request.title); }
    catch { title = { kind: "pi_side_dialog", title: `Side: ${request.title}` }; }
    if (!title || typeof title !== "object" || Array.isArray(title)) {
      title = { kind: "pi_side_dialog", title: `Side: ${request.title}` };
    }
    // The child cannot publish desktop notifications (PI_SPAWN_AGENT), so the parent
    // notifies here. notify:false keeps the generic prompt handler from adding another.
    const taggedTitle = JSON.stringify({ ...title, notify: false, sideDialogId: dialogId, sideConversationId: g.id });
    g.dialogIds.add(dialogId);
    publish(g);
    notifyPiNeedsInput(g.ctx, title.kind === "pi_approval_preview" ? "Pi side chat: Tool Approval" : "Pi side chat needs input");
    try {
      let value: string | boolean | undefined;
      // Managed children publish closure themselves; do not restart their timer
      // in the parent relay. Legacy children keep their existing timeout behavior.
      const opts = { signal, timeout: !tag && "timeout" in request ? request.timeout : undefined };
      switch (request.method) {
        case "select": value = await serviceUi(g.ctx).select(taggedTitle, request.options, opts); break;
        case "confirm": value = await serviceUi(g.ctx).confirm(taggedTitle, request.message, opts); break;
        case "input": value = await serviceUi(g.ctx).input(taggedTitle, request.placeholder, opts); break;
        case "editor": value = await serviceUi(g.ctx, signal).editor(taggedTitle, request.prefill); break;
      }
      if (!valid() || value === undefined) respond({ cancelled: true });
      else if (request.method === "confirm") respond({ confirmed: value === true });
      else respond({ value: String(value) });
    } catch (error) {
      respond({ cancelled: true });
      if (valid()) failure(g, `Side dialog failed: ${String(error)}`);
    } finally {
      if (tag) g.dialogControllers.delete(tag.id);
      g.dialogIds.delete(dialogId);
      publish(g);
    }
  }

  function event(g: Generation, child: SideRpc, data: SideRpcEvent): void {
    if (g.child !== child) return;
    if (data.type === "extension_ui_request") {
      if (data.method === "setStatus" && data.statusKey === SERVICE_DIALOG_STATUS && typeof data.statusText === "string") {
        try {
          const status: unknown = JSON.parse(data.statusText);
          if (status && typeof status === "object" && "state" in status && status.state === "closed"
            && "id" in status && typeof status.id === "string") g.dialogControllers.get(status.id)?.abort();
        } catch { /* A malformed status cannot authorize a reply. */ }
        return;
      }
      void relay(g, child, data as unknown as RpcExtensionUIRequest);
      return;
    }
    if (data.type === "entry_appended" && (data.entry as SessionEntry)?.type === "custom"
      && (data.entry as { customType?: string }).customType === PERMISSION_HISTORY) {
      void drain(g).then(() => publish(g), () => undefined);
    } else if (data.type === "message_start" && (data.message as AgentMessage)?.role === "assistant") {
      g.partialMessage = data.message as AgentMessage;
      publish(g);
    } else if (data.type === "message_update") {
      if (data.message) g.partialMessage = data.message as AgentMessage;
      else if (g.partialMessage) updateSidePartial(g.partialMessage as unknown as SideRpcEvent, data);
      publish(g);
    } else if (data.type === "message_end") {
      const message = data.message as AgentMessage;
      g.partialMessage = undefined;
      if (message.role === "assistant") g.stopReason = message.stopReason;
      if (message.role !== "system") {
        // The canonical drain replaces this optimistic view after persistence.
        if (g.pendingPrompt && userText(message) === g.pendingPrompt) {
          if (userText(g.messages.at(-1)) === g.pendingPrompt) g.messages.pop();
          g.pendingPrompt = undefined;
        }
        g.messages.push(message);
      }
      publish(g);
      void drain(g).then(() => publish(g), () => undefined);
    } else if (data.type === "tool_execution_start") {
      const { type: _type, ...tool } = data as ToolStart;
      g.tools = g.tools.filter(previous => previous.toolCallId !== tool.toolCallId);
      if (g.tools.length >= 256) {
        const completed = g.tools.findIndex(previous => previous.state !== "running");
        if (completed !== -1) g.tools.splice(completed, 1);
      }
      const parent = tool.parentToolCallId && g.tools.find(previous => previous.toolCallId === tool.parentToolCallId);
      const message = [...g.messages].reverse().find(message => message.role === "assistant"
        && message.content.some(block => block.type === "toolCall" && block.id === tool.toolCallId));
      g.tools.push({ ...tool, state: "running", startedAt: new Date().toISOString(),
        messageKey: parent ? parent.messageKey : message && messageKey(message) });
      g.activity = `Running ${tool.toolName}`;
      publish(g);
    } else if (data.type === "tool_execution_update" || data.type === "tool_execution_end") {
      const tool = g.tools.find(tool => tool.toolCallId === data.toolCallId);
      if (tool) {
        if (data.type === "tool_execution_update") {
          tool.partialResult = data.partialResult as SideTool["partialResult"];
        } else {
          tool.state = "completed";
          tool.partialResult = undefined;
          tool.result = data.result as ToolEnd["result"];
          tool.isError = data.isError === true;
        }
      }
      g.activity = g.tools.some(tool => tool.state === "running") ? g.activity : undefined;
      publish(g);
    } else if (data.type === "agent_settled") {
      void drain(g).then(() => {
        g.running = false;
        g.partialMessage = undefined;
        g.activity = undefined;
        state(g);
        publish(g);
        // User aborts and stale or replaced side chats need no alert.
        if (current === g && owns(g) && !g.cancelled && g.stopReason && g.stopReason !== "aborted") {
          if (g.stopReason === "error") notifyPiOutcome(g.ctx, "Pi side chat error", "error");
          else notifyPiOutcome(g.ctx, "Pi side chat finished", "completion");
        }
        g.stopReason = undefined;
      }, (error) => {
        g.running = false;
        failure(g, error);
        state(g);
      });
    } else if (data.type === "extension_error") {
      failure(g, `Side extension error: ${String(data.error)}`);
    }
  }

  function ensureChild(g: Generation): Promise<SideRpc> {
    if (g.ready) return g.ready;
    g.ready = (async () => {
      if (!g.reference) {
        g.reference = reference(g.ctx, pi);
        g.leafId = g.reference.boundary;
        state(g);
      }
      const seed = materialize(g.ctx, g.reference, g.id);
      g.directory = mkdtempSync(join(tmpdir(), "pi-side-"));
      g.file = join(g.directory, "session.jsonl");
      writeFileSync(g.file, [seed.header, ...seed.entries, ...g.entries].map((entry) => JSON.stringify(entry)).join("\n") + "\n", { mode: 0o600 });
      const promptFile = join(g.directory, "system-prompt.md");
      writeFileSync(promptFile, `${g.reference.source.systemPrompt}\n\nYou are answering an independent side conversation. The earlier conversation is a fixed snapshot for reference. Do not resume its task or assume its tools are available: use only your currently declared tools. Act only on requests in this side conversation. Your access mode is fixed to ask; request approval for writes and additional shell capabilities. Side answers are not sent to the main agent.\n`, { mode: 0o600 });
      const args = ["--mode", "rpc", "--session", g.file, "--no-approve", "--no-context-files", "--system-prompt", promptFile,
        "-e", join(dirname(fileURLToPath(import.meta.url)), "access-mode.ts"),
        "-e", join(dirname(fileURLToPath(import.meta.url)), "service.ts"),
        "-e", "builtin:codemode", "-e", "builtin:tool-search", "--tools", "read,bash,bash_control,edit,write,grep,find,ls,codemode,tool_search"];
      if (g.reference.source.model) args.push("--provider", g.reference.source.model.provider, "--model", g.reference.source.model.id);
      args.push("--thinking", g.reference.source.thinkingLevel);
      const child: SideRpc = new SideRpc(args, g.reference.source.cwd, (data) => event(g, child, data), (error) => {
        if (g.child !== child) return;
        g.dialogs.abort();
        recoverFile(g);
        g.running = false;
        g.partialMessage = undefined;
        g.activity = undefined;
        failure(g, error);
        state(g);
        // Never restart and replay a possibly executed prompt automatically.
      });
      g.child = child;
      await child.request({ type: "get_state" });
      await drain(g);
      g.initialized = true;
      return child;
    })();
    return g.ready;
  }

  async function abort(g: Generation): Promise<void> {
    g.cancelled = true;
    g.dialogs.abort();
    g.dialogIds.clear();
    publish(g);
    if (g.child && !g.initialized) {
      await g.child.stop();
      recoverFile(g);
    } else if (g.ready) {
      const child = await g.ready;
      await child.request({ type: "clear_queue" });
      await child.request({ type: "abort" });
      await drain(g);
    }
    g.running = false;
    g.partialMessage = undefined;
    g.activity = undefined;
    state(g);
    publish(g);
  }

  async function retire(g: Generation): Promise<void> {
    if (!g.persisted && !g.child) return;
    g.cancelled = true;
    g.dialogs.abort();
    g.dialogIds.clear();
    publish(g);
    // EOF requests orderly shutdown. Stop also escalates if initialization or a
    // dialog is stuck; waiting for get_state/abort first could otherwise deadlock.
    await g.child?.stop();
    await g.work;
    await g.drain;
    recoverFile(g);
    g.running = false;
    g.partialMessage = undefined;
    state(g);
    // Only transcript/prompt materialization is ephemeral. Side Bash artifacts
    // live under the parent-bound durable owner directory, not this directory.
    if (g.directory) rmSync(g.directory, { recursive: true, force: true });
    g.child = undefined;
    g.ready = undefined;
    g.initialized = undefined;
    g.work = undefined;
    g.directory = undefined;
    g.file = undefined;
    g.tools = [];
    g.activity = undefined;
    g.dialogs = new AbortController();
    g.drain = Promise.resolve();
  }

  function fresh(ctx: ExtensionContext, ref?: Reference): Generation {
    return {
      id: randomUUID(), ctx, createdAt: new Date().toISOString(), lastUsedAt: new Date().toISOString(),
      parentSessionFile: ctx.sessionManager.getSessionFile() ?? "",
      parentSessionId: ctx.sessionManager.getSessionId(),
      reference: ref, entries: [], leafId: ref?.boundary ?? null,
      messages: [], tools: [], draft: "", running: false, persisted: false,
      cancelled: false, dialogs: new AbortController(), dialogIds: new Set(), dialogControllers: new Map(), drain: Promise.resolve(),
    };
  }

  function restore(ctx: ExtensionContext): Generation {
    let g = fresh(ctx);
    const path = g.parentSessionFile && `${g.parentSessionFile}.side.json`;
    if (path && existsSync(path)) {
      try {
        const saved = JSON.parse(readFileSync(path, "utf8")) as SavedGeneration & {
          version: number; parentSessionId: string; parentSessionFile: string; currentId?: string; conversations?: SavedGeneration[];
        };
        if (![2, 3].includes(saved.version) || saved.parentSessionId !== g.parentSessionId || saved.parentSessionFile !== g.parentSessionFile
          || saved.version === 3 && (!Array.isArray(saved.conversations) || !saved.conversations.length)) {
          throw new Error("Invalid side conversation state");
        }
        const restored = new Map<string, Generation>();
        for (const item of saved.version === 2 ? [saved] : saved.conversations!) {
          if (!item || typeof item.id !== "string" || !/^[\w-]{1,128}$/.test(item.id) || restored.has(item.id)
            || !Array.isArray(item.entries) || typeof item.draft !== "string"
            || item.entries.some(entry => !entry || typeof entry.id !== "string")
            || item.title !== undefined && typeof item.title !== "string"
            || item.reference?.inheritedIds && (!Array.isArray(item.reference.inheritedIds)
              || item.reference.inheritedIds.some(id => typeof id !== "string"))
            || item.reference && (typeof item.reference.boundary !== "string" || !item.reference.source
              || typeof item.reference.source.systemPrompt !== "string"
              || item.reference.source.leafId !== null && typeof item.reference.source.leafId !== "string")) {
            throw new Error("Invalid saved side chat");
          }
          const createdAt = typeof item.createdAt === "string" ? item.createdAt : item.reference?.source.capturedAt || g.createdAt;
          const chat = { ...fresh(ctx), id: item.id, title: item.title, createdAt,
            lastUsedAt: typeof item.lastUsedAt === "string" ? item.lastUsedAt : createdAt,
            reference: item.reference, entries: item.entries, leafId: item.leafId, draft: item.draft,
            running: false, error: item.running ? "Side conversation was interrupted; no prompt was replayed." : item.error,
            pendingPrompt: item.pendingPrompt, pendingAfter: item.pendingAfter, persisted: true };
          refreshMessages(chat);
          restored.set(chat.id, chat);
        }
        conversations = restored;
        g = conversations.get(saved.version === 2 ? saved.id : saved.currentId ?? "") ?? latest()[0];
      } catch (error) {
        storageError = `Unable to restore side chats: ${String(error)}. Saved state was left unchanged: ${path}`;
        g.error = storageError;
        return g;
      }
    } else {
      // Legacy journal migration reads only its last generation. Never rewrite the
      // main history file; subsequent saves replace the separate current state.
      for (const entry of ctx.sessionManager.getEntries()) {
        if (entry.type !== "custom" || entry.customType !== JOURNAL || !entry.data) continue;
        const data = entry.data as JournalRecord;
        if (data.version !== 1 || data.parentSessionFile !== g.parentSessionFile || data.parentSessionId !== g.parentSessionId) continue;
        if (data.kind === "start") {
          g = fresh(ctx, data.seed && { source: data.seed.source, boundary: data.seed.boundary,
            inheritedIds: data.seed.entries.map(entry => entry.id) });
          g.id = data.id;
          if (data.seed) {
            const boundary = data.seed.entries.findIndex(entry => entry.id === data.seed!.boundary);
            g.entries = data.seed.entries.slice(boundary + 1);
          }
          g.persisted = true;
        } else if (data.id === g.id) {
          if (data.kind === "seed") {
            g.reference = { source: data.seed.source, boundary: data.seed.boundary,
              inheritedIds: data.seed.entries.map(entry => entry.id) };
            const boundary = data.seed.entries.findIndex(entry => entry.id === data.seed.boundary);
            g.entries = data.seed.entries.slice(boundary + 1);
            g.leafId = data.seed.boundary;
          } else if (data.kind === "entries") {
            g.entries.push(...data.entries);
            g.leafId = data.leafId;
          } else if (data.kind === "draft") g.draft = data.draft;
          else if (data.kind === "state") {
            g.running = data.running;
            g.pendingPrompt = data.pendingPrompt;
            g.pendingAfter = data.pendingAfter;
            g.error = data.error;
          }
        }
      }
    }
    if (g.running) {
      g.running = false;
      g.error = "Side conversation was interrupted. Its finalized transcript was restored; no prompt was replayed.";
    }
    refreshMessages(g);
    conversations.set(g.id, g);
    return g;
  }

  pi.on("session_start", (_event, ctx) => {
    shuttingDown = false;
    storageError = undefined;
    conversations.clear();
    titles = new AbortController();
    current = restore(ctx);
    if (current.persisted || current.reference) state(current);
    generateTitle(current);
    publish(current);
  });

  pi.on("session_shutdown", async () => {
    shuttingDown = true;
    titles.abort();
    // Start bounded child shutdown before an in-flight abort/transition can
    // wait indefinitely for an RPC response from that same child.
    const stopping = current?.child?.stop();
    void stopping?.catch(() => undefined);
    await transition;
    await stopping;
    if (current) await retire(current);
    current = undefined;
  });

  const sideAction = async (args: string, ctx: import("@earendil-works/pi-coding-agent").ExtensionCommandContext): Promise<{ disposition: "accepted" } | undefined> => {
      if (ctx.mode !== "rpc") {
        ctx.ui.notify("Side conversations are controlled through the pi-console frontend.", "warning");
        return;
      }
      let request: { action: string; id?: string; fromId?: string; abort?: boolean;
        message?: string; draft?: string; requestId?: string; parentSessionFile?: string };
      try {
        request = JSON.parse(args);
        if (!request || !["open", "prompt", "reset", "abort", "draft", "select", "delete"].includes(request.action)) throw new Error("Invalid action");
      } catch {
        ctx.ui.notify('Usage: /pi-side {"action":"open|prompt|reset|abort|draft|select|delete","message":"...","draft":"..."}', "warning");
        return;
      }
      const reply = (success: boolean, error?: string) => {
        ctx.ui.setStatus("pi-side-response", JSON.stringify({
          parentSessionFile: ctx.sessionManager.getSessionFile() ?? "",
          requestId: request.requestId, success, error,
        }));
        return success ? { disposition: "accepted" as const } : undefined;
      };
      const reject = (error: string) => { ctx.ui.notify(error, "warning"); reply(false, error); };
      if (shuttingDown) { reject("Pi is shutting down."); return; }
      if (storageError) { reject(storageError); return; }
      if (request.parentSessionFile !== undefined && request.parentSessionFile !== ctx.sessionManager.getSessionFile()) {
        reject("The parent session changed; the side action was not applied.");
        return;
      }
      const g = current ??= restore(ctx);
      g.ctx = ctx;
      if (transition) { reject("Side conversation is stopping or switching chats."); return; }
      if (request.action === "open") {
        g.lastUsedAt = new Date().toISOString();
        state(g);
        generateTitle(g);
        publish(g);
        return reply(true);
      }
      if (["prompt", "draft", "abort"].includes(request.action) && request.id !== g.id
        || ["reset", "select"].includes(request.action) && request.fromId !== g.id) {
        reject("The side chat changed; the action was not applied."); return;
      }
      if (request.action === "delete") {
        const target = request.id && conversations.get(request.id);
        if (!target) { reject("Side chat no longer exists."); return; }
        if (target.running) { reject("Abort the side chat before deleting it."); return; }
        transition = (async () => {
          await retire(target);
          conversations.delete(target.id);
          if (current === target) {
            current = latest()[0] ?? fresh(ctx);
            conversations.set(current.id, current);
          }
          state(current!);
          publish(current!);
        })().finally(() => { transition = undefined; });
        await transition;
        return reply(true);
      }
      if (request.action === "reset" || request.action === "select") {
        if (request.action === "select" && request.id === g.id) return reply(true);
        if (g.running && request.abort !== true) { reject("Confirm aborting the running side chat before moving."); return; }
        if (!existsSync(g.parentSessionFile)) { reject("Send a main prompt first so side chats have a saved parent session."); return; }
        const next = request.action === "reset" ? fresh(ctx, reference(ctx, pi)) : request.id && conversations.get(request.id);
        if (!next) { reject("Side chat no longer exists."); return; }
        // Capture a new chat's main context before waiting for child shutdown.
        transition = (async () => {
          await retire(g);
          if (shuttingDown) return;
          current = next;
          next.ctx = ctx;
          next.lastUsedAt = new Date().toISOString();
          conversations.set(next.id, next);
          state(next);
          generateTitle(next);
          publish(next);
        })().finally(() => { transition = undefined; });
        await transition;
        return reply(true);
      }
      if (request.action === "draft") {
        if (typeof request.draft !== "string" || Buffer.byteLength(request.draft) > 1024 * 1024) {
          reject("Side draft must be a string no larger than 1 MiB."); return;
        }
        if (g.draft !== request.draft) {
          g.draft = request.draft;
          state(g);
        }
        publish(g);
        return reply(true);
      }
      if (!existsSync(g.parentSessionFile)) {
        reject("Send a main prompt first so the side conversation has a saved parent session.");
        return;
      }
      if (request.action === "abort") {
        g.activity = "Stopping side conversation";
        publish(g);
        transition = abort(g).catch((error) => failure(g, error)).finally(() => { transition = undefined; });
        return reply(true);
      }
      if (g.reference?.source.leafId && !ctx.sessionManager.getEntry(g.reference.source.leafId)) {
        reject("This side chat's main context was deleted. Start a new side chat; its history is still available here."); return;
      }
      if (g.running) { reject("Side conversation is busy; the prompt was not queued."); return; }
      if (g.pendingPrompt || g.child?.stopped) {
        reject("The previous side request was interrupted or could not start. Use :PiSideNew before sending another prompt.");
        return;
      }
      if (typeof request.message !== "string" || !request.message.trim()) { reject("Side prompt must not be empty."); return; }
      const message = request.message;
      g.cancelled = false;
      g.stopReason = undefined;
      g.dialogs = new AbortController();
      g.error = undefined;
      g.running = true;
      g.activity = "Starting side conversation";
      g.draft = "";
      g.pendingPrompt = message;
      g.pendingAfter = g.entries.at(-1)?.id ?? g.reference?.boundary;
      state(g);
      refreshMessages(g);
      generateTitle(g);
      publish(g);
      reply(true);
      // Do not await the independent run in the parent's RPC command handler.
      g.work = (async () => {
        try {
          const child = await ensureChild(g);
          if (g.cancelled) return;
          g.activity = undefined;
          const result = await child.request<{ disposition: string }>({ type: "prompt", message });
          await drain(g);
          if (result.disposition === "handled") {
            g.pendingPrompt = undefined;
            g.running = false;
            refreshMessages(g);
          }
          state(g);
          publish(g);
        } catch (error) {
          g.running = false;
          g.activity = undefined;
          failure(g, error);
          state(g);
        }
      })();
      return { disposition: "accepted" as const };
  };
  pi.registerCommand("pi-side", { description: "Control ask-mode side chats (JSON: open, prompt, reset, select, delete, abort, draft).",
    handler: async (args, ctx) => { await sideAction(args, ctx); } });
  for (const operation of ["side.open", "side.prompt", "side.draft", "side.reset", "side.abort", "side.select", "side.delete"] as const) {
    registerServiceOperation(pi, operation, (payload, ctx) => sideAction(JSON.stringify({
      ...payload,
      action: operation.slice(5),
      message: operation === "side.prompt" && "text" in payload ? payload.text : undefined,
      draft: operation === "side.draft" && "text" in payload ? payload.text : undefined,
      parentSessionFile: ctx.sessionManager.getSessionFile(),
    }), ctx));
  }
}
