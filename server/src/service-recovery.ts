import { lstat, readFile, realpath, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { bootIdentity, interruptEpoch, inspectEpoch, ownerLease, registry, sealEpoch, unreconciledEpochs, type BootIdentity } from "../../pi/scripts/managed-process.mjs";
import { catalogOwnerEpochs, openStorage, privateDirectory, privateJson, syncDirectory, type CatalogSession, type Channel } from "./catalog-storage.js";
import { object } from "./pi-records.js";
import { managementIdentity } from "./service-paths.js";
import { managementLock } from "./service-supervisor.js";

export type RecoveryOptions = { root: string; channel: Channel; appRoot: string };
const terminal = new Set(["done", "cancelled", "interrupted"]);

async function optionalJson(path: string): Promise<unknown> {
  try { return await privateJson(path, 64 * 1024); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
function claimValue(text: string, epoch?: string): { epoch: string; appRoot: string } {
  const value: unknown = JSON.parse(text);
  if (!object(value) || value.schemaVersion !== 3 || typeof value.epoch !== "string"
    || epoch !== undefined && value.epoch !== epoch || typeof value.appRoot !== "string" || !isAbsolute(value.appRoot)) {
    throw new Error("Invalid service claim; manual inspection required");
  }
  return { epoch: value.epoch, appRoot: value.appRoot };
}
function bootValue(text: string | null): BootIdentity | undefined {
  if (!text) return;
  const value: unknown = JSON.parse(text);
  if (value === null) return;
  if (!object(value) || typeof value.machineId !== "string" || !/^[a-f0-9]{32}$/i.test(value.machineId)
    || typeof value.bootId !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value.bootId)) throw new Error("Invalid persisted boot identity; manual inspection required");
  return { machineId: value.machineId, bootId: value.bootId };
}

/** Explicit administration only. Neither startup nor resume invokes recovery. */
export async function reconcileService(options: RecoveryOptions): Promise<void> {
  const root = await realpath(options.root);
  await privateDirectory(root);
  const owner = await managementIdentity(options.appRoot, options.channel);
  const unlock = await managementLock(root);
  try {
    const lifetime = ownerLease(root); // Must precede discovery and all recovery mutations.
    try {
      const path = join(root, "owner.lock");
      const claim = await optionalJson(path);
      const claimText = claim === undefined ? undefined : await readFile(path, "utf8");
      if (claimText && JSON.stringify(JSON.parse(claimText)) !== JSON.stringify(claim)) throw new Error("Service lock changed during recovery");
      const currentClaim = claimText === undefined ? undefined : claimValue(claimText);
      const owned = await catalogOwnerEpochs(root, options.channel);
      const processes = join(root, "processes.sqlite");
      // Do not create a registry for a profile with no recovery work.
      if (!currentClaim && !owned.length) {
        try { await lstat(processes); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
      }
      const evidence = registry(processes);
      try {
        const orphaned = unreconciledEpochs(processes);
        const epochs = [...new Set([...owned, ...orphaned, ...(currentClaim ? [currentClaim.epoch] : [])])];
        const currentBoot = bootIdentity();
        // Validate every identity before sealing anything, including when a failed
        // replacement left a different claim from the catalog's crashed owner.
        const targets = epochs.map((epoch) => {
          const row = evidence.prepare("SELECT claim,owner,boot FROM epochs WHERE id=?").get(epoch);
          if (!row) throw new Error(`Execution epoch ${epoch} is missing; manual inspection required`);
          const onDisk = currentClaim?.epoch === epoch ? claimText : undefined;
          const archived = evidence.prepare("SELECT claim FROM recoveries WHERE epoch=?").get(epoch)?.claim;
          if (typeof row.claim !== "string" || !row.claim || typeof row.owner !== "string") throw new Error(`Durable service identity is missing for epoch ${epoch}; refusing recovery`);
          const text = row.claim;
          if (onDisk !== undefined && onDisk !== text) throw new Error(`Service claim differs from durable epoch ${epoch}; leaving data unchanged`);
          if (row.owner !== owner) throw new Error(`Epoch ${epoch} belongs to another installation/checkout (${row.owner}); refusing recovery from ${owner}`);
          claimValue(text, epoch);
          if (typeof archived === "string" && archived !== text) throw new Error(`Conflicting recovery claim evidence for ${epoch}`);
          const boot = bootValue(typeof row.boot === "string" ? row.boot : null);
          if (boot && currentBoot && boot.machineId !== currentBoot.machineId) throw new Error(`Epoch ${epoch} belongs to another host; local reboot recovery is not evidence of its worker termination`);
          return { epoch, text, boot };
        });
        // Archive exact durable claim bytes before changing catalog ownership or
        // retiring the file. The registry is authoritative if owner.lock is missing.
        for (const target of targets) evidence.prepare("INSERT OR IGNORE INTO recoveries VALUES(?,?)").run(target.epoch, target.text);
        for (const { epoch, boot } of targets) {
          sealEpoch(processes, epoch);
          const deadline = performance.now() + 10000;
          for (;;) {
            const pending = inspectEpoch(processes, epoch).filter((job) => !terminal.has(job.status));
            if (!pending.length) break;
            if (boot && currentBoot && boot.bootId !== currentBoot.bootId) {
              interruptEpoch(processes, epoch, {
                basis: "previous_boot", recordedBoot: boot, currentBoot, time: new Date().toISOString(),
              });
              break;
            }
            if (pending.some((job) => job.status === "unresolved") || performance.now() >= deadline) {
              const hint = !boot || !currentBoot
                ? " No usable boot evidence is available; worker termination cannot be established." : "";
              throw new Error(`Known managed work is still live or unresolved for ${epoch}; replacement blocked: ${pending.map((job) => `${job.id} (${job.status})`).join(", ")}.${hint}`);
            }
            await delay(50);
          }
        }
        if (!epochs.length) return;
        const { db } = await openStorage(root, options.channel, () => {}, epochs);
        try {
          db.exec("BEGIN IMMEDIATE");
          for (const epoch of epochs) for (const row of db.prepare("SELECT id,metadata FROM sessions WHERE owner_epoch=?").all(epoch)) {
            const session = JSON.parse(String(row.metadata)) as CatalogSession;
            if (session.stopReason !== "user") session.stopReason = "error";
            delete session.ownerEpoch;
            db.prepare("UPDATE sessions SET owner_epoch=NULL,metadata=? WHERE id=?").run(JSON.stringify(session), row.id);
          }
          db.exec("COMMIT");
          if (db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get()?.busy !== 0) throw new Error("Recovery checkpoint blocked; retry reconciliation before starting");
        } finally { db.close(); }
        const now = await optionalJson(path);
        if (JSON.stringify(now) !== JSON.stringify(claim)) throw new Error("Service lock changed during recovery; refusing removal");
        if (claimText !== undefined) { await unlink(path); await syncDirectory(root); }
      } finally { evidence.close(); }
    } finally { lifetime.close(); }
  } finally { await unlock(); }
}
