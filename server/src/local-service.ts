import { createServer, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { DeviceCredentials } from "./device-credentials.js";
import { RemoteListener, type TlsListenerOptions } from "./remote-transport.js";
import { chmod, lstat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { HostOwner, type HostOwnerOptions, type HostSummaries, type OwnedSession, type OwnedSessionUpdate } from "./host-owner.js";
import type { SessionSubscription } from "./session-subscription.js";
import { CommandError } from "./session-commands.js";
import { identifier } from "./host-commands.js";
import { object } from "./pi-records.js";
import { CAPABILITIES, MAX_REQUEST, PROTOCOL, records, RecordWriter } from "./local-protocol.js";
import { serviceBuild } from "./service-paths.js";

export const endpoint = (root: string): string => join(root, "service.sock");
function exact(value: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(value).some((key) => !keys.includes(key))) throw new CommandError("invalid_command", "Unknown IPC field");
}

/** Same-user local IPC. Filesystem ownership/modes are the authentication boundary.
 * A transport has at most one attachment; caller-supplied attachment IDs are refused. */
export async function runService(options: HostOwnerOptions & { root: string; tls?: TlsListenerOptions }): Promise<void> {
  const path = endpoint(options.root);
  if (Buffer.byteLength(path) > 100) throw new Error("Unix endpoint path is too long; select a shorter private --root");
  const buildId = await serviceBuild();
  const owner = await HostOwner.open(options);
  const clients = new Set<Socket>();
  const summaryStops = new Set<() => void>();
  let remote: RemoteListener | undefined;
  let credentials: DeviceCredentials;
  try { credentials = await DeviceCredentials.open(options.root, owner.hostId, options.channel, (id) => remote?.revoke(id)); }
  catch (error) { await owner.close(); throw error; }
  let startReady!: () => void, startFailed!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => { startReady = resolve; startFailed = reject; });
  void ready.catch(() => undefined);
  let stopping = false;
  let shutdownFailure: unknown;
  const server = createServer((socket) => {
    if (stopping || clients.size >= 64) { socket.destroy(); return; }
    clients.add(socket);
    void connection(socket).catch(() => socket.destroy()).finally(() => clients.delete(socket));
  });
  let resolveStopped!: () => void;
  const stopped = new Promise<void>((resolve) => { resolveStopped = resolve; });
  const shutdown = async (force: boolean): Promise<void> => {
    if (stopping) throw new CommandError("session_unavailable", "Service is already stopping");
    // HostOwner fences admissions in the same turn as the preflight.
    const task = owner.shutdown(force);
    stopping = true;
    if (owner.shutdownStarted) for (const stop of summaryStops) stop();
    try { await task; }
    catch (error) {
      // A preflight refusal leaves the owner usable. A cleanup failure retains
      // its fence/claim and terminates this owner after the diagnostic reply;
      // only explicit B2 reconciliation may authorize a later replacement.
      if (owner.shutdownStarted) shutdownFailure = error;
      else stopping = false;
      throw error;
    }
  };
  async function connection(socket: Duplex, deviceId?: string, onDetach?: (detach: () => void) => void): Promise<void> {
    const writer = new RecordWriter(socket);
    let handshaken = false;
    let subscription: SessionSubscription | undefined;
    let session: OwnedSession | undefined;
    let pending = 0;
    const detach = () => { subscription?.close(); subscription = undefined; session = undefined; };
    let summaryFeed: { previous: string; timer?: NodeJS.Timeout } | undefined;
    const stopSummaries = () => {
      if (summaryFeed?.timer) clearTimeout(summaryFeed.timer);
      summaryFeed = undefined;
      summaryStops.delete(stopSummaries);
    };
    const closeViews = () => { stopSummaries(); detach(); };
    onDetach?.(closeViews);
    const remoteAdmission = deviceId ? () => {
      if (socket.destroyed || !credentials.active(deviceId)) throw new CommandError("attachment_closed", "Remote authentication is no longer valid");
    } : undefined;
    const handshakeDeadline = setTimeout(() => socket.destroy(), 10000);
    socket.once("close", () => clearTimeout(handshakeDeadline));
    socket.on("error", () => undefined);
    socket.once("close", closeViews);
    const send = (value: unknown) => writer.send(value).catch((error) => { socket.destroy(); throw error; });
    async function pumpSummaries(feed: NonNullable<typeof summaryFeed>, initial?: HostSummaries): Promise<void> {
      if (summaryFeed !== feed) return;
      if (socket.destroyed || owner.shutdownStarted || deviceId && !credentials.active(deviceId)) { stopSummaries(); return; }
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
      } catch { stopSummaries(); socket.destroy(); }
    }
    async function pump(view: SessionSubscription): Promise<void> {
      try {
        while (!socket.destroyed && subscription === view) {
          const update = await view.next();
          if (subscription !== view) break;
          await send({ type: "update", update });
        }
      } catch {
        if (subscription === view && !socket.destroyed) socket.destroy();
      }
    }
    async function request(record: Record<string, unknown>): Promise<void> {
      let stopAfterReply = false;
      try {
        exact(record, ["id", "method", "payload"]);
        if (!identifier(record.id) || typeof record.method !== "string" || !object(record.payload)) throw new CommandError("invalid_command", "Invalid IPC request");
        const p = record.payload;
        // Authentication remains current for every operation, including buffered
        // records after revocation. Accepted owner work is never cancelled here.
        if (socket.destroyed || deviceId && !credentials.active(deviceId)) throw new CommandError("attachment_closed", "Remote authentication is no longer valid");
        if (deviceId && !["hello", "health", "sessions", "sessions.subscribe", "host.command", "host.status", "attach", "detach", "snapshot", "session.read", "command", "grant", "heartbeat", "command.status", "effect.inspect"].includes(record.method)) {
          throw new CommandError("unsupported_command", "Method is not available on remote transport");
        }
        let result: unknown;
        if (!handshaken && record.method !== "hello") throw new CommandError("unsupported_command", "Handshake is required");
        switch (record.method) {
          case "hello":
            exact(p, ["version", "channel"]);
            if (handshaken || p.version !== PROTOCOL || p.channel !== options.channel) throw new CommandError("unsupported_command", "Incompatible protocol/channel; select a compatible endpoint explicitly (no fallback)");
            handshaken = true;
            clearTimeout(handshakeDeadline);
            result = { version: PROTOCOL, capabilities: deviceId ? CAPABILITIES.filter((c) => c !== "service.stop") : CAPABILITIES,
              transport: deviceId ? "wss" : "local", ...(deviceId ? { deviceId } : {}), hostId: owner.hostId, channel: options.channel,
              buildId, runtimeBuildId: owner.buildId, appRoot: options.appRoot, serviceEpoch: owner.serviceEpoch,
              ...(!deviceId ? { endpoint: path } : {}) };
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
            const feed = summaryFeed ??= { previous: "" };
            summaryStops.add(stopSummaries);
            await send({ type: "response", id: record.id, success: true, result: summaries });
            if (initial) void pumpSummaries(feed, summaries);
            return;
          }
          case "host.command": result = await owner.command(p, remoteAdmission); break;
          case "host.status":
            exact(p, ["serviceEpoch", "commandId"]);
            if (!identifier(p.serviceEpoch) || !identifier(p.commandId)) throw new CommandError("invalid_command", "Invalid command lookup");
            result = owner.hostStatus(p.serviceEpoch, p.commandId); break;
          case "attach": {
            exact(p, ["sessionId", "label"]);
            if (!identifier(p.sessionId) || typeof p.label !== "string") throw new CommandError("invalid_command", "Invalid attachment");
            const target = owner.lookup(p.sessionId);
            if (!target) throw new CommandError("session_unavailable", "Session is saved, not live; explicitly resume it first");
            detach();
            session = target;
            const view = target.subscribe(p.label);
            subscription = view;
            void view.closed.then(() => { if (subscription === view) socket.destroy(); });
            await send({ type: "response", id: record.id, success: true,
              result: { attachmentId: view.attachmentId, snapshot: view.snapshot } });
            void pump(view);
            return;
          }
          case "detach": exact(p, []); detach(); result = {}; break;
          case "credentials.list": exact(p, []); result = credentials.list(); break;
          case "credentials.issue": exact(p, ["label"]); result = await credentials.issue(p.label); break;
          case "credentials.revoke": exact(p, ["deviceId"]); await credentials.revoke(p.deviceId); result = { revoked: true }; break;
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
              case "snapshot": exact(p, []); result = target.snapshot(); break;
              case "session.read": result = await target.read(p); break;
              case "command":
                exact(p, ["version", "id", "sessionId", "serviceEpoch", "runtimeRevision", "controlToken", "operation", "payload"]);
                if (p.sessionId !== target.id) throw new CommandError("invalid_command", "Command targets another attachment");
                result = await target.command({ ...p, attachmentId: view.attachmentId } as Parameters<OwnedSession["command"]>[0], remoteAdmission);
                break;
              case "grant": exact(p, []); result = target.controlGrant(view.attachmentId) ?? null; break;
              case "heartbeat":
                exact(p, ["controlToken"]);
                if (typeof p.controlToken !== "string") throw new CommandError("invalid_command", "Missing control token");
                target.heartbeat(view.attachmentId, p.controlToken); result = {}; break;
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
        await send({ type: "response", id: record.id, success: true, result });
      } catch (error) {
        await send({ type: "response", id: record.id, success: false, error: {
          code: error instanceof CommandError ? error.code : "service_error", message: error instanceof Error ? error.message : "Service request failed" } });
      } finally {
        if (stopAfterReply || shutdownFailure) finish();
      }
    }
    try {
      await ready;
      if (socket.destroyed) return;
      for await (const record of records(socket, MAX_REQUEST)) {
        if (++pending > 32) throw new Error("Too many concurrent IPC requests");
        void request(record).catch(() => socket.destroy()).finally(() => { pending--; });
      }
    } finally { clearTimeout(handshakeDeadline); closeViews(); socket.destroy(); }
  }
  function finish(): void {
    for (const stop of summaryStops) stop();
    remote?.close();
    server.close();
    for (const socket of clients) socket.destroy();
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
    if (options.tls) {
      remote = new RemoteListener(options.tls, credentials, (stream, deviceId, onDetach) => connection(stream, deviceId, onDetach));
      await remote.listen();
    }
    startReady();
  } catch (error) { startFailed(error); remote?.close(); server.close(); for (const socket of clients) socket.destroy(); await owner.close(); throw error; }
  const signal = () => { void shutdown(true).then(finish, (error) => { shutdownFailure = error; console.error(error); finish(); }); };
  process.once("SIGTERM", signal); process.once("SIGINT", signal);
  try { await stopped; }
  finally { process.off("SIGTERM", signal); process.off("SIGINT", signal); }
  if (shutdownFailure) throw new Error("Shutdown cleanup failed; owner claim retained. Inspect and explicitly reconcile before restarting", { cause: shutdownFailure });
}
