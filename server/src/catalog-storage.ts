import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { object } from "./pi-records.js";
import { CommandError, validPromptText, type CommandReceipt, type StoredCommand } from "./session-commands.js";
import { validQueueItem, type AcceptedQueueItem } from "./session-queue.js";
import { validEffectiveTitle } from "./session-rename.js";

export type Channel = "stable" | "dev";
export type CatalogSession = {
  id: string;
  piSessionId: string;
  cwd: string;
  createdAt: string;
  name?: string;
  archived?: boolean;
  deleted?: boolean;
  lifecycleRevision?: number;
  state: "saved" | "open" | "interrupted";
  ownerEpoch?: string;
  acceptedQueue?: AcceptedQueueItem[];
};
type CatalogData = { schemaVersion: 1; channel: Channel; hostId: string; sessions: CatalogSession[]; commands?: StoredCommand[] };
const CATALOG_BYTES = 64 * 1024 * 1024;
const COMMAND_BYTES = 32 * 1024 * 1024;
const ABORT_RESERVATION = 17 * 1024 * 1024;
export function commandBytes(command: StoredCommand): number {
  // Queue submission/edit receipts preserve accepted text even if Pi's history
  // append fails after message_end. Reserve escaped text plus outcome headroom.
  if (command.receipt.operation === "prompt.submit" || command.receipt.operation === "queue.edit") {
    return 4096 + Buffer.byteLength(JSON.stringify(command.receipt.result?.queueItemText ?? ""));
  }
  // Restoration checkpoints the original bytes before touching the worktree/index.
  // Base64 of a 1-MiB file plus compact outcome fits this fixed reservation.
  if (command.receipt.operation === "workspace.review.restore") return 2 * 1024 * 1024;
  // Compact review outcomes include bounded owner references/paths, never editor text.
  if (command.receipt.operation.startsWith("workspace.review.")) return 40 * 1024;
  if (command.receipt.result?.submittedText !== undefined) return 4096 + Buffer.byteLength(JSON.stringify(command.receipt.result.submittedText));
  // Other non-abort outcomes fit a fixed slot; completing cannot grow charge.
  // Abort reserves its maximum queue response until terminal.
  const largeOutcome = command.receipt.operation === "turn.abort" || command.receipt.operation === "history.navigate" || command.receipt.operation === "history.fork";
  if (command.receipt.status === "accepted" && largeOutcome) return ABORT_RESERVATION;
  return largeOutcome ? Math.max(4096, Buffer.byteLength(JSON.stringify(command))) : 4096;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await directory.sync(); }
  finally { await directory.close(); }
}

export async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
    throw new Error(`Service directory must be owned by this user with mode 0700: ${path}`);
  }
  await syncDirectory(path);
  await syncDirectory(await realpath(dirname(path)));
}

export async function privateJson(path: string, limit: number): Promise<unknown> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || stat.size > limit) {
      throw new Error(`Invalid private service file or size limit exceeded: ${path}`);
    }
    const bytes = await file.readFile();
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch { throw new Error(`Invalid service JSON: ${path}`); }
  } finally { await file.close(); }
}

/** Schema-1 import validation only; these historical ceilings do not limit SQLite. */
function catalogData(value: unknown, channel: Channel): CatalogData {
  if (!object(value) || value.schemaVersion !== 1) throw new Error("Unsupported service catalog schema; leaving existing data unchanged");
  if (value.channel !== channel || typeof value.hostId !== "string" || !uuid.test(value.hostId) || !Array.isArray(value.sessions)) {
    throw new Error("Invalid service catalog identity or channel");
  }
  const ids = new Set<string>();
  const piIds = new Set<string>();
  for (const item of value.sessions) {
    if (!object(item) || typeof item.id !== "string" || !uuid.test(item.id) || ids.has(item.id)
      || typeof item.piSessionId !== "string" || !uuid.test(item.piSessionId) || piIds.has(item.piSessionId)
      || typeof item.cwd !== "string" || !isAbsolute(item.cwd) || typeof item.createdAt !== "string"
      || (item.name !== undefined && typeof item.name !== "string")
      || typeof item.state !== "string" || !["saved", "open", "interrupted"].includes(item.state)
      || (item.ownerEpoch !== undefined && (typeof item.ownerEpoch !== "string" || !uuid.test(item.ownerEpoch)))
      || (item.state === "open" && item.ownerEpoch === undefined)) throw new Error("Invalid service catalog session");
    if (item.acceptedQueue !== undefined && (!Array.isArray(item.acceptedQueue)
      || !item.acceptedQueue.every(validQueueItem)
      || new Set(item.acceptedQueue.map((queued) => queued.id)).size !== item.acceptedQueue.length)) throw new Error("Invalid accepted queue");
    ids.add(item.id);
    piIds.add(item.piSessionId);
  }
  queueBudget(value as CatalogData);
  if (value.commands !== undefined) {
    if (!Array.isArray(value.commands) || value.commands.length > 1024) throw new Error("Invalid command receipt catalog");
    const commands = new Set<string>();
    for (const command of value.commands) {
      if (!object(command) || typeof command.fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(command.fingerprint)
        || !object(command.receipt)) throw new Error("Invalid command receipt");
      if (Buffer.byteLength(JSON.stringify(command)) > commandBytes(command as StoredCommand)) throw new Error("Command receipt exceeds its reserved slot");
      const receipt = command.receipt;
      if (typeof receipt.id !== "string" || !/^[\w-]{1,128}$/.test(receipt.id)
        || typeof receipt.sessionId !== "string" || !ids.has(receipt.sessionId)
        || typeof receipt.serviceEpoch !== "string" || !uuid.test(receipt.serviceEpoch)
        || !Number.isSafeInteger(receipt.runtimeRevision) || (receipt.runtimeRevision as number) < 0
        || !["control.acquire", "control.takeover", "control.release", "interaction.respond", "interaction.cancel", "turn.abort", "prompt.submit", "queue.edit", "queue.remove", "queue.reserve", "queue.release", "session.rename"].includes(String(receipt.operation))
        || !["accepted", "completed", "failed", "uncertain"].includes(String(receipt.status))
        || (receipt.error !== undefined && (!object(receipt.error) || typeof receipt.error.code !== "string" || typeof receipt.error.message !== "string"))) throw new Error("Invalid command receipt fields");
      if (receipt.result !== undefined) {
        if (!object(receipt.result) || (receipt.result.delivery !== undefined && receipt.result.delivery !== "flushed")
          || (receipt.result.idle !== undefined && typeof receipt.result.idle !== "boolean")) throw new Error("Invalid command result");
        if ([receipt.result.queueItemId, receipt.result.reservationId].some((id) => id !== undefined && (typeof id !== "string" || !/^[\w-]{1,128}$/.test(id)))
          || (receipt.result.queueItemRevision !== undefined && (!Number.isSafeInteger(receipt.result.queueItemRevision) || (receipt.result.queueItemRevision as number) < 1))) throw new Error("Invalid queue command result");
        if (receipt.result.queueItemText !== undefined && !validPromptText(receipt.result.queueItemText)) throw new Error("Invalid accepted text recovery result");
        if (receipt.result.title !== undefined && (receipt.operation !== "session.rename" || !validEffectiveTitle(receipt.result.title))) throw new Error("Invalid rename command result");
        const cleared = receipt.result.cleared;
        if (cleared !== undefined && (!object(cleared) || !Array.isArray(cleared.steering) || !Array.isArray(cleared.followUp)
          || ![...cleared.steering, ...cleared.followUp].every((text) => typeof text === "string"))) throw new Error("Invalid cleared queue result");
      }
      if (receipt.operation === "session.rename" && receipt.status === "completed"
        && (!object(receipt.result) || !validEffectiveTitle(receipt.result.title))) throw new Error("Missing completed rename title");
      const key = `${receipt.serviceEpoch}:${receipt.id}`;
      if (commands.has(key)) throw new Error("Duplicate command receipt");
      commands.add(key);
    }
    if ((value.commands as StoredCommand[]).reduce((sum, command) => sum + commandBytes(command), 0) > COMMAND_BYTES) throw new Error("Command receipt budget exceeded");
  }
  return value as CatalogData;
}

function queueBudget(data: CatalogData): void {
  const items = data.sessions.flatMap((session) => session.acceptedQueue ?? []);
  // Reserve fixed metadata/error headroom so terminal/recovery transitions never
  // grow the charge beyond the budget admitted for text.
  if (items.length > 128 || items.reduce((bytes, item) => bytes + Buffer.byteLength(JSON.stringify(item.text)) + 4096, 0) > 8 * 1024 * 1024) {
    throw new CommandError("queue_limit", "Accepted queue capacity reached (128 items / 8 MiB per profile)");
  }
}


// catalog.json is an activation guard, not a second writable catalog. Old schema-1
// owners reject it. Keep the original source bytes separately for offline recovery.
type Activation = { schemaVersion: 2; database: "catalog.sqlite"; hostId: string; channel: Channel;
  phase: "initializing" | "ready"; sourceDigest?: string };
const DATABASE_VERSION = 1;

async function optionalJson(path: string): Promise<unknown | undefined> {
  try { return await privateJson(path, CATALOG_BYTES); }
  catch (error) { if (object(error) && error.code === "ENOENT") return undefined; throw error; }
}

async function activate(root: string, value: Activation): Promise<void> {
  const temporary = join(root, `activation-` + randomUUID() + `.tmp`);
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(value) + "\n");
    await file.sync();
  } finally { await file.close(); }
  await rename(temporary, join(root, "catalog.json"));
  await syncDirectory(root);
}

async function sourceCopy(root: string, source?: CatalogData): Promise<{ data: CatalogData; digest: string }> {
  const path = join(root, "catalog.schema-1.json");
  if (source) {
    // Copy the exact validated source, not a lossy re-encoding.
    const original = await open(join(root, "catalog.json"), constants.O_RDONLY | constants.O_NOFOLLOW);
    let bytes: Buffer;
    try { bytes = await original.readFile(); } finally { await original.close(); }
    const parsed = catalogData(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), source.channel);
    if (JSON.stringify(parsed) !== JSON.stringify(source)) throw new Error("Migration source changed");
    const prior = await optionalJson(path);
    if (prior === undefined) {
      const temporary = join(root, `source-${randomUUID()}.tmp`);
      const copy = await open(temporary, "wx", 0o600);
      try { await copy.writeFile(bytes); await copy.sync(); } finally { await copy.close(); }
      await rename(temporary, path);
      await syncDirectory(root);
    } else {
      // A prior interrupted conversion is usable only with identical source bytes.
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { if (!(await file.readFile()).equals(bytes)) throw new Error("Conflicting migration source copy"); }
      finally { await file.close(); }
    }
  }
  const value = await privateJson(path, CATALOG_BYTES);
  if (!object(value) || (value.channel !== "stable" && value.channel !== "dev")) throw new Error("Invalid migration source");
  const data = catalogData(value, value.channel);
  if (data.sessions.some((session) => session.state === "open" || session.ownerEpoch !== undefined)) {
    throw new Error("Catalog contains unresolved live ownership; recovery is required before migration");
  }
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { return { data, digest: createHash("sha256").update(await file.readFile()).digest("hex") }; }
  finally { await file.close(); }
}

export async function validateManagedFile(root: string, session: CatalogSession): Promise<{ piSessionId: string; cwd: string }> {
  const file = await open(join(root, "sessions", session.id + ".jsonl"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.()) throw new Error("Invalid managed session file ownership");
    const buffer = Buffer.alloc(65536);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const end = buffer.subarray(0, bytesRead).indexOf(10);
    if (end < 0) throw new Error("Missing or oversized managed session header");
    const header: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, end)));
    if (!object(header) || header.type !== "session" || header.version !== 3 || header.id !== session.piSessionId
      || typeof header.cwd !== "string" || !isAbsolute(header.cwd)) throw new Error("Managed session identity does not match its catalog");
    return { piSessionId: session.piSessionId, cwd: header.cwd };
  } finally { await file.close(); }
}

export function insertSession(db: DatabaseSync, session: CatalogSession): void {
  const { acceptedQueue: _, ...metadata } = session;
  db.prepare("INSERT INTO sessions(id, pi_id, state, owner_epoch, metadata) VALUES(?,?,?,?,?)")
    .run(session.id, session.piSessionId, session.state, session.ownerEpoch ?? null, JSON.stringify(metadata));
  insertQueue(db, session.id, session.acceptedQueue ?? []);
}

export function insertQueue(db: DatabaseSync, sessionId: string, items: AcceptedQueueItem[]): void {
  const statement = db.prepare("INSERT INTO queue(session_id, id, position, charge, item) VALUES(?,?,?,?,?)");
  items.forEach((item, position) => statement.run(sessionId, item.id, position,
    Buffer.byteLength(JSON.stringify(item.text)) + 4096, JSON.stringify(item)));
}

export function insertCommand(db: DatabaseSync, command: StoredCommand): void {
  const { receipt } = command;
  const { metadata, recovery } = splitReceipt(receipt);
  const result = db.prepare("INSERT INTO commands(epoch, id, session_id, fingerprint, status, operation, reserved_bytes, receipt) VALUES(?,?,?,?,?,?,?,?)")
    .run(receipt.serviceEpoch, receipt.id, receipt.sessionId, command.fingerprint, receipt.status, receipt.operation, commandBytes(command), JSON.stringify(metadata));
  if (recovery) db.prepare("INSERT INTO recovery(command_seq, payload) VALUES(?,?)").run(result.lastInsertRowid, JSON.stringify(recovery));
}

export function splitReceipt(receipt: CommandReceipt): { metadata: CommandReceipt; recovery?: Pick<NonNullable<CommandReceipt["result"]>, "queueItemText" | "submittedText" | "editorText" | "cleared" | "reviewRecovery"> } {
  const metadata = structuredClone(receipt);
  if (!metadata.result) return { metadata };
  const { queueItemText, submittedText, editorText, cleared, reviewRecovery, ...compact } = metadata.result;
  metadata.result = compact;
  return { metadata, recovery: queueItemText !== undefined || submittedText !== undefined || editorText !== undefined || cleared !== undefined || reviewRecovery !== undefined ? { queueItemText, submittedText, editorText, cleared, reviewRecovery } : undefined };
}

/** Exclusive initialization only. Callers retain the claim on any mutation failure. */
export async function openStorage(root: string, channel: Channel, mutating: () => void, recoveryEpoch?: string): Promise<{ db: DatabaseSync; hostId: string }> {
  const path = join(root, "catalog.sqlite");
  const value = await optionalJson(join(root, "catalog.json"));
  let activation: Activation;
  let source: CatalogData | undefined;
  let databaseExists = false;
  try { await lstat(path); databaseExists = true; }
  catch (error) { if (!object(error) || error.code !== "ENOENT") throw error; }
  if (value === undefined || object(value) && value.schemaVersion === 1) {
    if (databaseExists) throw new Error("SQLite exists without an activation guard; offline inspection required");
    source = value === undefined ? undefined : catalogData(value, channel);
    if (source?.sessions.some((session) => session.state === "open" || session.ownerEpoch !== undefined)) {
      throw new Error("Catalog contains unresolved live ownership; recovery is required before migration");
    }
    if (source) for (const session of source.sessions) await validateManagedFile(root, session);
    // A leftover source without an activation guard must not become a fresh profile.
    if (!source && await optionalJson(join(root, "catalog.schema-1.json")) !== undefined) throw new Error("Migration source exists without activation guard");
    activation = { schemaVersion: 2, database: "catalog.sqlite", channel, hostId: source?.hostId ?? randomUUID(), phase: "initializing" };
    mutating();
    if (source) activation.sourceDigest = (await sourceCopy(root, source)).digest;
    await activate(root, activation);
  } else {
    if (!object(value) || value.schemaVersion !== 2 || value.database !== "catalog.sqlite" || value.channel !== channel
      || typeof value.hostId !== "string" || !uuid.test(value.hostId) || !["initializing", "ready"].includes(String(value.phase))
      || (value.sourceDigest !== undefined && (typeof value.sourceDigest !== "string" || !/^[a-f0-9]{64}$/.test(value.sourceDigest)))) {
      throw new Error("Unsupported service catalog activation schema or identity; leaving data unchanged");
    }
    activation = value as Activation;
    if (activation.phase === "ready" && !databaseExists) throw new Error("Authoritative SQLite database missing; refusing JSON fallback");
  }
  if (activation.phase === "initializing" && activation.sourceDigest) {
    const copy = await sourceCopy(root);
    if (copy.digest !== activation.sourceDigest || copy.data.hostId !== activation.hostId || copy.data.channel !== channel) throw new Error("Migration source identity/digest mismatch");
    source = copy.data;
    for (const session of source.sessions) await validateManagedFile(root, session);
  }
  if (!databaseExists) {
    mutating();
    const file = await open(path, "wx", 0o600);
    try { await file.sync(); } finally { await file.close(); }
    await syncDirectory(root);
  }
  // Refuse links/foreign or public files before SQLite can follow them. Sidecars
  // inherit the database's 0600 mode; the containing profile is also 0700.
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    try {
      const stat = await lstat(path + suffix);
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw new Error("Invalid private SQLite file: " + path + suffix);
    } catch (error) { if (!object(error) || error.code !== "ENOENT") throw error; }
  }
  // Inspect the version before writable opening / journal PRAGMAs. Empty v0 is
  // permitted only while initializing; a newer schema is never downgraded.
  const inspection = new DatabaseSync(path, { readOnly: true });
  let version: number;
  try {
    version = Number(inspection.prepare("PRAGMA user_version").get()!.user_version);
    if (version !== DATABASE_VERSION && !(version === 0 && activation.phase === "initializing"
      && Number(inspection.prepare("SELECT count(*) AS n FROM sqlite_master").get()!.n) === 0)) throw new Error("Unsupported SQLite catalog schema; leaving data unchanged");
    if (version === DATABASE_VERSION) {
      const meta = inspection.prepare("SELECT host_id, channel FROM profile WHERE singleton=1").get();
      if (meta?.host_id !== activation.hostId || meta.channel !== channel) throw new Error("SQLite profile identity mismatch");
      const owned = inspection.prepare("SELECT owner_epoch FROM sessions WHERE state='open' OR owner_epoch IS NOT NULL").all();
      if (owned.some((row) => !recoveryEpoch || row.owner_epoch !== recoveryEpoch)) throw new Error("Catalog contains unresolved live ownership; recovery required");
    }
  } finally { inspection.close(); }
  mutating();
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=0; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA fullfsync=ON; PRAGMA checkpoint_fullfsync=ON; PRAGMA wal_autocheckpoint=0; PRAGMA journal_size_limit=0; PRAGMA cache_size=-4096;");
    if (db.prepare("PRAGMA journal_mode").get()?.journal_mode !== "wal"
      || db.prepare("PRAGMA synchronous").get()?.synchronous !== 2
      || db.prepare("PRAGMA foreign_keys").get()?.foreign_keys !== 1
      || db.prepare("PRAGMA fullfsync").get()?.fullfsync !== 1
      || db.prepare("PRAGMA checkpoint_fullfsync").get()?.checkpoint_fullfsync !== 1
      || db.prepare("PRAGMA wal_autocheckpoint").get()?.wal_autocheckpoint !== 0) throw new Error("Required SQLite durability settings unavailable");
    if (version === 0) {
      db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE profile(singleton INTEGER PRIMARY KEY CHECK(singleton=1), host_id TEXT NOT NULL, channel TEXT NOT NULL);
        CREATE TABLE sessions(id TEXT PRIMARY KEY, pi_id TEXT NOT NULL UNIQUE, state TEXT NOT NULL, owner_epoch TEXT, metadata TEXT NOT NULL);
        CREATE TABLE queue(session_id TEXT NOT NULL REFERENCES sessions(id), id TEXT NOT NULL, position INTEGER NOT NULL, charge INTEGER NOT NULL, item TEXT NOT NULL, PRIMARY KEY(session_id,id), UNIQUE(session_id,position));
        CREATE TABLE commands(seq INTEGER PRIMARY KEY, epoch TEXT NOT NULL, id TEXT NOT NULL, session_id TEXT REFERENCES sessions(id), fingerprint TEXT NOT NULL, status TEXT NOT NULL, operation TEXT NOT NULL, reserved_bytes INTEGER NOT NULL, receipt TEXT NOT NULL, UNIQUE(epoch,id));
        CREATE INDEX commands_recent ON commands(session_id,seq DESC);
        CREATE INDEX commands_pending ON commands(status) WHERE status='accepted';
        CREATE TABLE recovery(command_seq INTEGER PRIMARY KEY REFERENCES commands(seq), payload TEXT NOT NULL);
        PRAGMA user_version=1;`);
      db.prepare("INSERT INTO profile VALUES(1,?,?)").run(activation.hostId, channel);
      for (const session of source?.sessions ?? []) insertSession(db, session);
      for (const command of source?.commands ?? []) insertCommand(db, command);
      db.exec("COMMIT");
    }
    if (activation.phase !== "ready") await activate(root, { ...activation, phase: "ready" });
    await syncDirectory(root);
    return { db, hostId: activation.hostId };
  } catch (error) { db.close(); throw error; }
}
