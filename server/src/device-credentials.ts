import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { privateJson, syncDirectory } from "./catalog-storage.js";
import { object } from "./pi-records.js";
import { CommandError } from "./session-commands.js";
import type { Channel } from "./session-catalog.js";

export type DeviceCredential = { version: 1; hostId: string; channel: Channel; deviceId: string; secret: string };
type Device = { deviceId: string; label: string; createdAt: string; revokedAt?: string; digest: string };
const digest = (secret: string): string => createHash("sha256").update(secret).digest("hex");
const uuid = /^[0-9a-f-]{36}$/;
export function credential(value: unknown): DeviceCredential {
  if (!object(value) || value.version !== 1 || typeof value.hostId !== "string" || !uuid.test(value.hostId)
    || !["stable", "dev"].includes(String(value.channel)) || typeof value.deviceId !== "string" || !uuid.test(value.deviceId)
    || typeof value.secret !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value.secret)
    || Object.keys(value).some((key) => !["version", "hostId", "channel", "deviceId", "secret"].includes(key))) throw new Error("Invalid device credential file");
  return value as DeviceCredential;
}

/** Owned by the local service only. Disk stores verification hashes, never bearer secrets. */
export class DeviceCredentials {
  private devices: Device[] = [];
  private lane: Promise<unknown> = Promise.resolve();
  private constructor(private readonly root: string, private readonly hostId: string, private readonly channel: Channel,
    private readonly revoked: (deviceId: string) => void) {}
  static async open(root: string, hostId: string, channel: Channel, revoked: (deviceId: string) => void): Promise<DeviceCredentials> {
    const store = new DeviceCredentials(root, hostId, channel, revoked);
    let value: unknown;
    try { value = await privateJson(join(root, "devices.json"), 1024 * 1024); }
    catch (error) { if (!object(error) || error.code !== "ENOENT") throw error; return store; }
    if (!object(value) || value.version !== 1 || value.hostId !== hostId || value.channel !== channel || !Array.isArray(value.devices)
      || value.devices.length > 1024 || !value.devices.every((d) => object(d) && typeof d.deviceId === "string" && uuid.test(d.deviceId)
        && typeof d.label === "string" && d.label.length <= 128 && typeof d.createdAt === "string"
        && (d.revokedAt === undefined || typeof d.revokedAt === "string") && typeof d.digest === "string" && /^[a-f0-9]{64}$/.test(d.digest))
      || new Set(value.devices.map((d) => d.deviceId)).size !== value.devices.length) throw new Error("Invalid device credential store");
    store.devices = value.devices as Device[];
    return store;
  }
  list(): Omit<Device, "digest">[] { return this.devices.map(({ digest: _digest, ...d }) => ({ ...d })); }
  active(deviceId: string): boolean { return this.devices.some((d) => d.deviceId === deviceId && !d.revokedAt); }
  authenticate(header: string | undefined): string | undefined {
    // Fixed-size syntax, no URL/query/cookie authentication and no token echo in errors.
    const match = header?.match(/^Bearer ([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/);
    if (!match) return undefined;
    const device = this.devices.find((d) => d.deviceId === match[1] && !d.revokedAt);
    if (!device || !timingSafeEqual(Buffer.from(device.digest, "hex"), Buffer.from(digest(match[2]), "hex"))) return undefined;
    return device.deviceId;
  }
  issue(label: unknown): Promise<DeviceCredential> {
    return this.serial(async () => {
      if (typeof label !== "string" || !label.trim() || label.length > 128 || /[\x00-\x1f\x7f]/.test(label)) throw new CommandError("invalid_command", "Device label must be 1-128 printable characters");
      if (this.devices.length >= 1024) throw new CommandError("invalid_command", "Device credential limit reached");
      const deviceId = randomUUID(), secret = randomBytes(32).toString("base64url");
      const devices = [...this.devices, { deviceId, label, createdAt: new Date().toISOString(), digest: digest(secret) }];
      await this.save(devices);
      this.devices = devices;
      return { version: 1, hostId: this.hostId, channel: this.channel, deviceId, secret };
    });
  }
  revoke(deviceId: unknown): Promise<void> {
    return this.serial(async () => {
      const device = this.devices.find((d) => d.deviceId === deviceId);
      if (!device) throw new CommandError("invalid_command", "Unknown device credential");
      if (!device.revokedAt) {
        const devices = this.devices.map((d) => d === device ? { ...d, revokedAt: new Date().toISOString() } : d);
        await this.save(devices);
        this.devices = devices;
      }
      // Synchronously detach before replying, even when repeating a revocation.
      this.revoked(device.deviceId);
    });
  }
  private serial<T>(task: () => Promise<T>): Promise<T> {
    const result = this.lane.then(task);
    this.lane = result.catch(() => undefined);
    return result;
  }
  private async save(devices: Device[]): Promise<void> {
    const temp = join(this.root, `.devices-${randomUUID()}`);
    const file = await open(temp, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify({ version: 1, hostId: this.hostId, channel: this.channel, devices }));
      await file.sync();
    } finally { await file.close(); }
    try { await rename(temp, join(this.root, "devices.json")); await syncDirectory(this.root); }
    finally { try { await unlink(temp); } catch (error) { if (!object(error) || error.code !== "ENOENT") throw error; } }
  }
}
