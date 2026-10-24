import { performance } from "node:perf_hooks";
import type { LocalClient } from "./local-client.js";
import type { ControlGrant, Controller } from "./session-commands.js";
import { object } from "./pi-records.js";

type Attachment = { sessionId: string; serviceEpoch: string; attachmentId: string; sequence: number; controller?: Controller };
type Lease = { attachment: Attachment; grantId: string; grant?: ControlGrant; pending: boolean; timer?: NodeJS.Timeout; deadline?: NodeJS.Timeout };

/** Renews only authority already assigned to this connection by the owner. */
export class BridgeControl {
  private generation = 0;
  private attachment?: Attachment;
  private lease?: Lease;
  constructor(private readonly client: LocalClient, private readonly output: (record: unknown) => void) {}

  reset(reason = "Attachment changed"): number {
    this.lose(reason);
    this.attachment = undefined;
    return ++this.generation;
  }

  attached(result: unknown, generation: number): void {
    if (generation !== this.generation || !object(result) || typeof result.attachmentId !== "string" || !object(result.snapshot)) return;
    const snapshot = result.snapshot;
    if (typeof snapshot.sessionId !== "string" || typeof snapshot.serviceEpoch !== "string") return;
    this.attachment = { sessionId: snapshot.sessionId, serviceEpoch: snapshot.serviceEpoch, attachmentId: result.attachmentId, sequence: -1 };
    this.snapshot(snapshot);
  }

  snapshot(value: unknown, generation = this.generation): void {
    if (generation === this.generation && object(value)) this.observe(value, value);
  }

  holdsGrant(value: unknown, generation: number): boolean {
    return generation === this.generation && !!this.lease && object(value)
      && value.attachmentId === this.lease.attachment.attachmentId && value.grantId === this.lease.grantId;
  }

  update(value: unknown): void {
    if (object(value) && object(value.owner)) this.observe(value, value.owner);
  }

  private observe(value: Record<string, unknown>, owner: Record<string, unknown>): void {
    const attachment = this.attachment;
    if (!attachment || value.sessionId !== attachment.sessionId || value.serviceEpoch !== attachment.serviceEpoch
      || typeof value.sequence !== "number" || value.sequence <= attachment.sequence) return;
    attachment.sequence = value.sequence;
    const controller = object(owner.controller) && typeof owner.controller.attachmentId === "string"
      && typeof owner.controller.grantId === "string" && typeof owner.controller.label === "string"
      ? owner.controller as Controller : undefined;
    if (controller?.grantId === attachment.controller?.grantId) return;
    this.lose(controller ? `Control taken over by ${controller.label}` : "Owner revoked or expired the control grant");
    attachment.controller = controller;
    if (controller?.attachmentId !== attachment.attachmentId) return;
    const lease: Lease = { attachment, grantId: controller.grantId, pending: false };
    this.lease = lease;
    this.deadline(lease, performance.now() + 20000);
    void this.renew(lease);
  }

  private lose(reason: string): void {
    const lease = this.lease;
    if (!lease) return;
    this.lease = undefined;
    clearTimeout(lease.timer); clearTimeout(lease.deadline);
    this.output({ type: "control_lost", sessionId: lease.attachment.sessionId, serviceEpoch: lease.attachment.serviceEpoch,
      attachmentId: lease.attachment.attachmentId, grantId: lease.grantId, reason });
  }

  private deadline(lease: Lease, at: number): void {
    clearTimeout(lease.deadline);
    lease.deadline = setTimeout(() => {
      if (this.lease === lease) this.lose("Control renewal could not be confirmed before the lease deadline");
    }, Math.max(1, at - performance.now()));
  }

  private async renew(lease: Lease): Promise<void> {
    if (this.lease !== lease || lease.pending) return;
    lease.pending = true;
    const started = performance.now();
    let delay = 1000;
    try {
      if (!lease.grant) {
        const grant = await this.client.requestControl("grant");
        if (this.lease !== lease) return;
        if (!object(grant) || grant.attachmentId !== lease.attachment.attachmentId || grant.grantId !== lease.grantId
          || typeof grant.token !== "string" || !grant.token || typeof grant.heartbeatMs !== "number"
          || !Number.isFinite(grant.heartbeatMs) || grant.heartbeatMs <= 0 || typeof grant.expiresAfterMs !== "number"
          || !Number.isFinite(grant.expiresAfterMs) || grant.expiresAfterMs <= grant.heartbeatMs) {
          this.lose("Owner no longer supplies this attachment's control grant"); return;
        }
        lease.grant = grant as ControlGrant;
        // Renew immediately: a grant lookup alone does not extend its deadline.
        delay = 0;
      } else {
        await this.client.requestControl("heartbeat", { controlToken: lease.grant.token });
        if (this.lease !== lease) return;
        this.deadline(lease, started + lease.grant.expiresAfterMs);
        delay = lease.grant.heartbeatMs;
      }
    } catch (error) {
      if (this.lease !== lease) return;
      const code = object(error) ? error.code : undefined;
      if (code === "control_revoked" || code === "control_required" || code === "attachment_closed") {
        this.lose(error instanceof Error ? error.message : "Owner rejected the control grant");
      }
      // Transient failures retain the existing deadline; never reacquire control.
    } finally {
      lease.pending = false;
      if (this.lease === lease) lease.timer = setTimeout(() => { void this.renew(lease); }, delay);
    }
  }
}
