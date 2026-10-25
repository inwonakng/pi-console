import { fork } from "node:child_process";
import { constants } from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { privateJson, syncDirectory } from "./catalog-storage.js";
import { identifier } from "./host-commands.js";
import type { HostOwnerOptions } from "./host-owner.js";
import { object } from "./pi-records.js";
import { CommandError } from "./session-commands.js";

export type RestartReceipt = {
  id: string; serviceEpoch: string; hostId: string; force: boolean;
  status: "accepted" | "completed" | "failed";
  result?: { serviceEpoch: string; buildId: string };
  error?: { code: string; message: string };
};
const receiptPath = (root: string) => join(root, "service-restart.json");
export async function readRestart(root: string): Promise<RestartReceipt | undefined> {
  let value: unknown;
  try { value = await privateJson(receiptPath(root), 16384); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  if (!object(value) || !identifier(value.id) || !identifier(value.serviceEpoch) || !identifier(value.hostId)
    || typeof value.force !== "boolean" || !["accepted", "completed", "failed"].includes(String(value.status))
    || value.status === "completed" && (!object(value.result) || !identifier(value.result.serviceEpoch)
      || typeof value.result.buildId !== "string")
    || value.status === "failed" && (!object(value.error) || typeof value.error.code !== "string" || typeof value.error.message !== "string")) {
    throw new Error("Invalid restart outcome; inspect service-restart.json");
  }
  return value as RestartReceipt;
}
export async function writeRestart(root: string, receipt: RestartReceipt): Promise<void> {
  const temporary = join(root, `.restart-${randomUUID()}.tmp`);
  try {
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(JSON.stringify(receipt) + "\n"); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, receiptPath(root));
    await syncDirectory(root);
  } finally {
    try { await unlink(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

/** Only the latest outcome crosses epochs; in-epoch IDs remain deduplicated. */
export class ServiceRestart {
  private readonly receipts = new Map<string, RestartReceipt>();
  private pending = false;
  constructor(private readonly options: HostOwnerOptions & { root: string }, private readonly hostId: string,
    private readonly epoch: string) {}

  async latest(): Promise<RestartReceipt | null> {
    const receipt = await readRestart(this.options.root);
    return receipt?.hostId === this.hostId ? receipt : null;
  }

  async status(epoch: string, id: string): Promise<RestartReceipt | null> {
    const latest = await readRestart(this.options.root);
    if (latest?.serviceEpoch === this.epoch && this.receipts.has(latest.id)) this.receipts.set(latest.id, latest);
    if (latest?.id === id && latest.serviceEpoch === epoch && latest.hostId === this.hostId) return latest;
    const saved = this.receipts.get(id);
    return saved?.serviceEpoch === epoch ? saved : null;
  }

  async request(payload: Record<string, unknown>): Promise<RestartReceipt> {
    if (!identifier(payload.id) || payload.serviceEpoch !== this.epoch || payload.hostId !== this.hostId
      || payload.confirmed !== true || typeof payload.force !== "boolean") {
      throw new CommandError("invalid_command", "Restart requires the current host/epoch, an ID, confirmation and an intentional force boolean");
    }
    const previous = await this.status(this.epoch, payload.id);
    if (previous) {
      if (previous.force !== payload.force) throw new CommandError("invalid_command", "Restart ID was already used with another force value");
      return previous;
    }
    if (this.pending) throw new CommandError("session_busy", "A server restart is already pending; inspect its outcome");
    if (this.receipts.size >= 128) throw new CommandError("session_busy", "Restart request limit reached; use the local CLI");
    // Set before the first asynchronous write/spawn so concurrent requests cannot race.
    this.pending = true;
    const receipt: RestartReceipt = { id: payload.id, serviceEpoch: this.epoch, hostId: this.hostId,
      force: payload.force, status: "accepted" };
    this.receipts.set(receipt.id, receipt);
    try {
      const latest = await readRestart(this.options.root);
      if (latest?.status === "accepted") {
        throw new CommandError("session_busy", "Previous restart outcome is unresolved; inspect service-restart.json and the service log before retrying");
      }
      await writeRestart(this.options.root, receipt);
      const log = await open(join(this.options.root, "service.log"), constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
      try {
        const stat = await log.stat();
        if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || stat.mode & 0o077) throw new Error("service.log must be private and same-user");
        const child = fork(new URL("./service-restart-worker.js", import.meta.url), [], {
          detached: true, cwd: this.options.appRoot, stdio: ["ignore", log.fd, log.fd, "ipc"],
          env: { ...process.env, ...this.options.environment }, execArgv: [] });
        child.once("exit", () => { this.pending = false; });
        await new Promise<void>((resolve, reject) => {
          const deadline = setTimeout(() => { child.kill(); reject(new Error("Restart coordinator did not become ready")); }, 10000);
          child.once("error", (error) => { clearTimeout(deadline); reject(error); });
          child.once("exit", () => { clearTimeout(deadline); reject(new Error("Restart coordinator exited before readiness")); });
          child.once("message", (message) => {
            clearTimeout(deadline);
            if (message === "ready") resolve(); else reject(new Error("Invalid restart coordinator handshake"));
          });
        });
        // Handoff is independent of response drainage. A lost acknowledgement
        // does not cancel accepted work or require replay from the frontend.
        await new Promise<void>((resolve, reject) => {
          child.send({ options: this.options, receipt }, (error) => { if (error) reject(error); else resolve(); });
        });
        child.unref();
        return receipt;
      } finally { await log.close(); }
    } catch (error) {
      this.pending = false;
      receipt.status = "failed";
      receipt.error = { code: error instanceof CommandError ? error.code : "service_error", message: (error instanceof Error ? error.message : "Restart setup failed").slice(0, 4096) };
      // Do not overwrite a previous unresolved request when setup refused it.
      const latest = await readRestart(this.options.root);
      if (latest?.id === receipt.id && latest.serviceEpoch === receipt.serviceEpoch) await writeRestart(this.options.root, receipt);
      throw error;
    }
  }
}
