import { deliverDesktopNotification, validDesktopNotification } from "../../pi/extensions/shared/desktop-notification.mjs";
import { readHostRegistry, type RegisteredHost } from "../../pi/extensions/shared/read-host-registry.mjs";
import { LocalClient } from "./local-client.js";
import { identifier } from "./host-commands.js";
import { object } from "./pi-records.js";
import type { Channel } from "./session-catalog.js";

type Follower = {
  target: RegisteredHost;
  abort: AbortController;
  client?: LocalClient;
  connecting: boolean;
  retryAt: number;
  attempts: number;
  error?: string;
};

/** One consumer per local server, independent of frontend attachments or controllers. */
export class RemoteNotifications {
  private readonly followers = new Map<string, Follower>();
  private readonly seen = new Set<string>();
  private timer?: NodeJS.Timeout;
  private registryError?: string;

  constructor(private readonly channel: Channel, private readonly hostId: string) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.refresh(), 1000);
    this.refresh();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    for (const follower of this.followers.values()) this.close(follower);
    this.followers.clear();
  }

  private close(follower: Follower): void {
    follower.abort.abort();
    follower.client?.close();
  }

  private current(follower: Follower): boolean {
    return !!this.timer && this.followers.get(follower.target.key) === follower && !follower.abort.signal.aborted;
  }

  private report(host: string, message: string): void {
    console.error(JSON.stringify({ type: "remote_notification_error", host, message }));
  }

  private refresh(): void {
    let targets: RegisteredHost[];
    try {
      targets = readHostRegistry(this.channel).filter((host) => host.enabled && host.remote);
      this.registryError = undefined;
    } catch (error) {
      // Invalid configuration must revoke existing subscriptions, not leave stale targets active.
      for (const follower of this.followers.values()) this.close(follower);
      this.followers.clear();
      const message = error instanceof Error ? error.message : "Invalid host registry";
      if (message !== this.registryError) this.report("registry", message);
      this.registryError = message;
      return;
    }
    for (const [key, follower] of this.followers) {
      const target = targets.find((target) => target.key === key);
      if (!target || target.hostId !== follower.target.hostId || target.remote !== follower.target.remote) {
        this.close(follower);
        this.followers.delete(key);
      }
    }
    for (const target of targets) {
      let follower = this.followers.get(target.key);
      if (!follower) {
        follower = { target, abort: new AbortController(), connecting: false, retryAt: 0, attempts: 0 };
        this.followers.set(target.key, follower);
      }
      follower.target = target; // Alias edits do not require reconnecting.
      if (!follower.client && !follower.connecting && Date.now() >= follower.retryAt) void this.connect(follower);
    }
  }

  private async connect(follower: Follower): Promise<void> {
    follower.connecting = true;
    let failed = false;
    let identity: { hostId: string; serviceEpoch: string } | undefined;
    const fail = (error: Error): void => {
      if (failed || !this.current(follower)) return;
      failed = true;
      follower.client?.close();
      follower.client = undefined;
      follower.retryAt = Date.now() + Math.min(30000, 1000 * 2 ** Math.min(follower.attempts++, 5));
      if (follower.error !== error.message) this.report(follower.target.alias, error.message);
      follower.error = error.message;
    };
    try {
      const { client, hello } = await LocalClient.openRemote(follower.target.remote!, this.channel, (record) => {
        if (!this.current(follower) || failed) return;
        if (record.type === "disconnected") { fail(new Error(String(record.message))); return; }
        if (record.type !== "desktop_notification") return;
        const event = record.notification;
        if (!identity || !object(event) || event.hostId !== identity.hostId || event.serviceEpoch !== identity.serviceEpoch
          || !identifier(event.sessionId) || !validDesktopNotification(event)) {
          fail(new Error("Invalid origin notification"));
          return;
        }
        const key = JSON.stringify([identity.hostId, identity.serviceEpoch, event.id]);
        if (this.seen.has(key)) return;
        this.seen.add(key);
        if (this.seen.size > 2048) this.seen.delete(this.seen.values().next().value!);
        // Display only; received events never enter the local owner's origin feed.
        const sent = deliverDesktopNotification({ kind: event.kind, title: event.title,
          body: `${follower.target.alias}\n${event.body}`,
          onError: (error) => this.report(follower.target.alias, error.message) });
        if (!sent && follower.error !== "No local desktop notifier available") {
          follower.error = "No local desktop notifier available";
          this.report(follower.target.alias, follower.error);
        }
      }, follower.abort.signal);
      if (!this.current(follower) || failed) { client.close(); return; }
      follower.client = client;
      if (hello.hostId === this.hostId) throw new Error("Ignoring this server's own endpoint");
      if (follower.target.hostId && hello.hostId !== follower.target.hostId) throw new Error("Host identity changed; confirm the replacement in Hosts");
      if (!identifier(hello.hostId) || !identifier(hello.serviceEpoch)
        || !(hello.capabilities as unknown[]).includes("notifications.subscribe")) {
        throw new Error("Remote server does not support notification subscriptions; update and restart it");
      }
      identity = { hostId: hello.hostId, serviceEpoch: hello.serviceEpoch };
      const deadline = setTimeout(() => client.close(), 10000);
      let result: unknown;
      try { result = await client.request("notifications.subscribe"); }
      finally { clearTimeout(deadline); }
      if (!object(result) || result.hostId !== identity.hostId || result.serviceEpoch !== identity.serviceEpoch) {
        throw new Error("Invalid notification subscription identity");
      }
      if (!failed) { follower.attempts = 0; follower.error = undefined; }
    } catch (error) {
      fail(error instanceof Error ? error : new Error("Notification subscription failed"));
    } finally {
      follower.connecting = false;
    }
  }
}
