import { createServer, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { Duplex } from "node:stream";
import { RemoteListener, listenerPort, listenerAddresses } from "./remote-transport.js";
import { chmod, lstat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { HostOwner, type HostOwnerOptions, type HostSummaries, type OwnedSession, type OwnedSessionUpdate, type OriginNotification, type SnapshotCursor } from "./host-owner.js";
import { CONVERSATION_SECTIONS } from "./pi-conversation.js";
import { RemoteNotifications } from "./remote-notifications.js";
import type { SessionSubscription } from "./session-subscription.js";
import { CommandError } from "./session-commands.js";
import { identifier, hostCommand } from "./host-commands.js";
import { object } from "./pi-records.js";
import { CAPABILITIES, MAX_REQUEST, PROTOCOL, REMOTE_METHODS, records, RecordWriter } from "./local-protocol.js";
import { endpoint, serviceBuild } from "./service-paths.js";
import { ServiceRestart } from "./service-restart.js";
import { readExtensionSettings } from "../../pi/extensions/shared/read-extension-settings.mjs";
import { ConnectionDiagnostics, diagnosticCode, serviceDiagnostic, renewalDiagnostic } from "./connection-diagnostics.js";

function exact(value: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(value).some((key) => !keys.includes(key))) throw new CommandError("invalid_command", "Unknown IPC field");
}

function snapshotCursor(value: unknown): SnapshotCursor | undefined {
  if (value === undefined) return;
  if (!object(value)) throw new CommandError("invalid_command", "Invalid snapshot cursor");
  exact(value, ["sessionId", "serviceEpoch", "runtimeRevision", "conversationRevisions"]);
  const revisions = value.conversationRevisions;
  if (!identifier(value.sessionId) || !identifier(value.serviceEpoch) || !Number.isSafeInteger(value.runtimeRevision) || (value.runtimeRevision as number) < 0 || !object(revisions)
    || Object.keys(revisions).length !== Object.keys(CONVERSATION_SECTIONS).length
    || Object.keys(CONVERSATION_SECTIONS).some((key) => !Number.isSafeInteger(revisions[key]) || (revisions[key] as number) < 0)) {
    throw new CommandError("invalid_command", "Invalid snapshot cursor");
  }
  return value as SnapshotCursor;
}

/** Same-user local IPC. Filesystem ownership/modes are the authentication boundary.
 * A transport has at most one attachment; caller-supplied attachment IDs are refused. */
export async function runService(options: HostOwnerOptions & { root: string; port?: number }): Promise<void> {
  serviceDiagnostic("start");
  try { await serve(options); serviceDiagnostic("stopped"); }
  catch (error) { serviceDiagnostic("failure", { code: diagnosticCode(error) }); throw error; }
}
async function serve(options: HostOwnerOptions & { root: string; port?: number }): Promise<void> {
  const path = endpoint(options.root);
  if (Buffer.byteLength(path) > 100) throw new Error("Unix endpoint path is too long; select a shorter private --root");
  const port = listenerPort(options.port);
  const webSettings = readExtensionSettings(options.channel).server?.webui;
  const webRoot = webSettings?.enabled ? join(options.appRoot, "web") : undefined;
  const buildId = await serviceBuild();
  const owner = await HostOwner.open(options);
  const restarts = new ServiceRestart(options, owner.hostId, owner.serviceEpoch);
  const remoteNotifications = new RemoteNotifications(options.channel, owner.hostId);
  const clients = new Map<Socket, ConnectionDiagnostics>();
  const summaryStops = new Set<() => void>();
  let remote: RemoteListener | undefined;
  let startReady!: () => void, startFailed!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => { startReady = resolve; startFailed = reject; });
  void ready.catch(() => undefined);
  let stopping = false;
  let shutdownFailure: unknown;
  let cleanupTimer: NodeJS.Timeout | undefined;
  const cleanup = async (): Promise<void> => {
    if (stopping) return;
    try { await owner.cleanupWorkspaces(); }
    catch (error) { console.error(JSON.stringify({ type: "workspace_cleanup", timestamp: new Date().toISOString(), error: diagnosticCode(error) })); }
    finally {
      if (!stopping) cleanupTimer = setTimeout(() => { void cleanup(); }, 24 * 60 * 60 * 1000);
    }
  };
  const server = createServer((socket) => {
    const diagnostics = new ConnectionDiagnostics(randomUUID(), "local");
    if (stopping || clients.size >= 64) { diagnostics.action("destroy", "admission_rejected"); socket.destroy(); return; }
    diagnostics.log("open");
    clients.set(socket, diagnostics);
    let rejected = false;
    void connection(socket, false, undefined, diagnostics.connectionId, diagnostics).catch((error) => {
      rejected = true; diagnostics.action("handler_rejected", "handler_rejected", error);
      diagnostics.action("destroy", "handler_rejected"); socket.destroy();
    }).finally(() => { if (!rejected) diagnostics.log("handler_complete"); clients.delete(socket); });
  });
  let resolveStopped!: () => void;
  const stopped = new Promise<void>((resolve) => { resolveStopped = resolve; });
  const shutdown = async (force: boolean): Promise<void> => {
    if (stopping) throw new CommandError("session_unavailable", "Service is already stopping");
    serviceDiagnostic("shutdown_requested");
    // HostOwner fences admissions in the same turn as the preflight.
    const task = owner.shutdown(force);
    stopping = true;
    if (owner.shutdownStarted) {
      clearTimeout(cleanupTimer);
      serviceDiagnostic("shutdown_started");
      remoteNotifications.stop();
      for (const stop of summaryStops) stop();
    }
    try { await task; serviceDiagnostic("shutdown_complete"); }
    catch (error) {
      // A preflight refusal leaves the owner usable. A cleanup failure retains
      // its fence/claim and terminates this owner after the diagnostic reply;
      // only explicit B2 reconciliation may authorize a later replacement.
      if (owner.shutdownStarted) shutdownFailure = error;
      else stopping = false;
      serviceDiagnostic(owner.shutdownStarted ? "shutdown_failed" : "shutdown_refused", { code: diagnosticCode(error) });
      throw error;
    }
  };
  async function connection(socket: Duplex, isRemote = false, onDetach?: (detach: (error?: Error) => void) => void,
    connectionId: string = randomUUID(), diagnostics = new ConnectionDiagnostics(connectionId, isRemote ? "ws" : "local")): Promise<void> {
    const writer = new RecordWriter(socket);
    let handshaken = false;
    let subscription: SessionSubscription | undefined;
    let session: OwnedSession | undefined;
    let pending = 0, viewGeneration = 0;
    type WindowView = { target: OwnedSession; view: SessionSubscription };
    let opening: { id: string; task: Promise<WindowView> } | undefined;
    const detach = () => { viewGeneration++; subscription?.close(); subscription = undefined; session = undefined; };
    let summaryFeed: { previous: string; timer?: NodeJS.Timeout } | undefined;
    const stopSummaries = () => {
      if (summaryFeed?.timer) clearTimeout(summaryFeed.timer);
      summaryFeed = undefined;
      summaryStops.delete(stopSummaries);
    };
    let notificationListener: ((notification: OriginNotification) => void) | undefined;
    const stopNotifications = () => {
      if (notificationListener) owner.notifications.off("notification", notificationListener);
      notificationListener = undefined;
      summaryStops.delete(stopNotifications);
    };
    const closeViews = () => { stopSummaries(); stopNotifications(); detach(); };
    let closing = false;
    let closeDeadline: NodeJS.Timeout | undefined;
    const closed = new Promise<void>((resolve) => socket.once("close", resolve));
    const disconnect = (error: Error & { code?: string }, code = "service_connection_error") => {
      if (closing) return;
      closing = true;
      const record = { type: "disconnected", connectionId, code: error.code ?? code, message: error.message.slice(0, 1024) };
      diagnostics.action("disconnect", "service_disconnect", { code: record.code });
      // Revoke authority immediately. A diagnostic must never keep a dead/slow viewer alive.
      closeViews();
      if (socket.destroyed) return;
      closeDeadline = setTimeout(() => { diagnostics.action("destroy", "disconnect_deadline"); socket.destroy(); }, 100);
      void writer.send(record).then(() => {
        diagnostics.action("end", "disconnect_sent"); socket.end();
      }, (error) => { diagnostics.action("destroy", "disconnect_write_failed", error); socket.destroy(); });
    };
    onDetach?.((error) => { if (error) disconnect(error); else closeViews(); });
    const remoteAdmission = () => {
      if (closing || socket.destroyed) throw new CommandError("attachment_closed", "Connection closed");
    };
    const handshakeDeadline = setTimeout(() => disconnect(new Error("Service handshake timed out after 10 seconds"), "handshake_timeout"), 10000);
    socket.once("close", () => { clearTimeout(handshakeDeadline); clearTimeout(closeDeadline); });
    socket.on("error", (error: Error) => {
      if (!isRemote) {
        diagnostics.observed("socket_error"); diagnostics.log("error", { cause: "socket_error", code: diagnosticCode(error) });
      }
      disconnect(error, "transport_error");
    });
    if (!isRemote) {
      socket.once("end", () => { diagnostics.observed("stream_end"); diagnostics.log("end", { cause: "stream_end" }); });
      socket.once("close", () => { diagnostics.observed("stream_close"); diagnostics.log("close", { cause: "stream_close" }); });
    }
    socket.once("close", closeViews);
    const send = (value: unknown, options: { control?: boolean; started?: () => void } = {}) => writer.send(value, options).catch((error: Error) => { disconnect(error, "output_error"); throw error; });
    async function pumpSummaries(feed: NonNullable<typeof summaryFeed>, initial?: HostSummaries): Promise<void> {
      if (summaryFeed !== feed) return;
      if (socket.destroyed || owner.shutdownStarted) { stopSummaries(); return; }
      try {
        const result = initial ?? owner.summaries();
        const serialized = JSON.stringify(result);
        if (serialized !== feed.previous) {
          await send({ type: "summaries", result });
          feed.previous = serialized;
        }
        // Schedule only after the previous write drains. Slow peers retain at
        // most one summary write, and intermediate changes coalesce naturally.
        if (summaryFeed === feed) feed.timer = setTimeout(() => { void pumpSummaries(feed); }, 750);
      } catch (error) { disconnect(error instanceof Error ? error : new Error("Session discovery failed"), "discovery_error"); }
    }
    async function pump(view: SessionSubscription): Promise<void> {
      try {
        while (!socket.destroyed && subscription === view) {
          const update = await view.next();
          if (subscription !== view) break;
          await send({ type: "update", update });
        }
      } catch (error) {
        if (subscription === view) disconnect(error instanceof Error ? error : new Error("Session update stream failed"));
      }
    }
    async function request(record: Record<string, unknown>): Promise<void> {
      const receivedAt = performance.now();
      const control = record.method === "heartbeat" || record.method === "grant";
      let stopAfterReply = false;
      if (closing) return;
      try {
        exact(record, ["id", "method", "payload"]);
        if (!identifier(record.id) || typeof record.method !== "string" || !object(record.payload)) throw new CommandError("invalid_command", "Invalid IPC request");
        const p = record.payload;
        if (socket.destroyed) throw new CommandError("attachment_closed", "Connection closed");
        if (isRemote && !REMOTE_METHODS.has(record.method)) {
          throw new CommandError("unsupported_command", "Method is not available on remote transport");
        }
        let result: unknown;
        if (!handshaken && record.method !== "hello") throw new CommandError("unsupported_command", "Handshake is required");
        switch (record.method) {
          case "hello":
            exact(p, ["version", "channel", "responseChunks"]);
            if (p.responseChunks !== undefined && typeof p.responseChunks !== "boolean") throw new CommandError("invalid_command", "Invalid transport negotiation");
            if (handshaken || p.version !== PROTOCOL || p.channel !== options.channel) throw new CommandError("unsupported_command", "Incompatible protocol/channel; select a compatible endpoint explicitly (no fallback)");
            handshaken = true;
            writer.chunks = p.responseChunks === true;
            clearTimeout(handshakeDeadline);
            result = { version: PROTOCOL, capabilities: isRemote ? CAPABILITIES.filter((c) => c !== "service.stop") : CAPABILITIES,
              transport: isRemote ? "ws" : "local", connectionId, hostId: owner.hostId, channel: options.channel,
              buildId, runtimeBuildId: owner.buildId, appRoot: options.appRoot, serviceEpoch: owner.serviceEpoch, stopping: owner.shutdownStarted,
              network: listenerAddresses(port), ...(!isRemote ? { endpoint: path } : {}) };
            break;
          case "health":
          case "sessions":
            exact(p, []);
            result = { sessions: owner.list(), serviceEpoch: owner.serviceEpoch, buildId, runtimeBuildId: owner.buildId, channel: options.channel };
            break;
          case "sessions.subscribe": {
            exact(p, []);
            if (owner.shutdownStarted) throw new CommandError("session_unavailable", "Service is stopping");
            const summaries = owner.summaries();
            const initial = !summaryFeed;
            const feed = summaryFeed ??= { previous: JSON.stringify(summaries) };
            summaryStops.add(stopSummaries);
            await send({ type: "response", id: record.id, success: true, result: summaries });
            if (initial) void pumpSummaries(feed, summaries);
            return;
          }
          case "notifications.subscribe": {
            exact(p, []);
            if (owner.shutdownStarted) throw new CommandError("session_unavailable", "Service is stopping");
            if (!notificationListener) {
              notificationListener = (notification) => { void send({ type: "desktop_notification", notification }).catch(() => undefined); };
              owner.notifications.on("notification", notificationListener);
              summaryStops.add(stopNotifications);
            }
            result = { hostId: owner.hostId, serviceEpoch: owner.serviceEpoch };
            break;
          }
          case "host.options":
            exact(p, ["serviceEpoch", "cwd", "refresh"]);
            if (p.serviceEpoch !== owner.serviceEpoch) throw new CommandError("stale_epoch", "Host service changed; refresh model options");
            result = await owner.optionsForHost(p.cwd, () => {
              if (socket.destroyed) throw new CommandError("attachment_closed", "Host options reader disconnected");
              remoteAdmission?.();
            }, p.refresh);
            break;
          case "host.complete": {
            exact(p, ["serviceEpoch", "cwd", "prefix", "offset"]);
            if (p.serviceEpoch !== owner.serviceEpoch) throw new CommandError("stale_epoch", "Host service changed; retry completion");
            const { serviceEpoch: _epoch, cwd, ...query } = p;
            result = await owner.completeForHost(cwd, query, () => {
              if (socket.destroyed) throw new CommandError("attachment_closed", "Host completion reader disconnected");
              remoteAdmission?.();
            });
            break;
          }
          case "host.directories": {
            exact(p, ["serviceEpoch", "path", "offset"]);
            if (p.serviceEpoch !== owner.serviceEpoch) throw new CommandError("stale_epoch", "Host service changed; select a directory again");
            const { serviceEpoch: _epoch, ...query } = p;
            result = await owner.directories(query, () => {
              if (socket.destroyed) throw new CommandError("attachment_closed", "Directory reader disconnected");
              remoteAdmission?.();
            });
            break;
          }
          case "host.history": {
            exact(p, ["serviceEpoch", "sessionId", "offset", "version"]);
            if (p.serviceEpoch !== owner.serviceEpoch) throw new CommandError("stale_epoch", "Host service changed; reopen history");
            if (!identifier(p.sessionId)) throw new CommandError("invalid_command", "Invalid history session identity");
            const { serviceEpoch: _epoch, sessionId, ...query } = p;
            result = await owner.history(sessionId, query, () => {
              if (socket.destroyed) throw new CommandError("attachment_closed", "History reader disconnected");
              remoteAdmission?.();
            });
            break;
          }
          case "host.saved":
            exact(p, ["serviceEpoch", "sessionId"]);
            if (p.serviceEpoch !== owner.serviceEpoch) throw new CommandError("stale_epoch", "Host service changed; select the saved session again");
            if (!identifier(p.sessionId)) throw new CommandError("invalid_command", "Invalid saved session identity");
            result = await owner.saved(p.sessionId, () => {
              if (socket.destroyed) throw new CommandError("attachment_closed", "Saved-session reader disconnected");
              remoteAdmission?.();
            });
            break;
          case "window.open": {
            const command = hostCommand(p);
            if (command.operation !== "host.create" || command.payload.provisional !== true) throw new CommandError("invalid_command", "Window open requires a provisional allocation");
            detach();
            const generation = viewGeneration;
            let opened: WindowView | undefined;
            const allocation = owner.command(command, remoteAdmission, (target) => {
              const view = target.subscribe("neovim window");
              opened = { target, view };
              if (socket.destroyed || closing || generation !== viewGeneration) { view.close(); return; }
              session = target; subscription = view;
              void view.closed.then((reason) => { if (subscription === view) disconnect(reason, "subscription_closed"); });
            });
            const task = allocation.then(() => {
              if (!opened) throw new CommandError("session_unavailable", "Window allocation did not produce a session");
              return opened;
            });
            // Capture allocation synchronously, so a following send can wait for
            // this exact window without waiting for its acknowledgment or Pi.
            opening = { id: command.id, task };
            void task.catch(() => undefined);
            const receipt = await allocation;
            const { target, view } = await task;
            await send({ type: "response", id: record.id, success: true,
              result: { ...receipt, attachmentId: view.attachmentId, snapshot: target.snapshot() } });
            if (subscription === view) void pump(view);
            return;
          }
          case "window.submit": {
            exact(p, ["id", "serviceEpoch", "createId", "text", "settings"]);
            if (!identifier(p.id) || !identifier(p.createId) || !opening || opening.id !== p.createId) throw new CommandError("invalid_command", "Submission does not target this window's allocation");
            const { target, view } = await opening.task;
            result = await target.submitWindow(p, view.attachmentId);
            break;
          }
          case "host.command": result = await owner.command(p, remoteAdmission); break;
          case "session.manage": result = await owner.manage(p, () => {
            if (socket.destroyed) throw new CommandError("attachment_closed", "Management client disconnected");
            remoteAdmission?.();
          }); break;
          case "session.manage.status":
            exact(p, ["serviceEpoch", "commandId", "sessionId"]);
            if (!identifier(p.serviceEpoch) || !identifier(p.commandId) || !identifier(p.sessionId)) throw new CommandError("invalid_command", "Invalid management lookup");
            result = owner.managementStatus(p.serviceEpoch, p.commandId, p.sessionId); break;
          case "host.status":
            exact(p, ["serviceEpoch", "commandId"]);
            if (!identifier(p.serviceEpoch) || !identifier(p.commandId)) throw new CommandError("invalid_command", "Invalid command lookup");
            result = owner.hostStatus(p.serviceEpoch, p.commandId); break;
          case "attach": {
            exact(p, ["sessionId", "label"]);
            if (!identifier(p.sessionId) || typeof p.label !== "string") throw new CommandError("invalid_command", "Invalid attachment");
            const target = owner.lookup(p.sessionId);
            if (!target) throw new CommandError("session_unavailable", "Session is not live; reconnect to restore a suspended session, or explicitly reopen it");
            detach();
            session = target;
            const view = target.subscribe(p.label);
            subscription = view;
            void view.closed.then((reason) => { if (subscription === view) disconnect(reason, "subscription_closed"); });
            await send({ type: "response", id: record.id, success: true,
              result: { attachmentId: view.attachmentId, snapshot: view.snapshot } });
            void pump(view);
            return;
          }
          case "detach": exact(p, []); detach(); result = {}; break;
          case "service.restart": {
            exact(p, ["id", "serviceEpoch", "hostId", "force", "confirmed"]);
            if (stopping) throw new CommandError("session_busy", "Service is stopping");
            result = await restarts.request(p);
            break;
          }
          case "service.restart.status":
            exact(p, ["serviceEpoch", "id"]);
            if (p.serviceEpoch === undefined && p.id === undefined) result = await restarts.latest();
            else {
              if (!identifier(p.serviceEpoch) || !identifier(p.id)) throw new CommandError("invalid_command", "Invalid restart lookup");
              result = await restarts.status(p.serviceEpoch, p.id);
            }
            break;
          case "service.stop":
            exact(p, ["serviceEpoch", "force"]);
            if (p.serviceEpoch !== owner.serviceEpoch) throw new CommandError("stale_epoch", "Service epoch changed");
            if (typeof p.force !== "boolean") throw new CommandError("invalid_command", "Stop requires an intentional force boolean");
            await shutdown(p.force); result = { stopped: true }; stopAfterReply = true; break;
          default: {
            const target = session;
            const view = subscription;
            if (!target || !view) throw new CommandError("attachment_closed", "Attach before using session operations");
            switch (record.method) {
              case "snapshot": exact(p, ["known"]); result = target.snapshotSince(snapshotCursor(p.known)); break;
              case "session.read":
                result = await target.read(p, () => {
                  if (socket.destroyed || subscription !== view || session !== target) throw new CommandError("attachment_closed", "Read attachment changed");
                  remoteAdmission?.();
                });
                break;
              case "resource.read": case "resource.complete":
                result = await target.resource(record.method, p, () => {
                  if (socket.destroyed || subscription !== view || session !== target) throw new CommandError("attachment_closed", "Resource attachment changed");
                  remoteAdmission?.();
                });
                break;
              case "command":
                exact(p, ["version", "id", "sessionId", "serviceEpoch", "runtimeRevision", "controlToken", "operation", "payload"]);
                if (p.sessionId !== target.id) throw new CommandError("invalid_command", "Command targets another attachment");
                result = await target.command({ ...p, attachmentId: view.attachmentId } as Parameters<OwnedSession["command"]>[0], remoteAdmission);
                break;
              case "grant": exact(p, []); result = target.controlGrant(view.attachmentId) ?? null; break;
              case "heartbeat":
                exact(p, ["controlToken", "reservationId"]);
                if (typeof p.controlToken !== "string" || p.reservationId !== undefined && !identifier(p.reservationId)) throw new CommandError("invalid_command", "Invalid heartbeat");
                result = target.heartbeat(view.attachmentId, p.controlToken, p.reservationId as string | undefined); break;
              case "response.viewed":
                exact(p, ["serviceEpoch", "runtimeRevision", "completionSeq", "controlToken"]);
                if (!identifier(p.serviceEpoch) || !Number.isSafeInteger(p.runtimeRevision) || Number(p.runtimeRevision) < 0
                  || !Number.isSafeInteger(p.completionSeq) || Number(p.completionSeq) < 1
                  || typeof p.controlToken !== "string" || !p.controlToken.length || p.controlToken.length > 128) {
                  throw new CommandError("invalid_command", "Invalid viewing acknowledgement");
                }
                target.responseViewed(view.attachmentId, p.controlToken, p.serviceEpoch, Number(p.runtimeRevision), Number(p.completionSeq));
                result = {}; break;
              case "command.status":
                exact(p, ["serviceEpoch", "commandId"]);
                if (!identifier(p.serviceEpoch) || !identifier(p.commandId)) throw new CommandError("invalid_command", "Invalid command lookup");
                result = target.commandStatus(p.serviceEpoch, p.commandId); break;
              case "effect.inspect":
                exact(p, ["controlToken", "update"]);
                if (typeof p.controlToken !== "string" || !object(p.update) || !object(p.update.effect)) throw new CommandError("invalid_command", "Invalid effect offer");
                result = target.inspectEffect(view.attachmentId, p.controlToken, p.update as OwnedSessionUpdate) ?? null;
                break;
              default: throw new CommandError("unsupported_command", `Unavailable in B3: ${record.method}`);
            }
          }
        }
        const handledAt = performance.now();
        const queuedBytes = writer.queuedBytes;
        let writeStartedAt: number | undefined;
        const diagnostic = (event: "delayed" | "confirmed") => renewalDiagnostic("server", event, {
          connectionId, handlingMs: handledAt - receivedAt, writeDelayMs: (writeStartedAt ?? performance.now()) - handledAt,
          responseQueueMs: performance.now() - handledAt, queuedBytes: writer.queuedBytes,
          writableBytes: socket.writableLength, readableBytes: socket.readableLength });
        const warning = control ? setTimeout(() => diagnostic("delayed"), 1000) : undefined;
        try {
          await send({ type: "response", id: record.id, success: true, result,
            ...(control ? { renewal: { handlingMs: handledAt - receivedAt, queuedBytes } } : {}) },
            { control, started: () => { writeStartedAt = performance.now(); } });
          if (control && performance.now() - receivedAt >= 1000) diagnostic("confirmed");
        } finally { clearTimeout(warning); }
      } catch (error) {
        await send({ type: "response", id: record.id, success: false, error: {
          code: error instanceof CommandError ? error.code : "service_error", message: error instanceof Error ? error.message : "Service request failed" } }, { control });
      } finally {
        if (stopAfterReply || shutdownFailure) finish();
      }
    }
    try {
      await ready;
      if (socket.destroyed) return;
      for await (const record of records(socket, MAX_REQUEST)) {
        if (closing) continue;
        if (++pending > 32) {
          disconnect(new Error("Too many concurrent IPC requests"), "request_limit");
          break;
        }
        void request(record).catch((error: Error) => disconnect(error)).finally(() => { pending--; });
      }
    } catch {
      // Parser errors can quote input; never put request contents in diagnostics.
      if (!stopping) disconnect(new Error(socket.destroyed ? "Transport closed while reading IPC input" : "Invalid or oversized IPC input"),
        socket.destroyed ? "transport_closed" : "input_error");
    } finally {
      if (closing && !socket.destroyed) await closed;
      clearTimeout(handshakeDeadline); clearTimeout(closeDeadline); closeViews();
      if (socket.destroyed) diagnostics.observed("stream_close");
      diagnostics.action("destroy", "connection_cleanup"); socket.destroy();
    }
  }
  function finish(): void {
    clearTimeout(cleanupTimer);
    serviceDiagnostic("finish");
    remoteNotifications.stop();
    for (const stop of summaryStops) stop();
    remote?.close();
    server.close();
    for (const [socket, diagnostics] of clients) { diagnostics.action("destroy", "service_shutdown"); socket.destroy(); }
    resolveStopped();
  }
  // Only the successfully claimed catalog owner may remove a leftover endpoint.
  try {
    try {
      const stat = await lstat(path);
      if (!stat.isSocket() || stat.uid !== process.getuid?.()) throw new Error("Refusing to replace a non-owned Unix endpoint");
      await unlink(path);
    } catch (error) { if (!object(error) || error.code !== "ENOENT") throw error; }
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, () => { server.off("error", reject); resolve(); });
    });
    await chmod(path, 0o600);
    remote = new RemoteListener(port, (stream, onDetach, connectionId, diagnostics) => connection(stream, true, onDetach, connectionId, diagnostics),
      webRoot ? { root: webRoot, serviceRoot: options.root, channel: options.channel, hostId: owner.hostId,
        allowedOrigins: webSettings?.["allowed-origins"] } : undefined);
    await remote.listen();
    remoteNotifications.start();
    console.log(JSON.stringify({ network: listenerAddresses(port) }));
    serviceDiagnostic("ready");
    startReady();
    cleanupTimer = setTimeout(() => { void cleanup(); }, 30_000);
  } catch (error) {
    serviceDiagnostic("startup_failed", { code: diagnosticCode(error) });
    startFailed(error); remoteNotifications.stop(); remote?.close(); server.close();
    for (const [socket, diagnostics] of clients) { diagnostics.action("destroy", "service_shutdown"); socket.destroy(); }
    await owner.close(); throw error;
  }
  const signal = (name: "SIGTERM" | "SIGINT") => {
    serviceDiagnostic("signal", { signal: name });
    void shutdown(true).then(finish, (error) => { shutdownFailure = error; serviceDiagnostic("shutdown_failed", { code: diagnosticCode(error) }); finish(); });
  };
  const sigterm = () => signal("SIGTERM"), sigint = () => signal("SIGINT");
  process.once("SIGTERM", sigterm); process.once("SIGINT", sigint);
  try { await stopped; }
  finally { process.off("SIGTERM", sigterm); process.off("SIGINT", sigint); }
  if (shutdownFailure) throw new Error("Shutdown cleanup failed; service lock retained. Inspect and explicitly reconcile before restarting", { cause: shutdownFailure });
}
