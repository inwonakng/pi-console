import { open } from "node:fs/promises";
import { hostCommand, hostFingerprint, type HostReceipt } from "./host-commands.js";
import { inspectEpoch } from "../../pi/scripts/managed-process.mjs";
import { randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";
import type { RpcCommand, RpcExtensionUIResponse, RpcResponse, RpcSessionState } from "@earendil-works/pi-coding-agent";
import { PiCommandError, PiProcess, type PiExit, type PiProcessOptions } from "./pi-process.js";
import type { InteractionSnapshot } from "./pi-interactions.js";
import { dialogRequest, object, type PiEvent } from "./pi-records.js";
import { PiConversation, type ConversationChange, type ConversationSnapshot, type FrontendEffect } from "./pi-conversation.js";
import { SessionSubscription } from "./session-subscription.js";
import { CommandError, SessionControl, commandFingerprint, sessionCommand, type CommandReceipt, type Controller,
  type ControlGrant, type SessionCommand } from "./session-commands.js";
import { SessionCatalog, type CatalogSession, type Channel } from "./session-catalog.js";
import { QueueReservations, editableItem, type AcceptedQueueItem, type AcceptedQueueSnapshot } from "./session-queue.js";
import { RENAME_COMMAND, RENAME_RESULT, renameResult, type RenameResult } from "./session-rename.js";
import { prepareHostResources, type HostResources } from "./host-resources.js";
import { isNative, nativeCommand, readCommand, validRead, type NativeOperation } from "./session-operations.js";
import { isBundled, BUNDLED_SOURCES, OPERATION_RESULT, operationCommand, operationResult, type BundledOperation, type OperationResult } from "./session-bundled.js";

type TrustStatus = { state: "pending" | "ready" | "restart" | "error"; cwd: string; sessionFile: string; error?: string };
type WorkspaceStatus = { cwd: string; sessionFile: string; transitionPending: boolean; [key: string]: unknown };
type BundledFlight = {
  worker: PiProcess; revision: number; runtimeId: string; invocationId: string; operation: BundledOperation["operation"];
  message: string; dispatched: boolean; requestId?: string; result?: OperationResult; recipient?: Controller;
};
type RenameFlight = {
  worker: PiProcess; revision: number; runtimeId: string; invocationId: string;
  message: string; dispatched: boolean; requestId?: string; result?: RenameResult;
};
export type OwnedSessionState = {
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
};
export type OwnedSessionSnapshot = OwnedSessionState & { sequence: number; conversation: ConversationSnapshot; commands: CommandReceipt[]; acceptedQueue: AcceptedQueueSnapshot };
export type EffectOffer = {
  id: string; policy: "inspect_only"; source: "owned_pi_stream";
  recipient: { attachmentId: string; grantId: string };
  runtimeId: string; cwd: string; data: FrontendEffect;
};
export type OwnedSessionUpdate = {
  sessionId: string;
  serviceEpoch: string;
  runtimeRevision: number;
  sequence: number;
  owner?: OwnedSessionState;
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

/** Private host composition, not a daemon or an authenticated application API. */
export class HostOwner {
  private readonly sessions = new Map<string, OwnedSession>();
  private creating = 0;
  private closing = false;
  private hostAdmission: Promise<void> = Promise.resolve();
  private hostAdmitting = 0;

  private constructor(private readonly catalog: SessionCatalog, private readonly options: HostOwnerOptions & { environment: NodeJS.ProcessEnv }, private readonly resources: HostResources) {
    void catalog.whenFailed.then((error) => {
      for (const session of this.sessions.values()) session.storageFailed(error);
    });
  }

  static async open(options: HostOwnerOptions): Promise<HostOwner> {
    if (!isAbsolute(options.binary) || !isAbsolute(options.appRoot)) throw new Error("Owner launch paths must be absolute");
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
  list(): CatalogSession[] { return this.catalog.list(); }

  /** Lookup never starts a worker or repeats trust/workspace initialization. */
  lookup(id: string): OwnedSession | undefined { return this.sessions.get(id); }

  async create(cwd: string): Promise<OwnedSession> {
    this.assertOpen();
    this.catalog.assertExecutionAllowed();
    this.creating++;
    try { return this.resume((await this.catalog.create(cwd)).id); }
    finally { this.creating--; }
  }

  /** Register synchronously, before any file checks, commits or child startup. */
  resume(id: string): OwnedSession {
    this.assertOpen();
    this.catalog.assertExecutionAllowed();
    const previous = this.sessions.get(id);
    if (previous && !previous.finished) return previous;
    const record = this.catalog.get(id);
    if (record.state === "open") throw new Error("Session has unresolved ownership; recovery is required");
    const previousState = previous?.snapshot();
    const session = new OwnedSession(this.catalog, record, this.options, this.resources, previousState?.runtimeRevision ?? 0, previousState?.sequence ?? 0);
    this.sessions.set(id, session);
    return session;
  }

  hostStatus(epoch: string, id: string): HostReceipt | { status: "unknown" } {
    const receipt = this.catalog.hostRecord(epoch, id)?.receipt;
    return receipt?.operation === "host.create" || receipt?.operation === "host.resume" ? receipt : { status: "unknown" };
  }

  /** Host IDs are disk identities, not connection IDs. Duplicate lookups never
   * resume a now-stopped worker or repeat initialization. */
  command(input: unknown): Promise<HostReceipt> {
    const command = hostCommand(input);
    if (command.serviceEpoch !== this.serviceEpoch) throw new CommandError("stale_epoch", "Host command belongs to another service epoch");
    this.assertOpen();
    if (this.hostAdmitting >= 128) throw new CommandError("command_limit", "Host admission limit exceeded");
    this.hostAdmitting++;
    const task = this.hostAdmission.then(async () => {
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
        const record = await this.catalog.create(command.payload.cwd, { fingerprint, receipt });
        sessionId = record.id;
        // The allocation receipt is already committed before any worker launch.
        this.resume(sessionId);
        return this.catalog.hostRecord(command.serviceEpoch, command.id)!.receipt;
      }
      this.catalog.get(command.payload.sessionId);
      await this.catalog.reserveHost(fingerprint, receipt);
      try {
        sessionId = this.resume(command.payload.sessionId).id;
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
      throw new Error("Stop owned sessions before closing the host owner");
    }
    this.assertOpen();
    this.closing = true;
    await this.catalog.close();
  }

  private assertOpen(): void {
    if (this.closing) throw new Error("Host owner is closing or closed");
  }
}

/** Initializing identity is available before ready(), including its pending UI.
 * Execution mutations use the private typed admission layer, never raw RPC.
 */
export class OwnedSession {
  private phase: OwnedSessionState["phase"] = "initializing";
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
  private bundled?: BundledFlight;
  private bundledInterrupt?: BundledFlight;
  private queueFlight?: {
    itemId: string; dispatched: boolean; userObserved: boolean; settled: boolean;
    outcome?: { disposition: "started" | "handled" } | { error: unknown };
  };
  private readonly offers = new Map<string, { revision: number; offer: EffectOffer; bytes: number }>();
  private offerBytes = 0;
  private readonly publications: string[] = [];
  private publishing = false;
  private admission: Promise<void> = Promise.resolve();
  private admitting = 0;
  private readonly commands = new Set<Promise<void>>();
  private aborting = 0;
  private sequence: number;
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

  constructor(private readonly catalog: SessionCatalog, private readonly record: CatalogSession, private readonly options: HostOwnerOptions & { environment: NodeJS.ProcessEnv }, private readonly resources: HostResources, revision: number, sequence = 0) {
    this.runtimeRevision = revision;
    this.sequence = sequence;
    this.initialized = new Promise<void>((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    // An unattended session can fail before anyone waits for readiness.
    void this.initialized.catch(() => undefined);
    this.running = Promise.resolve().then(() => this.run());
  }

  get id(): string { return this.record.id; }
  get finished(): boolean { return this.done && !this.lifecyclePending; }
  ready(): Promise<void> { return this.initialized; }

  snapshot(): OwnedSessionSnapshot {
    return { ...this.ownerState(), sequence: this.sequence, conversation: this.conversation.snapshot(), commands: this.catalog.recentCommands(this.id), acceptedQueue: this.queueSnapshot() };
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
      return update;
    });
    this.viewers.add(subscription);
    this.control.attach(id, label);
    return subscription;
  }

  /** Recheck after any async delay. Returns data for inspection/recoverable-draft
   * offering only, never an editor/navigation action or authority to overwrite. */
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
      return this.phase === "ready" && !this.stopRequested && !this.exit && this.usableWorkspace()
        && runtime?.active === true && runtime.id === stored.offer.runtimeId && runtime.cwd === stored.offer.cwd;
    } catch { return false; }
  }

  private offerEffect(data: FrontendEffect): void {
    // Delayed operation effects belong to its initiator, not whoever took over
    // while a confirmation/summary was pending. Never retarget them to a viewer.
    const active = this.bundled ?? this.bundledInterrupt;
    const recipient = active ? active.recipient : this.control.current();
    const runtime = this.worker?.interactionSnapshot().runtime;
    if (!recipient || !runtime?.active) return;
    const offer: EffectOffer = { id: randomUUID(), policy: "inspect_only", source: "owned_pi_stream",
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
  heartbeat(attachmentId: string, controlToken: string): void { this.control.heartbeat(attachmentId, controlToken); }

  commandStatus(serviceEpoch: string, id: string): CommandReceipt | { status: "unknown" } {
    const receipt = this.catalog.commandStatus(serviceEpoch, id);
    return receipt?.sessionId === this.id ? receipt : { status: "unknown" };
  }

  /** Resolve acceptance independently from eventual outcome. The short admission
   * lane serializes authorization/reservation, not a blocking abort or dialog.
   */
  async command(input: SessionCommand): Promise<CommandReceipt> {
    const command = sessionCommand(input);
    if (command.sessionId !== this.id) return Promise.reject(new CommandError("invalid_command", "Command targets another session"));
    if (command.serviceEpoch !== this.catalog.epoch) return Promise.reject(new CommandError("stale_epoch", "Command belongs to another service epoch"));
    if (this.admitting >= 128) return Promise.reject(new CommandError("command_limit", "Owner command admission limit exceeded"));
    this.admitting++;
    const task = this.admission.then(async () => {
      this.control.attached(command.attachmentId);
      const fingerprint = commandFingerprint(command);
      const existing = this.catalog.commandRecord(command.serviceEpoch, command.id);
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new CommandError("command_conflict", "Command ID was used for a different mutation");
        return existing.receipt;
      }
      this.control.authorize(command);
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
      try { await this.catalog.reserveCommand({ fingerprint, receipt }, queue); }
      catch (error) {
        if (!(error instanceof CommandError)) this.commandFailure(error);
        throw error;
      }
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
            if (command.operation === "queue.edit" || command.operation === "queue.remove") this.reservations.releaseItem(command.payload.itemId);
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
      } else if (bundled) this.trackCommand(this.executeBundled(receipt, bundled));
      else if (isNative(command)) {
        this.nativePending++;
        this.trackCommand(this.executeNative(command, receipt));
      } else if (rename) this.trackCommand(this.executeRename(receipt, rename));
      else this.trackCommand(this.executeCommand(command, receipt));
      return structuredClone(receipt);
    });
    this.admission = task.then(() => undefined, () => undefined);
    return task.finally(() => { this.admitting--; });
  }

  private queueSnapshot(): AcceptedQueueSnapshot {
    return { items: this.catalog.queue(this.id), reservation: this.reservations.snapshot() };
  }

  private queueChanged(): void {
    this.publish({ acceptedQueue: this.queueSnapshot() });
    this.scheduleQueue();
  }

  /** Queue mutation and ID reservation share one catalog commit. The receipt
   * completes ownership/editing, not delivery to Pi or an agent turn. */
  private prepareQueueCommand(command: SessionCommand, receipt: CommandReceipt): AcceptedQueueItem[] | undefined {
    const items = this.catalog.queue(this.id);
    if (command.operation === "prompt.submit") {
      const item: AcceptedQueueItem = { id: randomUUID(), revision: 1, serviceEpoch: this.catalog.epoch,
        runtimeRevision: command.runtimeRevision, text: command.payload.text.trim(), status: "queued" };
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
      && !this.aborting && !this.rename && !this.nativePending && !this.bundled && !this.bundledInterrupt && !this.queueRunPending && this.conversation.settled;
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
      if (!stale && (!outcome || !("error" in outcome) && outcome.disposition !== "handled" && !flight.userObserved && !flight.settled)) return;
      if (stale) {
        item.status = "failed"; item.revision++;
        item.error = { code: "stale_runtime", message: "Runtime changed during prompt delivery; inspect the conversation before editing/resubmitting" };
        this.queueRunPending = false;
      } else if (outcome && "error" in outcome) {
        item.status = outcome.error instanceof QueueDeferred ? "queued" : "failed";
        item.revision++;
        item.error = outcome.error instanceof QueueDeferred ? undefined : queueError(outcome.error);
      } else if (outcome && outcome.disposition === "started" && !flight.userObserved) {
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
    const next: NonNullable<OwnedSession["queueFlight"]> = { itemId: item.id, dispatched: false, userObserved: false, settled: false };
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
    if (this.rename || this.nativePending || this.bundled || this.bundledInterrupt) throw new CommandError("session_busy", "An owner operation is already pending");
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

  private prepareBundled(command: SessionCommand & BundledOperation, worker: PiProcess): BundledFlight {
    const interruptingJoin = command.operation === "spawn.stop" && this.bundled?.operation === "spawn.join" && !this.bundledInterrupt;
    if (this.rename || this.bundled && !interruptingJoin || this.bundledInterrupt || this.nativePending || this.aborting) throw new CommandError("session_busy", "Another owner operation is pending");
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
            outcome.result = { changed: true, ...(result.data.status !== undefined ? { status: result.data.status } : {}),
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
  async read(input: unknown): Promise<unknown> {
    if (!validRead(input)) throw new CommandError("invalid_command", "Invalid session read");
    const worker = this.commandRuntime(input.runtimeRevision);
    const response = await worker.request(readCommand(input.kind)!, () => { this.commandRuntime(input.runtimeRevision, worker); });
    this.commandRuntime(input.runtimeRevision, worker);
    return { runtimeRevision: this.runtimeRevision, data: "data" in response ? response.data : null };
  }

  private assertNativeReady(command: NativeOperation): void {
    if (this.phase !== "ready" || !this.usableWorkspace()) throw new CommandError("session_unavailable", "Trust/workspace state is not ready");
    if (command.operation === "retry.abort" || command.operation === "shell.abort") return;
    if (this.rename || this.bundled || this.bundledInterrupt || this.nativePending || this.aborting) throw new CommandError("session_busy", "Another owner operation is pending");
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

  private ownerState(): OwnedSessionState {
    return structuredClone({
      sessionId: this.id, serviceEpoch: this.catalog.epoch, runtimeRevision: this.runtimeRevision,
      phase: this.phase, trust: this.trust, workspace: this.workspace, piState: this.conversation.sessionState,
      interactions: this.worker?.interactionSnapshot() ?? { revision: 0, pending: [] }, controller: this.control.snapshot(),
      error: this.error?.message, exit: this.exit,
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

  private async executeLifecycle(command: SessionCommand & { operation: "session.kill" | "session.restart" }, receipt: CommandReceipt): Promise<void> {
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
    try { await this.finishCommand(receipt, error); }
    finally { this.lifecyclePending = false; }
  }

  private requestStop(): void {
    this.stopRequested = true;
    this.phase = "stopping";
    if (this.worker) void this.worker.stop();
    this.control.revoke();
    this.changed();
  }

  private async executeCommand(command: SessionCommand, receipt: CommandReceipt): Promise<void> {
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
      if (!active) { receipt.result = { idle: true }; return; }
      const guard = () => { this.commandRuntime(revision, worker); };
      let clearingError: unknown;
      try {
        const cleared = await worker.request({ type: "clear_queue" }, guard);
        if (cleared.command !== "clear_queue" || !object(cleared.data)
          || !Array.isArray(cleared.data.steering) || !Array.isArray(cleared.data.followUp)
          || ![...cleared.data.steering, ...cleared.data.followUp].every((text) => typeof text === "string")) {
          throw new Error("Invalid native queue clearing response");
        }
        receipt.result = { cleared: { steering: cleared.data.steering, followUp: cleared.data.followUp } };
        // Preserve returned text before abort. No automatic editor effect/replay.
        await this.catalog.updateCommand(receipt);
        this.publish({ command: structuredClone(receipt) });
      } catch (error) {
        if (!(error instanceof PiCommandError && error.outcome === "rejected")) throw error;
        clearingError = error;
      }
      // Existing behavior attempts abort even after native clear_queue rejection.
      await worker.request({ type: "abort" }, guard);
      if (clearingError) throw clearingError;
    } finally { this.aborting--; this.scheduleQueue(); }
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
    let owned = false;
    try {
      const header = await this.catalog.validateSessionFile(this.id);
      this.checkRunning();
      await this.catalog.markOpen(this.id);
      owned = true;
      this.checkRunning();
      // Only one trust-driven process replacement is permitted per startup.
      for (let replacement = 0; ; replacement++) {
        await this.catalog.validateSessionFile(this.id);
        this.checkRunning();
        await this.resources.assertUnchanged();
        this.checkRunning();
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
        this.worker = new PiProcess(workerOptions);
        this.changed();
        const restart = await this.initialize(this.worker);
        this.checkRunning();
        if (!restart) break;
        if (replacement >= 1) throw new Error("Project trust repeatedly requested a Pi restart");
        const exit = await this.worker.stop();
        this.syncRevision();
        if (exit.error || exit.code !== 0 || exit.descendantsUnresolved) throw new Error("Pi managed work did not finish cleanly for project trust replacement");
        this.exit = undefined;
      }
      await this.refreshConversation();
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
        // A failed markOpen may have an uncertain commit: never undo that claim.
        // stop() awaits the managed supervisor's terminal evidence. Unknown
        // escaped work remains outside the explicitly best-effort guarantee.
        await this.admission;
        await Promise.allSettled([...this.commands]);
        await this.admission;
        await this.interruptQueue("session_stopped", "Session stopped; review accepted work before explicitly editing/resubmitting");
        if (owned) await this.catalog.markStopped(this.id, !!this.error);
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
      this.checkIdentity();
      if (revision !== this.runtimeRevision) continue;
      if (!this.usableWorkspace()) throw new Error("Pi trust/workspace state does not match its active runtime");
      return false;
    }
    throw new Error("Workspace startup did not reach a stable runtime");
  }

  private event(event: PiEvent): void {
    const previousRevision = this.runtimeRevision;
    this.syncRevision();
    if (event.type === "extension_ui_request" && event.method === "setStatus" && event.statusKey === "pi-history-changed") {
      // Branch/history edits can keep the same Pi runtime UUID. Fence queued
      // text and deferred commands against that changed conversation context.
      this.runtimeRevision++;
    }
    if (event.type === "agent_settled") {
      this.queueRunPending = false;
      if (this.queueFlight?.dispatched) this.queueFlight.settled = true;
    }
    if (event.type === "message_end" && event.message.role === "user" && this.queueFlight?.dispatched) this.queueFlight.userObserved = true;
    if (event.type === "extension_ui_request" && event.method === "setStatus" && event.statusKey === "pi-console-runtime") {
      const runtime = this.worker?.interactionSnapshot().runtime;
      if (!runtime?.active) this.retain({ type: "runtime_ended" });
      else if (previousRevision !== this.runtimeRevision) {
        // Preserve statuses already published during extension binding. Pi binds
        // extensions before subscribing to the new runtime's session events.
        this.retain({ type: "invalidate_history" });
        if (this.phase === "ready") this.scheduleRefresh();
      }
    }
    if (event.type === "extension_error") this.error ??= new Error(`Pi extension failed during owner execution: ${event.error}`);
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
      const flight = [this.bundled, this.bundledInterrupt].find((flight) => flight?.invocationId === result.invocationId);
      if (!flight?.dispatched || flight.result || result.invocationId !== flight.invocationId || result.runtimeId !== flight.runtimeId
        || result.sessionId !== this.record.piSessionId || result.sessionFile !== this.catalog.sessionFile(this.id)) throw new Error("Unmatched managed operation result");
      flight.result = result;
      return;
    }
    if (event.type === "extension_ui_request" && event.method === "setStatus" && event.statusKey === RENAME_RESULT) {
      this.consumeRenameResult(event.statusText);
      return; // Private result: neither snapshot state nor a frontend effect.
    }
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
        && ["pi-console-runtime", "pi-console-dialog", "pi-project-trust", "pi-workspace"].includes(event.statusKey))) this.changed();
    if (event.type === "agent_settled" || event.type === "compaction_end"
      || (event.type === "extension_ui_request" && event.method === "setStatus" && event.statusKey === "pi-history-changed")) {
      this.retain({ type: "invalidate_history" });
      this.scheduleRefresh();
    }
    if (event.type === "agent_settled" || event.type === "compaction_end" || event.type === "auto_retry_end"
      || event.type === "summarization_retry_finished" || event.type === "queue_update"
      || event.type === "message_end" && event.message.role === "user") this.scheduleQueue();
  }

  private dispatch(command: RpcCommand & { id: string }): void {
    const flight = [this.bundled, this.bundledInterrupt].find((flight) => flight?.dispatched && command.type === "prompt" && command.message === flight.message);
    if (flight) {
      flight.requestId = command.id;
      return;
    }
    if (this.rename?.dispatched && command.type === "prompt" && command.message === this.rename.message) {
      this.rename.requestId = command.id;
      return; // Do not materialize the private command envelope as user work.
    }
    const work = this.conversation.dispatch(command);
    if (work) this.retain({ type: "work", work });
    if (command.type === "get_messages" && this.worker && this.conversation.idle) {
      this.captures.set(command.id, { worker: this.worker, revision: this.runtimeRevision, version: this.conversation.historyVersion });
    }
  }

  private response(response: RpcResponse, command: RpcCommand & { id: string }): void {
    if (response.id === this.rename?.requestId || response.id === this.bundled?.requestId || response.id === this.bundledInterrupt?.requestId) return;
    if (response.success && response.command === "get_state") {
      this.retain({ type: "pi_state", state: response.data });
      this.changed();
    }
    if (command.type === "get_messages") {
      const capture = this.captures.get(command.id);
      this.captures.delete(command.id);
      if (response.success && response.command === "get_messages" && capture && capture.worker === this.worker
        && capture.revision === this.runtimeRevision && capture.version === this.conversation.historyVersion && this.conversation.idle) {
        this.retain({ type: "history", messages: response.data.messages });
      } else this.refreshAgain = true;
    }
    this.scheduleQueue();
    const work = this.conversation.response(response);
    if (work) this.retain({ type: "work", work });
    if (command.type === "bash") {
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

  private publish(change: Pick<OwnedSessionUpdate, "owner" | "conversation" | "effect" | "command" | "acceptedQueue">): void {
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
    if (revision !== this.workerRevision) this.queueRunPending = false;
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
  if (error instanceof PiCommandError && error.outcome === "rejected") return { code: "pi_rejected", message: "Pi rejected this prompt; edit to retry or remove it" };
  return { code: "delivery_uncertain", message: "Prompt delivery is uncertain; inspect the conversation before editing/resubmitting" };
}

function asError(error: unknown): Error { return error instanceof Error ? error : new Error(String(error)); }
