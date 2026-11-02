import type { AgentBeforeSettleEvent, BeforeAgentStartEvent, CustomMessageEntryDraft, ExtensionAPI, ExtensionContext, SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { BashJobs } from "./bash-jobs";
import { serviceUi } from "./service-ui";

const COMPLETION = "pi-bash-completion";
export const BASH_INTERRUPT_TITLE = "Stop running background commands too?";
type StartingMessage = Extract<BeforeAgentStartEvent, { messageType: "custom" }>["message"];
type Flight = { jobId: string; deliveryId: string; draft: SessionBoundaryDraft; message?: StartingMessage };

/** Session-local delivery, never a native busy follow-up. Boundary acknowledgments
 * come from committed entries: Pi does not emit extension message_end for drafts. */
export class BashDelivery {
  private flight?: Flight;
  private timer?: ReturnType<typeof setTimeout>;
  private question?: Promise<void>;
  private readonly lifetime = new AbortController();
  private readonly unsubscribe: () => void;
  private signal?: AbortSignal;
  private explicitInput = false;
  private interruptPending = false;
  private readonly cancelledStarts = new Set<string>();

  constructor(private readonly pi: ExtensionAPI, private readonly jobs: BashJobs, private readonly ctx: ExtensionContext) {
    this.unsubscribe = jobs.subscribe(() => this.schedule());
  }

  hold(): void {
    this.explicitInput = false; // Cleared pre-interrupt input cannot release this hold later.
    this.jobs.holdCompletions();
    this.reconcile();
    const flight = this.flight;
    if (flight) {
      // Boundary handlers can still be awaiting other extensions. Retire our
      // uncommitted draft in place as non-context bookkeeping, not a completion
      // body that might arrive after interrupt. The runner retains draft objects.
      Object.assign(flight.draft, { type: "custom", customType: "pi-bash-delivery-cancelled", data: { deliveryId: flight.deliveryId } });
      this.cancelledStarts.add(flight.deliveryId);
      if (flight.message) this.cancelStart(flight.message);
      this.flight = undefined;
      this.acknowledge(flight.jobId, false);
    }
    if (!this.question) this.interruptPending = true;
  }
  private cancelStart(message: StartingMessage): void {
    message.customType = "pi-bash-delivery-cancelled";
    message.content = [];
    message.details = undefined;
  }
  private readonly aborted = () => this.hold();
  watchSignal(ctx: ExtensionContext): void {
    if (this.signal === ctx.signal) return;
    this.signal?.removeEventListener("abort", this.aborted);
    this.signal = ctx.signal;
    this.signal?.addEventListener("abort", this.aborted, { once: true });
    if (this.signal?.aborted) this.hold();
  }
  input(source: string): void { if (source !== "extension") this.explicitInput = true; }
  starting(event: BeforeAgentStartEvent): void {
    if (event.messageType === "custom") {
      const id = (event.message.details as { deliveryId?: string } | undefined)?.deliveryId;
      if (id && this.cancelledStarts.delete(id)) this.cancelStart(event.message);
      else if (id && this.flight && id === this.flight.deliveryId) this.flight.message = event.message;
    }
    if (event.messageType === "user" && this.explicitInput) {
      this.explicitInput = false;
      this.interruptPending = false;
      this.jobs.releaseCompletions();
    }
  }
  userMessage(): void {
    // Also covers explicit steer/follow-up consumed inside an existing run.
    if (this.explicitInput) {
      this.explicitInput = false;
      this.interruptPending = false;
      this.jobs.releaseCompletions();
    }
  }
  private committed(flight: Flight): boolean {
    return this.ctx.sessionManager.getEntries().some(entry => entry.type === "custom_message" && entry.customType === COMPLETION
      && (entry.details as { deliveryId?: unknown } | undefined)?.deliveryId === flight.deliveryId);
  }
  /** Call only after a boundary/start has had a chance to commit its entries. */
  reconcile(finished = false): void {
    const flight = this.flight;
    if (!flight) return;
    const delivered = this.committed(flight);
    if (!delivered && !finished) return;
    this.flight = undefined;
    this.acknowledge(flight.jobId, delivered);
  }
  message(customType: string, details: unknown): void {
    if (customType !== COMPLETION || !this.flight || !details || typeof details !== "object"
      || !("deliveryId" in details) || details.deliveryId !== this.flight.deliveryId) return;
    const flight = this.flight;
    this.flight = undefined;
    this.acknowledge(flight.jobId, true);
  }
  private acknowledge(jobId: string, delivered: boolean): void {
    try { this.jobs.acknowledgeCompletion(jobId, delivered); }
    catch (error) {
      // Registry acknowledgment settles its claim even on a storage error. Do
      // not let an AbortSignal listener throw and prevent stop/owner cleanup.
      this.jobs.holdCompletions();
      this.ctx.ui.notify(`Background Bash delivery bookkeeping failed: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  }
  private claim(): CustomMessageEntryDraft | undefined {
    if (this.flight || this.jobs.completionsHeld || this.lifetime.signal.aborted) return;
    for (const job of this.jobs.completions()) {
      const result = this.jobs.claimCompletion(job.jobId);
      if (!result) continue;
      const deliveryId = randomUUID();
      const draft: CustomMessageEntryDraft = { type: "custom_message", customType: COMPLETION, display: false,
        content: `Background Bash command completed.\n${JSON.stringify(result)}`,
        details: { jobId: job.jobId, deliveryId } };
      this.flight = { jobId: job.jobId, deliveryId, draft };
      return draft;
    }
  }
  boundary(event: AgentBeforeSettleEvent, ctx: ExtensionContext): { entries: AgentBeforeSettleEvent["entries"]; continue: boolean } | undefined {
    this.reconcile();
    if (event.outcome !== "completed" || ctx.signal?.aborted) return;
    const draft = this.claim();
    if (!draft) return;
    this.schedule(); // Recover a dropped/invalid boundary even without a continuation.
    return { entries: [...event.entries, draft], continue: true };
  }
  settled(aborted: boolean): void {
    // A queued user input may have been discarded by clear_queue. Settlement
    // proves none remains to start; don't let that stale intent block the outbox.
    this.explicitInput = false;
    if (aborted) this.hold();
    this.reconcile(true);
    this.cancelledStarts.clear();
    this.schedule();
    // Never await an optional answer in agent_settled: abort waits for that hook.
    if (this.ctx.mode === "tui" && this.interruptPending) this.confirm(true);
  }
  private schedule(): void {
    if (this.timer || this.lifetime.signal.aborted) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.lifetime.signal.aborted) return;
      try {
        if (this.flight) {
          // Busy delivery acknowledges through message/context/settlement hooks.
          // Poll only idleness, not a copy/scan of the entire session history.
          if (!this.ctx.isIdle()) { this.schedule(); return; }
          this.reconcile();
          if (this.flight) {
            // Idle custom-start preflight can fail before message_end/settled.
            // Retain the result, but do not loop/restart on an unavailable model.
            this.jobs.holdCompletions();
            this.reconcile(true);
          }
        }
        if (!this.ctx.isIdle() || this.explicitInput || this.jobs.completionsHeld) return;
        const draft = this.claim();
        if (!draft) return;
        // isIdle and sendMessage are in one synchronous continuation. Pi marks
        // custom starts busy synchronously; no completion enters its clearable queue.
        this.pi.sendMessage(draft, { triggerTurn: true, deliverAs: "followUp" });
        this.schedule();
      } catch (error) {
        this.jobs.holdCompletions();
        this.reconcile(true);
        this.ctx.ui.notify(`Background Bash delivery paused: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    }, this.flight ? 20 : 0);
    this.timer.unref();
  }

  /** The host calls this only after abort has acknowledged idle, with current
   * frontend availability. Raw/headless RPC never assumes hasUI means a reader. */
  confirm(frontendAvailable: boolean): void {
    if (this.question || !this.interruptPending || this.lifetime.signal.aborted) return;
    this.interruptPending = false;
    const ids = this.jobs.runningIds();
    const interactive = process.env.PI_INTERACTION_MODE !== "noninteractive" && this.ctx.hasUI
      && (this.ctx.mode === "tui" || this.ctx.mode === "rpc" && frontendAvailable);
    if (!ids.length || !interactive) return;
    this.question = (async () => {
      const yes = await serviceUi(this.ctx, this.lifetime.signal).confirm(BASH_INTERRUPT_TITLE,
        `${ids.length} background command${ids.length === 1 ? " is" : "s are"} still running. No or dismissal leaves them running.`, { signal: this.lifetime.signal });
      if (yes && !this.lifetime.signal.aborted) await Promise.all(ids.map(id => this.jobs.stop(id)));
    })().catch(error => {
      if (!this.lifetime.signal.aborted) this.ctx.ui.notify(`Could not stop background commands: ${error instanceof Error ? error.message : String(error)}`, "error");
    }).finally(() => { this.question = undefined; });
  }
  dispose(): void {
    this.lifetime.abort();
    this.unsubscribe();
    this.signal?.removeEventListener("abort", this.aborted);
    if (this.timer) clearTimeout(this.timer);
    this.reconcile(true);
  }
}
