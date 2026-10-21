# C: typed single-session operations

Local service/bridge/Neovim implementation, stopping for orchestrator review.
The plans and active handoff are deliberately unchanged. This report supplements
that historical B3 handoff; it does not authorize D–F or establish remote parity.

## Mutation inventory and mapping

All mutations use the existing connection-bound `command` method and disk-backed
command IDs. There is no raw RPC or client-selected extension-command endpoint.
Unknown fields, nonprimitive enums and unknown operations refuse before admission.

| Existing entrypoint | Typed owner operation / arguments |
| --- | --- |
| Main input, queue editor/removal | Existing `prompt.submit`, `queue.edit/remove/reserve/release`; unchanged non-slash application queue. |
| `!command` / `!!command` in input | `shell.run {command, excludeFromContext}`. `!!` excludes the result from model context. `shell.abort {}` interrupts owner Bash. Explicit user Bash retains Pi's unrestricted-shell semantics. Neovim's own local shell commands are not redirected. |
| Steering editor; native follow-up | `steering.submit {text}`, `followUp.submit {text}`. Nonempty/non-slash, at most 1 MiB; not application queue items. |
| Model/thinking pickers | `model.set {provider, modelId}`, `thinking.set {level}`. Levels: off/minimal/low/medium/high/xhigh/max; effective state comes from Pi. |
| Native delivery/settings | `steering.mode` / `followUp.mode {mode: all | one-at-a-time}`; `compaction.auto` / `retry.auto {enabled}`; `compaction.run {instructions}`; `retry.abort {}`. |
| Access/integration pickers and cycle shortcuts | `access.set {mode: readonly | ask | edit | full}`, `integration.set {mode: ask | allowed}`. `access.cycle` / `integration.cycle {modes}` advances owner state in the configured, validated order, without optimistic frontend state. |
| Rename/retitle/notification/usage shortcuts | Existing `session.rename {title}`; `title.generate {}`; `notifications.set {enabled}`; `usage.refresh {}`. Usage is explicitly not-applicable outside Codex; no credentials are supplied by a frontend. Notification settings remain session-owned; headless desktop delivery remains disabled. |
| History/tree navigation | `history.navigate {entryId, summarize}`. Retains existing before-user/after-other-entry positions, summary restrictions, trust and workspace restoration. |
| Fork/clone | `history.fork {entryId}` forks **before a user message**; `history.clone {entryId}` copies **through the selected entry**. Both are detached copies with new Pi/service IDs; neither repurposes the source handle. Only the initiating frontend selects the new session. |
| Tree delete, including undo-work choice | `history.delete {entryId}`. Existing mode selection, final confirmation, stale leaf/file checks, rollback/recovery and cleanup remain owner-side. There is no client `--yes` bypass. |
| Workspace tool transitions | `workspace.enter {id?, ignoredFiles?}`, `workspace.integrate {id?}`, `workspace.discard {id?}`. Reuse existing tool implementation and enter/return handlers. Wait for actual arrival/cleanup rather than acknowledging a queued slash command. Existing ask/allowed approval semantics and continuation turns remain. Foreign-conversation/child workspace targets refuse. |
| Side actions | `side.open {}`, `side.prompt {text}`, `side.reset {}`, `side.abort {}`. Explicit correlated acceptance is not completion of the independent run/cleanup. Service frontend drafts stay local; no debounced owner-draft writes are introduced. |
| Spawn picker | `spawn.join {id}`, `spawn.stop {id}` use current session's runs. A stop can interrupt a child while a separately correlated join waits. Launch remains the existing model-facing spawn tool, not a new generic tool-execution API. |
| Session restart/kill | `session.restart` / `session.kill {confirmed: true}`. Distinct from frontend restart, detach and turn abort. Restart retains the handle/identity and all viewers, revokes control and performs normal owner initialization after awaited cleanup. Kill preserves history/workspaces and closes only the initiating frontend after draft preservation. |
| New/resume/saved selection | Existing deduplicated `host.create {cwd}` / `host.resume {sessionId}`, catalog selection and attachment. New/CWD shortcuts use explicit owner directories, not a frontend-local path substitution. |
| Dialog answers/cancellation and control | Existing typed operations and B3 lifetimes; closing/detaching/takeover is not cancellation. |

Read-only `session.read {kind, runtimeRevision}` permits only `models`, `thinking`,
`entries`, `tree`, `stats`, `forkMessages`. It checks context before pipe dispatch
and after the response. Entries/tree are bounded by the adapter record limit, not
a new paginated resource API. Catalog/snapshot/status reads remain available to viewers.

Setup-only trust/workspace publication commands remain private owner initialization;
attachment does not rerun them. Existing legacy editor-owned entrypoints remain intact.
The service module replaces that implementation and never falls back into its local
filesystem, process, shell or `nvim_exec_lua` paths. Overview remote dispatch still refuses.

## Outcomes, fencing and recovery

- Admission checks current attachment, epoch, control grant and runtime/context.
  Accepted work survives takeover/disconnect; a later stale callback is not a new
  authorization. Flat payload keys are canonicalized for deduplication; reordered
  object keys do not turn an identical retry into another mutation. Actual backpressured writes recheck storage, worker, managed
  identity, readiness and context. Uncertain mutations are never replayed.
- Native operations use their correlated RPC response. Settings refresh authoritative
  Pi state; shell completion returns exit/cancel state, not merely dispatch success.
  Native steering/follow-up receipts describe queued/handled acceptance, not a turn.
- Each bundled capability has a fixed internal name and exact bundled source check.
  The managed envelope binds invocation/runtime/Pi session/file. A private matching
  terminal result, consumed at its stdout position, is required in addition to
  `handled`. Refusal/cancellation is failed; possible partial mutation or a missing,
  malformed, mismatched or duplicate result is uncertain and retires execution.
  Workspace cleanup/integration status remains explicit in completed results;
  history deletion distinguishes `applied` from `cleanup_incomplete`. Neither
  completion nor an uncertain failure proves rollback.
- Context transitions gate queue dispatch and advance the revision **before** their
  asynchronous handler. Runtime/history events continue advancing it. Old-target
  queued text becomes failed for review, including after a cancelled transition
  attempt; it is never rebound automatically. Fork/clone leave the source context
  intact: source work is not moved to the new identity.
- Fork/clone files use new canonical owner filenames before conversation-trust
  copying. Registration and terminal receipt commit together in SQLite. Pi JSONL,
  trust files and SQLite are not one cross-file transaction; a failure may retain an
  unregistered file and uncertain receipt, never permission to clone again.
- Submitted shell/native/side text is retained as `result.submittedText` in recovery
  storage. History navigation/fork text is `result.editorText`. Navigation/fork reserve
  the existing 17-MiB large-outcome budget; recent snapshots retain their separate
  2-MiB recovery budget. Full status lookup remains available. No receipt TTL/count
  ceiling or automatic replay was added.
- Live history completion may open a **separate recoverable draft**, bound to the
  initiating attachment/grant and expected transition. It never overwrites input.
  Receipt/snapshot/reconnect inspection does not apply editor/navigation actions.
  Existing generic effects remain inspect-only and are not retargeted after takeover.
- Frontend authority is sequence-fenced separately from rendered snapshots. A newer
  owner update invalidates takeover confirmations, callbacks and old-context editors
  immediately, even before the coalesced snapshot arrives. Old snapshot responses
  cannot restore authority; refresh/attach results are selection-bound.
- Pending approval windows are not rebuilt/cancelled by streaming, retry, compaction
  or ordinary refresh. Native queues and the editable queue render separately.
  `clear_queue` precedes active abort and preserves steering and follow-up text.
- Lost-ack text remains protected under its original ID. `:PiSubmissions` explicitly
  reviews text; `:PiOperations` inspects all session receipts; `:PiHostRequest` reviews
  an unresolved allocation/resume ID. A pending host ID cannot be overwritten by a
  second request. Reconnect looks up IDs with four bounded readers; it never resends.
- Interruption operations use essential storage headroom. Lifecycle outcomes drain
  before administrative close; a restart does not replace subscriptions with a new
  handle. Cleanup failures retain the existing best-effort ownership/recovery policy.

## Fresh evidence (2026-10-21)

Executed on **macOS 27.0.1 arm64, Node 26.12.0, Neovim 0.12.6, unchanged Pi 1.3.0**.
Private scratch HOME/agent/service/frontend state and Git projects were used. The
actual CLI service, Unix IPC, shipped Node bridges, shipped Lua renderers, installed
Neovim plugins and two separate Neovim processes were exercised. No installed Pi
files were modified. Model output, a transient provider error and approvals came
from scratch offline fixtures, not external model services.

Temporary probes (not shipped):

- `pi-c-ui-final.mjs`: controller/viewer enforcement; owner shell; settings and
  stale model picker; actual old-token command rejected server-side; takeover
  confirmation invoked in the pre-snapshot controller-update window; saved stale
  dialog callback after takeover; full approval preview/answer after disconnect;
  dropped frontend prompt callback with original-ID protection; two successive
  revisioned queue-editor saves and abort; reconnect with 80 unresolved diagnostic
  IDs and no request-limit overflow; owner workspace enter/discard with unchanged
  frontend cwd; owner history jump, separate recovery draft and unchanged input;
  clone changes only initiating selection; an actual side approval window remains
  open while both Neovims render main compaction and transient-error retry; accepted
  output continues in the same runtime after both Neovims, bridges **and protocol
  observers** close.
- `pi-c-extra-final.mjs`: all native settings, access/integration cycle, retitle,
  not-applicable usage refresh, distinct before-user fork versus inclusive clone,
  fork-ID and reordered-model-payload deduplication, owner shell, workspace
  enter/integrate plus ask-mode integration/discard cancellation, native steering and
  follow-up with both texts checkpointed before abort, actual Pi manual compaction
  and transient-error retry visible to a second attachment, old-target reserved
  queue failure/recovery after navigation, stale revision rejection, owner tree
  deletion with original mode/confirmation and stale-controller answer refusal,
  session restart/kill.
- `pi-c-side-final.mjs`: real bundled side open/prompt/reset/abort; a side approval survives
  main abort and manual compaction; explicit answer; actual model-triggered readonly
  child launch, concurrent typed join/stop and correlated terminal results. Restart
  during active side work awaits known managed cleanup and restores no running side
  prompt; no native queue/child request is replayed.
- `pi-c-lifecycle.mjs`: two actual Neovims retain the same session identity across
  owner restart, lose their grants, retain local input and auxiliary drafts, then
  explicitly reacquire control. Kill closes only its initiator, leaves the viewer
  open, saves the conversation and retains unsent input/modified auxiliary text in
  frontend recovery files.
- Server strict `npm run check --prefix server` / `npm run build --prefix server`,
  watchdog-first Neovim Lua loading and `git diff --check`. A supplemental strict
  extension check reports 24 pre-existing diagnostics, reproduced against HEAD with
  identical dependencies; it is **not a passing whole-extension typecheck**.

Fixture corrections were not product evidence: the first provider omitted baseUrl;
initial minimal-Neovim probes omitted real plugin paths; `/tmp` needed canonical
`/private/tmp` comparison; long component runs needed heartbeat renewal; one UI
probe observed the server grant before the frontend received it. Review/probes also
found and corrected coerced enums, interruption headroom, workspace cancellation,
join/stop exclusion, `runId` decoding and the pre-snapshot authority race. Final
independent source review found no Critical/Important issues; its checks were
source/typecheck/diff review, not an independent rerun of the runtime matrix.

Historical B3 actual Node 22.19/startup-race/slow-peer/crash-reconciliation/wire-loss
and B1/B2 storage/supervisor/fault results remain historical, not fresh C reruns.
Linux, C on actual Node 22.19, external-provider behavior, physical power loss,
whole-filesystem exhaustion and complete third-party dialog lifetime parity are
unverified. Unknown escaped descendants remain the approved best-effort limit.

## Explicit remaining boundary

No HTTPS/hosts/combined overview, installer/installed-Pi change, ownership redesign,
receipt expiry/count ceiling, replay, Alt binding, TODO/plan edit or permanent test.
D/E still own overview/window-launch parity, archived/deleted saved-session resources,
remote completion/artifacts/skills, editable workspace review/guarded resource saves
and broader notification delivery. Those shortcuts explicitly refuse; owner paths
are metadata, never authority to manipulate a matching frontend-local path.
Stop here for orchestrator review; this is not remote feature-complete acceptance.
