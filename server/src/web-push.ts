import { ECDH, createECDH, randomUUID } from "node:crypto";
import { open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import webpush, { type PushSubscription, type VapidKeys } from "web-push";
import { privateJson, syncDirectory } from "./catalog-storage.js";
import { object } from "./pi-records.js";
import type { OriginNotification } from "./host-owner.js";

const MAX_SUBSCRIPTIONS = 32;
type Device = { origin: string; subscription: PushSubscription };

function pushEndpoint(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 4096) return false;
  try {
    const url = new URL(value);
    // Subscription URLs are supplied by the browser, but must never turn this
    // unauthenticated trusted-network server into an arbitrary HTTP client.
    // web-push uses Node's legacy URL parser. Reject noncanonical URLs so its
    // authority cannot differ (e.g. an encoded dot hiding an internal IP).
    return url.href === value && url.protocol === "https:" && !url.username && !url.password && !url.port && !url.hash
      && (url.hostname === "fcm.googleapis.com" || url.hostname.endsWith(".push.apple.com")
        || url.hostname.endsWith(".push.services.mozilla.com"));
  } catch { return false; }
}
function key(value: unknown, length: number): value is string {
  return typeof value === "string" && /^[\w-]+={0,2}$/.test(value) && Buffer.from(value, "base64url").length === length;
}
function subscription(value: unknown): PushSubscription {
  if (!object(value) || !pushEndpoint(value.endpoint) || !object(value.keys)
    || !key(value.keys.p256dh, 65) || !key(value.keys.auth, 16)) throw new Error("Invalid push subscription");
  try { ECDH.convertKey(Buffer.from(value.keys.p256dh, "base64url"), "prime256v1"); }
  catch { throw new Error("Invalid push subscription key"); }
  return { endpoint: value.endpoint, keys: { p256dh: value.keys.p256dh, auth: value.keys.auth } };
}
function report(code: string): void {
  // Never log subscription capability URLs, keys, or message contents.
  console.error(JSON.stringify({ type: "web_push_error", code }));
}

/** Device opt-in is separate from the session's desktop notification policy. */
export class WebPushNotifications {
  private devices = new Map<string, Device>();
  private writes: Promise<void> = Promise.resolve();
  private deliveries: Promise<void> = Promise.resolve();
  private readonly seen = new Set<string>();
  private pending = 0;
  private stopped = false;
  private constructor(private readonly root: string, private readonly hostId: string, private readonly keys: VapidKeys) {}

  static async open(root: string, hostId: string): Promise<WebPushNotifications> {
    let stored: unknown;
    try { stored = await privateJson(join(root, "web-push.json"), 256 * 1024); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (stored === undefined) {
      const result = new WebPushNotifications(root, hostId, webpush.generateVAPIDKeys());
      await result.save(result.devices);
      return result;
    }
    if (!object(stored) || stored.version !== 1 || stored.hostId !== hostId
      || !key(stored.publicKey, 65) || !key(stored.privateKey, 32)
      || !Array.isArray(stored.devices) || stored.devices.length > MAX_SUBSCRIPTIONS) throw new Error("Invalid web-push.json");
    const signer = createECDH("prime256v1");
    signer.setPrivateKey(Buffer.from(stored.privateKey, "base64url"));
    if (!signer.getPublicKey().equals(Buffer.from(stored.publicKey, "base64url"))) throw new Error("Invalid Web Push signing keys");
    const result = new WebPushNotifications(root, hostId, { publicKey: stored.publicKey, privateKey: stored.privateKey });
    for (const value of stored.devices) {
      if (!object(value) || typeof value.origin !== "string" || new URL(value.origin).origin !== value.origin
        || !/^https?:/.test(value.origin)) throw new Error("Invalid Web Push device origin");
      const device = { origin: value.origin, subscription: subscription(value.subscription) };
      if (result.devices.has(device.subscription.endpoint)) throw new Error("Duplicate Web Push device");
      result.devices.set(device.subscription.endpoint, device);
    }
    return result;
  }

  get publicKey(): string { return this.keys.publicKey; }
  enabled(endpoint: string, origin: string): boolean { return this.devices.get(endpoint)?.origin === origin; }

  async subscribe(value: unknown, origin: string): Promise<void> {
    const device = { origin, subscription: subscription(value) };
    await this.change(devices => {
      const previous = devices.get(device.subscription.endpoint);
      if (previous && previous.origin !== origin) throw new Error("Subscription belongs to another origin");
      if (!previous && devices.size >= MAX_SUBSCRIPTIONS) throw new Error("Web Push device limit reached");
      devices.set(device.subscription.endpoint, device);
    });
  }
  async unsubscribe(endpoint: string, origin: string): Promise<void> {
    await this.change(devices => { if (devices.get(endpoint)?.origin === origin) devices.delete(endpoint); });
  }
  close(): void { this.stopped = true; }

  async handle(request: IncomingMessage, response: ServerResponse, origin?: string): Promise<void> {
    const reply = (status: number, value: unknown) => {
      const body = JSON.stringify(value);
      response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body),
        "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", Connection: "close" });
      response.end(body);
    };
    if (request.url === "/v1/push" && request.method === "GET") { reply(200, { publicKey: this.publicKey }); return; }
    if (!origin) { reply(403, { error: "Push settings require an allowed browser origin." }); return; }
    if (!(request.url === "/v1/push/status" && request.method === "POST")
      && !(request.url === "/v1/push/subscription" && ["POST", "DELETE"].includes(request.method ?? ""))) {
      reply(405, { error: "Unsupported push settings method." }); return;
    }
    if (request.headers["content-type"]?.split(";", 1)[0].trim() !== "application/json") {
      reply(415, { error: "Push settings require JSON." }); return;
    }
    let value: unknown;
    try {
      const body = await new Promise<string>((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;
        request.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 8192) { reject(new Error("Push settings body too large")); return; }
          chunks.push(chunk);
        });
        request.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        request.once("error", reject);
        request.once("aborted", () => reject(new Error("Push settings request aborted")));
      });
      value = JSON.parse(body);
      if (!object(value)) throw new Error("Invalid push settings");
      if (request.method === "POST" && request.url === "/v1/push/subscription") subscription(value.subscription);
      else if (!pushEndpoint(value.endpoint)) throw new Error("Invalid push endpoint");
    } catch { reply(400, { error: "Invalid push settings request." }); return; }
    try {
      const data = value as Record<string, unknown>;
      if (request.url === "/v1/push/status") reply(200, { enabled: this.enabled(data.endpoint as string, origin) });
      else if (request.method === "POST") { await this.subscribe(data.subscription, origin); reply(200, { enabled: true }); }
      else { await this.unsubscribe(data.endpoint as string, origin); reply(200, { enabled: false }); }
    } catch { report("subscription_update_failed"); reply(503, { error: "Could not save push settings. Check the service log and device limit." }); }
  }

  publish(event: OriginNotification): void {
    if (this.stopped || !this.devices.size) return;
    const id = JSON.stringify([event.hostId, event.serviceEpoch, event.id]);
    if (this.seen.has(id)) return;
    this.seen.add(id);
    if (this.seen.size > 2048) this.seen.delete(this.seen.values().next().value!);
    if (this.pending >= 64) { report("delivery_queue_full"); return; }
    // Keep the encrypted record below push services' 4 KiB payload limit,
    // including JSON escaping and multibyte session titles/directories.
    let body = event.body.slice(0, 8192);
    const payload = () => JSON.stringify({ title: event.title, body,
      tag: `${event.hostId}:${event.id}`, path: `/#sessions/${event.hostId}/${event.sessionId}` });
    while (Buffer.byteLength(payload()) > 3000) body = body.slice(0, Math.floor(body.length / 2));
    const message = payload();
    // Snapshot recipients now: a new opt-in must not receive older queued events.
    const recipients = [...this.devices.values()];
    this.pending++;
    this.deliveries = this.deliveries.then(async () => {
      if (this.stopped) return;
      await Promise.all(recipients.map(async device => {
        if (this.stopped || this.devices.get(device.subscription.endpoint) !== device) return;
        try {
          await webpush.sendNotification(device.subscription, message, { TTL: 3600, urgency: "high", timeout: 10000,
            vapidDetails: { ...this.keys, subject: "https://github.com/inwonakng/pi-console" } });
        } catch (error) {
          const status = object(error) ? error.statusCode : undefined;
          if (status === 404 || status === 410) {
            await this.change(devices => {
              if (devices.get(device.subscription.endpoint) === device) devices.delete(device.subscription.endpoint);
            });
          } else report(typeof status === "number" ? `push_http_${status}` : "push_delivery_failed");
        }
      }));
    }).catch(() => report("push_delivery_failed")).finally(() => { this.pending--; });
  }

  private change(update: (devices: Map<string, Device>) => void): Promise<void> {
    const task = this.writes.then(async () => {
      if (this.stopped) throw new Error("Web Push is stopping");
      const next = new Map(this.devices);
      update(next);
      await this.save(next);
      this.devices = next;
    });
    this.writes = task.catch(() => undefined);
    return task;
  }
  private async save(devices: Map<string, Device>): Promise<void> {
    const temporary = join(this.root, `.web-push-${randomUUID()}.tmp`);
    try {
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify({ version: 1, hostId: this.hostId, ...this.keys, devices: [...devices.values()] }) + "\n");
        await file.sync();
      } finally { await file.close(); }
      await rename(temporary, join(this.root, "web-push.json"));
      await syncDirectory(this.root);
    } finally {
      try { await unlink(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
  }
}
