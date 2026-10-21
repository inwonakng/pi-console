import type { OwnedSessionSnapshot, OwnedSessionUpdate } from "./host-owner.js";

/** Owner-internal pull stream. Closing/dropping a view never touches Pi. */
export class SessionSubscription {
  private queue: string[] = [];
  private bytes = 0;
  private waiting?: { resolve: (update: OwnedSessionUpdate) => void; reject: (error: Error) => void };
  private failure?: Error;

  constructor(readonly attachmentId: string, readonly snapshot: OwnedSessionSnapshot, private readonly detached: () => void,
    private readonly filter: (update: OwnedSessionUpdate) => OwnedSessionUpdate = (update) => update) {}

  next(): Promise<OwnedSessionUpdate> {
    if (this.failure) return Promise.reject(this.failure);
    const line = this.queue.shift();
    if (line !== undefined) {
      this.bytes -= Buffer.byteLength(line);
      return Promise.resolve(this.filter(JSON.parse(line) as OwnedSessionUpdate));
    }
    if (this.waiting) return Promise.reject(new Error("Only one subscription read may be pending"));
    return new Promise((resolve, reject) => { this.waiting = { resolve, reject }; });
  }

  close(): void { this.drop(new Error("Session subscription detached")); }

  /** Called synchronously by the owner; no viewer callback runs in its reducer. */
  push(line: string): void {
    if (this.failure) return;
    const bytes = Buffer.byteLength(line);
    if (this.queue.length >= 256 || this.bytes + bytes > 8 * 1024 * 1024) {
      this.drop(new Error("Session viewer fell behind; resubscribe with a fresh snapshot"));
      return;
    }
    const waiting = this.waiting;
    if (waiting) {
      this.waiting = undefined;
      waiting.resolve(this.filter(JSON.parse(line) as OwnedSessionUpdate));
    } else {
      this.queue.push(line);
      this.bytes += bytes;
    }
  }

  private drop(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    this.queue = [];
    this.bytes = 0;
    const waiting = this.waiting;
    this.waiting = undefined;
    waiting?.reject(error);
    this.detached();
  }
}
