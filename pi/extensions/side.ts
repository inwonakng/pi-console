import { registerServiceOperation } from "./shared/service-operation";
import { SERVICE_DIALOG_STATUS, serviceDialogTag, serviceUi } from "./shared/service-ui";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  SessionManager,
  sessionEntryToContextMessages,
  type ExtensionAPI,
  type ExtensionContext,
  type RpcExtensionUIRequest,
  type RpcExtensionUIResponse,
  type SessionEntry,
  type SessionHeader,
} from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { messageKey, PERMISSION_HISTORY, permissionSnapshot } from "../scripts/permission-history.mjs";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SideRpc, updateSidePartial, type SideRpcEvent } from "./shared/side-rpc";

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

type Seed = { source: Source; header: SessionHeader; entries: SessionEntry[]; boundary: string };
type RecordBase = { version: 1; parentSessionFile: string; parentSessionId: string; id: string };
type JournalData =
  | { kind: "start"; seed?: Seed }
  | { kind: "seed"; seed: Seed }
  | { kind: "entries"; entries: SessionEntry[]; leafId: string | null }
  | { kind: "draft"; draft: string }
  | { kind: "state"; running: boolean; error?: string; pendingPrompt?: string; pendingAfter?: string };
type JournalRecord = RecordBase & JournalData;

type Generation = {
  id: string;
  ctx: ExtensionContext;
  parentSessionFile: string;
  parentSessionId: string;
  seed?: Seed;
  entries: SessionEntry[];
  leafId: string | null;
  messages: AgentMessage[];
  partialMessage?: AgentMessage;
  draft: string;
  pendingPrompt?: string;
  pendingAfter?: string;
  running: boolean;
  error?: string;
  activity?: string;
  journaled: boolean;
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
  publishTimer?: NodeJS.Timeout;
};

function snapshot(ctx: ExtensionContext, pi: ExtensionAPI): Seed {
  const source: Source = {
    capturedAt: new Date().toISOString(),
    cwd: ctx.cwd,
    leafId: ctx.sessionManager.getLeafId(),
    model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
    thinkingLevel: pi.getThinkingLevel(),
    systemPrompt: ctx.getSystemPrompt(),
  };
  const manager = SessionManager.inMemory(source.cwd, { parentSession: ctx.sessionManager.getSessionFile() });
  // Projection contains only finalized, effective context, including context edits.
  for (const message of structuredClone(ctx.sessionManager.buildSessionProjection().messages)) {
    if (message.role === "compactionSummary") manager.appendCompaction(message.summary, null, message.tokensBefore);
    else if (message.role === "branchSummary") manager.branchWithSummary(manager.getLeafId(), message.summary);
    else manager.appendMessage(message);
  }
  if (source.model) manager.appendModelChange(source.model.provider, source.model.id);
  manager.appendThinkingLevelChange(source.thinkingLevel);
  const boundary = manager.appendCustomEntry(BOUNDARY, { capturedAt: source.capturedAt });
  return { source, header: manager.getHeader()!, entries: manager.getEntries(), boundary };
}

function userText(message: AgentMessage | undefined): string | undefined {
  if (message?.role !== "user") return undefined;
  return typeof message.content === "string" ? message.content
    : message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
}

function refreshMessages(g: Generation): void {
  const boundary = g.seed ? g.entries.findIndex((entry) => entry.id === g.seed!.boundary) : -1;
  g.messages = boundary < 0 ? [] : g.entries.slice(boundary + 1)
    .flatMap(sessionEntryToContextMessages).filter((message) => message.role !== "system");
  if (g.pendingPrompt) {
    // Keep an accepted prompt visible even if the child dies before persisting it.
    const after = g.pendingAfter ? g.entries.findIndex((entry) => entry.id === g.pendingAfter) : boundary;
    const persisted = g.entries.slice(Math.max(boundary, after) + 1).some((entry) =>
      entry.type === "message" && userText(entry.message) === g.pendingPrompt);
    if (persisted) g.pendingPrompt = undefined;
    else g.messages.push({ role: "user", content: g.pendingPrompt, timestamp: Date.now() });
  }
}

export default function sideExtension(pi: ExtensionAPI) {
  if (process.env.PI_SIDE_AGENT === "1" || process.env.PI_SPAWN_AGENT === "1") return;
  let current: Generation | undefined;
  let transition: Promise<void> | undefined;
  let shuttingDown = false;

  function owns(g: Generation): boolean {
    return g.ctx.sessionManager.getSessionId() === g.parentSessionId;
  }

  function record(g: Generation, data: JournalData): void {
    if (!owns(g)) return;
    pi.appendEntry(JOURNAL, {
      version: 1,
      parentSessionFile: g.parentSessionFile,
      parentSessionId: g.parentSessionId,
      id: g.id,
      ...data,
    });
  }

  function startJournal(g: Generation): void {
    if (g.journaled) return;
    record(g, { kind: "start", seed: g.seed });
    g.journaled = true;
  }

  function state(g: Generation): void {
    startJournal(g);
    record(g, { kind: "state", running: g.running, error: g.error, pendingPrompt: g.pendingPrompt, pendingAfter: g.pendingAfter });
  }

  function publish(g: Generation, immediate = true): void {
    if (g !== current || shuttingDown || g.ctx.mode !== "rpc") return;
    if (!immediate) {
      g.publishTimer ??= setTimeout(() => { g.publishTimer = undefined; publish(g); }, 100);
      return;
    }
    if (g.publishTimer) clearTimeout(g.publishTimer);
    g.publishTimer = undefined;
    const permissions = permissionSnapshot(g.entries);
    if (!g.running) permissions.items = permissions.items.map(item => item.state === "pending"
      ? { ...item, state: "cancelled", reason: "Side conversation stopped without a recorded permission decision." } : item);
    g.ctx.ui.setStatus("pi-side", JSON.stringify({
      parentSessionFile: g.parentSessionFile,
      id: g.id,
      capturedAt: g.seed?.source.capturedAt,
      messages: g.messages,
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
      record(g, { kind: "entries", entries: delta, leafId });
      g.entries.push(...delta);
      g.leafId = leafId;
    }
    refreshMessages(g);
  }

  function drain(g: Generation): Promise<void> {
    const next = g.drain.then(async () => {
      if (!g.child) return;
      // message_end is emitted before SessionManager appends that message.
      await new Promise<void>((resolve) => setImmediate(resolve));
      const data = await g.child.request<{ entries: SessionEntry[]; leafId: string | null }>({
        type: "get_entries", since: g.entries.at(-1)?.id,
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
      addEntries(g, entries, entries.at(-1)?.id ?? g.leafId);
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
    // The child owns notifications (including question deduplication and approval
    // titles). Relaying its dialog must not send a second notification in the parent.
    const taggedTitle = JSON.stringify({ ...title, notify: false, sideDialogId: dialogId, sideConversationId: g.id });
    g.dialogIds.add(dialogId);
    publish(g);
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
      if (process.env.PI_CONSOLE_SERVICE === "1" && current === g && !g.cancelled
        && data.method === "setStatus" && data.statusKey === "pi-desktop-notification" && typeof data.statusText === "string") {
        try {
          const intent = JSON.parse(data.statusText);
          if (intent && typeof intent === "object") g.ctx.ui.setStatus("pi-desktop-notification", JSON.stringify({ ...intent, sideConversationId: g.id }));
        } catch { /* Invalid child effects never become parent actions. */ }
        return;
      }
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
      publish(g, false);
    } else if (data.type === "message_end") {
      const message = data.message as AgentMessage;
      g.partialMessage = undefined;
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
      g.activity = `Running ${String(data.toolName)}`;
      publish(g);
    } else if (data.type === "tool_execution_end") {
      g.activity = undefined;
      publish(g);
    } else if (data.type === "agent_settled") {
      void drain(g).then(() => {
        g.running = false;
        g.partialMessage = undefined;
        g.activity = undefined;
        state(g);
        publish(g);
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
      if (!g.seed) {
        g.seed = snapshot(g.ctx, pi);
        g.entries = [...g.seed.entries];
        g.leafId = g.entries.at(-1)?.id ?? null;
        startJournal(g);
        record(g, { kind: "seed", seed: g.seed });
      }
      g.directory = mkdtempSync(join(tmpdir(), "pi-side-"));
      g.file = join(g.directory, "session.jsonl");
      writeFileSync(g.file, [g.seed.header, ...g.entries].map((entry) => JSON.stringify(entry)).join("\n") + "\n", { mode: 0o600 });
      const promptFile = join(g.directory, "system-prompt.md");
      writeFileSync(promptFile, `${g.seed.source.systemPrompt}\n\nYou are answering an independent side conversation. The earlier conversation is a fixed snapshot for reference. Do not resume its task or assume its tools are available: use only your currently declared tools. Act only on requests in this side conversation. Your access mode is fixed to ask; request approval for writes and additional shell capabilities. Side answers are not sent to the main agent.\n`, { mode: 0o600 });
      const args = ["--mode", "rpc", "--session", g.file, "--no-approve", "--no-context-files", "--system-prompt", promptFile,
        "-e", join(dirname(fileURLToPath(import.meta.url)), "access-mode.ts"),
        "-e", join(dirname(fileURLToPath(import.meta.url)), "service.ts"),
        "-e", "builtin:codemode", "-e", "builtin:tool-search", "--tools", "read,bash,edit,write,grep,find,ls,codemode,tool_search"];
      if (g.seed.source.model) args.push("--provider", g.seed.source.model.provider, "--model", g.seed.source.model.id);
      args.push("--thinking", g.seed.source.thinkingLevel);
      const child: SideRpc = new SideRpc(args, g.seed.source.cwd, (data) => event(g, child, data), (error) => {
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
    if (!g.journaled && !g.child) return;
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
    if (g.publishTimer) clearTimeout(g.publishTimer);
    if (g.directory) rmSync(g.directory, { recursive: true, force: true });
  }

  function fresh(ctx: ExtensionContext, seed?: Seed): Generation {
    return {
      id: randomUUID(), ctx,
      parentSessionFile: ctx.sessionManager.getSessionFile() ?? "",
      parentSessionId: ctx.sessionManager.getSessionId(),
      seed, entries: seed ? [...seed.entries] : [], leafId: seed?.boundary ?? null,
      messages: [], draft: "", running: false, journaled: false,
      cancelled: false, dialogs: new AbortController(), dialogIds: new Set(), dialogControllers: new Map(), drain: Promise.resolve(),
    };
  }

  function restore(ctx: ExtensionContext): Generation {
    let g = fresh(ctx);
    // Deliberately session-wide: /tree does not rewind the side conversation.
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type !== "custom" || entry.customType !== JOURNAL || !entry.data) continue;
      const data = entry.data as JournalRecord;
      if (data.version !== 1 || data.parentSessionFile !== g.parentSessionFile || data.parentSessionId !== g.parentSessionId) continue;
      if (data.kind === "start") {
        g = fresh(ctx, data.seed);
        g.id = data.id;
        g.journaled = true;
      } else if (data.id === g.id) {
        if (data.kind === "seed") {
          g.seed = data.seed;
          g.entries = [...data.seed.entries];
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
    if (g.running) {
      g.running = false;
      g.error = "Side conversation was interrupted. Its finalized transcript was restored; no prompt was replayed.";
    }
    refreshMessages(g);
    return g;
  }

  pi.on("session_start", (_event, ctx) => {
    shuttingDown = false;
    current = restore(ctx);
    publish(current);
  });

  pi.on("session_shutdown", async () => {
    shuttingDown = true;
    // Start bounded child shutdown before an in-flight abort/transition can
    // wait indefinitely for an RPC response from that same child.
    const stopping = current?.child?.stop();
    void stopping?.catch(() => undefined);
    await transition;
    await stopping;
    if (current) await retire(current);
    current = undefined;
  });

  const sideAction = async (args: string, ctx: import("@earendil-works/pi-coding-agent").ExtensionCommandContext) => {
      if (ctx.mode !== "rpc") {
        ctx.ui.notify("Side conversations are controlled through the pi-console frontend.", "warning");
        return;
      }
      let request: { action: string; message?: string; draft?: string; requestId?: string; parentSessionFile?: string };
      try {
        request = JSON.parse(args);
        if (!request || !["open", "prompt", "reset", "abort", "draft"].includes(request.action)) throw new Error("Invalid action");
      } catch {
        ctx.ui.notify('Usage: /pi-side {"action":"open|prompt|reset|abort|draft","message":"...","draft":"..."}', "warning");
        return;
      }
      const reply = (success: boolean, error?: string) => {
        ctx.ui.setStatus("pi-side-response", JSON.stringify({
          parentSessionFile: ctx.sessionManager.getSessionFile() ?? "",
          requestId: request.requestId, success, error,
        }));
        return success ? { disposition: "accepted" as const } : undefined;
      };
      const reject = (error: string) => { reply(false, error); };
      if (shuttingDown) { reject("Pi is shutting down."); return; }
      if (request.parentSessionFile !== undefined && request.parentSessionFile !== ctx.sessionManager.getSessionFile()) {
        reject("The parent session changed; the side action was not applied.");
        return;
      }
      const g = current ??= restore(ctx);
      g.ctx = ctx;
      if (request.action === "open") { publish(g); return reply(true); }
      if (transition) { reject("Side conversation is stopping or starting a new chat."); return; }
      if (request.action === "draft") {
        if (typeof request.draft !== "string" || Buffer.byteLength(request.draft) > 1024 * 1024) {
          reject("Side draft must be a string no larger than 1 MiB."); return;
        }
        if (g.draft !== request.draft) {
          g.draft = request.draft;
          startJournal(g);
          record(g, { kind: "draft", draft: g.draft });
        }
        publish(g);
        return reply(true);
      }
      if (!existsSync(g.parentSessionFile)) {
        reject("Send a main prompt first so the side conversation has a saved parent session.");
        return;
      }
      if (request.action === "reset") {
        // Capture now, before waiting for the old child, even while main streams.
        const next = fresh(ctx, snapshot(ctx, pi));
        g.activity = "Starting new side conversation";
        publish(g);
        transition = retire(g).then(() => {
          current = next;
          startJournal(next);
          publish(next);
        }).catch((error) => failure(g, error)).finally(() => { transition = undefined; });
        return reply(true);
      }
      if (request.action === "abort") {
        g.activity = "Stopping side conversation";
        publish(g);
        transition = abort(g).catch((error) => failure(g, error)).finally(() => { transition = undefined; });
        return reply(true);
      }
      if (g.running) { reject("Side conversation is busy; the prompt was not queued."); return; }
      if (g.pendingPrompt || g.child?.stopped) {
        reject("The previous side request was interrupted or could not start. Use :PiSideNew before sending another prompt.");
        return;
      }
      if (typeof request.message !== "string" || !request.message.trim()) { reject("Side prompt must not be empty."); return; }
      const message = request.message;
      g.cancelled = false;
      g.dialogs = new AbortController();
      g.error = undefined;
      g.running = true;
      g.activity = "Starting side conversation";
      g.draft = "";
      startJournal(g);
      record(g, { kind: "draft", draft: "" });
      g.pendingPrompt = message;
      g.pendingAfter = g.entries.at(-1)?.id;
      state(g);
      refreshMessages(g);
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
  pi.registerCommand("pi-side", { description: "Control the independent ask-mode side conversation (JSON: open, prompt, reset, abort, draft).",
    handler: async (args, ctx) => { await sideAction(args, ctx); } });
  for (const operation of ["side.open", "side.prompt", "side.draft", "side.reset", "side.abort"] as const) {
    registerServiceOperation(pi, operation, (payload, ctx) => sideAction(JSON.stringify({
      action: operation.slice(5),
      message: operation === "side.prompt" && "text" in payload ? payload.text : undefined,
      draft: operation === "side.draft" && "text" in payload ? payload.text : undefined,
      parentSessionFile: ctx.sessionManager.getSessionFile(),
    }), ctx));
  }
}
