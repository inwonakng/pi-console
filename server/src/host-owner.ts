import { open } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { DESKTOP_NOTIFICATION_STATUS, validDesktopNotification, type DesktopNotification } from "../../pi/extensions/shared/desktop-notification.mjs";
import { completeHostFiles } from "./host-discovery.js";
import { tmpdir } from "node:os";
import { WorkspaceReviews, type ReviewMutation } from "./workspace-reviews.js";
import { readResource, completeFiles, completeDirectory, type ResourceContext } from "./resource-reads.js";
import { hostCommand, hostFingerprint, type HostReceipt } from "./host-commands.js";
import { inspectEpoch } from "../../pi/scripts/managed-process.mjs";
import { createHash, randomUUID } from "node:crypto";
import { SavedHelperUnresolved, savedSessionHelper, type SavedPreview, type SavedResult } from "./saved-sessions.js";
import { isAbsolute, join } from "node:path";
import type { RpcCommand, RpcExtensionUIResponse, RpcResponse, RpcSessionState } from "@earendil-works/pi-coding-agent";
import { PiCommandError, PiProcess, type PiExit, type PiProcessOptions } from "./pi-process.js";
import type { InteractionSnapshot } from "./pi-interactions.js";
import { dialogRequest, object, type PiEvent } from "./pi-records.js";
import { PiConversation, messageKey, type ConversationChange, type ConversationSnapshot, type ConversationRevisions, type ConversationSections, type FrontendEffect } from "./pi-conversation.js";
import { SessionSubscription } from "./session-subscription.js";
import { CommandError, SessionControl, commandFingerprint, sessionCommand, type CommandReceipt, type Controller,
  type ControlGrant, type SessionCommand } from "./session-commands.js";
import { managementCommand, managementFingerprint, type ManagementCommand } from "./session-management.js";
import { SessionCatalog, type CatalogSession, type Channel } from "./session-catalog.js";
import { QueueReservations, editableItem, type AcceptedQueueItem, type AcceptedQueueSnapshot } from "./session-queue.js";
import { RENAME_COMMAND, RENAME_RESULT, renameResult, type RenameResult } from "./session-rename.js";
import { prepareHostResources, type HostResources } from "./host-resources.js";
import { readHostOptions, OptionsHelperUnresolved, type HostOptions } from "./host-options.js";
import { isNative, nativeCommand, readCommand, validRead, type NativeOperation } from "./session-operations.js";
import { isBundled, BUNDLED_SOURCES, OPERATION_RESULT, operationCommand, operationResult, type BundledOperation, type OperationResult } from "./session-bundled.js";

type TrustStatus = { state: "pending" | "ready" | "restart" | "error"; cwd: string; sessionFile: string; error?: string };
type WorkspaceStatus = { cwd: string; sessionFile: string; transitionPending: boolean; [key: string]: unknown };
type BundledFlight = {
  worker: PiProcess; revision: number; runtimeId: string; invocationId: string; operation: BundledOperation["operation"];
  message: string; dispatched: boolean; requestId?: string; result?: OperationResult; resultRevision?: number; recipient?: Controller;
};
type SubagentCancellation = { runtimeId: string; message: string; requestId?: string; result?: OperationResult };
type RenameFlight = {
  worker: PiProcess; revision: number; runtimeId: string; invocationId: string;
  message: string; dispatched: boolean; requestId?: string; result?: RenameResult;
};
type SessionActivity = {
  status: "Starting" | "Stopping" | "Stopped" | "Error" | "Waiting" | "Compacting" | "Retrying" | "Working" | "Done" | "Idle";
  completionSeq: number;
  turnOutcome?: ConversationSnapshot["execution"]["outcome"];
  subagentRuns: { runId: string; status: string; execution?: string; writerOwned?: boolean; readyForReview?: boolean; agent?: string; role?: string; progress?: string }[];
};
export type OwnedSessionState = SessionActivity & {
  sessionId: string;
  serviceEpoch: string;
  runtimeRevision: number;
  phase: "initializing" | "ready" | "stopping" | "stopped" | "failed";
  trust?: TrustStatus;
  workspace?: WorkspaceStatus;
  piState?: RpcSessionState;
  interactions: InteractionSnapshot;
  controller?: Controller;
  error?: string;
  exit?: PiExit;
  startupTimings?: { validationMs: number; workerMs: number; historyMs: number };
};
export type SnapshotCursor = { sessionId: string; serviceEpoch: string; runtimeRevision: number; conversationRevisions: ConversationRevisions };
export type OwnedSessionSnapshot = OwnedSessionState & { sequence: number; conversation: ConversationSnapshot; conversationRevisions: ConversationRevisions; commands: CommandReceipt[]; acceptedQueue: AcceptedQueueSnapshot };
export type OwnedSessionPatch = Omit<OwnedSessionSnapshot, "conversation"> & { conversationSections: ConversationSections };
export type OwnedSessionSummary = Pick<OwnedSessionState, "phase" | "runtimeRevision" | "controller" | keyof SessionActivity> & {
  sequence: number;
  piState?: Pick<RpcSessionState, "isStreaming" | "isCompacting" | "pendingMessageCount">;
  pendingInteractions: number;
  accessMode?: string; integrationMode?: string; notificationsEnabled: boolean; cwd: string;
};
export type HostSummaries = {
  sessions: (Pick<CatalogSession, "id" | "cwd" | "name"> & { live?: OwnedSessionSummary })[];
  hostId: string;
  channel: Channel;
  serviceEpoch: string;
};
export type OriginNotification = DesktopNotification & { hostId: string; serviceEpoch: string; sessionId: string };
export type EffectOffer = {
  id: string; policy: "recipient_bound"; source: "owned_pi_stream";
  recipient: { attachmentId: string; grantId: string };
  runtimeId: string; cwd: string; data: FrontendEffect;
};
export type OwnedSessionUpdate = {
  sessionId: string;
  serviceEpoch: string;
  runtimeRevision: number;
  sequence: number;
  owner?: OwnedSessionState;
  closeFrontend?: { attachmentId: string; commandId: string };
  conversation?: ConversationChange;
  effect?: EffectOffer;
  command?: CommandReceipt;
  acceptedQueue?: AcceptedQueueSnapshot;
};
export type HostOwnerOptions = {
  root?: string;
  channel: Channel;
  binary: string;
  appRoot: string;
  environment?: NodeJS.ProcessEnv;
  provider?: string;
  model?: string;
};

const HOST_OPTIONS_TTL_MS = 60_000;
const MAX_HOST_OPTIONS = 32;
type CachedHostOptions = { options: HostOptions; expiresAt: number };

/** Private host composition, not a daemon or an authenticated application API. */
export class HostOwner {
  readonly notifications = new EventEmitter<{ notification: [OriginNotification] }>();
  private readonly sessions = new Map<string, OwnedSession>();
  private creating = 0;
  private closing = false;
  private hostAdmission: Promise<void> = Promise.resolve();
  private hostAdmitting = 0;
  private readonly hostOptionsCache = new Map<string | undefined, CachedHostOptions>();
  private readonly hostOptionsFlights = new Map<string | undefined, Promise<CachedHostOptions>>();
  private readonly savedMutations = new Set<string>();
  private helperUnresolved?: Error;

  private constructor(private readonly catalog: SessionCatalog, private readonly options: HostOwnerOptions & { environment: NodeJS.ProcessEnv }, private readonly resources: HostResources) {
    void catalog.whenFailed.then((error) => {
      for (const session of this.sessions.values()) session.storageFailed(error);
    });
  }

  static async open(options: HostOwnerOptions): Promise<HostOwner> {
    if (!isAbsolute(options.binary) || !isAbsolute(options.appRoot)) throw new Error("Service launch paths must be absolute");
    if (options.provider && !options.model) throw new Error("Selecting a Pi provider also requires a model");
    const resources = await prepareHostResources(options);
    const pinned = { ...options, root: resources.root, binary: resources.binary, appRoot: resources.appRoot, environment: { ...resources.environment } };
    const catalog = await SessionCatalog.open(pinned);
    try {
      const manifest = join(catalog.root, `resources-${catalog.epoch}.json`);
      const file = await open(manifest, "wx", 0o600);
      try { await file.writeFile(JSON.stringify({ buildId: resources.buildId, files: resources.files, resolutions: resources.resolutions, lookup: resources.lookup })); await file.sync(); }
      finally { await file.close(); }
      pinned.environment.PI_CONSOLE_RESOURCE_MANIFEST = manifest;
      pinned.environment.PI_CONSOLE_BUILD_ID = resources.buildId;
      pinned.environment.PI_CONSOLE_PROCESS_REGISTRY = catalog.processRegistry;
      pinned.environment.PI_CONSOLE_OWNER_EPOCH = catalog.epoch;
      return new HostOwner(catalog, pinned, resources);
    } catch (error) { await catalog.close(); throw error; }
  }

  /** Explicit recovery only; callers then reopen and explicitly resume a saved session. */
  static reconcile(options: { root: string; channel: Channel }): Promise<void> { return SessionCatalog.reconcile(options); }

  get shutdownStarted(): boolean { return this.closing; }
  get buildId(): string { return this.resources.buildId; }
  get hostId(): string { return this.catalog.hostId; }
  get serviceEpoch(): string { return this.catalog.epoch; }
  list(): (CatalogSession & { live?: OwnedSessionSummary })[] {
    return this.catalog.list().map((record) => {
      const session = this.lookup(record.id);
      return { ...record, ...(session ? { live: session.summary() } : {}) };
    });
  }

  /** Owner-local display projection only; never subscribes to workers or other hosts. */
  summaries(): HostSummaries {
    return { sessions: this.catalog.list().map(({ id, cwd, name }) => {
      const session = this.lookup(id);
      return { id, cwd, name: session?.name || name, ...(session ? { live: session.summary() } : {}) };
    }), hostId: this.hostId, channel: this.options.channel, serviceEpoch: this.serviceEpoch };
  }

  async directories(input: unknown, check: () => void): Promise<unknown> {
    this.assertOpen();
    return completeDirectory(input, () => { this.assertOpen(); check(); });
  }

  async completeForHost(cwd: unknown, input: unknown, check: () => void): Promise<unknown> {
    this.assertOpen();
    return completeHostFiles(cwd, input, () => { this.assertOpen(); check(); });
  }

  /** Cache display metadata only; session startup still initializes and checks trust normally. */
  async optionsForHost(cwd: unknown, check: () => void, refresh: unknown = false): Promise<HostOptions & { cacheTtlMs: number }> {
    if (cwd !== undefined && (typeof cwd !== "string" || !isAbsolute(cwd) || Buffer.byteLength(cwd) > 4096
      || /[\u0000-\u001f\u007f]/.test(cwd))) throw new CommandError("invalid_command", "Invalid host options directory");
    if (typeof refresh !== "boolean") throw new CommandError("invalid_command", "Invalid host options refresh");
    this.assertOpen(); check();
    this.catalog.assertExecutionAllowed();
    const key = cwd as string | undefined;
    const cached = this.hostOptionsCache.get(key);
    this.hostOptionsCache.delete(key);
    if (!refresh && cached && cached.expiresAt > performance.now()) {
      this.hostOptionsCache.set(key, cached); // Least-recently-used entries are evicted first.
      return { ...cached.options, cacheTtlMs: Math.max(0, Math.floor(cached.expiresAt - performance.now())) };
    }
    if (this.hostAdmitting >= 128) throw new CommandError("command_limit", "Host admission limit exceeded");
    this.hostAdmitting++;
    try {
      let task = this.hostOptionsFlights.get(key);
      if (!task) {
        task = this.hostAdmission.then(async () => {
          this.assertOpen();
          this.catalog.assertLaunchAllowed();
          try {
            // Discovery belongs to the owner, not the first reader's connection.
            const options = await readHostOptions(this.resources, this.options.environment,
              { cwd: key, provider: this.options.provider, model: this.options.model },
              () => { this.assertOpen(); this.catalog.assertExecutionAllowed(); });
            this.assertOpen();
            this.catalog.assertExecutionAllowed();
            const entry = { options, expiresAt: performance.now() + HOST_OPTIONS_TTL_MS };
            this.hostOptionsCache.set(key, entry);
            while (this.hostOptionsCache.size > MAX_HOST_OPTIONS) {
              this.hostOptionsCache.delete(this.hostOptionsCache.keys().next().value);
            }
            return entry;
          } catch (error) {
            if (error instanceof OptionsHelperUnresolved) {
              this.helperUnresolved = error;
              for (const session of this.sessions.values()) session.storageFailed(error);
            }
            throw error;
          }
        }).finally(() => { this.hostOptionsFlights.delete(key); });
        this.hostOptionsFlights.set(key, task);
        this.hostAdmission = task.then(() => undefined, () => undefined);
      }
      // A refresh joins discovery already running for this directory, but never reuses a cached result.
      const entry = await task;
      this.assertOpen(); check();
      this.catalog.assertExecutionAllowed();
      return { ...entry.options, cacheTtlMs: Math.max(0, Math.floor(entry.expiresAt - performance.now())) };
    } finally { this.hostAdmitting--; }
  }

  /** Lookup never starts a worker or repeats trust/workspace initialization. */
  lookup(id: string): OwnedSession | undefined {
    const session = this.sessions.get(id);
    return session && !session.finished ? session : undefined;
  }

  private savedRecord(id: string): CatalogSession {
    const record = this.catalog.get(id);
    if (record.deleted) throw new CommandError("session_unavailable", "Session was deleted; receipts and workspace recovery data remain available");
    if (record.ownerEpoch || this.sessions.get(id) && !this.sessions.get(id)!.finished) {
      throw new CommandError("session_busy", "Open conversations are protected. Use current control to explicitly stop the session before archiving/deleting it.");
    }
    return record;
  }

  private async savedHelper(sessionId: string, payload: { action: "preview" | "delete"; expectedVersion?: string; mode?: string; confirmed?: true }): Promise<SavedResult> {
    this.catalog.assertLaunchAllowed();
    try {
      return await savedSessionHelper({ binary: this.options.binary, appRoot: this.options.appRoot,
        sessionDirectory: join(this.catalog.root, "sessions"), workspaceRoot: join(this.catalog.root, "workspaces"),
        environment: this.options.environment, assertExecutionAllowed: () => this.catalog.assertExecutionAllowed() }, { ...payload, sessionId });
    } catch (error) {
      if (error instanceof SavedHelperUnresolved) {
        this.helperUnresolved = error;
        for (const session of this.sessions.values()) session.storageFailed(error);
      }
      throw error;
    }
  }

  private async savedPreview(id: string): Promise<SavedPreview & { helperVersion: string; archived: boolean }> {
    const record = this.savedRecord(id);
    const result = await this.savedHelper(id, { action: "preview" });
    if (!result.success) throw new CommandError("resource_conflict", result.error);
    if (!("version" in result)) throw new Error("Missing saved session preview");
    if (JSON.stringify(record) !== JSON.stringify(this.savedRecord(id))) throw new CommandError("resource_conflict", "Saved session changed during preview");
    const ids = result.workspaces.map(workspace => workspace.id);
    for (const session of this.sessions.values()) {
      if (session.finished) continue;
      const state = session.snapshot();
      if (state.phase !== "ready" || session.workspaceTransitionPending || ids.includes(String(state.workspace?.id))
        || result.workspaces.some(workspace => state.interactions.runtime?.cwd === workspace.worktreePath
          || state.interactions.runtime?.cwd.startsWith(workspace.worktreePath + "/"))) {
        throw new CommandError("session_busy", "A linked workspace is in use or another session is transitioning; session/workspaces kept");
      }
    }
    return { ...result, helperVersion: result.version, archived: record.archived === true,
      version: createHash("sha256").update(JSON.stringify([record, result.version])).digest("hex") };
  }

  /** Catalog history is readable without attaching to or resuming a worker. */
  history(id: string, query: { offset?: unknown; version?: unknown }, admission: () => void): Promise<unknown> {
    if (this.hostAdmitting >= 128) throw new CommandError("command_limit", "Host admission limit exceeded");
    this.hostAdmitting++;
    const task = this.hostAdmission.then(async () => {
      this.assertOpen(); admission();
      const record = this.catalog.get(id);
      const check = () => {
        this.assertOpen(); admission();
        const current = this.catalog.get(id);
        if (current.deleted || current.piSessionId !== record.piSessionId || current.lifecycleRevision !== record.lifecycleRevision) {
          throw new CommandError("resource_conflict", "Session history context changed; select the session again");
        }
      };
      check();
      this.savedMutations.add(id);
      try {
        await this.catalog.validateSessionFile(id);
        check();
        return await readResource({ sessionFile: this.catalog.sessionFile(id), cwd: record.cwd, workspaceRoot: record.cwd,
          workspacesRoot: join(this.catalog.root, "workspaces"), tempRoot: tmpdir(), skillPaths: [], liveOutputPaths: [], check },
          { ...query, kind: "history" });
      } finally { this.savedMutations.delete(id); }
    });
    this.hostAdmission = task.then(() => undefined, () => undefined);
    return task.finally(() => { this.hostAdmitting--; });
  }

  /** Read preview shares the lifecycle admission lane; no runtime is resumed. */
  saved(id: string, check: () => void): Promise<unknown> {
    if (this.hostAdmitting >= 128) throw new CommandError("command_limit", "Host admission limit exceeded");
    this.hostAdmitting++;
    const task = this.hostAdmission.then(async () => {
      this.assertOpen(); check();
      this.savedMutations.add(id);
      try {
        const { helperVersion: _helperVersion, ...preview } = await this.savedPreview(id);
        check(); this.assertOpen();
        return preview;
      } finally { this.savedMutations.delete(id); }
    });
    this.hostAdmission = task.then(() => undefined, () => undefined);
    return task.finally(() => { this.hostAdmitting--; });
  }

  async create(cwd: string): Promise<OwnedSession> {
    this.assertOpen();
    this.catalog.assertLaunchAllowed();
    this.creating++;
    try { return this.resume((await this.catalog.create(cwd)).id); }
    finally { this.creating--; }
  }

  /** Register synchronously, before any file checks, commits or child startup. */
  resume(id: string, recoverOnly = false): OwnedSession {
    this.assertOpen();
    this.catalog.assertExecutionAllowed();
    if (this.savedMutations.has(id)) throw new CommandError("session_busy", "Saved-session operation in progress; resume explicitly after inspecting its outcome");
    const record = this.catalog.get(id);
    if (record.archived || record.deleted) throw new CommandError("session_unavailable", "Explicitly unarchive before resuming; deleted sessions cannot resume");
    const previous = this.sessions.get(id);
    if (previous && !previous.finished) {
      if (recoverOnly && (record.stopReason === "user" || !previous.recoverable)) throw new CommandError("session_unavailable", "Session is stopping or failed; explicitly reopen it after cleanup");
      return previous;
    }
    if (record.ownerEpoch) throw new Error("Session has unresolved ownership; recovery is required");
    if (recoverOnly && record.stopReason !== "service_shutdown") throw new CommandError("session_unavailable", "Session was not stopped by service shutdown; explicitly reopen it first");
    const previousState = previous?.snapshot();
    const session = new OwnedSession(this.catalog, record, this.options, previousState?.runtimeRevision ?? 0, previousState?.sequence ?? 0, () => {
      if (this.savedMutations.size) throw new CommandError("session_busy", "Saved-session lifecycle operation in progress; retry workspace changes explicitly after inspecting its outcome");
    }, (notification) => {
      if (!this.closing) this.notifications.emit("notification", { ...notification, hostId: this.hostId, serviceEpoch: this.serviceEpoch, sessionId: id });
    });
    this.sessions.set(id, session);
    return session;
  }

  hostStatus(epoch: string, id: string): HostReceipt | { status: "unknown" } {
    const receipt = this.catalog.hostRecord(epoch, id)?.receipt;
    return receipt && ["host.create", "host.resume", "host.recover", "host.archive", "host.delete"].includes(receipt.operation) ? receipt : { status: "unknown" };
  }

  manage(input: unknown, admission?: () => void): Promise<CommandReceipt> {
    const command = managementCommand(input);
    if (command.serviceEpoch !== this.serviceEpoch) throw new CommandError("stale_epoch", "Management request belongs to another service epoch");
    this.assertOpen();
    const previous = this.catalog.commandRecord(command.serviceEpoch, command.id);
    if (previous) {
      if (previous.fingerprint !== managementFingerprint(command)) throw new CommandError("command_conflict", "Command ID was used for another mutation");
      return Promise.resolve(previous.receipt);
    }
    const session = this.lookup(command.sessionId);
    if (!session) throw new CommandError("session_unavailable", "Session is not live; management never resumes it");
    return session.manage(command, admission);
  }

  managementStatus(epoch: string, id: string, sessionId: string): CommandReceipt | { status: "unknown" } {
    const receipt = this.catalog.commandRecord(epoch, id)?.receipt;
    return receipt?.authority === "management" && receipt.sessionId === sessionId ? receipt : { status: "unknown" };
  }

  /** Host IDs are disk identities, not connection IDs. Duplicate lookups never
   * resume a now-stopped worker or repeat initialization. */
  command(input: unknown, admission?: () => void): Promise<HostReceipt> {
    const command = hostCommand(input);
    if (command.serviceEpoch !== this.serviceEpoch) throw new CommandError("stale_epoch", "Host command belongs to another service epoch");
    this.assertOpen();
    if (this.hostAdmitting >= 128) throw new CommandError("command_limit", "Host admission limit exceeded");
    this.hostAdmitting++;
    const task = this.hostAdmission.then(async () => {
      admission?.();
      this.assertOpen();
      this.catalog.assertExecutionAllowed();
      const fingerprint = hostFingerprint(command);
      const previous = this.catalog.hostRecord(command.serviceEpoch, command.id);
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new CommandError("command_conflict", "Command ID was used for another mutation");
        return previous.receipt;
      }
      const receipt: HostReceipt = { id: command.id, serviceEpoch: this.serviceEpoch, operation: command.operation, status: "accepted" };
      let sessionId: string;
      if (command.operation === "host.create") {
        this.catalog.assertLaunchAllowed();
        const record = await this.catalog.create(command.payload.cwd, { fingerprint, receipt }, admission);
        sessionId = record.id;
        // The allocation receipt is already committed before any worker launch.
        this.resume(sessionId);
        return this.catalog.hostRecord(command.serviceEpoch, command.id)!.receipt;
      }
      if (command.operation === "host.archive" || command.operation === "host.delete") {
        const id = command.payload.sessionId;
        this.savedMutations.add(id);
        try {
          const preview = await this.savedPreview(id);
          if (preview.version !== command.payload.expectedVersion) throw new CommandError("resource_conflict", "Saved session or linked workspaces changed while confirming; select it again");
          if (command.operation === "host.archive" && preview.archiveBlocked) throw new CommandError("session_busy", "Retained source/child workspace protects this session from archival; finish its workspace lifecycle first");
          if (command.operation === "host.delete" && preview.mode !== command.payload.mode) throw new CommandError("resource_conflict", "Host trash availability changed; confirm the new deletion mode");
          await this.catalog.reserveHost(fingerprint, receipt, admission);
          if (command.operation === "host.archive") {
            receipt.status = "completed";
            receipt.result = { sessionId: id, archived: command.payload.archived };
            await this.catalog.finishHost(receipt, { sessionId: id, archived: command.payload.archived });
          } else {
            try {
              const result = await this.savedHelper(id, { action: "delete", expectedVersion: preview.helperVersion, mode: command.payload.mode, confirmed: true });
              if (!result.success) {
                receipt.status = result.mutated ? "uncertain" : "failed";
                // Host outcomes retain their existing 4-KiB reservation. Bound
                // diagnostics only; workspace recovery patches/records stay intact.
                receipt.error = { code: result.mutated ? "cleanup_incomplete" : "resource_conflict", message: result.error.slice(0, 512) };
              } else if (!("deleted" in result) || !result.deleted) throw new Error("Missing deletion outcome");
              else { receipt.status = "completed"; receipt.result = { sessionId: id, deleted: true, mode: result.mode }; }
            } catch (error) {
              receipt.status = "uncertain";
              receipt.error = { code: "outcome_uncertain", message: asError(error).message.slice(0, 512) };
            }
            await this.catalog.finishHost(receipt, receipt.result?.deleted ? { sessionId: id, deleted: true } : undefined);
          }
          return receipt;
        } finally { this.savedMutations.delete(id); }
      }
      this.catalog.get(command.payload.sessionId);
      await this.catalog.reserveHost(fingerprint, receipt, admission);
      try {
        sessionId = this.resume(command.payload.sessionId, command.operation === "host.recover").id;
        receipt.status = "completed";
        receipt.result = { sessionId };
      } catch (error) {
        receipt.status = "failed";
        receipt.error = { code: "session_unavailable", message: asError(error).message };
      }
      await this.catalog.finishHost(receipt);
      return receipt;
    });
    this.hostAdmission = task.then(() => undefined, () => undefined);
    return task.finally(() => { this.hostAdmitting--; });
  }

  /** Administrative local shutdown. Fence all admissions synchronously after
   * preflight, before awaiting any child. No frontend disconnect calls this. */
  async shutdown(force = false): Promise<void> {
    this.assertOpen();
    if (this.creating || this.hostAdmitting) throw new CommandError("session_busy", "Host lifecycle admission is in progress; inspect and retry explicitly");
    if (!force) {
      for (const session of this.sessions.values()) {
        const reason = session.stopBlockReason();
        if (reason) throw new CommandError("session_busy", reason);
      }
      if (this.catalog.list().some((session) => session.acceptedQueue?.some((item) => item.status !== "failed"))) {
        throw new CommandError("session_busy", "Accepted queued work would be interrupted");
      }
      if (inspectEpoch(this.catalog.processRegistry, this.serviceEpoch).some((job) => job.parent !== null && !["done", "cancelled"].includes(job.status))) {
        throw new CommandError("session_busy", "Known managed child work remains; use an intentional force stop to interrupt it");
      }
    }
    this.closing = true;
    // stop() revokes runtime execution before its first await.
    const results = await Promise.allSettled([...this.sessions.values()].map((session) => session.stop()));
    const errors = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    if (errors.length) throw new AggregateError(errors, "Owned cleanup failed; retain service claim for recovery");
    await this.catalog.close();
  }

  /** Closing a view must not call this or OwnedSession.stop(). */
  async close(): Promise<void> {
    if (this.creating || [...this.sessions.values()].some((session) => !session.finished)) {
      throw new Error("Stop sessions before closing the host service");
    }
    this.assertOpen();
    this.closing = true;
    await this.catalog.close();
  }

  private assertOpen(): void {
    if (this.helperUnresolved) throw this.helperUnresolved;
    if (this.closing) throw new Error("Host service is closing or closed");
  }
}

/** Initializing identity is available before ready(), including its pending UI.
 * Execution mutations use the private typed admission layer, never raw RPC.
 */
export class OwnedSession {
  private phase: OwnedSessionState["phase"] = "initializing";
  private startupTimings?: OwnedSessionState["startupTimings"];
  private readonly conversation = new PiConversation();
  private readonly viewers = new Set<SessionSubscription>();
  private readonly reservations = new QueueReservations(() => this.queueChanged());
  private readonly control = new SessionControl(() => {
    this.reservations.controlChanged(this.control.snapshot());
    this.changed();
  });
  private queueScheduled = false;
  private queueAgain = false;
  private queueRunPending = false;
  private rename?: RenameFlight;
  private nativePending = 0;
  private nativeQueueCommands = new Set<Promise<void>>();
  private bundled?: BundledFlight;
  private bundledInterrupt?: BundledFlight;
  private readonly subagentCancellations = new Map<string, SubagentCancellation>();
  // Delivery provenance is ephemeral, separate from durable accepted work. A
  // restart never revives a grant; explicit edits capture their own recipient.
  private readonly queueRecipients = new Map<string, Controller>();
  private queueFlight?: {
    itemId: string; recipient?: Controller; requestId?: string; dispatched: boolean; observedMessage?: string; settled: boolean;
    outcome?: { disposition: "started" | "handled" } | { error: unknown };
  };
  private readonly offers = new Map<string, { revision: number; offer: EffectOffer; bytes: number }>();
  private offerBytes = 0;
  private turnRecipient: Controller | null | undefined;
  private mainEffectsAmbiguous = false;
  private readonly spawnRecipients = new Map<string, Controller | undefined>();
  private readonly publications: string[] = [];
  private publishing = false;
  private admission: Promise<void> = Promise.resolve();
  private admitting = 0;
  private readonly commands = new Set<Promise<void>>();
  private aborting = 0;
  private sequence: number;
  private viewedCompletionSeq = 0;
  private refresh?: Promise<void>;
  private refreshAgain = false;
  private readonly captures = new Map<string, { worker: PiProcess; revision: number; version: number }>();
  private runtimeRevision: number;
  private workerRevision = 0;
  private worker?: PiProcess;
  private trust?: TrustStatus;
  private trustWorkerRevision?: number;
  private workspace?: WorkspaceStatus;
  private workspaceWorkerRevision?: number;
  private error?: Error;
  private cleanupError?: Error;
  private exit?: PiExit;
  private stopRequested = false;
  private serviceStopping = false;
  private restartRequested = false;
  private lifecyclePending = false;
  private lifecycle?: Promise<void>;
  private restartReady?: { resolve: () => void; reject: (error: Error) => void };
  private done = false;
  private wake?: () => void;
  private readonly running: Promise<void>;
  private readonly initialized: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;

  constructor(private readonly catalog: SessionCatalog, private readonly record: CatalogSession, private readonly options: HostOwnerOptions & { environment: NodeJS.ProcessEnv }, revision: number, sequence = 0, private readonly assertSavedIdle: () => void = () => {},
    private readonly notify: (notification: DesktopNotification) => void = () => {}) {
    this.runtimeRevision = revision;
    this.sequence = sequence;
    this.initialized = new Promise<void>((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    // An unattended session can fail before anyone waits for readiness.
    void this.initialized.catch(() => undefined);
    this.running = Promise.resolve().then(() => this.run());
  }

  get id(): string { return this.record.id; }
  get name(): string | undefined { return this.conversation.sessionState?.sessionName; }
  get finished(): boolean { return this.done && !this.lifecyclePending; }
  get recoverable(): boolean { return !this.stopRequested && !this.error && !this.done; }
  ready(): Promise<void> { return this.initialized; }

  snapshot(): OwnedSessionSnapshot {
    return { ...this.ownerState(), sequence: this.sequence, conversation: this.conversation.snapshot(), conversationRevisions: this.conversation.sectionRevisions(),
      commands: this.catalog.recentCommands(this.id), acceptedQueue: this.queueSnapshot() };
  }

  snapshotSince(known?: SnapshotCursor): OwnedSessionSnapshot | OwnedSessionPatch {
    // Never reuse sections across a service or runtime replacement.
    if (!known || known.sessionId !== this.id || known.serviceEpoch !== this.catalog.epoch || known.runtimeRevision !== this.runtimeRevision) return this.snapshot();
    return { ...this.ownerState(), sequence: this.sequence, conversationSections: this.conversation.changedSections(known.conversationRevisions),
      conversationRevisions: this.conversation.sectionRevisions(), commands: this.catalog.recentCommands(this.id), acceptedQueue: this.queueSnapshot() };
  }

  /** No conversation, queued text, interaction contents or control secrets. */
  summary(): OwnedSessionSummary {
    const state = this.conversation.sessionState;
    const pendingInteractions = this.worker?.interactionSnapshot().pending.filter((item) => !item.submitted).length ?? 0;
    return { ...this.activity(), sequence: this.sequence, phase: this.phase, runtimeRevision: this.runtimeRevision, controller: this.control.snapshot(), pendingInteractions,
      accessMode: this.conversation.status("pi-access-mode")?.match(/^Mode: (\w+)$/)?.[1],
      integrationMode: this.conversation.status("pi-integration-mode")?.match(/^Integration: (\w+)$/)?.[1],
      notificationsEnabled: this.conversation.status("pi-notifications") === "notify on", cwd: this.workspace?.cwd ?? this.record.cwd,
      ...(state ? { piState: { isStreaming: state.isStreaming, isCompacting: state.isCompacting, pendingMessageCount: state.pendingMessageCount } } : {}) };
  }

  /** Capture and registration run in one synchronous turn with event reduction.
   * No cursor replay: effects before this watermark are deliberately absent.
   */
  subscribe(label = "Interface"): SessionSubscription {
    if (this.viewers.size >= 32) throw new Error("Session viewer limit exceeded");
    if (typeof label !== "string" || !label.trim() || Buffer.byteLength(label) > 256) throw new CommandError("invalid_command", "Invalid attachment label");
    const id = randomUUID();
    const subscription = new SessionSubscription(id, this.snapshot(), () => {
      this.viewers.delete(subscription);
      this.control.detach(id);
    }, (update) => {
      if (update.effect && !this.validOffer(id, update)) delete update.effect;
      if (update.closeFrontend?.attachmentId !== id) delete update.closeFrontend;
      return update;
    });
    this.viewers.add(subscription);
    this.control.attach(id, label);
    return subscription;
  }

  /** Recheck after any async delay. Returns live recipient-bound data, never
   * authority to overwrite a draft. The frontend must also recheck local context. */
  inspectEffect(attachmentId: string, token: string, update: OwnedSessionUpdate): FrontendEffect | undefined {
    if (!this.validOffer(attachmentId, update, token)) return;
    return structuredClone(this.offers.get(update.effect!.id)!.offer.data);
  }

  private validOffer(attachmentId: string, update: OwnedSessionUpdate, token?: string): boolean {
    const effect = update.effect;
    if (!effect || update.sessionId !== this.id || update.serviceEpoch !== this.catalog.epoch
      || update.runtimeRevision !== this.runtimeRevision) return false;
    const stored = this.offers.get(effect.id);
    if (!stored || stored.revision !== this.runtimeRevision || stored.offer.recipient.attachmentId !== attachmentId
      || !this.control.matches(attachmentId, stored.offer.recipient.grantId, token)) return false;
    try {
      this.catalog.assertExecutionAllowed();
      this.checkIdentity();
      const runtime = this.worker?.interactionSnapshot().runtime;
      const notification = stored.offer.data.type === "notification" || stored.offer.data.type === "extension_signal"
        && stored.offer.data.key === "pi-spawn-notification";
      return (this.phase === "ready" || notification && this.phase === "initializing") && !this.stopRequested && !this.exit
        && (notification || this.usableWorkspace()) && runtime?.active === true && runtime.id === stored.offer.runtimeId && runtime.cwd === stored.offer.cwd;
    } catch { return false; }
  }

  private offerEffect(data: FrontendEffect): void {
    // Delayed operation effects belong to its initiator, not whoever took over
    // while a confirmation/summary was pending. Never retarget them to a viewer.
    const active = this.bundled ?? this.bundledInterrupt;
    // History restores input through its correlated completion receipt only.
    if (active?.operation === "history.navigate" && data.type === "editor_text") return;
    let recipient = active ? active.recipient : this.turnRecipient !== undefined ? this.turnRecipient ?? undefined : this.control.current();
    let independent = false;
    if (data.type === "extension_signal" && data.key === "pi-spawn-notification") {
      try {
        const payload: unknown = JSON.parse(data.value ?? "null");
        if (!object(payload)) return;
        recipient = typeof payload.runId === "string" ? this.spawnRecipients.get(payload.runId) : undefined;
        independent = true;
      } catch { return; }
    }
    // Native input can be transformed/handled or consumed inside Pi's existing
    // run without an attributed dispatch. Never guess which grant owns its
    // uncorrelated effects, even while an unrelated bundled operation is active.
    if (this.mainEffectsAmbiguous && !independent) return;
    if (active && (data.type === "notification" || data.type === "editor_text") && this.turnRecipient !== undefined
      && active.recipient?.grantId !== this.turnRecipient?.grantId && (!this.conversation.executionSettled || this.queueFlight?.dispatched)) return;
    const runtime = this.worker?.interactionSnapshot().runtime;
    if (!recipient || !runtime?.active) return;
    const offer: EffectOffer = { id: randomUUID(), policy: "recipient_bound", source: "owned_pi_stream",
      recipient: { attachmentId: recipient.attachmentId, grantId: recipient.grantId }, runtimeId: runtime.id, cwd: runtime.cwd, data };
    const bytes = Buffer.byteLength(JSON.stringify(offer));
    if (bytes > 2 * 1024 * 1024) return;
    while (this.offers.size >= 128 || this.offerBytes + bytes > 4 * 1024 * 1024) {
      const oldest = this.offers.keys().next().value!;
      this.offerBytes -= this.offers.get(oldest)!.bytes;
      this.offers.delete(oldest);
    }
    this.offers.set(offer.id, { revision: this.runtimeRevision, offer, bytes });
    this.offerBytes += bytes;
    const update = { sessionId: this.id, serviceEpoch: this.catalog.epoch, runtimeRevision: this.runtimeRevision, sequence: this.sequence + 1, effect: offer };
    if (this.validOffer(recipient.attachmentId, update)) this.publish({ effect: offer });
  }

  /** Secrets are returned only to the holding attachment, never in events. */
  controlGrant(attachmentId: string): ControlGrant | undefined { return this.control.grantFor(attachmentId); }

  /** Connection liveness only: never a durable command or a grant acquisition. */
  heartbeat(attachmentId: string, controlToken: string, reservationId?: string): { reservationCurrent: boolean } {
    this.control.heartbeat(attachmentId, controlToken);
    if (reservationId) {
      try { this.reservations.renew(reservationId, this.control.current()!); }
      catch (error) {
        if (error instanceof CommandError && error.code === "reservation_expired") return { reservationCurrent: false };
        throw error;
      }
    }
    return { reservationCurrent: true };
  }

  /** Viewing is runtime-local, monotonic, and authorized by the current controller. */
  responseViewed(attachmentId: string, token: string, serviceEpoch: string, runtimeRevision: number, completionSeq: number): void {
    if (serviceEpoch !== this.catalog.epoch) throw new CommandError("stale_epoch", "Session service changed");
    if (runtimeRevision !== this.runtimeRevision) throw new CommandError("stale_runtime", "Session runtime changed");
    const controller = this.control.current();
    if (!controller || !this.control.matches(attachmentId, controller.grantId, token)) {
      throw new CommandError("control_revoked", "Viewing acknowledgement requires current session control");
    }
    if (!Number.isSafeInteger(completionSeq) || completionSeq < 1 || completionSeq > this.conversation.completedTurns) {
      throw new CommandError("invalid_command", "Invalid viewed completion");
    }
    if (completionSeq <= this.viewedCompletionSeq) return;
    this.viewedCompletionSeq = completionSeq;
    this.changed();
  }

  commandStatus(serviceEpoch: string, id: string): CommandReceipt | { status: "unknown" } {
    const receipt = this.catalog.commandStatus(serviceEpoch, id);
    return receipt?.sessionId === this.id ? receipt : { status: "unknown" };
  }

  /** Resolve acceptance independently from eventual outcome. The short admission
   * lane serializes authorization/reservation, not a blocking abort or dialog.
   */
  async command(input: SessionCommand, admission?: () => void): Promise<CommandReceipt> {
    const command = sessionCommand(input);
    if (command.sessionId !== this.id) return Promise.reject(new CommandError("invalid_command", "Command targets another session"));
    if (command.serviceEpoch !== this.catalog.epoch) return Promise.reject(new CommandError("stale_epoch", "Command belongs to another service epoch"));
    if (this.admitting >= 128) return Promise.reject(new CommandError("command_limit", "Service command admission limit exceeded"));
    this.admitting++;
    const task = this.admission.then(async () => {
      admission?.();
      this.control.attached(command.attachmentId);
      const fingerprint = commandFingerprint(command);
      const existing = this.catalog.commandRecord(command.serviceEpoch, command.id);
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new CommandError("command_conflict", "Command ID was used for a different mutation");
        return existing.receipt;
      }
      this.control.authorize(command);
      const recipient = this.control.snapshot();
      const worker = this.commandRuntime(command.runtimeRevision);
      const rename = command.operation === "session.rename" ? this.prepareRename(command, worker) : undefined;
      if (this.bundled && contextOperation(this.bundled.operation) && ["prompt.submit", "queue.edit"].includes(command.operation)) throw new CommandError("session_busy", "History transition pending; retain text and review after arrival");
      if (isNative(command)) this.assertNativeReady(command);
      const bundled = isBundled(command) ? this.prepareBundled(command, worker) : undefined;
      if ((command.operation === "session.restart" || command.operation === "session.kill") && this.lifecyclePending) throw new CommandError("session_busy", "Session lifecycle operation pending");
      if (command.operation === "interaction.respond" || command.operation === "interaction.cancel") this.interactionResponse(command);
      const receipt: CommandReceipt = { id: command.id, sessionId: this.id, serviceEpoch: this.catalog.epoch,
        runtimeRevision: command.runtimeRevision, operation: command.operation, status: "accepted" };
      if (isNative(command)) {
        if ("text" in command.payload) receipt.result = { submittedText: command.payload.text };
        if ("command" in command.payload) receipt.result = { submittedText: command.payload.command };
      }
      if (command.operation === "side.prompt") receipt.result = { submittedText: command.payload.text };
      const queue = this.prepareQueueCommand(command, receipt);
      try { await this.catalog.reserveCommand({ fingerprint, receipt }, queue, admission); }
      catch (error) {
        if (!(error instanceof CommandError)) this.commandFailure(error);
        throw error;
      }
      // Install only after the queue mutation committed. Capture authority before
      // that await: detach/expiry during persistence must not rebind accepted work.
      const itemId = receipt.result?.queueItemId;
      if (itemId && (command.operation === "prompt.submit" || command.operation === "queue.edit") && recipient) this.queueRecipients.set(itemId, recipient);
      if (itemId && command.operation === "queue.remove") this.queueRecipients.delete(itemId);
      if (rename) this.rename = rename;
      if (bundled) {
        if (this.bundled) this.bundledInterrupt = bundled;
        else this.bundled = bundled;
      }
      this.publish({ command: receipt });
      // Control effects are ordered before the next admission. A lost takeover
      // acknowledgment can never cause a duplicate to steal control again.
      if (command.operation.startsWith("control.")) {
        let error: unknown;
        try { this.commandRuntime(command.runtimeRevision); this.control.apply(command); }
        catch (failure) { error = failure; }
        this.trackCommand(this.finishCommand(receipt, error));
      } else if (command.operation === "prompt.submit" || command.operation.startsWith("queue.")) {
        let error: unknown;
        try {
          if (queue) {
            if (command.operation === "queue.remove") this.reservations.releaseItem(command.payload.itemId);
            this.queueChanged();
          } else {
            // Reservations are ephemeral authority, unlike already accepted text.
            // A detach during the durable admission must not resurrect a pause.
            this.commandRuntime(command.runtimeRevision);
            this.control.authorize(command);
            if (command.operation === "queue.reserve") {
              const reservation = this.reservations.reserve(command.payload.itemId, this.control.snapshot()!);
              receipt.result = { reservationId: reservation.id };
            } else if (command.operation === "queue.release") {
              this.reservations.assertCurrent(command.payload.reservationId);
              this.reservations.clear();
            }
          }
        } catch (failure) { error = failure; }
        this.trackCommand(this.finishCommand(receipt, error));
      } else if (command.operation === "session.kill" || command.operation === "session.restart") {
        this.lifecyclePending = true;
        // Not in commands: stop drains that set, so awaiting stop inside it
        // would wait for itself. The lifecycle receipt is finalized afterward.
        this.lifecycle = this.executeLifecycle(command, receipt).catch((error: unknown) => this.commandFailure(error));
      } else if (command.operation === "workspace.review.save" || command.operation === "workspace.review.stage"
        || command.operation === "workspace.review.unstage" || command.operation === "workspace.review.restore") this.trackCommand(this.editReview(command, receipt, admission));
      else if (bundled) this.trackCommand(this.executeBundled(receipt, bundled));
      else if (isNative(command)) {
        this.nativePending++;
        const task = this.executeNative(command, receipt);
        if (command.operation === "steering.submit" || command.operation === "followUp.submit") this.nativeQueueCommands.add(task);
        this.trackCommand(task.finally(() => this.nativeQueueCommands.delete(task)));
      } else if (rename) this.trackCommand(this.executeRename(receipt, rename));
      else this.trackCommand(this.executeCommand(command, receipt));
      return structuredClone(receipt);
    });
    this.admission = task.then(() => undefined, () => undefined);
    return task.finally(() => { this.admitting--; });
  }

  /** Management admission shares ordering and receipts, but never touches controller grants. */
  manage(input: ManagementCommand, admission?: () => void): Promise<CommandReceipt> {
    const command = managementCommand(input);
    if (command.sessionId !== this.id) throw new CommandError("invalid_command", "Management targets another session");
    if (command.serviceEpoch !== this.catalog.epoch) throw new CommandError("stale_epoch", "Host service changed");
    if (this.admitting >= 128) throw new CommandError("command_limit", "Service command admission limit exceeded");
    this.admitting++;
    const task = this.admission.then(async () => {
      admission?.();
      const fingerprint = managementFingerprint(command);
      const existing = this.catalog.commandRecord(command.serviceEpoch, command.id);
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new CommandError("command_conflict", "Command ID was used for another mutation");
        return existing.receipt;
      }
      const worker = this.commandRuntime(command.runtimeRevision);
      if (this.lifecyclePending) throw new CommandError("session_busy", "Session lifecycle operation pending");
      const bundled = command.operation !== "session.kill" && command.operation !== "turn.abort" ? this.prepareBundled(command, worker) : undefined;
      const receipt: CommandReceipt = { id: command.id, sessionId: this.id, serviceEpoch: this.catalog.epoch,
        runtimeRevision: command.runtimeRevision, operation: command.operation, authority: "management", status: "accepted" };
      let closeAttachment: string | undefined;
      try {
        await this.catalog.reserveCommand({ fingerprint, receipt }, undefined, () => {
          admission?.();
          if (command.operation === "session.kill") closeAttachment = this.control.current()?.attachmentId;
        });
      } catch (error) { if (!(error instanceof CommandError)) this.commandFailure(error); throw error; }
      if (bundled) this.bundled = bundled;
      this.publish({ command: receipt });
      if (command.operation === "session.kill") {
        this.lifecyclePending = true;
        this.lifecycle = this.executeLifecycle(command, receipt, closeAttachment).catch((error: unknown) => this.commandFailure(error));
      } else if (command.operation === "turn.abort") this.trackCommand(this.executeCommand(command, receipt));
      else if (bundled) this.trackCommand(this.executeBundled(receipt, bundled));
      return structuredClone(receipt);
    });
    this.admission = task.then(() => undefined, () => undefined);
    return task.finally(() => { this.admitting--; });
  }

  private queueSnapshot(): AcceptedQueueSnapshot {
    const items = this.catalog.queue(this.id);
    const flight = this.queueFlight;
    const item = flight && items.find((item) => item.id === flight.itemId);
    if (item?.timeline && flight?.observedMessage) item.timeline.observedMessage = flight.observedMessage;
    return { items, reservation: this.reservations.snapshot() };
  }

  private queueChanged(): void {
    const snapshot = this.queueSnapshot();
    const pending = new Set(snapshot.items.filter(item => item.status !== "failed"
      && item.runtimeRevision === this.runtimeRevision && item.serviceEpoch === this.catalog.epoch).map(item => item.id));
    for (const id of this.queueRecipients.keys()) if (!pending.has(id)) this.queueRecipients.delete(id);
    this.publish({ acceptedQueue: snapshot });
    this.scheduleQueue();
  }

  /** Queue mutation and ID reservation share one catalog commit. The receipt
   * completes ownership/editing, not delivery to Pi or an agent turn. */
  private prepareQueueCommand(command: SessionCommand, receipt: CommandReceipt): AcceptedQueueItem[] | undefined {
    const items = this.catalog.queue(this.id);
    if (command.operation === "prompt.submit") {
      const item: AcceptedQueueItem = { id: randomUUID(), revision: 1, serviceEpoch: this.catalog.epoch,
        runtimeRevision: command.runtimeRevision, text: command.payload.text.trim(), status: "queued",
        timeline: this.conversation.timelineAnchor };
      items.push(item);
      // Pi publishes message_end before appending history. Keep a recoverable
      // copy after live queue handoff; receipt data never authorizes replay.
      receipt.result = { queueItemId: item.id, queueItemRevision: item.revision, queueItemText: item.text };
      return items;
    }
    if (command.operation === "queue.edit" || command.operation === "queue.remove" || command.operation === "queue.reserve") {
      const item = editableItem(items, command.payload.itemId, command.payload.expectedRevision);
      if (command.operation === "queue.reserve") return;
      if (command.operation === "queue.remove") items.splice(items.indexOf(item), 1);
      else if (command.operation === "queue.edit") {
        item.text = command.payload.text.trim();
        if (!item.timeline || item.serviceEpoch !== this.catalog.epoch || item.runtimeRevision !== command.runtimeRevision || item.timeline.observedMessage) {
          item.timeline = this.conversation.timelineAnchor;
        }
        item.status = "queued";
        item.error = undefined;
        item.serviceEpoch = this.catalog.epoch;
        item.runtimeRevision = command.runtimeRevision;
        item.revision++;
      }
      receipt.result = { queueItemId: item.id, queueItemRevision: item.revision,
        ...(command.operation === "queue.edit" ? { queueItemText: item.text } : {}) };
      return items;
    }
    if (command.operation === "queue.release") this.reservations.assertCurrent(command.payload.reservationId);
  }

  private scheduleQueue(): void {
    if (this.done) return;
    if (this.queueScheduled) { this.queueAgain = true; return; }
    this.queueScheduled = true;
    // Same lane as edit/remove admission. Do not hold it across a Pi response:
    // extension input hooks may wait on an interaction or control transfer.
    const task = this.admission.then(() => this.pumpQueue());
    this.admission = task.then(() => undefined, () => undefined);
    void task.catch((error: unknown) => this.commandFailure(error)).finally(() => {
      this.queueScheduled = false;
      if (this.queueAgain) { this.queueAgain = false; this.scheduleQueue(); }
    });
  }

  private queueCanDispatch(): boolean {
    return !this.stopRequested && !this.error && !this.exit && this.phase === "ready" && this.usableWorkspace()
      && !this.aborting && !this.rename && !this.nativePending && !this.bundled && !this.bundledInterrupt && !this.queueRunPending
      && !this.conversation.continuationPending && this.conversation.executionSettled;
  }

  private async pumpQueue(): Promise<void> {
    if (this.stopRequested || this.error || this.exit) return;
    const items = this.catalog.queue(this.id);
    const flight = this.queueFlight;
    if (flight) {
      const item = items.find((item) => item.id === flight.itemId);
      if (!item || item.status !== "sending") throw new Error("Accepted queue lost its sending item");
      const stale = item.runtimeRevision !== this.runtimeRevision;
      const outcome = flight.outcome;
      // A slash handler can publish a new context before acknowledging handling.
      if (item.text.startsWith("/") && !outcome) return;
      if (!stale && (!outcome || !("error" in outcome) && outcome.disposition !== "handled" && !flight.observedMessage && !flight.settled)) return;
      if (item.timeline && flight.observedMessage) item.timeline.observedMessage = flight.observedMessage;
      if (outcome && !("error" in outcome) && outcome.disposition === "handled") {
        // A command may intentionally change runtime/history without a user message.
        items.splice(items.indexOf(item), 1);
        this.queueRunPending = false;
      } else if (stale) {
        item.status = "failed"; item.revision++;
        item.error = { code: "stale_runtime", message: "Runtime changed during prompt delivery; inspect the conversation before editing/resubmitting" };
        this.queueRunPending = false;
      } else if (outcome && "error" in outcome) {
        item.status = outcome.error instanceof QueueDeferred ? "queued" : "failed";
        item.revision++;
        item.error = outcome.error instanceof QueueDeferred ? undefined : queueError(outcome.error);
      } else if (outcome && outcome.disposition === "started" && !flight.observedMessage) {
        item.status = "failed"; item.revision++;
        item.error = { code: "delivery_uncertain", message: "Pi settled without an observed user message; review before editing/resubmitting" };
      } else items.splice(items.indexOf(item), 1);
      await this.catalog.replaceQueue(this.id, items);
      this.queueFlight = undefined;
      this.queueChanged();
    }
    // Never silently retarget accepted text after startup replacement, branch
    // navigation, clean resume or owner epoch changes. Failed items keep order.
    let changed = false;
    for (const item of items) {
      if (item.status !== "queued" || item.serviceEpoch === this.catalog.epoch && item.runtimeRevision === this.runtimeRevision) continue;
      item.status = "failed"; item.revision++;
      item.error = { code: "stale_runtime", message: "Accepted prompt targets a replaced context; review before editing/resubmitting" };
      this.reservations.releaseItem(item.id);
      changed = true;
    }
    if (changed) { await this.catalog.replaceQueue(this.id, items); this.queueChanged(); }
    if (!this.queueCanDispatch() || items.some((item) => item.status === "sending")) return;
    const item = items.find((item) => item.status === "queued");
    if (!item || this.reservations.blocks(item.id)) return;
    const worker = this.commandRuntime(item.runtimeRevision);
    item.status = "sending"; item.revision++;
    await this.catalog.replaceQueue(this.id, items);
    const next: NonNullable<OwnedSession["queueFlight"]> = { itemId: item.id, recipient: this.queueRecipients.get(item.id),
      dispatched: false, settled: false };
    this.queueFlight = next;
    this.queueChanged();
    this.trackCommand((async () => {
      try {
        const response = await worker.request({ type: "prompt", message: item.text }, () => {
          this.commandRuntime(item.runtimeRevision, worker);
          // Readiness/execution can change during fsync or stdin backpressure.
          // A temporary busy gate defers, without retrying a possibly sent write.
          if (!this.queueCanDispatch()) throw new QueueDeferred();
          this.assertReady(item.runtimeRevision);
          next.dispatched = true;
          this.queueRunPending = true;
        });
        if (response.command !== "prompt" || !["started", "handled"].includes(response.data.disposition)) throw new Error("Unexpected accepted queue disposition");
        next.outcome = { disposition: response.data.disposition as "started" | "handled" };
        if (response.data.disposition === "handled" && this.queueFlight === next) this.queueRunPending = false;
      } catch (error) {
        next.outcome = { error };
        if (this.queueFlight === next) this.queueRunPending = false;
      }
      this.scheduleQueue();
    })());
  }

  private assertRenameReady(): void {
    if (this.phase !== "ready" || !this.usableWorkspace()) {
      throw new CommandError("session_unavailable", "Rename requires ready trust/workspace state");
    }
    if (this.aborting || this.queueFlight || this.queueRunPending || !this.conversation.settled
      || this.worker?.interactionSnapshot().pending.some((item) => !sideInteraction(item.request.title))) {
      throw new CommandError("session_busy", "Rename requires settled execution without a pending main interaction");
    }
  }

  private prepareRename(command: SessionCommand & { operation: "session.rename" }, worker: PiProcess): RenameFlight {
    if (this.rename || this.nativePending || this.bundled || this.bundledInterrupt) throw new CommandError("session_busy", "A session operation is already pending");
    this.assertRenameReady();
    const runtimeId = worker.interactionSnapshot().runtime!.id;
    const invocationId = randomUUID();
    const request = { version: 1, invocationId, runtimeId, sessionId: this.record.piSessionId,
      sessionFile: this.catalog.sessionFile(this.id), title: command.payload.title };
    return { worker, revision: command.runtimeRevision, runtimeId, invocationId,
      message: `/${RENAME_COMMAND} ${JSON.stringify(request)}`, dispatched: false };
  }

  private async executeRename(receipt: CommandReceipt, flight: RenameFlight): Promise<void> {
    const outcome = structuredClone(receipt);
    const guard = () => {
      this.commandRuntime(flight.revision, flight.worker);
      this.assertRenameReady();
    };
    try {
      try {
        guard();
        // Discover each time; runtime replacement invalidates both discovery and
        // dispatch. Refuse collisions instead of guessing a suffixed invocation.
        const discovery = await flight.worker.request({ type: "get_commands" }, guard);
        guard();
        if (discovery.command !== "get_commands" || discovery.data.commands.filter((command) =>
          command.name === RENAME_COMMAND && command.source === "extension"
          && command.sourceInfo?.path === join(this.options.appRoot, "pi", "extensions", "auto-title.ts")).length !== 1) {
          throw new CommandError("unsupported_command", "Bundled managed rename capability is missing or ambiguous");
        }
        const response = await flight.worker.request({ type: "prompt", message: flight.message }, () => {
          guard();
          flight.dispatched = true;
        });
        // The result was consumed synchronously at its stdout position, before
        // this promise resumes. handled alone (including input hooks) proves nothing.
        this.commandRuntime(flight.revision, flight.worker);
        if (response.command !== "prompt" || response.data.disposition !== "handled" || !flight.result) {
          throw new Error("Managed rename did not return a correlated terminal result");
        }
        outcome.status = flight.result.status;
        if (flight.result.status === "completed") outcome.result = { title: flight.result.title };
        else outcome.error = { code: flight.result.code, message: flight.result.status === "failed"
          ? "Rename was refused before mutation; review the title and current session state"
          : "Rename may be partially applied; inspect session metadata before taking further action" };
      } catch (error) {
        // Only proven-unsent refusals are failed. Once sent, even a native
        // rejection can mean a missing command fell through to ordinary input.
        outcome.status = !flight.dispatched && (error instanceof CommandError
          || error instanceof PiCommandError && error.outcome === "rejected") ? "failed" : "uncertain";
        outcome.error = { code: outcome.status === "failed" && error instanceof CommandError ? error.code : "rename_uncertain",
          message: outcome.status === "failed" ? "Rename was not dispatched; review session state before retrying"
            : "Rename outcome is uncertain; inspect session metadata, never automatically replay" };
      }
      // An unproven outcome must not reopen dispatch on handled alone. Stop the
      // child conservatively; accepted text remains recoverable for explicit review.
      if (outcome.status === "uncertain") this.commandFailure(new Error(outcome.error!.message));
      // Serialize the terminal commit and gate release with new admission. A
      // status lookup can observe the persisted receipt before this continuation
      // runs; a new command must not then see a completed-but-still-busy rename.
      const completion = this.admission.then(async () => {
        await this.catalog.updateCommand(outcome);
        if (this.rename === flight) this.rename = undefined;
        this.publish({ command: outcome });
      });
      this.admission = completion.then(() => undefined, () => undefined);
      await completion;
    } catch (error) {
      this.commandFailure(error);
      throw error;
    } finally {
      if (this.rename === flight) this.rename = undefined;
      this.scheduleQueue();
    }
  }

  private consumeRenameResult(text: string | undefined): void {
    const flight = this.rename;
    const result = renameResult(text);
    if (!flight?.dispatched || flight.result || result.invocationId !== flight.invocationId
      || result.runtimeId !== flight.runtimeId || result.sessionId !== this.record.piSessionId
      || result.sessionFile !== this.catalog.sessionFile(this.id)) throw new Error("Unmatched managed rename result");
    this.commandRuntime(flight.revision, flight.worker);
    flight.result = result;
  }

  get workspaceTransitionPending(): boolean { return !!this.bundled && contextOperation(this.bundled.operation) || this.lifecyclePending; }

  private prepareBundled(command: { runtimeRevision: number } & BundledOperation, worker: PiProcess): BundledFlight {
    if (contextOperation(command.operation)) this.assertSavedIdle();
    const interruptingJoin = command.operation === "spawn.stop" && this.bundled?.operation === "spawn.join" && !this.bundledInterrupt;
    if (this.rename || this.bundled && !interruptingJoin || this.bundledInterrupt || this.nativePending || this.aborting) throw new CommandError("session_busy", "Another session operation is pending");
    if (this.phase !== "ready" || !this.usableWorkspace()) throw new CommandError("session_unavailable", "Trust/workspace state is not ready");
    if (command.operation.startsWith("history.") || command.operation.startsWith("workspace.") || command.operation === "title.generate") this.assertRenameReady();
    const runtimeId = worker.interactionSnapshot().runtime!.id;
    const invocationId = randomUUID();
    return { worker, revision: command.runtimeRevision, runtimeId, invocationId, operation: command.operation, dispatched: false,
      recipient: this.control.current(), message: `/${operationCommand(command.operation)} ${JSON.stringify({ version: 1, invocationId,
        runtimeId, sessionId: this.record.piSessionId, sessionFile: this.catalog.sessionFile(this.id), payload: command.payload })}` };
  }

  private async executeBundled(receipt: CommandReceipt, flight: BundledFlight): Promise<void> {
    const outcome = structuredClone(receipt);
    let clone: CatalogSession | undefined;
    try {
      const guard = () => {
        if (contextOperation(flight.operation)) this.assertSavedIdle();
        this.commandRuntime(flight.revision, flight.worker);
        this.assertReady(flight.revision);
        if (flight.operation.startsWith("history.") || flight.operation.startsWith("workspace.") || flight.operation === "title.generate") this.assertRenameReady();
      };
      try {
        const discovery = await flight.worker.request({ type: "get_commands" }, guard);
        guard();
        const name = operationCommand(flight.operation);
        if (discovery.command !== "get_commands" || discovery.data.commands.filter((c) => c.name === name && c.source === "extension"
          && c.sourceInfo?.path === join(this.options.appRoot, "pi", "extensions", BUNDLED_SOURCES[flight.operation])).length !== 1) {
          throw new CommandError("unsupported_command", "Bundled typed capability is missing or ambiguous");
        }
        const response = await flight.worker.request({ type: "prompt", message: flight.message }, () => {
          guard();
          flight.dispatched = true;
          if (contextOperation(flight.operation)) {
            // Fence the whole async transition window, not only its later status.
            flight.revision = ++this.runtimeRevision;
            this.changed();
          }
        });
        const result = flight.result;
        if (response.command !== "prompt" || response.data.disposition !== "handled" || !result) throw new Error("No correlated terminal operation result");
        outcome.status = result.status;
        if (result.status === "completed") {
          if (flight.operation === "history.clone" || flight.operation === "history.fork") {
            if (!result.data?.sessionFile || !result.data.cwd) throw new Error("Clone result omitted identity");
            clone = await this.catalog.cloneRecord(result.data.sessionFile, result.data.cwd);
            outcome.result = { sessionId: clone.id, ...(result.data.editorText !== undefined ? { editorText: result.data.editorText } : {}) };
          } else if (flight.operation === "history.navigate" || flight.operation === "history.delete") {
            if (result.data?.changed !== true || flight.operation === "history.delete" && !["applied", "cleanup_incomplete"].includes(result.data.status ?? "")) throw new Error("Missing history completion");
            outcome.result = { changed: true, ...(flight.operation === "history.navigate" ? { contextRevision: flight.resultRevision } : {}),
              ...(result.data.status !== undefined ? { status: result.data.status } : {}),
              ...(result.data.editorText !== undefined ? { editorText: result.data.editorText } : {}) };
          } else if (flight.operation === "access.set" || flight.operation === "integration.set" || flight.operation === "access.cycle" || flight.operation === "integration.cycle") {
            if (typeof result.data?.mode !== "string") throw new Error("Missing mode completion");
            outcome.result = { mode: result.data.mode };
          } else if (flight.operation === "title.generate") {
            if (typeof result.data?.title !== "string") throw new Error("Missing generated title");
            outcome.result = { title: result.data.title };
          } else if (flight.operation === "usage.refresh") {
            if (typeof result.data?.changed !== "boolean" || !["refreshed", "not_applicable"].includes(result.data.status ?? "")) throw new Error("Missing usage refresh outcome");
            outcome.result = { changed: result.data.changed, status: result.data.status };
          } else if (flight.operation === "notifications.set") {
            if (typeof result.data?.enabled !== "boolean") throw new Error("Missing notification setting");
            outcome.result = { enabled: result.data.enabled };
          } else if (flight.operation.startsWith("workspace.")) {
            if (typeof result.data?.changed !== "boolean") throw new Error("Missing workspace completion");
            outcome.result = result.data;
          } else if (flight.operation.startsWith("side.")) {
            if (result.data?.disposition !== "accepted") throw new Error("Missing side acceptance");
            outcome.result = { ...outcome.result, disposition: "accepted" };
          } else {
            if (result.data?.changed !== true) throw new Error("Missing subagent completion");
            outcome.result = result.data;
          }
          // State may still name the outgoing runtime. Refresh against the same
          // managed file, then validate identity; never accept a fork on this ID.
          await flight.worker.request({ type: "get_state" }, () => {
            this.catalog.assertExecutionAllowed();
            const runtime = flight.worker.interactionSnapshot().runtime;
            if (flight.worker !== this.worker || !runtime?.active || runtime.sessionId !== this.record.piSessionId
              || runtime.sessionFile !== this.catalog.sessionFile(this.id)) throw new Error("Operation changed managed identity");
          });
          this.checkIdentity();
        } else outcome.error = { code: result.code ?? "operation_failed", message: result.status === "failed"
          ? "Operation was refused/cancelled before application" : "Operation may be partially applied; inspect before taking further action" };
      } catch (error) {
        outcome.status = !flight.dispatched && error instanceof CommandError ? "failed" : "uncertain";
        outcome.error = { code: outcome.status === "failed" && error instanceof CommandError ? error.code : "operation_uncertain",
          message: outcome.status === "failed" ? "Operation was not dispatched" : "Operation outcome is uncertain; inspect, never automatically replay" };
      }
      if (outcome.status === "uncertain") this.commandFailure(new Error(outcome.error!.message));
      const completion = this.admission.then(async () => {
        await this.catalog.updateCommand(outcome, clone);
        if (this.bundled === flight) this.bundled = undefined;
        if (this.bundledInterrupt === flight) this.bundledInterrupt = undefined;
        this.publish({ command: outcome });
      });
      this.admission = completion.then(() => undefined, () => undefined);
      await completion;
    } finally {
      if (this.bundled === flight) this.bundled = undefined;
      if (this.bundledInterrupt === flight) this.bundledInterrupt = undefined;
      this.scheduleQueue();
      this.scheduleRefresh();
    }
  }

  /** Typed reads are attachment-bound by transport and fenced across async work. */
  async read(input: unknown, admission?: () => void): Promise<unknown> {
    if (!validRead(input)) throw new CommandError("invalid_command", "Invalid session read");
    const worker = this.commandRuntime(input.runtimeRevision);
    const check = () => { admission?.(); this.commandRuntime(input.runtimeRevision, worker); };
    check();
    const response = await worker.request(readCommand(input.kind)!, check);
    check();
    return { runtimeRevision: this.runtimeRevision, data: "data" in response ? response.data : null };
  }

  private readonly reviews = new WorkspaceReviews(() => JSON.stringify([this.catalog.epoch, this.id, this.runtimeRevision]));
  private reviewContext(worker: PiProcess, check: () => void): ResourceContext {
    const runtime = worker.interactionSnapshot().runtime!;
    return { sessionFile: this.catalog.sessionFile(this.id), cwd: runtime.cwd,
      workspaceRoot: typeof this.workspace?.path === "string" ? this.workspace.path : runtime.cwd,
      workspaceId: typeof this.workspace?.id === "string" ? this.workspace.id : undefined,
      workspacesRoot: join(this.catalog.root, "workspaces"), tempRoot: this.options.environment?.TMPDIR ?? tmpdir(),
      skillPaths: [], liveOutputPaths: this.conversation.outputPaths(), check };
  }
  private async editReview(command: SessionCommand & ReviewMutation, receipt: CommandReceipt, admission?: () => void): Promise<void> {
    let error: unknown;
    try {
      const worker = this.commandRuntime(command.runtimeRevision);
      const check = () => {
        admission?.(); this.control.authorize(command); this.commandRuntime(command.runtimeRevision, worker);
        if (!this.usableWorkspace()) throw new CommandError("session_unavailable", "Review context is transitioning");
      };
      check();
      await this.catalog.validateSessionFile(this.id);
      check();
      const context = this.reviewContext(worker, check);
      if (command.operation === "workspace.review.save") receipt.result = await this.reviews.save(context, command.payload);
      else {
        const operation = command.operation === "workspace.review.stage" ? "stage" : command.operation === "workspace.review.unstage" ? "unstage" : "restore";
        const result = await this.reviews.mutate(context, operation, command.payload.actionId, async (reviewRecovery) => {
          receipt.result = { reviewRecovery };
          await this.catalog.updateCommand(receipt);
          check();
        });
        receipt.result = { ...receipt.result, ...result };
      }
    } catch (failure) { error = failure; }
    await this.finishCommand(receipt, error);
  }
  private resourceReaders = 0;
  async resource(method: "resource.read" | "resource.complete", input: unknown, admission: () => void): Promise<unknown> {
    if (this.resourceReaders >= 4) throw new CommandError("session_busy", "Too many resource readers");
    this.resourceReaders++;
    try { return await this.resourceRead(method, input, admission); }
    finally { this.resourceReaders--; }
  }
  private async resourceRead(method: "resource.read" | "resource.complete", input: unknown, admission: () => void): Promise<unknown> {
    if (!object(input) || !Number.isSafeInteger(input.runtimeRevision)) throw new CommandError("invalid_command", "Missing resource context");
    const { runtimeRevision, ...payload } = input;
    const revision = Number(runtimeRevision), worker = this.commandRuntime(revision);
    const check = () => {
      admission(); this.commandRuntime(revision, worker);
      if (!this.usableWorkspace()) throw new CommandError("session_unavailable", "Resource context is transitioning");
    };
    check();
    await this.catalog.validateSessionFile(this.id);
    check();
    const skillPaths: string[] = [];
    if (payload.kind === "skill") {
      const response = await worker.request({ type: "get_commands" }, check);
      check();
      if (response.success && response.command === "get_commands") {
        for (const command of response.data.commands) {
          if (command.source === "skill" && command.sourceInfo?.path) skillPaths.push(command.sourceInfo.path);
        }
      }
    }
    const context: ResourceContext = { ...this.reviewContext(worker, check), skillPaths };
    const review = method === "resource.read" && typeof payload.kind === "string"
      && (payload.kind.startsWith("workspaceReview") || ["workspaceFile", "workspaceStats"].includes(payload.kind));
    const data = await (review ? this.reviews.read(context, payload) : method === "resource.read" ? readResource(context, payload) : completeFiles(context, payload));
    check();
    if (review && Buffer.byteLength(JSON.stringify(data)) > 4 * 1024 * 1024) throw new CommandError("resource_limit", "Review response exceeds 4 MiB");
    return { runtimeRevision: revision, data };
  }

  private assertSteeringActive(): void {
    if (!this.queueRunPending && !this.conversation.awaitingSettlement && !this.conversation.snapshot().execution.running) {
      throw new CommandError("session_busy", "Steering requires an active turn; retain the draft or use the main input");
    }
  }

  private assertNativeReady(command: NativeOperation): void {
    if (this.phase !== "ready" || !this.usableWorkspace()) throw new CommandError("session_unavailable", "Trust/workspace state is not ready");
    if (command.operation === "retry.abort" || command.operation === "shell.abort") return;
    if (this.rename || this.bundled || this.bundledInterrupt || this.nativePending || this.aborting) throw new CommandError("session_busy", "Another session operation is pending");
    if (command.operation === "steering.submit") this.assertSteeringActive();
    if (command.operation === "compaction.run" && (!this.conversation.settled || this.queueFlight || this.queueRunPending)) {
      throw new CommandError("session_busy", "Manual compaction requires settled execution");
    }
  }

  private async executeNative(command: SessionCommand & NativeOperation, receipt: CommandReceipt): Promise<void> {
    let error: unknown;
    try {
      const worker = this.commandRuntime(command.runtimeRevision);
      const response = await worker.request(nativeCommand(command), () => {
        this.commandRuntime(command.runtimeRevision, worker);
        this.assertReady(command.runtimeRevision);
        if (command.operation === "steering.submit" || command.operation === "followUp.submit") {
          if (this.aborting) throw new CommandError("session_busy", "Abort is clearing native queues; text retained in this command receipt");
          if (command.operation === "steering.submit") this.assertSteeringActive();
        }
      });
      this.commandRuntime(command.runtimeRevision, worker);
      if (command.operation === "steering.submit" || command.operation === "followUp.submit") {
        if ((response.command !== "steer" && response.command !== "follow_up") || !["queued", "handled"].includes(response.data.disposition)) throw new Error("Invalid native queue outcome");
        receipt.result = { ...receipt.result, disposition: response.data.disposition as "queued" | "handled" };
      } else if (command.operation === "shell.run") {
        if (response.command !== "bash") throw new Error("Invalid shell outcome");
        receipt.result = { ...receipt.result, exitCode: response.data.exitCode, cancelled: response.data.cancelled };
      }
      // Native responses positively acknowledge the specific command. Refresh
      // authoritative settings; never optimistically mutate a frontend snapshot.
      if (command.operation.endsWith(".set") || command.operation.endsWith(".mode") || command.operation.endsWith(".auto")) {
        await worker.request({ type: "get_state" }, () => { this.commandRuntime(command.runtimeRevision, worker); });
      }
    } catch (failure) { error = failure; }
    try { await this.finishCommand(receipt, error); }
    finally { this.nativePending--; this.scheduleQueue(); }
  }

  private async interruptQueue(code: string, message: string): Promise<void> {
    this.queueRecipients.clear();
    this.reservations.clear();
    const items = this.catalog.queue(this.id);
    let changed = false;
    for (const item of items) {
      if (item.status === "failed") continue;
      const sending = item.status === "sending";
      item.status = "failed"; item.revision++;
      item.error = { code: sending ? "delivery_uncertain" : code, message };
      changed = true;
    }
    this.queueFlight = undefined;
    this.queueRunPending = false;
    if (changed) { await this.catalog.replaceQueue(this.id, items); this.queueChanged(); }
  }

  private activity(): SessionActivity {
    const pending = this.worker?.interactionSnapshot().pending.some((item) => !item.submitted);
    const status = this.done ? "Stopped"
      : this.error || this.phase === "failed" ? "Error"
      : this.phase === "stopping" ? "Stopping"
      : pending ? "Waiting"
      : this.phase === "initializing" ? "Starting"
      : this.conversation.compacting ? "Compacting"
      : this.conversation.retrying ? "Retrying"
      : this.queueRunPending || this.conversation.continuationPending || !this.conversation.executionSettled ? "Working"
      : this.conversation.turnOutcome === "error" ? "Error"
      : this.conversation.turnOutcome === "completed" && this.conversation.completedTurns > this.viewedCompletionSeq ? "Done" : "Idle";
    const subagentRuns: SessionActivity["subagentRuns"] = [];
    const raw = this.conversation.status("pi-spawn-runs");
    if (raw) {
      try {
        const value: unknown = JSON.parse(raw);
        if (object(value) && Array.isArray(value.runs)) {
          for (const run of value.runs) {
            if (!object(run) || typeof run.runId !== "string" || typeof run.status !== "string"
              || (run.status !== "running" && run.writerOwned !== true)) continue;
            subagentRuns.push({ runId: run.runId, status: run.status,
              execution: typeof run.execution === "string" ? run.execution : undefined,
              writerOwned: run.writerOwned === true, readyForReview: run.readyForReview === true,
              agent: typeof run.agent === "string" ? run.agent : undefined,
              role: typeof run.role === "string" ? run.role : undefined,
              progress: typeof run.progress === "string" ? run.progress : undefined });
          }
        }
      } catch { /* A malformed extension status cannot change owner activity. */ }
    }
    return { status, completionSeq: this.conversation.completedTurns, turnOutcome: this.conversation.turnOutcome, subagentRuns };
  }

  private ownerState(): OwnedSessionState {
    return structuredClone({
      ...this.activity(), sessionId: this.id, serviceEpoch: this.catalog.epoch, runtimeRevision: this.runtimeRevision,
      phase: this.phase, trust: this.trust, workspace: this.workspace, piState: this.conversation.sessionState,
      interactions: this.worker?.interactionSnapshot() ?? { revision: 0, pending: [] }, controller: this.control.snapshot(),
      error: this.error?.message, exit: this.exit, startupTimings: this.startupTimings,
    });
  }

  /** Rechecked at the actual backpressured queue write position. */
  assertReady(runtimeRevision: number): void {
    if (runtimeRevision !== this.runtimeRevision) throw new Error("Stale session runtime revision");
    if (this.error || this.phase !== "ready" || !this.usableWorkspace()) throw new Error("Session trust/workspace startup is not ready");
  }

  private commandRuntime(revision: number, worker = this.worker): PiProcess {
    this.catalog.assertExecutionAllowed();
    if (revision !== this.runtimeRevision || worker !== this.worker) throw new CommandError("stale_runtime", "Command targets a replaced runtime");
    if (this.stopRequested || this.error || this.exit || !worker || !worker.interactionSnapshot().runtime?.active) {
      throw new CommandError("session_unavailable", "Session runtime is unavailable");
    }
    try { this.checkIdentity(); }
    catch { throw new CommandError("session_unavailable", "Managed session identity is not ready"); }
    return worker;
  }

  private interactionResponse(command: SessionCommand & { operation: "interaction.respond" | "interaction.cancel" }): RpcExtensionUIResponse {
    const pending = this.worker?.interactionSnapshot().pending.find((item) => item.request.id === command.payload.requestId && !item.submitted);
    if (!pending || (pending.tag?.deadline !== undefined && Date.now() >= pending.tag.deadline)) {
      throw new CommandError("interaction_resolved", "Interaction expired, resolved or was already answered");
    }
    if (command.operation === "interaction.cancel") return { type: "extension_ui_response", id: command.payload.requestId, cancelled: true };
    const answer = command.payload.answer;
    if (pending.request.method === "confirm" ? !("confirmed" in answer)
      : !("value" in answer) || (pending.request.method === "select" && !pending.request.options.includes(answer.value))) {
      throw new CommandError("invalid_command", "Answer does not match the pending interaction");
    }
    return { type: "extension_ui_response", id: command.payload.requestId, ...answer };
  }

  private trackCommand(task: Promise<void>): void {
    this.commands.add(task);
    void task.catch((error: unknown) => this.commandFailure(error)).finally(() => this.commands.delete(task));
  }

  private commandFailure(error: unknown): void {
    this.error = asError(error);
    this.control.revoke();
    if (this.worker) void this.worker.stop();
    this.changed();
  }

  private async finishCommand(receipt: CommandReceipt, error?: unknown): Promise<void> {
    const outcome = structuredClone(receipt);
    outcome.status = error ? (error instanceof CommandError || error instanceof PiCommandError && error.outcome === "rejected" ? "failed" : "uncertain") : "completed";
    if (error) outcome.error = error instanceof CommandError ? { code: error.code, message: error.message }
      : { code: outcome.status === "failed" ? "pi_rejected" : "delivery_uncertain", message: "Pi command did not produce a confirmed outcome; review command status before taking further action" };
    await this.catalog.updateCommand(outcome);
    this.publish({ command: outcome });
  }

  private async executeLifecycle(command: { runtimeRevision: number; operation: "session.kill" | "session.restart" }, receipt: CommandReceipt, closeAttachment?: string): Promise<void> {
    let error: unknown;
    try {
      // No takeover can cancel an already accepted kill/restart. Context and
      // storage still fence it; a new runtime must never be killed by an old ID.
      this.commandRuntime(command.runtimeRevision);
      if (command.operation === "session.restart") {
        const ready = new Promise<void>((resolve, reject) => { this.restartReady = { resolve, reject }; });
        this.restartRequested = true;
        this.requestStop();
        await ready;
      } else {
        this.requestStop();
        await this.running;
        if (this.cleanupError) throw this.cleanupError;
      }
    } catch (failure) { error = failure; }
    try {
      await this.finishCommand(receipt, error);
      if (!error && closeAttachment) this.publish({ closeFrontend: { attachmentId: closeAttachment, commandId: receipt.id } });
    } finally { this.lifecyclePending = false; }
  }

  private requestStop(): void {
    this.stopRequested = true;
    this.phase = "stopping";
    if (this.worker) void this.worker.stop();
    this.control.revoke();
    this.changed();
  }

  private async executeCommand(command: SessionCommand | Extract<ManagementCommand, { operation: "turn.abort" }>, receipt: CommandReceipt): Promise<void> {
    let error: unknown;
    try {
      const worker = this.commandRuntime(command.runtimeRevision);
      const guard = () => { this.commandRuntime(command.runtimeRevision, worker); };
      if (command.operation === "interaction.respond" || command.operation === "interaction.cancel") {
        await worker.respond(this.interactionResponse(command), worker.interactionSnapshot().runtime!.id, () => {
          guard(); this.interactionResponse(command);
        });
        receipt.result = { delivery: "flushed" };
      } else if (command.operation === "turn.abort") {
        await this.abortTurn(command.runtimeRevision, worker, receipt);
      }
    } catch (failure) { error = failure; }
    await this.finishCommand(receipt, error);
  }

  private async abortTurn(revision: number, worker: PiProcess, receipt: CommandReceipt): Promise<void> {
    const state = this.conversation.snapshot();
    const active = this.queueRunPending || this.conversation.awaitingSettlement || state.execution.running || state.piState?.isCompacting || state.execution.compaction?.type === "compaction_start"
      || state.execution.retry?.type === "auto_retry_start" || !!state.execution.summarization;
    this.aborting++;
    try {
      // Idle Escape still explicitly cancels main dialogs. Side operations keep
      // their own lifetimes; detach/takeover never comes through this path.
      await this.cancelMainInteractions(revision, worker);
      // Pi input hooks may finish enqueueing after settlement or clear_queue.
      // Drain only accepted native submissions before clearing, never replay them.
      await Promise.all(this.nativeQueueCommands);
      const guard = () => { this.commandRuntime(revision, worker); };
      let clearingError: unknown;
      try {
        const cleared = await worker.request({ type: "clear_queue" }, guard);
        if (cleared.command !== "clear_queue" || !object(cleared.data)
          || !Array.isArray(cleared.data.steering) || !Array.isArray(cleared.data.followUp)
          || ![...cleared.data.steering, ...cleared.data.followUp].every((text) => typeof text === "string")) {
          throw new Error("Invalid native queue clearing response");
        }
        receipt.result = { ...(!active ? { idle: true } : {}), cleared: { steering: cleared.data.steering, followUp: cleared.data.followUp } };
        // Preserve returned text before abort. No automatic editor effect/replay.
        await this.catalog.updateCommand(receipt);
        this.publish({ command: structuredClone(receipt) });
      } catch (error) {
        if (!(error instanceof PiCommandError && error.outcome === "rejected")) throw error;
        clearingError = error;
      }
      // Existing behavior attempts abort even after native clear_queue rejection.
      try { await this.cancelSubagents(revision, worker); }
      finally { await worker.request({ type: "abort" }, guard); }
      if (clearingError) throw clearingError;
    } finally { this.aborting--; this.scheduleQueue(); }
  }

  private async cancelSubagents(revision: number, worker: PiProcess): Promise<void> {
    const guard = () => { this.commandRuntime(revision, worker); };
    const discovery = await worker.request({ type: "get_commands" }, guard);
    const name = "pi-console-spawn-cancel";
    if (discovery.command !== "get_commands" || discovery.data.commands.filter((command) => command.name === name
      && command.source === "extension" && command.sourceInfo?.path === join(this.options.appRoot, "pi", "extensions", "spawn.ts")).length !== 1) {
      throw new CommandError("unsupported_command", "Subagent cancellation capability is missing or ambiguous");
    }
    guard();
    const invocationId = randomUUID();
    const runtimeId = worker.interactionSnapshot().runtime!.id;
    const flight: SubagentCancellation = { runtimeId, message: `/${name} ${JSON.stringify({ version: 1, invocationId,
      runtimeId, sessionId: this.record.piSessionId, sessionFile: this.catalog.sessionFile(this.id), payload: {} })}` };
    this.subagentCancellations.set(invocationId, flight);
    try {
      const response = await worker.request({ type: "prompt", message: flight.message }, guard);
      if (response.command !== "prompt" || response.data.disposition !== "handled"
        || flight.result?.status !== "completed" || flight.result.data?.changed !== true) {
        throw new Error("Subagent cancellation did not confirm cleanup; inspect retained work before changing history");
      }
    } finally { this.subagentCancellations.delete(invocationId); }
  }

  private async cancelMainInteractions(revision: number, worker: PiProcess): Promise<void> {
    for (const pending of worker.interactionSnapshot().pending) {
      if (pending.submitted || sideInteraction(pending.request.title)) continue;
      this.commandRuntime(revision, worker);
      // A concurrently answered/closed dialog is not an abort failure.
      if (!worker.interactionSnapshot().pending.some((item) => item.request.id === pending.request.id && !item.submitted)) continue;
      try {
        await worker.respond({ type: "extension_ui_response", id: pending.request.id, cancelled: true }, pending.runtimeId, () => {
          this.commandRuntime(revision, worker);
          if (!worker.interactionSnapshot().pending.some((item) => item.request.id === pending.request.id && !item.submitted)) {
            throw new CommandError("interaction_resolved", "Interaction already closed or answered");
          }
        });
      } catch (error) {
        if (!(error instanceof CommandError && error.code === "interaction_resolved")) throw error;
      }
    }
  }

  /** Shared storage failure retires all workers without another durable write. */
  storageFailed(error: Error): void {
    if (this.done) return;
    this.error ??= error;
    // Revoking control must not read a possibly broken database to publish a pause.
    this.reservations.clear(false);
    // Cleanup failure remains on this session; observers may still await stop().
    void this.stop().catch(() => undefined);
  }

  stopBlockReason(): string | undefined {
    if (this.lifecyclePending) return `Session ${this.id} has a pending lifecycle outcome; stop refused`;
    if (this.done) return;
    if (this.phase !== "ready" || this.stopRequested || !this.usableWorkspace() || !this.conversation.settled
      || this.admitting || this.commands.size || this.lifecyclePending || this.bundled || this.nativePending || this.aborting || this.rename || this.queueFlight || this.queueRunPending
      || this.worker?.interactionSnapshot().pending.length || this.catalog.queue(this.id).some((item) => item.status !== "failed")) {
      return `Session ${this.id} has active work, approval, accepted queue or transition; stop refused`;
    }
  }

  /** Explicit owner shutdown, not frontend detach or a guarded service-stop API. */
  async stop(): Promise<void> {
    if (!this.done) {
      // Administrative shutdown supersedes a pending session restart.
      this.serviceStopping = true;
      this.restartRequested = false;
      this.requestStop();
    }
    await this.running;
    await this.lifecycle;
    if (this.cleanupError) throw this.cleanupError;
  }

  private async run(): Promise<void> {
    for (;;) {
      await this.runOnce();
      if (!this.restartRequested || this.cleanupError) {
        this.restartReady?.reject(this.cleanupError ?? this.error ?? new Error("Session restart did not reach readiness"));
        this.restartReady = undefined;
        return;
      }
      this.restartRequested = false;
      this.stopRequested = false;
      this.done = false;
      this.phase = "initializing";
      this.error = undefined;
      this.exit = undefined;
      this.changed();
    }
  }

  private async runOnce(): Promise<void> {
    const started = performance.now();
    this.startupTimings = { validationMs: 0, workerMs: 0, historyMs: 0 };
    let owned = false;
    try {
      const header = await this.catalog.validateSessionFile(this.id);
      this.checkRunning();
      await this.catalog.claimOwnership(this.id);
      owned = true;
      this.checkRunning();
      this.startupTimings.validationMs = performance.now() - started;
      // Only one trust-driven process replacement is permitted per startup.
      for (let replacement = 0; ; replacement++) {
        await this.catalog.validateSessionFile(this.id);
        this.checkRunning();
        this.catalog.assertLaunchAllowed();
        this.workerRevision = 0;
        this.trust = undefined;
        this.workspace = undefined;
        this.exit = undefined;
        const workerOptions: PiProcessOptions = {
          binary: this.options.binary, appRoot: this.options.appRoot, cwd: header.cwd,
          sessionDirectory: join(this.catalog.root, "sessions"), workspaceRoot: join(this.catalog.root, "workspaces"),
          session: { file: this.catalog.sessionFile(this.id) }, environment: this.options.environment,
          provider: this.options.provider, model: this.options.model,
          assertExecutionAllowed: () => this.catalog.assertExecutionAllowed(),
          onEvent: (event) => this.event(event),
          onDispatch: (command) => this.dispatch(command),
          onResponse: (response, command) => this.response(response, command),
          onInteractionChange: () => this.changed(),
          onExit: (exit) => {
            this.exit = exit;
            this.captures.clear();
            this.syncRevision();
            this.retain({ type: "runtime_ended" });
            this.changed();
          },
        };
        const workerStarted = performance.now();
        this.worker = new PiProcess(workerOptions);
        this.changed();
        const restart = await this.initialize(this.worker);
        this.startupTimings.workerMs += performance.now() - workerStarted;
        this.checkRunning();
        if (!restart) break;
        if (replacement >= 1) throw new Error("Project trust repeatedly requested a Pi restart");
        const exit = await this.worker.stop();
        this.syncRevision();
        if (exit.error || exit.code !== 0 || exit.descendantsUnresolved) throw new Error("Pi managed work did not finish cleanly for project trust replacement");
        this.exit = undefined;
      }
      const historyStarted = performance.now();
      await this.refreshConversation();
      this.startupTimings.historyMs = performance.now() - historyStarted;
      this.checkRunning();
      if (!this.conversation.hydrated) throw new Error("Pi conversation did not reach a stable startup snapshot");
      this.phase = "ready";
      this.changed();
      this.resolveReady();
      this.restartReady?.resolve();
      this.restartReady = undefined;
      const exit = await this.worker!.waitForExit();
      if (!this.stopRequested) throw new Error(exit.error ?? "Pi exited unexpectedly");
    } catch (error) {
      if (!this.stopRequested) this.error = asError(error);
    } finally {
      try {
        if (this.worker) {
          this.exit = await this.worker.stop();
          this.syncRevision();
          if (this.exit.descendantsUnresolved) throw new Error("Known Pi managed work remains unresolved; retain session ownership for recovery");
          if (this.exit.error || this.exit.code !== 0) this.error ??= new Error(this.exit.error ?? "Pi exited abnormally");
        }
        // A failed ownership claim may have an uncertain commit: never undo it.
        // stop() awaits the managed supervisor's terminal evidence. Unknown
        // escaped work remains outside the explicitly best-effort guarantee.
        await this.admission;
        await Promise.allSettled([...this.commands]);
        await this.admission;
        await this.interruptQueue("session_stopped", "Session stopped; review accepted work before explicitly editing/resubmitting");
        if (owned) await this.catalog.releaseOwnership(this.id, this.error ? "error" : this.serviceStopping ? "service_shutdown" : undefined);
      } catch (error) {
        this.cleanupError = asError(error);
        this.error = new Error("Session ownership cleanup failed; recovery is required", { cause: error });
      }
      this.control.revoke();
      this.phase = this.error ? "failed" : "stopped";
      this.done = true;
      this.rejectReady(this.error ?? new Error("Session stopped before startup completed"));
      this.changed();
    }
  }

  private async initialize(worker: PiProcess): Promise<boolean> {
    // Workspace publication can queue a same-child cwd/runtime replacement.
    // Repeat initialization against that fresh context, never against a view.
    for (let pass = 0; pass < 8; pass++) {
      await worker.ready();
      await this.refreshConversation();
      this.checkIdentity();
      this.checkRunning();
      const revision = this.runtimeRevision;
      const commands = await worker.request({ type: "get_commands" });
      if (commands.command !== "get_commands") throw new Error("Unexpected Pi command discovery response");
      for (const name of ["pi-trust-setup", "pi-workspace-publish"]) {
        if (!commands.data.commands.some((command) => command.name === name && command.source === "extension")) {
          throw new Error(`Required pi-console extension command is missing: ${name}`);
        }
      }
      this.trust = undefined;
      this.changed();
      const trustReply = await worker.request({ type: "prompt", message: "/pi-trust-setup" });
      this.checkRunning();
      const trust = this.trust as TrustStatus | undefined;
      if (trustReply.command !== "prompt" || trustReply.data.disposition !== "handled" || !trust || trust.state === "error") {
        throw new Error(trust?.error ?? "Project trust setup returned no completed result");
      }
      this.checkStatusIdentity(trust);
      if (trust.state === "restart") return true;
      if (trust.state !== "ready") throw new Error("Project trust setup did not finish");
      this.workspace = undefined;
      this.changed();
      const published = await worker.request({ type: "prompt", message: "/pi-workspace-publish" });
      if (published.command !== "prompt" || published.data.disposition !== "handled") throw new Error("Workspace publication was not handled");
      this.checkRunning();
      if (!(this.workspace as WorkspaceStatus | undefined)) throw new Error("Workspace publication returned no status");
      while (this.workspacePending()) {
        this.checkRunning();
        await new Promise<void>((resolve) => { this.wake = resolve; });
      }
      this.checkRunning();
      // Restoration replaces the cwd-bound runtime and clears its Pi state.
      // Hydrate that new context on the next pass before validating identity.
      if (revision !== this.runtimeRevision) continue;
      this.checkIdentity();
      if (!this.usableWorkspace()) throw new Error("Pi trust/workspace state does not match its active runtime");
      return false;
    }
    throw new Error("Workspace startup did not reach a stable runtime");
  }

  private event(event: PiEvent): void {
    if (event.type === "extension_ui_request" && event.method === "setStatus" && event.statusKey === DESKTOP_NOTIFICATION_STATUS) {
      let notification: unknown;
      try { notification = JSON.parse(event.statusText ?? "null"); } catch { return; }
      if (validDesktopNotification(notification)) this.notify({ id: notification.id, kind: notification.kind, title: notification.title, body: notification.body });
      return; // Never retain or replay desktop intents as conversation statuses/effects.
    }
    const previousRevision = this.runtimeRevision;
    this.syncRevision();
    if (event.type === "extension_ui_request" && event.method === "setStatus" && event.statusKey === "pi-workspace-continuation"
      && event.statusText !== undefined && event.statusText !== "pending" && event.statusText !== "starting") {
      throw new Error("Invalid Pi workspace continuation status");
    }
    if (event.type === "extension_ui_request" && event.method === "setStatus" && event.statusKey === "pi-history-changed") {
      // Branch/history edits can keep the same Pi runtime UUID. Fence queued
      // text and deferred commands against that changed conversation context.
      this.runtimeRevision++;
    }
    if (event.type === "agent_settled") {
      this.queueRunPending = false;
      if (this.queueFlight?.dispatched) this.queueFlight.settled = true;
    }
    const flight = this.queueFlight;
    if (event.type === "message_end" && event.message.role === "user" && flight?.dispatched
      && flight.outcome && "disposition" in flight.outcome && flight.outcome.disposition === "started" && !flight.observedMessage) {
      flight.observedMessage = messageKey(event.message);
    }
    if (event.type === "extension_ui_request" && event.method === "setStatus" && event.statusKey === "pi-console-runtime") {
      const runtime = this.worker?.interactionSnapshot().runtime;
      if (!runtime?.active) this.retain({ type: "runtime_ended", preserveContinuation: true });
      else if (previousRevision !== this.runtimeRevision) {
        // Preserve statuses already published during extension binding. Pi binds
        // extensions before subscribing to the new runtime's session events.
        this.retain({ type: "invalidate_history" });
        if (this.phase === "ready") this.scheduleRefresh();
      }
    }
    if (event.type === "extension_error") {
      if (event.event === "command") {
        this.offerEffect({ type: "notification", level: "error", message: `${event.extensionPath}: ${event.error}` });
      } else this.error ??= new Error(`Pi extension failed during session execution: ${event.error}`);
    }
    if (event.type === "extension_ui_request" && event.method === "setStatus") {
      if (event.statusKey === "pi-project-trust" || event.statusKey === "pi-workspace") {
        const value: unknown = typeof event.statusText === "string" ? JSON.parse(event.statusText) : undefined;
        if (!object(value) || typeof value.cwd !== "string" || !isAbsolute(value.cwd) || typeof value.sessionFile !== "string") {
          throw new Error("Invalid Pi startup status");
        }
        // Bundled trust can publish during binding after old-runtime stop but
        // before service.ts announces the incoming runtime. Attribute only fresh
        // publications in that inactive gap to the next adapter revision.
        const statusRevision = this.workerRevision + (this.worker?.interactionSnapshot().runtime?.active ? 0 : 1);
        if (event.statusKey === "pi-project-trust") {
          if (!["pending", "ready", "restart", "error"].includes(String(value.state))
            || (value.error !== undefined && typeof value.error !== "string")) throw new Error("Invalid Pi trust status");
          this.trust = value as TrustStatus;
          this.trustWorkerRevision = statusRevision;
        } else {
          if (typeof value.transitionPending !== "boolean") throw new Error("Invalid Pi workspace transition status");
          this.workspace = value as WorkspaceStatus;
          this.workspaceWorkerRevision = statusRevision;
        }
      }
    }
    if (event.type === "extension_ui_request" && event.method === "setStatus" && event.statusKey === OPERATION_RESULT) {
      const result = operationResult(event.statusText);
      const cancellation = this.subagentCancellations.get(result.invocationId);
      if (cancellation) {
        if (cancellation.result || result.runtimeId !== cancellation.runtimeId || result.sessionId !== this.record.piSessionId
          || result.sessionFile !== this.catalog.sessionFile(this.id)) throw new Error("Unmatched subagent cancellation result");
        cancellation.result = result;
        return;
      }
      const flight = [this.bundled, this.bundledInterrupt].find((flight) => flight?.invocationId === result.invocationId);
      if (!flight?.dispatched || flight.result || result.invocationId !== flight.invocationId || result.runtimeId !== flight.runtimeId
        || result.sessionId !== this.record.piSessionId || result.sessionFile !== this.catalog.sessionFile(this.id)) throw new Error("Unmatched managed operation result");
      flight.result = result;
      flight.resultRevision = this.runtimeRevision;
      return;
    }
    if (event.type === "extension_ui_request" && event.method === "setStatus" && event.statusKey === RENAME_RESULT) {
      this.consumeRenameResult(event.statusText);
      return; // Private result: neither snapshot state nor a frontend effect.
    }
    if (event.type === "extension_ui_request" && event.method === "setStatus" && typeof event.statusText === "string") {
      if (event.statusKey === "pi-spawn-runs") {
        try {
          const payload: unknown = JSON.parse(event.statusText);
          if (object(payload) && Array.isArray(payload.runs)) {
            const ids = new Set<string>();
            for (const run of payload.runs) if (object(run) && typeof run.runId === "string") {
              ids.add(run.runId);
              if (!this.spawnRecipients.has(run.runId)) this.spawnRecipients.set(run.runId,
                run.status === "running" && !this.conversation.idle && !this.mainEffectsAmbiguous ? this.turnRecipient ?? undefined : undefined);
            }
            for (const id of this.spawnRecipients.keys()) if (!ids.has(id)) this.spawnRecipients.delete(id);
          }
        } catch { /* Retained state is still data, never an instruction to replay. */ }
      }
    }
    // Persist conversation activity, never token deltas or status polling.
    if (event.type === "message_start" || event.type === "message_end" || event.type === "compaction_end" || event.type === "session_info_changed"
      || event.type === "extension_ui_request" && event.method === "setStatus" && event.statusKey === "pi-history-changed") {
      this.trackCommand(this.catalog.updateActivity(this.id));
    }
    if (event.type === "session_info_changed") this.trackCommand(this.catalog.updateTitle(this.id, event.name));
    const change = this.conversation.event(event);
    if (change) {
      if (change.type === "notification" || change.type === "editor_text" || change.type === "extension_signal") {
        this.offerEffect(change);
      } else this.retain(change);
    }
    if (dialogRequest(event) && this.aborting && !sideInteraction(event.title) && this.worker) {
      const worker = this.worker;
      const revision = this.runtimeRevision;
      // Run after the current stdout batch, with fresh liveness/runtime checks.
      this.trackCommand(Promise.resolve().then(async () => {
        if (this.aborting) await this.cancelMainInteractions(revision, worker);
      }).catch((error: unknown) => {
        if (!(error instanceof CommandError && ["stale_runtime", "session_unavailable"].includes(error.code))) throw error;
      }));
    }
    if (dialogRequest(event) || event.type === "extension_error"
      || (event.type === "extension_ui_request" && event.method === "setStatus"
        && ["pi-console-runtime", "pi-console-dialog", "pi-project-trust", "pi-workspace", "pi-workspace-continuation"].includes(event.statusKey))) this.changed();
    if (event.type === "agent_settled" || event.type === "compaction_end"
      || (event.type === "extension_ui_request" && event.method === "setStatus" && event.statusKey === "pi-history-changed")) {
      this.retain({ type: "invalidate_history" });
      this.scheduleRefresh();
    }
    if (event.type === "agent_settled" || event.type === "compaction_end" || event.type === "auto_retry_end"
      || event.type === "summarization_retry_finished" || event.type === "queue_update"
      || event.type === "message_end" && event.message.role === "user"
      || event.type === "extension_ui_request" && event.method === "setStatus" && event.statusKey === "pi-workspace-continuation") this.scheduleQueue();
  }

  private dispatch(command: RpcCommand & { id: string }): void {
    const cancellation = [...this.subagentCancellations.values()].find((flight) => command.type === "prompt" && command.message === flight.message);
    if (cancellation) {
      cancellation.requestId = command.id;
      return;
    }
    const flight = [this.bundled, this.bundledInterrupt].find((flight) => flight?.dispatched && command.type === "prompt" && command.message === flight.message);
    if (flight) {
      flight.requestId = command.id;
      return;
    }
    if (this.rename?.dispatched && command.type === "prompt" && command.message === this.rename.message) {
      this.rename.requestId = command.id;
      return; // Do not materialize the private command envelope as user work.
    }
    if (command.type === "prompt") {
      // Only a committed editable-queue flight supplies main-turn provenance.
      // Missing provenance must not fall back to whoever controls dispatch now.
      if (this.queueFlight?.dispatched) this.queueFlight.requestId = command.id;
      this.turnRecipient = this.queueFlight?.dispatched ? this.queueFlight.recipient ?? null : null;
      if (this.queueFlight?.dispatched && this.conversation.settled && !this.nativePending && !this.nativeQueueCommands.size) this.mainEffectsAmbiguous = false;
    } else if (command.type === "steer" || command.type === "follow_up") {
      // Native messages may continue inside the same Pi run, before public user
      // events and without another dispatch. Preserve turnRecipient but suppress
      // ambiguous effects until a fresh, fully settled ordinary prompt boundary.
      this.mainEffectsAmbiguous = true;
    }
    const work = this.conversation.dispatch(command);
    if (work) this.retain({ type: "work", work });
    if ((command.type === "get_messages" || command.type === "get_session_stats") && this.worker && this.conversation.idle) {
      this.captures.set(command.id, { worker: this.worker, revision: this.runtimeRevision, version: this.conversation.historyVersion });
    }
  }

  private response(response: RpcResponse, command: RpcCommand & { id: string }): void {
    if ([...this.subagentCancellations.values()].some((flight) => response.id === flight.requestId)) return;
    if (response.id === this.rename?.requestId || response.id === this.bundled?.requestId || response.id === this.bundledInterrupt?.requestId) return;
    // Prompt acceptance precedes its user events in Pi's stdout stream. Record
    // it synchronously, before a later event in the same batch is reduced.
    const flight = this.queueFlight;
    if (flight && response.id === flight.requestId && response.success && response.command === "prompt"
      && (response.data.disposition === "started" || response.data.disposition === "handled")) {
      flight.outcome = { disposition: response.data.disposition };
    }
    if (response.success && response.command === "get_state") {
      if (response.data.sessionId === this.record.piSessionId && response.data.sessionFile === this.catalog.sessionFile(this.id)) {
        this.trackCommand(this.catalog.updateTitle(this.id, response.data.sessionName));
      }
      this.retain({ type: "pi_state", state: response.data });
      this.changed();
    }
    if (command.type === "get_messages" || command.type === "get_session_stats") {
      const capture = this.captures.get(command.id);
      this.captures.delete(command.id);
      if (response.success && capture && capture.worker === this.worker
        && capture.revision === this.runtimeRevision && capture.version === this.conversation.historyVersion && this.conversation.idle) {
        if (response.command === "get_messages") this.retain({ type: "history", messages: response.data.messages });
        if (response.command === "get_session_stats") this.retain({ type: "session_stats", stats: response.data });
      } else this.refreshAgain = true;
    }
    this.scheduleQueue();
    const work = this.conversation.response(response);
    if (work) this.retain({ type: "work", work });
    if (command.type === "bash" || command.type === "prompt" && response.success
      && response.command === "prompt" && response.data.disposition === "handled") {
      // Handled slash commands need no agent_settled event to publish their changes.
      this.retain({ type: "invalidate_history" });
      this.scheduleRefresh();
    }
  }

  /** Reconcile only at idle boundaries: get_messages has no atomic active-run
   * snapshot contract. The version fence rejects interleaving live events.
   */
  private refreshConversation(): Promise<void> {
    if (this.refresh) { this.refreshAgain = true; return this.refresh; }
    const worker = this.worker;
    if (!worker || !this.conversation.idle || this.stopRequested || this.exit) return Promise.resolve();
    this.refresh = (async () => {
      do {
        this.refreshAgain = false;
        const revision = this.runtimeRevision;
        await worker.request({ type: "get_state" });
        if (worker !== this.worker || revision !== this.runtimeRevision) { this.refreshAgain = true; return; }
        if (this.conversation.sessionState?.isStreaming || !this.conversation.idle) return;
        await worker.request({ type: "get_session_stats" });
        if (worker !== this.worker || revision !== this.runtimeRevision) { this.refreshAgain = true; return; }
        if (!this.conversation.idle) return;
        await worker.request({ type: "get_messages" });
      } while (this.refreshAgain && worker === this.worker && this.conversation.idle && !this.stopRequested && !this.exit);
    })().catch((error: unknown) => { this.refreshAgain = false; throw error; }).finally(() => {
      this.refresh = undefined;
      // A settlement/runtime signal can arrive while get_state is pending or in
      // the same stdout batch as its response. Do not lose that coalesced read.
      if (this.refreshAgain && this.conversation.idle && !this.stopRequested && !this.exit) this.scheduleRefresh();
    });
    return this.refresh;
  }

  private scheduleRefresh(): void {
    // Defer dispatch until the current stdout batch has finished reducing. A
    // rejected refresh fences the owner; it never retries an execution command.
    void Promise.resolve().then(() => this.refreshConversation()).catch((error: unknown) => {
      if (this.stopRequested || this.exit) return;
      this.error = asError(error);
      if (this.worker) void this.worker.stop();
      this.changed();
    });
  }

  private retain(change: ConversationChange): void {
    this.conversation.apply(structuredClone(change));
    this.publish({ conversation: change });
  }

  private publish(change: Pick<OwnedSessionUpdate, "owner" | "conversation" | "effect" | "command" | "acceptedQueue" | "closeFrontend">): void {
    const update: OwnedSessionUpdate = {
      sessionId: this.id, serviceEpoch: this.catalog.epoch, runtimeRevision: this.runtimeRevision,
      sequence: ++this.sequence, ...change,
    };
    if (!this.viewers.size) return;
    this.publications.push(JSON.stringify(update));
    if (this.publishing) return;
    this.publishing = true;
    try {
      // Dropping a slow controller revokes its grant synchronously, which can
      // publish again. Finish this fanout before delivering that newer sequence.
      for (let line = this.publications.shift(); line !== undefined; line = this.publications.shift()) {
        for (const viewer of this.viewers) viewer.push(line);
      }
    } finally { this.publishing = false; }
  }

  private syncRevision(): void {
    const revision = this.worker?.interactionSnapshot().revision ?? 0;
    if (revision !== this.workerRevision) {
      this.queueRunPending = false;
      this.turnRecipient = undefined;
      this.mainEffectsAmbiguous = false;
      this.queueRecipients.clear();
      this.spawnRecipients.clear();
    }
    this.runtimeRevision += revision - this.workerRevision;
    this.workerRevision = revision;
  }

  private checkIdentity(): void {
    const runtime = this.worker?.interactionSnapshot().runtime;
    const state = this.conversation.sessionState;
    if (!runtime?.active || runtime.sessionId !== this.record.piSessionId || runtime.sessionFile !== this.catalog.sessionFile(this.id)
      || state?.sessionId !== this.record.piSessionId || state.sessionFile !== this.catalog.sessionFile(this.id)) {
      throw new Error("Pi runtime changed managed conversation identity or became unavailable");
    }
  }

  private checkStatusIdentity(status: { cwd: string; sessionFile: string }): void {
    const runtime = this.worker?.interactionSnapshot().runtime;
    if (!runtime?.active || status.cwd !== runtime.cwd || status.sessionFile !== runtime.sessionFile) throw new Error("Pi startup status targets a different runtime");
  }

  private workspacePending(): boolean { return this.workspace?.transitionPending === true; }

  private usableWorkspace(): boolean {
    const runtime = this.worker?.interactionSnapshot().runtime;
    return !!runtime?.active && runtime.sessionId === this.record.piSessionId && runtime.sessionFile === this.catalog.sessionFile(this.id)
      && this.trustWorkerRevision === this.workerRevision && this.workspaceWorkerRevision === this.workerRevision
      && this.trust?.state === "ready" && this.trust.cwd === runtime.cwd && this.trust.sessionFile === runtime.sessionFile
      && this.workspace?.transitionPending === false && this.workspace.cwd === runtime.cwd && this.workspace.sessionFile === runtime.sessionFile;
  }

  private checkRunning(): void {
    this.catalog.assertExecutionAllowed();
    if (this.stopRequested) throw new Error("Session startup was stopped");
    if (this.error) throw this.error;
    if (this.exit) throw new Error(this.exit.error ?? "Pi exited during startup");
  }

  private changed(): void {
    this.publish({ owner: this.ownerState() });
    this.scheduleQueue();
    const wake = this.wake;
    this.wake = undefined;
    wake?.();
  }
}

function contextOperation(operation: string): boolean {
  return operation === "history.navigate" || operation === "history.delete" || operation.startsWith("workspace.");
}

function sideInteraction(title: string): boolean {
  try { const value: unknown = JSON.parse(title); return object(value) && typeof value.sideDialogId === "string"; }
  catch { return false; }
}

class QueueDeferred extends Error {}
function queueError(error: unknown): { code: string; message: string } {
  if (error instanceof CommandError) return { code: error.code, message: error.message };
  if (error instanceof PiCommandError && error.outcome === "rejected") return { code: "pi_rejected", message: error.message };
  return { code: "delivery_uncertain", message: "Prompt delivery is uncertain; inspect the conversation before editing/resubmitting" };
}

function asError(error: unknown): Error { return error instanceof Error ? error : new Error(String(error)); }
