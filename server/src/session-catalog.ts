import { randomUUID } from "node:crypto";
import type { HostReceipt } from "./host-commands.js";
import { lstat, open, realpath, statfs, unlink, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, basename, dirname } from "node:path";
import { setImmediate } from "node:timers/promises";
import { type DatabaseSync, type SQLInputValue } from "node:sqlite";
import { object } from "./pi-records.js";
import { assertManagedLaunchAllowed, beginEpoch, ownerLease, registry, sealEpoch, inspectEpoch } from "../../pi/scripts/managed-process.mjs";
import { setTimeout as delay } from "node:timers/promises";
import { CommandError, type CommandReceipt, type StoredCommand } from "./session-commands.js";
import { validQueueItem, type AcceptedQueueItem } from "./session-queue.js";
import { validEffectiveTitle } from "./session-rename.js";
import { commandBytes, insertCommand, insertQueue, insertSession, openStorage, privateDirectory, privateJson,
  readManagedMetadata, splitReceipt, syncDirectory, validateManagedFile, type CatalogSession, type Channel } from "./catalog-storage.js";
export type { CatalogSession, Channel } from "./catalog-storage.js";

const MiB = 1024 * 1024;
// Free-space admission policy, not a guarantee against other writers or disk loss.
const ORDINARY_HEADROOM = 64 * MiB;
const CONTROL_HEADROOM = 16 * MiB;
const essential = new Set<CommandReceipt["operation"]>(["control.acquire", "control.takeover", "control.release",
  "interaction.respond", "interaction.cancel", "turn.abort", "shell.abort", "retry.abort", "side.abort", "spawn.stop", "session.kill", "queue.remove", "queue.release"]);

/** One private profile owner. History stays indexed on disk, never in a ledger cache. */
export class SessionCatalog {
  private writing: Promise<void> = Promise.resolve();
  private closing?: Promise<void>;
  private released = false;
  private failure?: Error;
  private resolveFailure!: (error: Error) => void;
  /** Resolves once, after the synchronous fence; observers run outside transactions. */
  readonly whenFailed = new Promise<Error>((resolve) => { this.resolveFailure = resolve; });
  private commits = 0;
  private checkpointBytes = 0;
  private transactionBytes = 0;

  private constructor(readonly root: string, readonly channel: Channel, readonly hostId: string,
    readonly epoch: string, private readonly db: DatabaseSync, private readonly lock: FileHandle,
    private readonly lifetime: { close(): void }) {}

  get processRegistry(): string { return join(this.root, "processes.sqlite"); }

  /** Explicit administrative reconciliation, never invoked by open/resume. No PID from disk is signalled. */
  static async reconcile(options: { root: string; channel: Channel }): Promise<void> {
    const root = await realpath(options.root);
    await privateDirectory(root);
    const lifetime = ownerLease(root);
    try {
      const path = join(root, "owner.lock");
      const claim = await privateJson(path, 16384);
      if (!object(claim) || claim.schemaVersion !== 3 || typeof claim.epoch !== "string") {
        throw new Error("Legacy or invalid service lock lacks managed execution evidence; manual inspection required");
      }
      const epoch = claim.epoch;
      const processes = join(root, "processes.sqlite");
      sealEpoch(processes, epoch); // Cancels intents and fences surviving launchers in one transaction.
      const deadline = performance.now() + 10000;
      for (;;) {
        const jobs = inspectEpoch(processes, epoch);
        const pending = jobs.filter((job) => job.status !== "done" && job.status !== "cancelled");
        if (!pending.length) break;
        if (pending.some((job) => job.status === "unresolved") || performance.now() >= deadline) {
          throw new Error("Known managed work is still live or unresolved; replacement blocked: " + pending.map((job) => `${job.id} (${job.status})`).join(", "));
        }
        await delay(50);
      }
      // Atomic immutable evidence, before changing the catalog or removing the
      // claim. SQLite FULL commits make interrupted publication restart-safe.
      const evidence = registry(processes);
      try {
        const bytes = await open(path, "r");
        let text: string;
        try { text = await bytes.readFile("utf8"); } finally { await bytes.close(); }
        evidence.prepare("INSERT OR IGNORE INTO recoveries VALUES(?,?)").run(epoch, text);
        if (evidence.prepare("SELECT claim FROM recoveries WHERE epoch=?").get(epoch)?.claim !== text) throw new Error("Conflicting recovery claim evidence");
        const { db } = await openStorage(root, options.channel, () => {}, epoch);
        try {
          db.exec("BEGIN IMMEDIATE");
          for (const row of db.prepare("SELECT id,metadata FROM sessions WHERE owner_epoch=?").all(epoch)) {
            const session = JSON.parse(String(row.metadata)) as CatalogSession;
            // An accepted kill remains an explicit stop even if the owner crashed.
            if (session.stopReason !== "user") session.stopReason = "error";
            delete session.ownerEpoch;
            db.prepare("UPDATE sessions SET owner_epoch=NULL,metadata=? WHERE id=?").run(JSON.stringify(session), row.id);
          }
          db.exec("COMMIT");
          if (db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get()?.busy !== 0) throw new Error("Recovery checkpoint blocked; retain original claim");
        } finally { db.close(); }
        if (JSON.stringify(await privateJson(path, 16384)) !== JSON.stringify(claim)) throw new Error("Service lock changed during recovery");
        await unlink(path);
        await syncDirectory(root);
      } finally { evidence.close(); }
    } finally { lifetime.close(); }
  }

  static async open(options: { root: string; channel: Channel; appRoot: string }): Promise<SessionCatalog> {
    if (options.channel !== "stable" && options.channel !== "dev") throw new Error("Unknown service channel");
    if (!isAbsolute(options.root) || !isAbsolute(options.appRoot)) throw new Error("Service roots must be absolute host paths");
    await privateDirectory(options.root);
    const root = await realpath(options.root);
    const lockPath = join(root, "owner.lock");
    const lifetime = ownerLease(root);
    let lock: FileHandle;
    try { lock = await open(lockPath, "wx", 0o600); }
    catch (error) {
      lifetime.close();
      if (object(error) && error.code === "EEXIST") {
        let owner = "unknown checkout";
        try { const value = await privateJson(lockPath, 16384); if (object(value) && typeof value.appRoot === "string") owner = value.appRoot; }
        catch { /* Unreadable claims still block replacement. */ }
        throw new Error(`Service profile is in use or requires recovery (${owner}); refusing to start another service process`);
      }
      throw error;
    }
    const epoch = randomUUID();
    let retainClaim = false;
    let catalog: SessionCatalog | undefined;
    try {
      await lock.writeFile(JSON.stringify({ schemaVersion: 3, epoch, appRoot: await realpath(options.appRoot) }) + "\n");
      await lock.sync();
      await syncDirectory(root);
      beginEpoch(join(root, "processes.sqlite"), epoch);
      await privateDirectory(join(root, "sessions"));
      await privateDirectory(join(root, "workspaces"));
      const { db, hostId } = await openStorage(root, options.channel, () => { retainClaim = true; });
      catalog = new SessionCatalog(root, options.channel, hostId, epoch, db, lock, lifetime);
      await catalog.recover();
      await catalog.backfillMetadata();
      return catalog;
    } catch (error) {
      catalog?.db.close();
      lifetime.close();
      if (retainClaim) {
        await lock.close();
        throw new Error("Catalog initialization did not finish; retain the service lock for inspection/recovery", { cause: error });
      }
      let cleanupError: unknown;
      try {
        const owned = await lock.stat();
        const current = await lstat(lockPath);
        const claim = await privateJson(lockPath, 16384);
        if (owned.dev !== current.dev || owned.ino !== current.ino || !object(claim) || claim.epoch !== epoch) throw new Error("Service lock changed during initialization");
        await unlink(lockPath);
        await syncDirectory(root);
      } catch (failure) { cleanupError = failure; }
      finally { await lock.close(); }
      if (cleanupError) throw new AggregateError([error, cleanupError], "Catalog initialization failed; claim cleanup needs inspection", { cause: error });
      throw error;
    }
  }

  /** Execution authority, not a diagnostic-read gate. Never clears after an I/O recovery. */
  assertExecutionAllowed(): void {
    if (this.failure) throw this.failure;
    if (this.closing || this.released) throw new Error("Service catalog is closing or closed");
  }

  /** Resource refusal fences new workers/helpers, never RPCs to existing workers. */
  assertLaunchAllowed(): void {
    this.assertExecutionAllowed();
    assertManagedLaunchAllowed(this.processRegistry, this.epoch);
  }

  list(): CatalogSession[] {
    return this.read(() => this.db.prepare("SELECT metadata FROM sessions ORDER BY rowid DESC").all()
      .map((row) => this.withQueue(JSON.parse(String(row.metadata)) as CatalogSession)).filter(session => !session.deleted)
      .sort((left, right) => Date.parse(right.lastActivityAt ?? right.createdAt) - Date.parse(left.lastActivityAt ?? left.createdAt)));
  }

  get(id: string): CatalogSession {
    return this.read(() => {
      const row = this.db.prepare("SELECT metadata FROM sessions WHERE id=?").get(id);
      if (!row) throw new Error("Unknown service session");
      return this.withQueue(JSON.parse(String(row.metadata)) as CatalogSession);
    });
  }

  private withQueue(session: CatalogSession): CatalogSession {
    session.acceptedQueue = this.queue(session.id);
    return session;
  }

  sessionFile(id: string): string {
    this.get(id);
    return join(this.root, "sessions", `${id}.jsonl`);
  }

  hostRecord(epoch: string, id: string): { fingerprint: string; receipt: HostReceipt } | undefined {
    return this.read(() => {
      const row = this.db.prepare("SELECT fingerprint, receipt FROM commands WHERE epoch=? AND id=?").get(epoch, id);
      return row ? { fingerprint: String(row.fingerprint), receipt: JSON.parse(String(row.receipt)) as HostReceipt } : undefined;
    });
  }

  /** Host receipts use the existing nullable session FK. Allocation and receipt
   * publication commit together; a lost create ack cannot allocate twice. */
  private insertHost(fingerprint: string, receipt: HostReceipt): void {
    this.db.prepare("INSERT INTO commands(epoch,id,session_id,fingerprint,status,operation,reserved_bytes,receipt) VALUES(?,?,NULL,?,?,?,?,?)")
      .run(receipt.serviceEpoch, receipt.id, fingerprint, receipt.status, receipt.operation, 4096, JSON.stringify(receipt));
    this.transactionBytes += 4096;
  }

  async reserveHost(fingerprint: string, receipt: HostReceipt, admission?: () => void): Promise<void> {
    await this.serial(async () => {
      await this.storageCapacity(4096, false);
      this.transaction(() => { admission?.(); this.insertHost(fingerprint, receipt); });
    });
  }

  async finishHost(receipt: HostReceipt, saved?: { sessionId: string; archived?: boolean; deleted?: true }): Promise<void> {
    await this.change(() => {
      if (saved) {
        const session = this.get(saved.sessionId);
        if (session.ownerEpoch) throw new Error("Saved session became owned before completion");
        if (saved.archived !== undefined) session.archived = saved.archived;
        if (saved.deleted) session.deleted = true;
        session.lifecycleRevision = (session.lifecycleRevision ?? 0) + 1;
        this.updateSession(session);
      }
      const changed = this.db.prepare("UPDATE commands SET status=?, receipt=? WHERE epoch=? AND id=? AND status='accepted'")
        .run(receipt.status, JSON.stringify(receipt), receipt.serviceEpoch, receipt.id);
      if (changed.changes !== 1) throw new Error("Host receipt is not pending");
      this.transactionBytes += 4096;
    });
  }

  async create(cwd: string, host?: { fingerprint: string; receipt: HostReceipt }, admission?: () => void): Promise<CatalogSession> {
    if (!isAbsolute(cwd)) throw new Error("Session cwd must be an absolute host directory");
    return this.serial(async () => {
      await this.storageCapacity(4096, false);
      const directory = await realpath(cwd);
      if (!(await lstat(directory)).isDirectory()) throw new Error("Session cwd must be a host directory");
      const id = randomUUID();
      const session: CatalogSession = { id, piSessionId: id, cwd: directory, createdAt: new Date().toISOString() };
      const file = await open(join(this.root, "sessions", `${id}.jsonl`), "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify({ type: "session", version: 3, id, timestamp: session.createdAt, cwd: directory }) + "\n");
        await file.sync();
      } finally { await file.close(); }
      await syncDirectory(join(this.root, "sessions"));
      // Failed registration can leave an unregistered empty file; never adopt/delete it.
      return this.transaction(() => {
        admission?.();
        insertSession(this.db, session);
        if (host) this.insertHost(host.fingerprint, { ...host.receipt, status: "completed", result: { sessionId: id } });
        return session;
      });
    });
  }

  async validateSessionFile(id: string): Promise<{ piSessionId: string; cwd: string }> {
    return validateManagedFile(this.root, this.get(id));
  }

  async claimOwnership(id: string): Promise<void> {
    await this.change(() => {
      const session = this.get(id);
      if (session.ownerEpoch !== undefined || session.archived || session.deleted) throw new Error("Session is owned, archived, or deleted");
      session.lifecycleRevision = (session.lifecycleRevision ?? 0) + 1;
      delete session.stopReason;
      session.ownerEpoch = this.epoch;
      this.updateSession(session);
    });
  }

  async releaseOwnership(id: string, reason?: CatalogSession["stopReason"]): Promise<void> {
    await this.change(() => {
      const session = this.get(id);
      if (session.ownerEpoch !== this.epoch) throw new Error("Session ownership changed before recording its exit");
      if (session.stopReason !== "user") session.stopReason = reason;
      delete session.ownerEpoch;
      this.updateSession(session);
    });
  }

  async updateTitle(id: string, name: string | undefined): Promise<void> {
    name = name?.trim() || undefined;
    await this.serial(() => {
      const session = this.get(id);
      if (session.name === name || session.deleted) return;
      this.transaction(() => {
        session.name = name;
        this.updateSession(session);
      });
    });
  }

  async updateActivity(id: string, timestamp = new Date().toISOString()): Promise<void> {
    await this.serial(() => {
      const session = this.get(id);
      if (session.deleted || Date.parse(timestamp) <= Date.parse(session.lastActivityAt ?? session.createdAt)) return;
      this.transaction(() => {
        session.lastActivityAt = timestamp;
        this.updateSession(session);
      });
    });
  }

  private async backfillMetadata(): Promise<void> {
    for (const session of this.list()) {
      // Never read a file still claimed by an unresolved worker.
      if (session.ownerEpoch !== undefined) continue;
      let metadata: Awaited<ReturnType<typeof readManagedMetadata>>;
      try { metadata = await readManagedMetadata(this.root, session); }
      catch (error) {
        console.warn(`Could not refresh metadata for session ${session.id}:`, error);
        continue; // An unreadable history must not hide other saved sessions.
      }
      await this.updateTitle(session.id, metadata.name);
      await this.updateActivity(session.id, metadata.lastActivityAt);
    }
  }

  private updateSession(session: CatalogSession): void {
    const { acceptedQueue: _, ...metadata } = session;
    this.db.prepare("UPDATE sessions SET owner_epoch=?, metadata=? WHERE id=?")
      .run(session.ownerEpoch ?? null, JSON.stringify(metadata), session.id);
  }

  private receipts(where: string, parameters: SQLInputValue[]): StoredCommand[] {
    // The subquery limits compact records before fetching recovery blobs.
    return this.read(() => this.db.prepare(`SELECT c.fingerprint, c.receipt, r.payload FROM (${where}) c
      LEFT JOIN recovery r ON r.command_seq=c.seq`).all(...parameters).map((row) => {
      const receipt = JSON.parse(String(row.receipt)) as CommandReceipt;
      if (row.payload !== null) receipt.result = { ...receipt.result, ...JSON.parse(String(row.payload)) };
      return { fingerprint: String(row.fingerprint), receipt };
    }));
  }

  recentCommands(sessionId: string): CommandReceipt[] {
    return this.read(() => {
      let remaining = 2 * MiB;
      // Size the blobs on disk before hydrating; a count limit alone permits
      // 128 large abort outcomes to overwhelm every snapshot and its viewers.
      const rows = this.db.prepare(`SELECT c.seq, c.receipt, length(CAST(r.payload AS BLOB)) AS bytes
        FROM (SELECT seq, receipt FROM commands WHERE session_id=? ORDER BY seq DESC LIMIT 128) c
        LEFT JOIN recovery r ON r.command_seq=c.seq ORDER BY c.seq DESC`).all(sessionId);
      return rows.map((row) => {
        const receipt = JSON.parse(String(row.receipt)) as CommandReceipt;
        if (row.bytes !== null) {
          const bytes = Number(row.bytes);
          if (bytes <= remaining) {
            const recovery = this.db.prepare("SELECT payload FROM recovery WHERE command_seq=?").get(row.seq)!;
            receipt.result = { ...receipt.result, ...JSON.parse(String(recovery.payload)) };
            remaining -= bytes;
          } else receipt.recoveryAvailable = true;
        }
        return receipt;
      }).reverse();
    });
  }

  commandStatus(epoch: string, id: string): CommandReceipt | undefined { return this.commandRecord(epoch, id)?.receipt; }

  commandRecord(epoch: string, id: string): StoredCommand | undefined {
    return this.receipts("SELECT seq, fingerprint, receipt FROM commands WHERE epoch=? AND id=?", [epoch, id])[0];
  }

  queue(sessionId: string): AcceptedQueueItem[] {
    return this.read(() => this.db.prepare("SELECT item FROM queue WHERE session_id=? ORDER BY position").all(sessionId)
      .map((row) => JSON.parse(String(row.item)) as AcceptedQueueItem));
  }

  private setQueue(sessionId: string, items: AcceptedQueueItem[]): void {
    this.get(sessionId);
    if (!items.every(validQueueItem) || new Set(items.map((item) => item.id)).size !== items.length) throw new Error("Invalid accepted queue update");
    this.db.prepare("DELETE FROM queue WHERE session_id=?").run(sessionId);
    insertQueue(this.db, sessionId, items);
    const total = this.db.prepare("SELECT count(*) AS n, coalesce(sum(charge),0) AS bytes FROM queue").get()!;
    if (Number(total.n) > 128 || Number(total.bytes) > 8 * MiB) throw new CommandError("queue_limit", "Accepted queue capacity reached (128 items / 8 MiB per profile)");
    this.transactionBytes += Number(total.bytes);
  }

  async replaceQueue(sessionId: string, items: AcceptedQueueItem[]): Promise<void> {
    const copy = structuredClone(items);
    await this.change(() => this.setQueue(sessionId, copy));
  }

  async reserveCommand(command: StoredCommand, queue?: AcceptedQueueItem[], admission?: () => void): Promise<CommandReceipt> {
    const copy = structuredClone(command);
    const items = queue && structuredClone(queue);
    return this.serial(async () => {
      if (copy.receipt.serviceEpoch !== this.epoch) throw new CommandError("stale_epoch", "Command belongs to another service epoch");
      if (this.commandRecord(copy.receipt.serviceEpoch, copy.receipt.id)) throw new CommandError("command_conflict", "Command ID is already reserved");
      if (Buffer.byteLength(JSON.stringify(copy)) > commandBytes(copy)) throw new Error("Command receipt exceeds its reserved slot");
      await this.storageCapacity(commandBytes(copy), essential.has(copy.receipt.operation));
      return this.transaction(() => {
        admission?.();
        if (items) this.setQueue(copy.receipt.sessionId, items);
        if (copy.receipt.operation === "session.kill") {
          const session = this.get(copy.receipt.sessionId);
          if (session.ownerEpoch !== this.epoch || session.stopReason === "user") throw new CommandError("session_unavailable", "Session is no longer live");
          // Persist intent atomically with acceptance, retaining the ownership
          // fence until worker cleanup (or explicit reconciliation) completes.
          session.stopReason = "user";
          session.lifecycleRevision = (session.lifecycleRevision ?? 0) + 1;
          this.updateSession(session);
        }
        insertCommand(this.db, copy);
        this.transactionBytes += commandBytes(copy);
        return copy.receipt;
      });
    });
  }

  /** A detached clone keeps the source handle untouched. Registration shares
   * the terminal receipt transaction; trust stays keyed to its canonical file. */
  async cloneRecord(file: string, cwd: string): Promise<CatalogSession> {
    const directory = join(this.root, "sessions");
    const id = basename(file, ".jsonl");
    if (dirname(file) !== directory || file !== join(directory, `${id}.jsonl`) || !/^[0-9a-f-]{36}$/.test(id)) throw new Error("Clone is not a service-managed session file");
    const record: CatalogSession = { id, piSessionId: id, cwd, createdAt: new Date().toISOString() };
    const header = await validateManagedFile(this.root, record);
    if (header.cwd !== cwd) throw new Error("Clone cwd does not match its header");
    Object.assign(record, await readManagedMetadata(this.root, record));
    const handle = await open(file, "r+");
    try { await handle.sync(); } finally { await handle.close(); }
    await syncDirectory(directory);
    return record;
  }

  async updateCommand(receipt: CommandReceipt, clone?: CatalogSession): Promise<void> {
    const next = structuredClone(receipt);
    await this.change(() => {
      const command = this.commandRecord(next.serviceEpoch, next.id);
      if (!command || command.receipt.status !== "accepted") throw new Error("Command receipt is not pending");
      const updated = { fingerprint: command.fingerprint, receipt: next };
      if (next.sessionId !== command.receipt.sessionId || next.operation !== command.receipt.operation
        || next.runtimeRevision !== command.receipt.runtimeRevision || next.authority !== command.receipt.authority) throw new Error("Command outcome identity changed");
      if (commandBytes(updated) > commandBytes(command) || Buffer.byteLength(JSON.stringify(updated)) > commandBytes(command)) {
        throw new Error("Command outcome exceeds its reserved storage budget");
      }
      if ((next.operation === "session.rename" || next.operation === "title.generate") && next.status === "completed") {
        const session = this.get(next.sessionId);
        if (!validEffectiveTitle(next.result?.title)) throw new Error("Invalid completed rename");
        session.name = next.result.title;
        this.updateSession(session);
      }
      if (clone) {
        if (!["history.clone", "history.fork"].includes(next.operation) || next.status !== "completed" || next.result?.sessionId !== clone.id) throw new Error("Invalid clone registration outcome");
        insertSession(this.db, clone);
      }
      this.transactionBytes += commandBytes(updated);
      const { metadata, recovery } = splitReceipt(next);
      const row = this.db.prepare("UPDATE commands SET status=?, reserved_bytes=?, receipt=? WHERE epoch=? AND id=? RETURNING seq")
        .get(next.status, commandBytes(updated), JSON.stringify(metadata), next.serviceEpoch, next.id)!;
      this.db.prepare("DELETE FROM recovery WHERE command_seq=?").run(row.seq);
      if (recovery) this.db.prepare("INSERT INTO recovery VALUES(?,?)").run(row.seq, JSON.stringify(recovery));
    });
  }

  private async storageCapacity(bytes: number, control: boolean): Promise<void> {
    let free: number;
    try { const stat = await statfs(this.root); free = stat.bavail * stat.bsize; }
    catch (error) { throw this.fence(error); }
    const pending = this.db.prepare("SELECT coalesce(sum(reserved_bytes),0) AS bytes FROM commands WHERE status='accepted'").get()!;
    // WAL plus main-file growth/checkpoint scratch and outstanding outcome budgets.
    if (free < 2 * (Number(pending.bytes) + bytes) + (control ? CONTROL_HEADROOM : ORDINARY_HEADROOM)) {
      throw new CommandError("storage_pressure", "Insufficient free space for durable admission and recovery headroom; no command dispatched");
    }
  }

  private async recover(): Promise<void> {
    await this.change(() => {
      // Indexed bulk transition, no historical receipt hydration. Recovery blobs
      // are separate and unchanged. Old envelopes never regain admission authority.
      this.db.prepare(`UPDATE commands SET status='uncertain', receipt=json_set(receipt, '$.status','uncertain',
        '$.error',json_object('code','owner_interrupted','message','Service stopped before a durable command outcome; review, do not replay')) WHERE status='accepted'`).run();
      const sessions = this.db.prepare("SELECT DISTINCT session_id FROM queue").all();
      for (const row of sessions) {
        const items = this.queue(String(row.session_id));
        for (const item of items) if (item.status !== "failed") {
          item.status = "failed";
          item.revision++;
          item.error = { code: "owner_interrupted", message: "Service stopped before queue delivery completed; review before explicitly editing/resubmitting" };
        }
        this.setQueue(String(row.session_id), items);
      }
    });
  }

  async close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      await this.writing;
      if (this.failure) {
        this.db.close();
        await this.lock.close();
        this.lifetime.close();
        throw this.failure;
      }
      if (this.db.prepare("SELECT 1 FROM sessions WHERE owner_epoch IS NOT NULL LIMIT 1").get()) throw new Error("Stop owned sessions before releasing the service catalog");
      const jobs = inspectEpoch(this.processRegistry, this.epoch);
      if (jobs.some((job) => !["done", "cancelled"].includes(job.status))) throw new Error("Known managed processes remain unresolved; retain ownership");
      sealEpoch(this.processRegistry, this.epoch);
      try { this.checkpoint(true); this.db.close(); }
      catch (error) { throw this.fence(error); }
      const path = join(this.root, "owner.lock");
      const owner = await privateJson(path, 16384);
      const original = await this.lock.stat();
      const current = await lstat(path);
      if (!object(owner) || owner.epoch !== this.epoch || original.dev !== current.dev || original.ino !== current.ino) throw new Error("Service lock changed; refusing to remove it");
      await unlink(path);
      this.released = true;
      try { await syncDirectory(this.root); }
      finally { await this.lock.close(); this.lifetime.close(); }
    })();
    try { await this.closing; }
    catch (error) { if (!this.released) this.closing = undefined; throw error; }
  }

  private async serial<T>(update: () => T | Promise<T>): Promise<T> {
    if (this.closing) throw new Error("Service catalog is closing");
    if (this.failure) throw this.failure;
    const task = this.writing.then(async () => {
      if (this.failure) throw this.failure;
      // Yield between bounded transactions, including under sustained admissions.
      await setImmediate();
      if (this.failure) throw this.failure;
      try { return await update(); }
      catch (error) {
        if (object(error) && ["ERR_SQLITE_ERROR", "ENOSPC", "EIO", "EDQUOT", "EROFS"].includes(String(error.code))) throw this.fence(error);
        throw error;
      }
    });
    this.writing = task.then(() => undefined, () => undefined);
    return task;
  }

  private change<T>(update: () => T): Promise<T> { return this.serial(() => this.transaction(update)); }

  private transaction<T>(update: () => T): T {
    if (this.failure) throw this.failure;
    this.transactionBytes = 0;
    let began = false;
    let committing = false;
    try {
      this.db.exec("BEGIN IMMEDIATE");
      began = true;
      const result = update();
      committing = true;
      this.db.exec("COMMIT");
      began = false;
      this.checkpointBytes += this.transactionBytes + 4096;
      if (++this.commits % 128 === 0 || this.checkpointBytes >= 8 * MiB) {
        this.checkpoint(false);
        this.checkpointBytes = 0;
      }
      return result;
    } catch (error) {
      if (began) {
        try { this.db.exec("ROLLBACK"); }
        catch (rollback) { throw this.fence(new AggregateError([error, rollback], "Transaction/rollback failed")); }
      }
      if (committing || object(error) && error.code === "ERR_SQLITE_ERROR") throw this.fence(error);
      throw error;
    }
  }

  private checkpoint(final: boolean): void {
    const row = this.db.prepare(`PRAGMA wal_checkpoint(${final ? "TRUNCATE" : "PASSIVE"})`).get()!;
    if (final && Number(row.busy) !== 0) throw new Error("SQLite checkpoint blocked; ownership must remain claimed");
    // PASSIVE busy is a valid partial checkpoint; WAL remains authoritative.
  }

  private read<T>(query: () => T): T {
    try { return query(); }
    catch (error) {
      if (object(error) && error.code === "ERR_SQLITE_ERROR") throw this.fence(error);
      throw error;
    }
  }

  private fence(error: unknown): Error {
    if (!this.failure) {
      this.failure = new Error("SQLite storage unavailable or commit uncertain; further mutations fenced, retain service lock for recovery", { cause: error });
      this.resolveFailure(this.failure);
    }
    return this.failure;
  }
}
