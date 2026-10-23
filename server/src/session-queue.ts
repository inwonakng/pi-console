import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { CommandError, validPromptText, type Controller } from "./session-commands.js";
import { object } from "./pi-records.js";

export type AcceptedQueueItem = {
  id: string;
  revision: number;
  serviceEpoch: string;
  runtimeRevision: number;
  text: string;
  status: "queued" | "sending" | "failed";
  error?: { code: string; message: string };
  /** Display-only references. Never authorize delivery or automatic replay. */
  timeline?: { afterMessage: string | null; observedMessage?: string };
};
export type QueueReservation = {
  id: string; itemId: string; attachmentId: string; grantId: string;
  /** Display only; authority uses the owner's monotonic deadline. */
  expiresAt: number;
};
export type AcceptedQueueSnapshot = { items: AcceptedQueueItem[]; reservation?: QueueReservation };

export function validQueueItem(value: unknown): value is AcceptedQueueItem {
  return object(value) && typeof value.id === "string" && /^[\w-]{1,128}$/.test(value.id)
    && Number.isSafeInteger(value.revision) && (value.revision as number) >= 1
    && typeof value.serviceEpoch === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value.serviceEpoch)
    && Number.isSafeInteger(value.runtimeRevision) && (value.runtimeRevision as number) >= 0
    && validPromptText(value.text) && typeof value.status === "string" && ["queued", "sending", "failed"].includes(value.status)
    && (value.error === undefined || object(value.error) && typeof value.error.code === "string" && typeof value.error.message === "string")
    && (value.timeline === undefined || object(value.timeline)
      && (value.timeline.afterMessage === null || typeof value.timeline.afterMessage === "string" && /^[a-f0-9]{64}$/.test(value.timeline.afterMessage))
      && (value.timeline.observedMessage === undefined || typeof value.timeline.observedMessage === "string" && /^[a-f0-9]{64}$/.test(value.timeline.observedMessage)));
}

export function editableItem(items: AcceptedQueueItem[], id: string, revision: number): AcceptedQueueItem {
  const item = items.find((item) => item.id === id);
  if (!item || item.revision !== revision || item.status === "sending") {
    throw new CommandError("queue_conflict", "Queue item changed, is sending, or was already dispatched/removed; refresh before editing");
  }
  return item;
}

/** One controller's finite editor pause, not a lease on accepted work. */
export class QueueReservations {
  private reservation?: QueueReservation;
  private deadline = 0;
  private timer?: NodeJS.Timeout;
  constructor(private readonly changed: () => void) {}
  snapshot(): QueueReservation | undefined { return this.reservation && { ...this.reservation }; }
  reserve(itemId: string, controller: Controller): QueueReservation {
    this.clear(false);
    this.deadline = performance.now() + 30000;
    const reservation = { id: randomUUID(), itemId, attachmentId: controller.attachmentId, grantId: controller.grantId, expiresAt: Date.now() + 30000 };
    this.reservation = reservation;
    this.arm();
    this.changed();
    // Publication can evict a slow controller and release this pause reentrantly.
    // The receipt still identifies the reservation that was created, not a revival.
    return { ...reservation };
  }
  assertCurrent(id: string): void {
    this.expire();
    if (this.reservation?.id !== id) throw new CommandError("reservation_expired", "Queue edit reservation expired or was released");
  }
  blocks(itemId: string): boolean { this.expire(); return this.reservation?.itemId === itemId; }
  releaseItem(itemId: string): void { if (this.reservation?.itemId === itemId) this.clear(); }
  controlChanged(controller?: Controller): void {
    if (this.reservation && this.reservation.grantId !== controller?.grantId) this.clear();
  }
  clear(notify = true): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.reservation) return;
    this.reservation = undefined;
    if (notify) this.changed();
  }
  private expire(): void { if (this.reservation && performance.now() >= this.deadline) this.clear(); }
  private arm(): void {
    this.timer = setTimeout(() => { this.expire(); if (this.reservation) this.arm(); }, Math.max(1, this.deadline - performance.now()));
    this.timer.unref();
  }
}
