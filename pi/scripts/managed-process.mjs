import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { openSync, closeSync, lstatSync, fsyncSync, readFileSync, realpathSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';

// Keep ordinary editor/TUI extension imports free of SQLite initialization.
const require = createRequire(import.meta.url);
function database(path) { const { DatabaseSync } = require('node:sqlite'); return new DatabaseSync(path); }

const script = fileURLToPath(import.meta.url);
const contexts = new WeakMap();
const terminal = "('done','cancelled')";

export function assertManagedResources(env = process.env) {
  if (!env.PI_CONSOLE_RESOURCE_MANIFEST) return;
  privateFile(env.PI_CONSOLE_RESOURCE_MANIFEST);
  const manifest = JSON.parse(readFileSync(env.PI_CONSOLE_RESOURCE_MANIFEST, 'utf8'));
  if (manifest.buildId !== env.PI_CONSOLE_BUILD_ID || !Array.isArray(manifest.files)) throw new Error('Invalid host resource manifest');
  assertResourceManifest(manifest);
}

// Reuse the startup snapshot; launch checks inspect metadata, never file contents.
export function assertResourceManifest(manifest) {
  for (const candidate of manifest.lookup ?? []) {
    let target = null;
    try { target = realpathSync(candidate.path); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (target !== candidate.target) throw new Error('Host dependency lookup changed; restart required: ' + candidate.path);
  }
  for (const dependency of manifest.resolutions ?? []) {
    const paths = createRequire(dependency.from).resolve.paths(dependency.name) ?? [];
    const candidate = paths.map(path => join(path, dependency.name)).find(path => existsSync(join(path, 'package.json')));
    if ((candidate ? realpathSync(candidate) : null) !== dependency.target) throw new Error('Host dependency resolution changed; restart required: ' + dependency.name);
  }
  for (const file of manifest.files) {
    if (realpathSync(file.path) !== file.target) throw new Error('Host resources changed; restart required');
    const stat = lstatSync(file.target, { bigint: true });
    for (const key of ['ino','mode','size','mtimeNs','ctimeNs']) if (String(stat[key]) !== file[key]) throw new Error('Host resources changed; restart required: ' + file.path);
  }
}

function privateFile(path) {
  let fd;
  try { fd = openSync(path, 'wx', 0o600); fsyncSync(fd); }
  catch (e) { if (e.code !== 'EEXIST') throw e; }
  finally { if (fd !== undefined) closeSync(fd); }
  const s = lstatSync(path);
  if (!s.isFile() || s.nlink !== 1 || s.uid !== process.getuid() || (s.mode & 0o077)) throw new Error('Invalid private ownership file: ' + path);
}

export function ownerLease(root) {
  const path = join(root, 'owner-lease.sqlite');
  privateFile(path);
  const db = database(path);
  // Simultaneous EXCLUSIVE attempts can both encounter transient read locks,
  // leaving no winner with a zero busy timeout. Wait briefly at this boundary;
  // exhaustion still refuses ownership, without touching claims or recovery.
  try { db.exec('PRAGMA busy_timeout=50; BEGIN EXCLUSIVE'); }
  catch (e) { db.close(); throw new Error('Service process is still alive or its lifetime lease is unavailable', { cause: e }); }
  return { close() { db.close(); } };
}

export function registry(path) {
  privateFile(path);
  const db = database(path);
  try {
    db.exec('PRAGMA busy_timeout=1000');
    const v = db.prepare('PRAGMA user_version').get().user_version;
    if (v !== 0 && v !== 1) throw new Error('Unsupported managed ownership registry');
    db.exec('PRAGMA busy_timeout=1000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA fullfsync=ON; PRAGMA foreign_keys=ON;');
    if (v === 0) db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE epochs(id TEXT PRIMARY KEY, state TEXT NOT NULL);
      CREATE TABLE jobs(id TEXT PRIMARY KEY, epoch TEXT NOT NULL REFERENCES epochs(id), parent TEXT REFERENCES jobs(id), label TEXT NOT NULL, status TEXT NOT NULL, launch_open INTEGER NOT NULL, result TEXT);
      CREATE INDEX jobs_epoch ON jobs(epoch,status);
      CREATE INDEX jobs_parent ON jobs(parent);
      CREATE TABLE recoveries(epoch TEXT PRIMARY KEY, claim TEXT NOT NULL);
      PRAGMA user_version=1; COMMIT;`);
    return db;
  } catch (e) { db.close(); throw e; }
}

function transaction(db, f) {
  db.exec('BEGIN IMMEDIATE');
  try { const value = f(); db.exec('COMMIT'); return value; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

function assertLaunchAllowed(db, epoch) {
  const state = db.prepare('SELECT state FROM epochs WHERE id=?').get(epoch)?.state;
  if (state === 'restart-required') throw new Error('Host runtime resources changed or became unreadable; restart the service before launching more managed work');
  if (state !== 'active') throw new Error('Managed launch admission is sealed');
}

export function assertManagedLaunchAllowed(path, epoch) {
  const db = registry(path);
  try { assertLaunchAllowed(db, epoch); }
  finally { db.close(); }
}

function ancestorsOpen(db, job) {
  const state = db.prepare('SELECT state FROM epochs WHERE id=?').get(job.epoch)?.state;
  // Resource changes fence new launches, but must not stop existing workloads.
  if (state !== 'active' && state !== 'restart-required') return false;
  let parent = job.parent;
  while (parent) {
    const row = db.prepare('SELECT parent,status,launch_open FROM jobs WHERE id=?').get(parent);
    if (!row || row.status !== 'running' || !row.launch_open) return false;
    parent = row.parent;
  }
  return true;
}

export function beginEpoch(path, epoch) {
  const db = registry(path);
  try { db.prepare("INSERT INTO epochs VALUES(?,'active')").run(epoch); }
  finally { db.close(); }
}

function sealTree(db, id) {
  db.prepare(`WITH RECURSIVE tree(id) AS (SELECT id FROM jobs WHERE id=? UNION ALL SELECT jobs.id FROM jobs JOIN tree ON jobs.parent=tree.id)
    UPDATE jobs SET launch_open=0, status=CASE WHEN status='intent' THEN 'cancelled' ELSE status END WHERE id IN tree`).run(id);
}

export function sealEpoch(path, epoch) {
  const db = registry(path);
  try { transaction(db, () => {
    if (!db.prepare('SELECT 1 FROM epochs WHERE id=?').get(epoch)) throw new Error('Unknown legacy execution epoch; manual recovery required');
    db.prepare("UPDATE epochs SET state='sealed' WHERE id=?").run(epoch);
    db.prepare("UPDATE jobs SET launch_open=0,status=CASE WHEN status='intent' THEN 'cancelled' ELSE status END WHERE epoch=?").run(epoch);
  }); } finally { db.close(); }
}

export function inspectEpoch(path, epoch) {
  const db = registry(path);
  try { return db.prepare('SELECT id,parent,label,status,launch_open,result FROM jobs WHERE epoch=? ORDER BY rowid').all(epoch)
    .map(row => ({ ...row, result: row.result ? JSON.parse(row.result) : undefined })); }
  finally { db.close(); }
}

/** Only service-owned execution is wrapped. Ordinary editor/TUI launches stay unchanged. */
export function managedSpawn(command, args, options) {
  const env = options.env ?? process.env;
  const path = env.PI_CONSOLE_PROCESS_REGISTRY;
  const epoch = env.PI_CONSOLE_OWNER_EPOCH;
  if (!path || !epoch) return spawn(command, args, options);
  // The supervisor validates resources immediately before granting execution,
  // including nested launches. Do not repeat its full scan in the caller.
  const db = registry(path);
  const id = randomUUID();
  try { transaction(db, () => {
    const job = { epoch, parent: env.PI_CONSOLE_PROCESS_JOB || null };
    assertLaunchAllowed(db, epoch);
    if (!ancestorsOpen(db, job)) throw new Error('Managed launch admission is sealed');
    db.prepare("INSERT INTO jobs VALUES(?,?,?,?,'intent',1,NULL)").run(id, epoch, job.parent, command);
  }); } finally { db.close(); }
  let child;
  try {
    child = spawn(process.execPath, [script, 'supervise', path, id], {
      // Helper-only SQLite warnings must not become shell command output. The
      // anchor/workload receive the original environment in the launch message.
      cwd: options.cwd, env: { ...env, PI_CONSOLE_PROCESS_JOB: id, NODE_NO_WARNINGS: '1' }, detached: true,
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    });
    contexts.set(child, { path, id });
    child.on('error', () => {});
    child.on('message', () => {});
    child.on('spawn', () => {
      if (child.connected) child.send({ type: 'launch', command, args, env: { ...env, PI_CONSOLE_PROCESS_JOB: id } }, () => {});
    });
    return child;
  } catch (e) {
    // Intent has not received a launch grant. Reconciliation can cancel it.
    throw e;
  }
}

export function managedResult(child) {
  const context = contexts.get(child);
  if (!context) return undefined;
  const db = registry(context.path);
  try {
    const row = db.prepare('SELECT status,result FROM jobs WHERE id=?').get(context.id);
    if (row?.status !== 'done' || !row.result) return { code: null, signal: null, managedUnresolved: true, error: 'Managed supervisor ended without terminal cleanup evidence' };
    return JSON.parse(row.result);
  } finally { db.close(); }
}

export function stopManaged(child) {
  if (!contexts.has(child)) return false;
  child.stdin?.end();
  if (child.connected) child.send({ type: 'stop' }, () => {});
  return true;
}

// Best-effort discovery, never a stable registration boundary or stale-disk PID kill.
// A supervisor retains observed identities only in memory. Losing it leaves its
// granted job unresolved. Discovery runs only during cleanup; processes that
// leave the workload group and lose their ancestry before then can escape it.
function processes() {
  const output = execFileSync('/bin/ps', ['-ww', '-axo', 'pid=,ppid=,pgid=,stat=,lstart=,command='], { encoding: 'utf8', timeout: 1000, maxBuffer: 8 * 1024 * 1024 });
  const rows = new Map();
  for (const line of output.trim().split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+\s+\S+\s+\d+\s+[\d:]+\s+\d+)\s+(.+)$/);
    if (m) rows.set(Number(m[1]), { pid: Number(m[1]), parent: Number(m[2]), group: Number(m[3]), zombie: m[4].includes('Z'), identity: m[5], command: m[6] });
  }
  return rows;
}

async function supervise(path, id) {
  let db;
  let anchor;
  let stopAt;
  let exit;
  let launched = false;
  let finished = false;
  let directUnresolved = false;
  let sealed = false;
  let pendingRefusalEpoch;
  const known = new Map();
  const stop = () => { stopAt ??= performance.now(); };
  // Install death handling BEFORE waiting for initialization/launch.
  process.on('disconnect', stop);
  process.on('SIGTERM', stop);
  process.on('SIGHUP', stop);
  process.on('message', message => {
    if (message?.type === 'stop') stop();
    if (message?.type !== 'launch' || launched || finished) return;
    launched = true;
    try {
      const job = db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
      if (!job) throw new Error('Managed launch has no registered intent');
      assertLaunchAllowed(db, job.epoch);
      try { assertManagedResources(message.env); }
      catch (error) {
        // The loop must persist this refusal before starting terminal cleanup.
        pendingRefusalEpoch = job.epoch;
        throw new Error('Host runtime resources changed or became unreadable; restart the service before launching more managed work', { cause: error });
      }
      transaction(db, () => {
        const current = db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
        assertLaunchAllowed(db, job.epoch);
        if (stopAt || !current || current.status !== 'intent' || !ancestorsOpen(db, current)) throw new Error('Managed launch was cancelled before execution');
        db.prepare("UPDATE jobs SET status='running' WHERE id=?").run(id);
      });
      // Durable grant precedes fork. Death in this window is known uncertainty,
      // never permission to infer no launch from a missing PID/closed pipe.
      anchor = spawn(process.execPath, [script, 'anchor'], { detached: true, stdio: ['inherit', 'inherit', 'inherit', 'ipc'], env: message.env });
      anchor.on('error', error => { exit = { code: null, signal: null, error: error.message }; stop(); });
      anchor.on('message', record => {
        if (record?.type === 'workload_exit') { exit = record.exit; stop(); }
      });
      anchor.on('exit', () => { if (!finished) {
        if (!exit) { directUnresolved = true; exit = { code: null, signal: null, error: 'Managed anchor lost before workload exit acknowledgment' }; }
        stop();
      } });
      anchor.on('spawn', () => anchor.send(message, () => {}));
    } catch (e) { exit = { code: null, signal: null, error: e.message }; stop(); }
  });
  try {
    db = registry(path);
    const currentJob = db.prepare('SELECT * FROM jobs WHERE id=?');
    while (!finished) {
      if (pendingRefusalEpoch) {
        try {
          transaction(db, () => db.prepare("UPDATE epochs SET state='restart-required' WHERE id=? AND state='active'").run(pendingRefusalEpoch));
          pendingRefusalEpoch = undefined;
        } catch (error) {
          // Retry within the existing cleanup grace; never publish cancelled/done
          // with a lost refusal. Persistent storage failure leaves ownership unproven.
          if (performance.now() - stopAt > 8000) throw error;
          await delay(50);
          continue;
        }
      }
      const job = currentJob.get(id);
      if (!job || !job.launch_open || !ancestorsOpen(db, job)) stop();
      // Registry admission still observes ancestor cancellation/reconciliation,
      // but running workloads need no process-table discovery.
      if (stopAt === undefined) { await delay(50); continue; }
      // No launch request can arrive after owner death and a cancelled intent
      // cannot acquire a grant even if its supervisor starts very late.
      if (!sealed) { transaction(db, () => sealTree(db, id)); sealed = true; }
      const rows = anchor?.pid || known.size ? processes() : new Map();
      const delegated = new Set();
      const children = db.prepare(`WITH RECURSIVE tree(id) AS (SELECT id FROM jobs WHERE parent=? UNION ALL SELECT jobs.id FROM jobs JOIN tree ON jobs.parent=tree.id) SELECT id FROM tree`).all(id);
      for (const row of rows.values()) if (children.some(child => row.command.endsWith(`managed-process.mjs supervise ${path} ${child.id}`))) delegated.add(row.pid);
      let more;
      do {
        more = false;
        for (const row of rows.values()) if (!delegated.has(row.pid) && delegated.has(row.parent)) { delegated.add(row.pid); more = true; }
      } while (more);
      // Registered supervisors own their subtrees. Killing those helpers here
      // would destroy the very terminal evidence this ancestor must await.
      for (const pid of delegated) known.delete(pid);
      for (const [pid, row] of known) if (!rows.has(pid) || rows.get(pid).identity !== row.identity || rows.get(pid).zombie) known.delete(pid);
      const anchorAlive = anchor?.pid && anchor.exitCode === null && anchor.signalCode === null;
      let changed;
      do {
        changed = false;
        for (const row of rows.values()) if (!row.zombie && !delegated.has(row.pid) && !known.has(row.pid)
          && (anchorAlive && row.group === anchor.pid || known.has(row.parent))) {
          known.set(row.pid, row); changed = true;
        }
      } while (changed);
      if (stopAt !== undefined) {
        const elapsed = performance.now() - stopAt;
        if (elapsed >= 2000) {
          // Fresh in-memory identity recheck. This is best-effort OS discovery,
          // not pidfd-strength isolation against hostile PID churn.
          const signal = elapsed >= 5000 ? 'SIGKILL' : 'SIGTERM';
          // The live child anchor pins its process group. Never signal a group
          // remembered after anchor exit, or one containing delegated helpers.
          // Keep the anchor alive until it acknowledges the workload's exit.
          const group = anchorAlive && rows.get(anchor.pid)?.group === anchor.pid
            && ![...delegated].some(pid => rows.get(pid)?.group === anchor.pid)
            && (signal === 'SIGTERM' || exit) ? anchor.pid : undefined;
          if (group !== undefined) {
            try { process.kill(-group, signal); }
            catch (e) { if (e.code !== 'ESRCH') throw e; }
          }
          for (const [pid, row] of known) {
            if (row.group === group || pid === anchor?.pid && (signal === 'SIGTERM' || !exit)) continue;
            if (rows.get(pid)?.identity === row.identity) {
              try { process.kill(pid, signal); }
              catch (e) { if (e.code !== 'ESRCH') throw e; }
            }
          }
        }
        const nested = db.prepare(`WITH RECURSIVE tree(id) AS (SELECT id FROM jobs WHERE parent=? UNION ALL SELECT jobs.id FROM jobs JOIN tree ON jobs.parent=tree.id)
          SELECT jobs.id,jobs.status FROM jobs JOIN tree USING(id) WHERE status NOT IN ${terminal}`).all(id);
        const workloadClosed = !anchor || anchor.exitCode !== null || anchor.signalCode !== null;
        // The idle anchor is a trusted launch-fenced helper, not a workload.
        if (exit && known.size === 1 && known.has(anchor?.pid) && nested.length === 0 && anchor.connected) anchor.send({ type: 'finish' }, () => {});
        if (known.size === 0 && workloadClosed && nested.length === 0 && !directUnresolved) {
          exit ??= { code: null, signal: null, error: 'Managing process ended before launch' };
          transaction(db, () => db.prepare("UPDATE jobs SET status='done',launch_open=0,result=? WHERE id=?").run(JSON.stringify({ ...exit, managedUnresolved: false }), id));
          finished = true;
        } else if ((elapsed > 8000 && (known.size > 0 || directUnresolved)) || elapsed > 12000) {
          const result = { ...exit, code: exit?.code ?? null, signal: exit?.signal ?? null, managedUnresolved: true,
            error: 'Known managed work did not finish within shutdown escalation', survivors: [...known.keys()], nested };
          transaction(db, () => db.prepare("UPDATE jobs SET status='unresolved',launch_open=0,result=? WHERE id=?").run(JSON.stringify(result), id));
          finished = true;
        }
      }
      if (!finished) await delay(250);
    }
    const result = JSON.parse(db.prepare('SELECT result FROM jobs WHERE id=?').get(id).result);
    if (process.connected) await new Promise(resolve => process.send({ type: 'managed_exit', exit: result }, () => resolve()));
    process.exitCode = result.managedUnresolved || result.error ? 1 : result.code ?? (result.signal ? 1 : 0);
  } catch (e) {
    console.error('Managed supervisor failed; ownership remains unresolved:', e);
    process.exitCode = 1;
  } finally {
    db?.close();
    if (anchor?.connected) anchor.disconnect();
    if (process.connected) process.disconnect();
    // Unresolved helpers must not hold a parent's transport forever.
    process.stdin.destroy(); process.stdout.destroy(); process.stderr.destroy();
    process.exit(process.exitCode ?? 1);
  }
}

async function anchor() {
  // Trusted process group anchor. It never forks after workload_exit. The
  // supervisor remains outside this group and publishes final evidence.
  process.on('SIGTERM', () => {});
  let started = false;
  process.on('message', message => {
    if (message?.type === 'finish') process.exit(0);
    if (message?.type !== 'launch' || started) return;
    started = true;
    try {
      const child = spawn(message.command, message.args, { env: message.env, stdio: 'inherit' });
      child.on('error', error => process.send?.({ type: 'workload_exit', exit: { code: null, signal: null, error: error.message } }));
      child.on('exit', (code, signal) => process.send?.({ type: 'workload_exit', exit: { code, signal } }));
    } catch (e) { process.send?.({ type: 'workload_exit', exit: { code: null, signal: null, error: e.message } }); }
  });
  process.on('disconnect', () => { process.exit(1); });
}

if (process.argv[1] === script) {
  if (process.argv[2] === 'supervise') void supervise(process.argv[3], process.argv[4]);
  else if (process.argv[2] === 'anchor') void anchor();
  else throw new Error('Unknown managed process mode');
}
