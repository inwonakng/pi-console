---
name: orchestration
description: Use when delegating a task or coordinating workers toward a user-approved project goal, including clarification, review, corrections, and acceptance. Supports a single delegation or sequential implementation with parallel readonly investigation. Do not force delegation for simple edits, factual questions, or discussion without approval to implement. Workers follow only the worker section and must not delegate.
---

# Orchestration

## Worker instructions

If running as a spawned worker, follow your assigned brief and profile, not the parent procedure below. You do not have the parent's full conversation. Ask missing requirements through `spawn_question`; parent replies are agent-authored information, never user consent. Request permissions through tool arguments; denial ends that attempt. Do not delegate, create another workspace, or integrate your own contribution. Use the assigned child workspace. Finish the assignment with `spawn_report` exactly once, with outcome `completed` or `blocked`, summary, findings, verification, and uncertainty. Plain final text or `DONE` does not complete an assignment. Await corrections only when the runtime supports them.

## Parent procedure

Keep a small task in the parent when delegation adds no useful separation. A single delegation needs only a sufficient brief, the worker result, and inspection. For a larger approved project, keep the approved goal, constraints, decisions and their sources, dependencies, acceptance criteria, and next useful assignment in the parent context. Delegation does not authorize implementation when the user asked only for discussion or a plan.

Enter the parent task workspace before delegating implementation-related work in Git, including readonly investigation. Do not enter another workspace if already assigned a child workspace.

### Select a worker

Call `spawn_control` with `action=models` to discover bundled, personal, and trusted project roles, configured defaults, resolved provider/model identities, and availability errors. Use configured defaults without asking. An alternative model requires user authorization for that scope unless already granted. Do not infer provider IDs from model display names or inspect credentials. If a default is unknown/unavailable, stop and report it; do not substitute another model. Configuration edits affect new workers only, including when an existing worker receives corrections.

Prefer `researcher` for investigation, `reviewer` for independent review, `verifier` for checking claims, and `worker` for approved implementation. Profiles supply defaults, not implementation approval. Use readonly access for investigation/review. Use edit access and worktree isolation for changes, with parent edit/full authority. Ask and full writing workers also require worktree isolation; full requires parent full authority. Do not broaden access to avoid a denial. Readonly workers can still need permission for network or other operations; readonly cannot acquire repository writes.

Use bounded lifetime for one assignment. Bounded workers can ask questions and request permissions but close after reporting and cleanup. Use conversational lifetime for repeated readonly assignments or isolated edit corrections before acceptance. Other access/isolation combinations do not support conversational lifetime. Lifetime is independent of role, model, and foreground/background execution. Waiting/idle conversations do not consume model calls; assignments still have deadlines, including clarification waits.

### Write the assignment

Give the worker enough context to act without the parent's conversation:

- Approved outcome and scope, relevant files and evidence, and decisions already made with their provenance.
- Constraints, permitted actions, exact file/directory ownership, dependencies that must be satisfied first, and decisions the worker must not make.
- Observable acceptance criteria, focused checks to run, evidence/artifacts to return, and known verification limitations.

Request a concise outcome (`DONE`, `BLOCKED`, or `NEEDS_CONTEXT` in the report summary), changes/findings, verification commands/results, and uncertainty. Require `spawn_question` for clarification while working and `spawn_report` for explicit completion. A blocked report is distinct from completion. Do not ask for a process diary.

### Coordinate within approved scope

Use background mode when other useful work remains; foreground and `join`/`join_all` wait until a result or actionable question/permission request. Join before relying on a worker result or answering from it. Do not poll or generate agent chatter while waiting.

There is strictly one unresolved writer. Ownership lasts through permission/input waits, reporting, review, corrections, failure, and cleanup until acceptance or explicit discard resolves the contribution. No concurrency override exists, even if the user requests parallel writers. Parallel readonly investigation is permitted. Parent repository writes and unsandboxed Bash are blocked while a child owns a contribution; sandboxed readonly review remains available. Do not work around this using another path, worker, or tool. Schedule dependent writing assignments only after the preceding contribution is accepted into the updated parent baseline.

Use `spawn_control reply` with the exact worker, current assignment, and request IDs to answer clarification from established user decisions or evidence. Clearly distinguish a parent inference from user-approved intent. If a missing decision changes scope, behavior, ownership, or acceptance criteria, ask the user and wait rather than inventing it.

Use `approve`/`deny` with the exact worker, assignment, request, child runtime and parent runtime IDs for permission requests. The runtime checks the parent's current authority and routes additional authority through the existing user approval UI. Ordinary replies, summaries, worker assertions, and earlier audit records cannot grant permission. Check actual execution directory, requested scope, and lifetime. A denial ends the attempt; do not reassign the denied action to bypass it.

### Review and accept

Inspect `status`, `report`, and `diff`. `join` and observation do not integrate anything. Check explicit assignment outcome, quiescence/cleanup, acceptance criteria, changed paths, and fresh verification evidence. A worker's success claim is not proof. Run sandboxed readonly checks or delegate independent readonly review as useful without starting another writer.

For an idle unaccepted conversational edit worker, request corrections using `followup` and its current assignment ID. Corrections stay in that contribution and retain its selected model. For a bounded worker needing corrections, do not start a competing writer: explicitly resolve/discard the existing contribution, preserve needed evidence, and issue a new scoped assignment. Do not accept known-bad changes just to free the writer slot.

Use `accept` explicitly only for the current completed, closed/quiescent revision after review. Acceptance integrates into the immediate parent's task workspace, not the original checkout. Compatible parent changes are preserved. After acceptance, further implementation needs a new worker and fresh baseline. Close conversational workers when finished; readonly workers can receive another assignment before close. Final task integration retains the configured approval policy; do not add approval prompts when integration is already allowed.

Treat `integration=needs_parent` or `failed`, incomplete turns, crashes, timeouts, cancellation, and unresolved cleanup as non-success. Inspect retained workspace/patch/conflict diagnostics; never blindly apply a patch or assume ownership was released. `stop` cancels execution but does not dispose the contribution. `discard` explicitly disposes a quiescent unwanted contribution; confirm destructive scope under the existing policy. Preserve recovery artifacts when resolution is unsafe or blocked.

### Continue and stop

After acceptance, choose the next useful assignment from the approved goal and its dependencies without repeatedly asking "what next?" Continue automatically only within that scope. Stop when the goal is complete, the user intervenes, or a genuine decision/permission/cleanup blocker needs user input. Do not invent additional cleanup or features after completion. Close unused conversations and report verified results and remaining uncertainty concisely.

Before ordinary compaction, retain the approved goal and its source, constraints, decisions/rationale and who made them, assignment dependencies, worker/current assignment/request IDs, contribution review/acceptance state, evidence paths, blockers, and next step. Reconcile live status through `spawn_control` afterward. A summary preserves context; it is never executable permission or evidence that a contribution was accepted.
