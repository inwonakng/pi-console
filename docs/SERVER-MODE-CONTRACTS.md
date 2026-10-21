# Server-mode compatibility gate

Status: **C typed local single-session implementation; stop for orchestrator review (2026-10-21).**
See [`SERVER-MODE-C.md`](SERVER-MODE-C.md) for the mutation inventory, current contracts
and fresh macOS/Node 26.12/actual two-Neovim evidence. Installed Pi remains unchanged.
The B3 and earlier reports below are historical unless explicitly rerun in that C report.
C on actual Node 22.19 and Linux remain unexecuted; this is not remote resource parity,
a default-workflow replacement, full installer or authorization for D–F.

[`plans/server-mode.md`](../plans/server-mode.md) is the migration specification.
See [`plans/server-mode-handoff.md`](../plans/server-mode-handoff.md) for the current
stopping point and next implementation slice.

## C local single-session evidence (2026-10-21)

The [C report](SERVER-MODE-C.md) records the typed allowlist, positive bundled-result
protocol, detached fork/clone identity registration, context/queue fencing, native
queue separation, lifecycle and frontend authority changes. Fresh checks exercise
the real service and two actual Neovims, not only owner components. B3 reconnect
pressure, consecutive queue saves, frontend-independent output and lost-ack input
protection were rerun. Prior storage/crash/Node-floor evidence is not relabeled as C.
No permanent tests, plan/TODO edits, installed-Pi changes or excluded transport/resource/
installer expansion were introduced.

## Historical B3 completion — startup coordination and operational attachment (2026-10-21)

### Diagnosis and bounded correction

The earlier B3 report below overstated the zero-owner race as an architectural B2
blocker. It is a startup-coordination availability bug. No duplicate owner, data loss,
or need for an ownership redesign was established.

Two independent processes were barrier-released into real `HostOwner.open()` calls;
the winner, if any, stayed alive until both outcomes were collected. Before the fix,
round 11 produced two SQLite error-5 chains from `ownerLease()` and only a zero-byte
`owner-lease.sqlite`. No `owner.lock`, registry, catalog, worker or socket existed.
This reproduces the original symptom independently of launcher readiness polling.

A separate read-only investigator reduced it to two barrier-released calls to the
unchanged lease helper, keeping the winner held throughout the competing attempt:

| Initial lease file | Rounds | One owner | Both BUSY |
| --- | ---: | ---: | ---: |
| Absent | 400 | 399 | 1 |
| Precreated empty | 400 | 254 | 146 |
| Initialized SQLite | 400 | 223 | 177 |

A scratch comparison on precreated empty files gave 247/400 one-owner outcomes with
zero wait, versus **400/400 with a 50-ms SQLite busy wait**. No double success was
observed. Transient contention during read-to-exclusive acquisition is the supported
explanation, not a directly traced SQLite lock interleaving. Empty-file initialization
alone does not explain failures on initialized files. Failed transactions reported
`isTransaction === false`.

The production change is confined to `ownerLease()`: `busy_timeout=50`, retaining
`BEGIN EXCLUSIVE`, close-on-failure and refusal on exhaustion. This applies to ordinary
open and explicit reconciliation; it never clears a claim, grants recovery, retries
initialization after claim publication, or replays a mutation. The catalog's zero
transaction timeout is unchanged. A busy-handler budget is not a hard wall-clock
latency promise (scratch losing calls reached about 63 ms).

Patched production `HostOwner.open()` passed **30/30 fresh-profile races**, exactly one
held owner each. The actual CLI passed **eight fresh + eight reopened-profile start
races on each of Node 26.12.0 and Node 22.19.0**. Both callers exited 0 with the same
host/epoch; a fresh process-table observation showed one live `cli.js run` owner.
Another pair of starts during every live service preserved that epoch. Services were
stopped through their endpoint, never through stale PID files.

### Candidate review corrections

The existing candidate was retained, including the earlier overlap/failed-shutdown/
dev-management fixes. Independent review found three additional gaps:

- Service tool actions called the legacy output viewer, which could read owner
  `fullOutputPath` locally or open spawn artifacts/tmux workspace review. They now
  open only recorded tool text; owner resource actions remain unavailable.
- Delayed takeover confirmation could use a new attachment/session. It now captures
  generation/attachment/session/runtime and refuses a changed context.
- Lost-ack prompt text looked unsent and could be sent under a new ID. Unresolved
  submissions now display their ID/status in the transcript, retain text and block
  identical-text submission until explicit `:PiSubmissions` review. Reconnect only
  queries original IDs; it does not replay. Controlled restart retains protection.
- Final review found recovery under release-specific `stdpath("state")`. Draft storage
  now uses channel-stable XDG frontend state, independent of `NVIM_APPNAME`. Fresh
  headless write/read checks across two app names retained input and original command
  IDs; stable/dev remained separate and files were 0600.

### Fresh operational matrix

All groups below passed on **macOS arm64 / unchanged Pi 1.3.0 / Neovim 0.12.6**, with
**Node 26.12.0 and actual official Darwin-arm64 Node 22.19.0**. Isolated HOME/agent,
project, service and frontend state were used. Streaming came from a scratch offline
provider; an input hook used the production bundled `serviceUi` confirmation wrapper.
No external-provider success or new third-party dialog guarantee is claimed.

- Real bundled startup, disk-backed host create/resume lookup, payload conflict,
  same-ID retry and one worker; prompt status preserves accepted text.
- Explicitly discarded create/resume/prompt response frames followed by disconnect,
  original-ID lookup and retry: one allocation/turn, no worker relaunch/replay.
- Two actual headless Neovims, shipped UI/renderers and individual Node bridges:
  viewer draft retained, streaming late attachment, confirmed takeover, old token
  rejected through the original frontend transport, actual shared queue editor save
  and owner abort. Reattached snapshots include current partial text.
- Controlled frontend restart writes/consumes its recovery payload, preserves main
  and auxiliary queue/answer draft text, and does not reacquire another frontend's
  control. Recovery files live under
  `${XDG_STATE_HOME:-$HOME/.local/state}/pi-console/frontend/<channel>/service-drafts`,
  not a release-specific Neovim directory. Reconnect similarly stays a viewer. Restored auxiliary drafts are inspect-only.
- Every frontend/bridge/observer closed during streaming: same runtime continued and
  later attachment saw longer partial text with no controller. An unanswered approval
  likewise remained after zero frontends; late actual Neovim rendered its full preview
  and answered explicitly. Normal service stop refused the pending approval.
- Actual-UI dropped-response-callback regression: retained input and visible original
  receipt status, no fresh prompt when identical text was submitted again. Delayed
  takeover after reconnect refused. A trapped legacy viewer/local-read API was not
  invoked by the service's recorded-tool action.
- Sixteen overlapping attaches on one connection retained a usable current view.
  Malformed JSON, invalid UTF-8, arrays and >2-MiB unterminated frames dropped their
  peers. A paused client flooded with bounded snapshots was evicted while another
  client and real Pi partial output kept advancing. Profile/socket modes were 0700/0600.
- Foreign dev checkout start/stop/restart/reconcile refused with the owning checkout
  identified and the epoch unchanged; explicit compatible viewing remained allowed.
- Real owner SIGKILL during streaming with accepted queued text: live reconciliation
  refused; ordinary `run` refused the retained crash claim; explicit CLI `reconcile`
  then `start` then `resume` preserved host/session identity, old receipts and failed
  queue text, rejected old-epoch envelopes, reacquired no control and replayed no work.
- Scratch-injected real `OwnedSession.stop()` rejection exercised failed shutdown:
  diagnostic response, owner exit 1, no healthy listener, exact claim retained,
  ordinary startup refusal, then explicit known-managed-work reconciliation.

Commands/groups were temporary `pi-b3-{race,start,accept,wire-loss,ui,ui-regress,
recovery,peers}.mjs` probes outside the repository. No tests ship. Strict
`npm run check --prefix server` and `npm run build --prefix server` passed under both
Node versions; `node --check pi/scripts/managed-process.mjs`, `bash -n bin/pi-console`,
watchdog-first Neovim Lua loading/runtime checks and `git diff --check` passed.
Dependencies installed with `npm ci --offline --ignore-scripts --prefix server` and
`--prefix pi`; installed Pi was not changed.

Fixture corrections, not product failures: initial acquisition was attempted before
runtime startup; a turn-count assertion included auto-title's separate provider call;
UI reconnect/control assertions initially observed cached state before attachment/
controller refresh; remote evaluation of immediate editor exit loses its own reply.
Corrected probes wait for authoritative attachment/grant state and schedule exit after
the diagnostic response. A later regression fixture reused several MiB of failed queue
text from the slow-peer probe and evicted its observer under documented viewer limits;
it was rerun on isolated small state. Successful complete groups above ran afterward.

**Limits:** Linux is unavailable and unexecuted. Actual Node 22.19 B3 execution above is
fresh, not a claim that every historical B1/B2 fault/nested/sandbox probe was rerun.
Repeat this matrix and the existing B2 Linux sandbox/monitor checklist on Linux/22.19.
Physical power loss, whole-filesystem exhaustion, external providers and complete
third-party dialog lifetime behavior remain unverified. The approved unknown-escape
limitation stands; known live/unresolved managed work still refuses replacement.
C–F, broader commands, HTTPS/overview and full installer remain out of scope.

Independent follow-up review approved the corrected B3 slice with no Critical/Important
findings. Review inspected the final source/docs, actual Node-floor check and parent-run
runtime logs; the broad runtime matrix was not independently rerun. Final draft-path
correction was followed by fresh cross-app-name recovery and actual frontend regressions.

## Historical B3 candidate and superseded integration stop (2026-10-21)

The evidence below is retained for diagnosis. Its architectural-blocker/retry prohibition,
unfinished-gate list and Node-floor status are superseded by the completion section above.

### Historical stop condition: lifetime-lease contention

The B3 assignment required reporting concrete B2 blockers rather than bypassing
ownership. Work stopped at this gate; no lease/registry/reconciliation implementation
was changed. The approved best-effort contract remains: known live/unresolved managed
work blocks replacement; possible unknown escaped work does not block explicit resume.

Fresh macOS arm64 / Node **26.12.0** probes against the unchanged B2 helper observed:

- Two independent `server start` calls on a fresh private profile both exited 1 after
  readiness polling; both candidate `server run` processes failed in
  `ownerLease()` → `PRAGMA busy_timeout=0; BEGIN EXCLUSIVE` with
  `ERR_SQLITE_ERROR`, SQLite error code **5**, `database is locked`. No endpoint or
  owner was left. This happened in two separate fresh-profile operational runs.
- An independent component-only probe removed the listener, bridge and frontend:
  launch two Node processes concurrently, each calling
  `HostOwner.open({root: freshPrivateRoot, channel: "dev", appRoot: checkout,
  binary: "/opt/homebrew/bin/pi"})`; a winner holds for 500 ms, then closes.
  Rounds 1–3 each produced one owner; round 4 produced **zero owners**, both with
  the same lease error. The failed profile held only a private zero-byte
  `owner-lease.sqlite`, with no `owner.lock` or catalog. There was no claim removal,
  stale-PID signalling, reconciliation, worker launch or replay in this probe.
- Separate direct `run` races (ordinary and detached children) and another pair of
  `start` calls did produce one owner; both successful start callers reported the
  same host ID and service epoch. Those positive runs do **not** close the
  intermittently failing gate. A tiny direct-lease-only five-round probe produced
  one winner each time; that narrower result does not invalidate the owner probe.

This is an availability blocker at the B2 admission/lease boundary, not evidence of
unsafe duplicate execution, a SQLite ledger-loss bug, or a reason to restore the
withdrawn exhaustive-containment requirement. The original report treated this as a stop before further acceptance. That was too
restrictive: bounded startup coordination is allowed and now verified above. Claim
removal and ownership-contract weakening remain forbidden.

### Candidate code and positive evidence (not B3 acceptance)

New `server/src/{cli,local-service,local-client,local-protocol,service-paths,bridge,
host-commands}.ts` compose independent foreground/detached startup, a same-user 0700
profile/0600 Unix socket, protocol-v1/channel/capability/build handshake, connection-bound
attachments, typed command dispatch, bounded framing/client output, and guarded
administrative stop/restart. Host allocation/resume receipts use the existing SQLite
commands table (nullable host session FK); creation allocation and receipt commit
atomically. No schema migration, dependency, installer delivery, HTTPS or raw-RPC tunnel
was added. Explicit `server reconcile` invokes B2 recovery without resuming work.
Dev-management commands compare the serving checkout; explicit compatible views may
attach without acquiring control.

`pi-console --service` selects a separate UI composition that reuses existing layout,
message/tool/thinking rendering and keymaps without loading legacy RPC ownership/event
handlers. It renders coalesced pure owner snapshots after ordered update notifications;
100-ms read coalescing is not a latency guarantee. Actions cover non-slash text,
control, approvals, shared queues, rename and abort. Owner-path actions/links, shell,
slash/settings/history/workspace/side/spawn controls are explicitly unavailable.
Effects are inspect-only recovered-draft buffers, never editor/navigation application.
Reconnect does not acquire a grant or replay a mutation. Local main/queue/answer drafts
have private frontend recovery files; controlled restart uses the launcher's private
handoff. These new draft/restart paths still need full acceptance below.

Fresh checks used **Neovim 0.12.6**, unchanged installed **Pi 1.3.0**, its actual bundled
extensions, an isolated agent/home/project and a scratch offline slow-stream provider.
No external-provider success is claimed.

- `npm ci --offline --ignore-scripts --prefix server` and `--prefix pi` passed.
  Final stopping checks after the lifecycle/source corrections passed:
  `npm run check --prefix server`, `npm run build --prefix server`,
  `bash -n bin/pi-console`, `git diff --check`, and watchdog-protected headless
  Neovim `loadfile` syntax validation of all seven changed/new Lua files.
  Syntax/build checks do not accept the unexecuted runtime paths below.
- Two actual headless Neovim processes loaded the shipped attachment composition,
  layout/message rendering and installed UI dependencies, each with its own Node bridge.
  They attached as viewers, UI1 acquired control, UI2's rejected submission retained
  its draft, UI2 reattached during streaming and rendered the current partial output,
  then confirmed takeover. A raw typed request sent from UI1's actual old transport
  with its captured stale token received `control_revoked`; UI1's nonempty draft
  survived. Both saw the same accepted queue. UI2 opened the actual local queue-editor
  buffer, saved an edited item through the service, and aborted through the owner.
- A second probe submitted slow work, then closed **both actual Neovims/bridges and
  the observer attachment**. After 1.8 seconds with no attachments, a new attachment
  saw a longer partial assistant message in the **same runtime ID**, with no controller.
- Initial probe failures exposed a missing empty-transcript rendering context and
  Lua empty tables encoded as JSON arrays; the context and wire-object normalization
  were corrected, then both complete actual-frontend probe groups passed. A fixture
  configuration used invalid `notifications.enabled`; it was corrected to the existing
  `notifications.default: disabled` setting before the positive real-Pi runs.
- Independent review identified overlapping-attach pumping, failed-shutdown listener
  state, and cross-checkout dev management gaps. Source corrections capture each
  subscription, terminate failed owners while retaining claims, and refuse foreign
  checkout administration. **These latest lifecycle corrections were typechecked,
  built and inspected, not runtime-accepted before the B2 stop condition.**

### Historical incomplete verification (superseded above)

At that stopping point, B3 was **not accepted**. Late unanswered-approval rendering/answering after all frontend
exits; lost create/resume/prompt acknowledgments; malformed/oversized/slow peers;
controlled frontend relaunch and private draft recovery; forced/failed cleanup and
cross-checkout management regression probes; and owner-crash reconciliation plus
explicit resume **through the new service entrypoint** remain unexecuted. Earlier B2
component recovery evidence is not a substitute for that entrypoint check.

**Minimum Node:** B3 ran only on Node 26.12.0. Actual Node **22.19.0** B3 checks are
unexecuted; older B1 floor evidence below is historical, not B3 validation.

**Linux:** unavailable and unexecuted. After repairing/reviewing the lease blocker,
repeat fresh-profile racing `start`/`run`, socket permissions/framing, detached lifetime,
two actual frontends/takeover, streaming/approval late attach, lost-ack deduplication,
normal/forced lifecycle and explicit `reconcile`→`start`→`resume` on Linux and Node 22.19.
Also retain the B2 Linux sandbox/monitor/namespace checklist below. Do not mark the
platform accepted from macOS evidence or from possible unknown-escape limitations.

Temporary probes lived outside the repository; none ship as tests. The active handoff
contains the candidate boundary and stop condition, not superseded B1/B2 assignments.

## B2 retry — revised best-effort contract and fresh evidence (2026-10-21)

**Production component implementation verified and independently reviewed on macOS; not end-to-end service or Linux/Node-minimum acceptance.**
This section supersedes earlier statements that recovery, channel roots and effect
recipient fencing are wholly unimplemented. Earlier B1 and withdrawn-candidate
reports remain historical evidence, not fresh B2 results.

The user approved best-effort ownership: unknown escaped descendants do not block
explicit resume; known live/unresolved managed jobs do. There is no exhaustive
containment/security guarantee, mandatory VM/cgroup, new production package,
installed-Pi change, transport/frontend attachment, broader command family or B3.

### Implemented boundary

`pi/scripts/managed-process.mjs` is shared by the server and bundled side/spawn/Bash.
Its stable-ID supervisor/anchor pair persists intent and execution grant before
launch. SQLite ancestor/epoch fences cancel ungranted intents and prevent late
registered launchers from racing reconciliation. A supervisor survives owner death,
stops managed work and publishes terminal evidence; its own loss leaves a granted
job unresolved. Anchor loss without workload completion acknowledgment also stays
unresolved. Model sandboxed/approved-unrestricted and explicit user/RPC Bash use registered
operations (preserving their separate permission semantics). Live process-table sampling covers observable MCP/sandbox/helper
descendants; registered nested supervisors retain their own cleanup/publication
window. Unknown detach/reparent/namespace/external-service escapes remain possible.
No persisted PID is used to signal recovery targets.

`SessionCatalog` holds a separate kernel lifetime lease. Explicit
`HostOwner.reconcile({root,channel})` acquires it, seals the old epoch, waits for
known managed jobs and stores exact old claim bytes in an immutable FULL SQLite
recovery row before catalog transition/claim retirement. Interrupted publication
and catalog commit are idempotent. This lease serializes recovery; it does not
prove worker death. Legacy B1 claims lacking this evidence still refuse automatic
reconciliation. SQLite ledger identity/schema and recovery payloads are unchanged;
reopen marks unfinished receipts uncertain and queue items failed, never replayed.

Spawn awaits managed cleanup before patch capture. A durable child-workspace marker
and persisted cleanup error prevent later join/capture/integration/removal from
bypassing failed cleanup; a failed metadata publication can require inspection.
Service cleanup Git is directly awaited with a 10s bound. Unknown escaped filters
or outside writers can still invalidate a snapshot; patches are not exhaustive
quiescence evidence. Desktop alerter is disabled on service workers (notification
policy belongs to clients); sanitized TMUX prevents host UI review launches while
retaining review data. Existing external services are not adopted/killed.

Host resources default to `HOME/.local/state/pi-console/service/<channel>`, preserve
host credentials/settings and use explicit sanitized environment/PATH. Bundled and
installed Pi trees/dependencies are fingerprinted; top-level checks, inherited
stat/realpath/resolution manifests and bundled before-switch guards refuse dev
resource changes. This is change detection, not atomic source isolation; arbitrary
user/project resources are not part of the service build fingerprint.

Effects are bounded, recipient/grant/runtime/cwd-bound **inspect-only offers** from
the owned stream, not claims about which attachment initiated an extension event.
Subscription dequeue filters stale/wrong-recipient offers while preserving sequence
envelopes. `inspectEffect` rechecks token, expiry, owner revision, readiness and
storage after async delays. Snapshots contain no offers/tokens and do not replay.
There are no actionable editor/navigation callbacks; B3 must preserve local drafts.

### Fresh retry checks (macOS 27.0.0 arm64 / Node 26.12.0 / unchanged Pi 1.3.0)

Temporary probes ran outside the repository and were removed; none ship as tests.

- `npm ci --offline --ignore-scripts --prefix server` and `--prefix pi`, strict
  server check/build, helper syntax and whitespace checks passed. Server runtime
  dependencies remain built-ins plus the shared local helper.
- Prototype ordinary pipes, TERM-ignore escalation, owner SIGKILL during active
  work, cancellation before launch grant, sealed-late-launch refusal, supervisor
  loss refusal and unknown detached-late-write limitation passed. Independent gate
  review found an anchor-ack gap; corrected anchor-loss probe and reruns passed,
  then independent follow-up approved proceeding. This was prototype acceptance,
  not evidence for production code that changed afterward.
- Production real Pi startup/trust/workspace readiness, actual RPC bash,
  clean stop/reopen/explicit resume and stable session identity passed. Two actual
  subscriptions exercised recipient filtering, takeover, owner-history revision,
  synchronous expiry and same-attachment reacquisition checks; snapshots excluded
  offers. These are server component checks, not actual frontend draft application.
- Changed bundled dev resources refused a same-child `switch_session` before reload
  (runtime ID unchanged), and refused a future runtime. A targeted inherited-manifest
  probe detected a newly installed nearer hoisted dependency outside the original
  dependency trees, including package-less index directories and CommonJS file
  candidates. The latter were an additional source-review finding, then corrected.
- Real Pi with an isolated offline fixture provider started **both actual bundled
  spawn and side Pi runtimes**, confirmed via child startup markers, then stopped
  them with active work and an actual TERM-ignoring RPC bash. Managed registry jobs
  were terminal and the shell stopped writing. The first nested fixture only saw
  intents; it was replaced with startup-marker assertions. A subsequent fixture
  failure was an undiscovered custom provider in side; moving that fixture to the
  isolated agent resource directory exercised the unchanged side loading policy.
- Actual installed stdio MCP initialized through its normal transport, launched a
  detached TERM-resistant fixture descendant, and stopped writing after managed
  shutdown. A durable child-workspace marker probe refused patch capture,
  integration, preview and removal; after the fixture simulated successful cleanup
  by clearing the marker, capture included its simulated late shutdown write. A synchronous nested resource
  refusal produced a terminal failed spawn and did not strand shutdown.
- A real HostOwner SIGKILL with active main Pi, Bash, side and spawn passed explicit
  reconciliation and resume with no side/spawn replay. An earlier version relying
  only on sampling missed freshly launched RPC Bash before reparenting; that scratch
  writer was explicitly stopped, and bundled Bash was changed to durable prelaunch
  registration. The corrected crash and clean-shutdown runs passed; unknown escaped
  grandchildren remain an accepted, separately demonstrated limitation.
- A production supervisor probe with TERM-resistant nested work passed: ancestor
  escalation preserved registered child supervisors until terminal publication.
- Actual owner SIGKILL, live-owner/racing-open refusal, exact claim-evidence
  publication SIGKILL and post-catalog-commit SIGKILL passed restart-safe explicit
  reconciliation. Host/session IDs, fingerprint, original recovery text and accepted
  queue text survived; receipts became uncertain and queue items failed, not replayed.
  A transient registry-open lock failure found during reruns was corrected by setting
  the connection busy timeout before schema inspection; corrected reruns passed.

Final production reruns passed all probe groups after the last relevant code edits.
Independent follow-up reviews found no Critical/Important blocker in the corrected
ownership/finalization/effect slice, resource lookup fencing or registered Bash delta.
Reviewers inspected source and checks; parent-run runtime evidence was not independently
reproduced where reviewer process-table access was denied. Helper-only SQLite warnings
are suppressed without changing workload environment; ordinary extension imports load
SQLite lazily. The current stopping point and limitations are in the handoff.

### Explicit limits / Linux continuation

Linux and Node 22.19 have not run this retry. No claim of full descendant cleanup,
privileged or adversarial PID identity, external-service cancellation, physical power
loss/full-filesystem behavior, or end-to-end service attachment is made. Linux SRT
0.0.77 uses separate session/PID namespaces, optional nested seccomp helpers and
host-side bridges: source inspection is not runtime acceptance. Before platform
acceptance, repeat the owner-death/prelaunch/nested-escalation/recovery-cutpoint and
side/spawn/MCP probes on Linux with actual bundled sandbox commands; include both
normal and unrestricted approved shell paths, surviving monitor/bridge reporting,
process-table permission failure and namespace/group changes. Unknown escapes should
show the documented limitation; known unresolved work must continue to block.

## Runtime baseline

- Installed Pi **1.3.0** requires Node **>=22.19.0**. Both installers now reject
  older Node before staging or changing an installation. README uses that floor.
- Initial probes ran on **macOS 27.0.1, arm64, Node 26.12.0, npm 11.20.0**, against
  repository baseline `e98255beba97efbe0e4a5a0fb7532ff022547d54`.
  Those initial probes did not execute Node 22.19 or Linux. B1 below now includes
  actual Node 22.19.0 execution on macOS; Linux remains unavailable.
- Pi 1.3.0 is the baseline for adapter work, not a promise that all server-mode
  acceptance checks pass. Raw RPC limitations are handled inside pi-console;
  this migration does not require a patched Pi distribution.
- Keep one RPC CLI subprocess per live top-level conversation. Existing extension
  access, workspace, side, sandbox and subagent state includes process-global
  slots; do not put multiple conversations in one extension-loaded runtime.
- Preserve execution-host provider/settings discovery. New channel-specific
  session/workspace roots do not require copying provider credentials or changing
  the user's agent directory.

Installed RPC/commands/UI, JSON event, message/session format, extension/SDK, CLI,
configuration and provider documentation, examples, declarations and implementation
were inspected. Runtime evidence takes precedence over an example's suggestions.

## B1 SQLite evidence (2026-10-20)

**B1 shared-storage fence blocker repaired and reviewed; stopped before B2.** Current
storage contracts are in `server/README.md` → **SQLite storage (B1)**. The later
pre-SQLite reports are historical: their schema-1 JSON implementation, 1,024-ID /
32-MiB receipt ceiling and unexecuted Node-floor statements are superseded here,
not claims about the current SQLite ledger. Existing owner/RPC/control/queue and
uncertain-outcome behavior remains in place; no frontend, transport or command
family was added.

### Shared-storage execution-fence repair

A subsequent review reproduced an Important/blocking gap: accepted writes in one
session could reach Pi after another session fenced the shared catalog. The repair
adds synchronous `SessionCatalog.assertExecutionAllowed()` authority, required
`PiProcess` checks before spawn and at actual writes (including after callbacks),
and one-shot failure propagation outside transactions to stop all owned sessions.
Edit pauses clear without database reads; control revokes; diagnostics remain
readable where possible. Failure remains latched after SQLite becomes writable.
Claims/recovery data are retained; `storage_pressure` remains a nonfatal refusal.
No schema/dependency change, broader commands, transport or B2 implementation.

Fresh checks on **macOS 27.0.1 arm64 / Node 26.12.0**, using scratch probes outside
the repository (removed afterward):

```sh
npm ci --offline --ignore-scripts --prefix server
npm run check --prefix server
npm run build --prefix server
# Scratch names below are evidence descriptions, not shipped commands:
node probe.mjs baseline prompt  # Before editing: reproduced actual stdin escape
node probe.mjs fixed prompt
node probe.mjs fixed reply
node probe.mjs fixed rename
node boundaries.mjs
node starting.mjs
node real-pi.mjs
node recovery.mjs
git diff --check
```

- Three two-session regressions held the target serialized-write chain, reserved
  prompt/reply/rename, caused an actual SQLite write refusal using `query_only`,
  restored SQLite writability, then released the chain. No target record reached
  stdin; all workers stopped and grants revoked. Receipts, accepted queue/recovery
  text and open ownership/claim remained; replacement/create/resume refused.
- Adapter-only probes with no shutdown observer proved that the pipe barrier
  independently blocked prompt/reply delivery and another spawn. A blocked reply
  was not reserved. Injecting failure from `onDispatch` exercised the final check.
  Startup faults before spawn and during a pending `get_state` prevented later
  initialization mutations/replacement. Rename probes held the actual prompt
  after successful command discovery.
- Persistent injected queue-read failure with an edit reservation, engine
  `SQLITE_FULL` via page limits, and an injected checkpoint failure after commit
  all retired both sessions and retained ownership. A low-space `statfs` fixture
  returned `storage_pressure` without reserving the ID or fencing workers; the
  same ID dispatched after space was restored.
- Unchanged **Pi 1.3.0**, copied bundled extensions, isolated home/agent state and
  notifications disabled passed startup/trust replies, rename correlation/dedup,
  takeover/stale token and idle abort. A prompt used the missing-credential
  negative path, not a successful provider turn. A cross-session storage fault
  stopped both workers with deferred rename unapplied and prior name/text/claim
  retained; replacement refused.
- Synthetic and unchanged-Pi clean reopen/explicit resume preserved host/session
  identity, Pi header, original/edited recovery text and failed queue state. No
  prompt replay or control reacquisition occurred; old-epoch execution rejected.
- Independent review found no remaining Critical/Important issue in this repair.

**Limits:** Node 22/Linux were not rerun for the repair. `query_only` is a real
SQLite refusal, page limits exercise engine full, and read/checkpoint faults are
injected; none establishes physical power-loss/I/O or full-filesystem behavior.
The earlier floor/migration/large-ledger/provider evidence below is historical.
Complete descendant cleanup, owner-death reconciliation and attachment remain
B2/B3. Losing the catalog never proves it is safe to remove claims or resume.

### Driver and delivery (original B1 evidence)

On **macOS 27.0.1 arm64**, actual **Node 22.19.0** (official darwin-arm64 binary)
and **Node 26.12.0** executed the built-in `node:sqlite` driver, strict build and
unchanged installed **Pi 1.3.0**. The floor emits SQLite's experimental warning;
no driver dependency, Node-floor increase or installed-Pi change was needed.
Compiled server imports were inspected: only Node built-ins and local modules.
The locked server dependency install used `npm ci --offline`.

Commands used (temporary scripts lived outside the repository and were removed):

```sh
cd server
npm ci --offline
npm run check
npm run build
# Also ran both TypeScript invocations directly with the Node 22.19 binary.
# Scratch probe names; B1_REPO pointed at the active task workspace:
node storage.mjs
node faults.mjs
node --expose-gc bounds.mjs
node real-pi.mjs
node maintenance.mjs
# Repeated faults/bounds/real-pi/maintenance with Node 22.19.0; child PATH selected that
# same runtime via B1_NODE_BIN. The 6,166-command storage probe also ran there.
```

Both versions opened the checked WAL/FULL/fullfsync/checkpoint_fullfsync settings
(SQLite **3.50.4** in Node 22, **3.54.0** in Node 26).
Foreign keys are on; busy timeout zero; automatic checkpoints off; page cache
4 MiB. Periodic PASSIVE checkpoints use 128 commits / approximately 8 MiB of
charged writes; clean close uses nonbusy TRUNCATE. This is synchronous SQLite
with explicit event-loop yields, **not** off-thread or guaranteed nonblocking I/O.

### Preservation and failure checks

- Fresh/create/reopen preserved host/session/Pi identity and names, indexed
  fingerprints/outcomes, original/edited/abort-cleared text and managed Pi headers.
  Eight simultaneous fresh opens produced exactly one owner; an existing claim
  was never removed. Private database/WAL/SHM/guard/claim modes were checked.
- Normal schema-1 conversion preserved exact source bytes in an atomic private
  source copy, queue ordering and failed-item revisions. Unfinished queue items
  changed to failed with one revision increment; unresolved receipts became
  uncertain on permitted reopen. Pi JSONL bytes were unchanged and never used as
  proof that receipt recovery text could be deleted.
- Unknown newer JSON and SQLite schemas, unresolved legacy ownership and a
  ready activation whose database was missing refused without replacing the
  source/database. SQLite version inspection precedes writable opening/PRAGMAs.
  An unresolved current SQLite open row also refused before writable opening,
  preserving the database hash after fixture-only claim reconciliation.
- Offline backup/restore passed on both runtimes: cleanly close, privately copy
  the entire profile, archive the original offline, restore the copy to its
  original location, and reopen. Identities/recovery/Pi header and closed database
  hash matched. A group/world-readable database refused without changing its hash;
  EXPLAIN confirmed indexed epoch/ID lookup.
- Subprocess exits were injected before/after source publication, after the
  activation guard, inside the import transaction, after its commit and after
  ready activation. Each retained its claim. Once those fixture children were
  reaped and confirmed to have spawned no workers, **fixture-only** claim
  reconciliation allowed continuation with one imported identity/receipt set.
  A schema-2 guard blocks the old schema-1 reader; the retained source is never a
  writable fallback. This is not a shipped stale-lock recovery procedure.
- Queue-budget refusal rolled back queue and reservation together. SQLite trigger
  failures tested queue replacement/receipt insertion rollback and rename
  metadata/outcome rollback. Faults after successful COMMIT but before returning
  its acknowledgment preserved both committed changes and fenced future writes.
  Reopen observed terminal committed outcomes or unresolved-as-uncertain, never
  automatic dispatch/replay.
- Actual SQLite engine `SQLITE_FULL` was produced with `max_page_count`, not by
  filling the host filesystem. It rolled back admission/queue changes, fenced
  later mutation and retained the claim. Injected checkpoint exceptions after
  committed admission likewise retained an uncertain durable acceptance.
- Injected filesystem free-space readings at 56 MiB refused ordinary prompt
  admission while permitting abort/takeover/approval outcomes; zero available
  space refused even control admission explicitly. The live policy is twice
  outstanding/new reservation bytes plus 64-MiB ordinary or 16-MiB essential
  headroom, not physical preallocation. It imposes no historical-count limit.
- A read failure while a mutation awaited its event-loop yield no longer allowed
  that mutation to commit: failure is checked again after yields and at transaction
  entry. Large recent snapshots now fetch compact metadata/blob sizes first and
  hydrate at most 2 MiB of recovery JSON. Full diagnostic lookup retains all text.

### Scale, memory and responsiveness

A **6,166-command** floor-runtime storage probe retained the first ID, rejected
reuse, and admitted abort/takeover/approval operations after historical growth.
Database plus WAL reached 47,700,120 bytes; clean DB was 46,624,768 bytes for its
6,000 small / 160 quarter-MiB text records plus other outcomes. Receipt count did
not hydrate the ledger or grow snapshots beyond their count/byte budgets.

A separate probe on **both runtimes** completed 8,000 small commands, 160 one-MiB
text receipts and one 16-MiB abort recovery result. A synthetic child continuously
emitted JSONL while timers ran through synchronous writes/checkpoints:

| Measurement | Node 26.12.0 | Node 22.19.0 |
| --- | ---: | ---: |
| Elapsed | 46.3 s | 53.8 s |
| Forced-GC heap at 2,000 / 8,000 small commands | 5.62 / 5.59 MiB | 4.98 / 5.11 MiB |
| RSS at those points | 25.16 / 29.67 MiB | 61.08 / 61.66 MiB |
| Maximum 5-ms timer gap | 87.8 ms | 128.4 ms |
| JSONL frames consumed | 8,179 | 9,517 |
| Maximum reader callback gap | 177.0 ms | 393.0 ms |
| Closed database | 189,456,384 bytes | 189,456,384 bytes |
| Recent snapshot JSON / recovery markers | 1,077,940 bytes / 127 | 1,077,940 bytes / 127 |

A full status lookup still returned the complete 16-MiB abort payload. Snapshot
hydration increased measured JS heap by about 2.11 MiB, independent of historical
receipt count. These are selected process measurements, not an RSS hard ceiling,
disk-space bound, latency SLA or physical durability test. History is retained on
disk without automatic cleanup. Larger/slower storage can pause output/leases;
no claim of nonblocking SQLite is made.

### Fresh real-Pi regression checks

Both Node versions ran **1,807 owner commands** with unchanged Pi 1.3.0 and copied
bundled extensions, isolated HOME/agent/project/profile state and notifications
disabled. A scratch-only offline faux provider and managed confirmation exercised:

- Real bundled trust/workspace startup and managed runtime readiness.
- 1,500 takeovers, then an early-ID retry without recreating its grant and a
  changed-payload conflict. Subsequent approval, queue and idle-abort admission
  remained usable.
- Correlated explicit rename normalization plus effective catalog/Pi name;
  two actual turns with a second queued prompt edited by exact revision while
  the first streamed; accepted original/edited recovery receipts after reopen.
- Approval response delivered once through the existing control/RPC flow;
  300 further takeovers while stream events and checkpoints continued.
- Clean stop/reopen preserved identities/name and did not start a worker;
  explicit resume hydrated history without queue replay. An old terminal
  diagnostic was removed in the fixture: lookup returned unknown and its old
  envelope still rejected as stale epoch before execution.

Sustained writes delivered 1,063 owner updates; the maximum gap in a 20-ms
heartbeat probe was **32.5 ms (Node 26)** / **37.0 ms (Node 22)**. These checks did
not rerun every earlier retry/compaction, active native-clear abort, sandbox,
subagent or third-party-dialog scenario. No external provider was contacted.

### Remaining limits and Linux B1 checklist

No Linux execution, physical power-loss test, whole-filesystem exhaustion,
slow/network filesystem exercise or long-duration mixed workload was available.
Online backup/restore is not implemented or verified. Offline backup requires a
cleanly closed whole profile in a private destination; never launch a backup as
a second owner of the same identity. WAL-only/main-file-only copying is not a
supported live backup. Claims/descendants still require B2 reconciliation, and
no administrative service shutdown path or frontend attachment was added.

On a **Linux local filesystem** (not a shared live profile), with scratch-only
state and unchanged Pi 1.3.0:

1. Run `npm ci`, strict check and build under Node **22.19.0**, then the current
   supported Node. Verify built-in SQLite opens without extra flags, WAL/FULL /
   fullfsync PRAGMAs read back as required, and all storage artifacts are private.
2. Race eight fresh profile opens; create/save/reopen; convert a schema-1 fixture
   with completed/unresolved receipts, original/edited/abort-cleared recovery and
   ordered/revisioned queued/failed items. Compare exact Pi/source-copy bytes and
   identities. Repeat offline whole-profile backup/restore; never run both copies.
   Refuse newer JSON/SQLite versions, public storage modes and unresolved claims/open rows.
3. Interrupt before/after source publication, guard activation, import COMMIT and
   ready activation. Reap only those fixture processes, prove no worker was ever
   launched, then explicitly reconcile only their fixture claims. Verify one
   authoritative database, no duplicate import and no ready-profile JSON fallback.
4. Complete more than 6,000 commands in one epoch; retry/conflict the first ID and
   admit abort/takeover/approval responses. Check indexed lookup/query plans,
   128-receipt/2-MiB hydration bounds and full large-payload lookup after reopen.
5. Inject trigger rollback, post-COMMIT acknowledgment loss and checkpoint failure;
   induce engine SQLITE_FULL with page limits. On a disposable capacity-limited
   filesystem also test real ENOSPC/checkpoint failure. Confirm no dispatch after
   failed admission, fenced later writes and retained claims; never unlink a real
   owner's lock to make the probe pass.
6. Inject soft free-space pressure around ordinary/essential thresholds, including
   pending abort reservations. Measure DB/WAL growth, forced-GC heap and continuous
   child JSONL / lease heartbeat latency during large writes/checkpoints. Record
   storage type and hardware; do not transfer macOS timing claims to Linux.
7. With isolated offline provider state and bundled extensions, repeat startup,
   approval, queue/edit, rename, clean stop/reopen and explicit resume. Keep old
   epoch rejection after deleting an eligible fixture diagnostic; verify no
   automatic prompt/approval/tool replay. Revalidate B2 descendant ownership
   separately before declaring any crash recovery operational.

## Initial macOS probe results

Temporary probes used isolated HOME/agent/config/state/project directories and a
deterministic offline provider **inside a real Pi RPC child**. They used no model
credentials, external network, Neovim or tmux. Watchdogs preceded initialization;
failures exited nonzero; owned children and scratch files were cleaned up.

Commands under the temporary `pi-server-gate-a.*` directory were:

```sh
node probe.mjs
node probe.mjs bundled
node shutdown.mjs eof
node shutdown.mjs sigterm
node check-installers.mjs
```

The bundled run used a scratch copy of `pi/`, with sandbox-runtime 0.0.77 and yaml
2.9.0 copied from the existing installation. This was **not** a fresh-install
check: scratch `npm ci --prefix ...` failed lock validation with npm 11.20.0;
running from the package directory passed validation but lacked offline cached
downloads. No lockfile was changed to bypass either result.

| Check | Observation |
| --- | --- |
| Initialization | `get_state` returns the requested `--session-id` and session filename before the first prompt; the file need not exist yet. |
| Bundled startup | `get_commands`, `/pi-trust-setup`, `/pi-workspace-publish` succeed in a project without trust-gated resources. Full trust-choice/restart is not covered. |
| Approval with no frontend | Fixture and bundled access approvals wait without settling until an explicit answer. |
| Streaming | Tool partial results and text deltas arrive through `agent_settled`; final text matches assembled Unicode/emoji/U+2028/U+2029 deltas. |
| Partial state | `get_messages` excludes the pending assistant message. The adapter must continuously materialize streaming output. |
| Dialog reply | No normal RPC acknowledgment follows an answer. |
| Timeout/abort | Native timeout and supplied signal resolve false internally without a raw closure event; late answers are ignored. |
| Bash/history | Bash output streams before its final response; `get_entries` returns finalized history. |
| cwd transition | Extension `cwdOverride` changes effective cwd while preserving session ID/file. |
| Direct new-session | Raw `new_session` produces two fixture startup records, confirming duplicate startup dispatch. |
| EOF/shutdown | Idle EOF invokes `session_shutdown` and exits 0, also with bundled extensions. Active direct bash exits on EOF (0) and SIGTERM (143); its shell leader is gone. This does not prove full descendant cleanup. |
| Installers | Both pass `bash -n`; exact Node predicates reject 20.11/22.18 and accept 22.19/22.20/23/24/26. Rejecting Node stubs make both entrypoints fail before staging/install writes. These are predicate checks, not execution on each Node version. |

Real-provider retries/compaction, full workspaces/review, side/spawn teardown,
service-crash reconciliation, network/TLS/auth, multi-view state and Linux remain
unverified by these initial probes.

## Repo-local handling of raw RPC limitations

The earlier report incorrectly prescribed changes to Pi source. The approach is
to keep the installed RPC subprocess unchanged and add only the metadata
pi-console needs in its own bundled extensions and service adapter.

### Dialog lifetime

Raw RPC removes timed-out/aborted callbacks without publishing closure. Neither
session files nor `agent_settled` establishes liveness for idle command dialogs
or side work. This does not require changing Pi.

Bundled dialogs now use `shared/service-ui.ts`. It is inactive unless
`PI_CONSOLE_SERVICE=1` and the context is RPC. Ordinary Neovim/Pi TUI launches
retain their previous behavior. The helper returns a wrapped UI object; it does
not replace or mutate Pi's UI context.

- Managed dialog titles carry a `serviceDialog` UUID, runtime UUID and optional
  original deadline. Existing title/preview fields remain intact. The adapter can
  associate the tag with the raw RPC request ID.
- A `pi-console-dialog` status closes that tag exactly once when its promise
  resolves/rejects, its signal aborts or its runtime ends. Consume these records
  continuously, not from session files. Reconnect must not recreate dialogs.
- Runtime invalidation also retires an editor wait. The adapter must then cancel
  its matching raw callback when necessary, since Pi's editor API has no signal.
  This cleans up an already-invalidated request; frontend detach must not trigger
  cancellation or an answer.
- Native Pi timeouts remain authoritative. A resolved confirmation may be false
  because of user choice, cancellation or timeout; closure does not claim to
  distinguish causes Pi does not expose.

Every bundled select/confirm/input/editor call uses this helper. Arbitrary
third-party extensions calling raw `ctx.ui` directly are not instrumented; do not
claim verified retained-lifetime support for those dialogs. Their handling remains
an adapter audit item.

### Runtime identity

`pi/extensions/service.ts` emits `pi-console-runtime` started/stopped status with
an opaque runtime UUID, effective cwd and Pi session identity. Rebinding the same
active session manager keeps the same UUID and emits no second start. Shutdown
invalidates its managed waits before publishing stopped. The service translates
that identity into its runtime revision; filename equality is not a runtime fence.

Do not patch Pi's duplicate raw new/switch/fork/clone binding. New conversations
will be separate owned children; existing bundled navigation commands already use
Pi's command-context APIs. Retain the narrow `cwdOverride` cast in
`shared/workspace-navigation.ts`: the probe demonstrated it works without changing
installed declarations. Runtime creation can fail after old-runtime teardown;
the adapter must not then pretend the old context remains usable.

### Side and subagents

Managed side children load the same repo-local lifecycle extension. The relay
matches child dialog tags to per-request abort controllers. A child closure retires
its parent relay, without restarting the child's timeout; generation abort still
invalidates all relays. Unmanaged side conversations retain their previous timeout
behavior. Spawned subagents remain noninteractive and decline unexpected UI;
transcript requests must never become actionable approvals on attachment.

## Verification of the repo-local lifecycle slice

Temporary `pi-service-ui.*` probes ran against unchanged installed Pi 1.3.0 on
this Mac. They used isolated state, an offline provider fixture and a scratch copy
of this checkout's extensions, with watchdogs before subprocess startup:

```sh
node rpc.mjs managed
node rpc.mjs legacy
node rpc.mjs bundled
node rpc.mjs approval
node rpc.mjs side
node typecheck.mjs
```

- All four dialog methods preserve content and produce one terminal record in
  managed RPC mode. With service mode off they retain the original titles and
  emit no lifecycle records. A pending confirmation remains open without a view.
  A separate real bundled access-mode tool approval also remains pending until
  explicitly answered and closes its tracked tag once.
- Native timeout and signal abort close the matching tag; late answers produce no
  duplicate closure. Runtime replacement retires simultaneous confirm/editor
  waits, emits a new runtime identity once despite duplicate native binding, and
  allows orderly EOF shutdown. The probe explicitly cancels the retired raw
  editor callback, as the future adapter must do.
- The real bundled parent side extension was exercised against a synthetic child
  RPC process. Child closure retires the parent relay and removes its pending
  dialog ID; the original deadline is preserved and no parent timeout is started.
  This is not a full model-driven side/subagent acceptance check.
- Strict TypeScript 5.9.3 checks pass for both new lifecycle modules against the
  installed Pi declarations and Node 22.19.19 types. The whole extension tree has
  the same 23 strict diagnostics as its unmodified baseline (trust/workspace/spawn),
  with no new diagnostics. These unrelated existing errors were not changed.

That lifecycle-only slice did not implement or verify the subprocess adapter.
Temporary probes are not part of the shipped code.

## Private subprocess adapter slice

`server/` now builds a private Node/TypeScript adapter around the unchanged Pi CLI.
Its lockfile pins development tools and Pi's RPC types; built code has no runtime
package dependencies. It is not yet a daemon, application API or frontend transport.
The RPC-ready check does not perform owner-side trust/workspace initialization.

The adapter continuously reads strict LF JSONL with fatal streaming UTF-8 decoding,
correlates responses, serializes writes with backpressure, and consumes the managed
runtime/dialog records above. It reserves an answer before dispatch and retires
invalidated raw editor callbacks; this closes the previously deferred adapter side
of bundled dialog tracking. It does not implement control leases or command receipts.

Resource limits: 16 MiB per record, 128 outstanding commands, 128 queued writes /
32 MiB of queued data, 256 pending dialogs / 32 MiB of retained dialog data, and an
8,192-character stderr tail. Stop requests EOF, then TERM at 2 seconds and KILL at
5 seconds. Final output is drained after exit; a further 5-second pipe grace period
bounds inherited-descriptor hangs, reporting possible surviving descendants rather
than claiming whole-tree cleanup.

Fresh macOS evidence, using temporary `pi-adapter.*` probes:

- `npm ci --offline --ignore-scripts --no-audit --no-fund`, `npm run check`, and
  `npm run build` validate the locked build. A separate production copy installed
  with `npm ci --omit=dev` loads the built adapter with no development dependencies.
  The Pi dependency is for types only.
- `node real.mjs` exercises an actual Pi 1.3.0 child with an isolated offline
  provider: startup/runtime metadata, explicitly invoked bundled trust/workspace
  setup, stripped frontend/tmux/child-role environment, unattended access approval,
  independent reads, stale/duplicate reply rejection, snapshot copy isolation,
  Unicode streaming, native command failure, confirm/editor abort, runtime clone
  replacement and orderly exit. The parent adapter consumes closure records and
  performs raw editor cleanup. No provider credentials or network were used.
- `node faults.mjs` uses synthetic children to check split UTF-8, Unicode line
  separators, CRLF, out-of-order responses, exactly one raw editor cleanup,
  oversize input/output, malformed/truncated records, invalid/truncated UTF-8,
  early stdout EOF, response mismatch/unknown IDs, missing lifecycle integration,
  blocked-pipe queue limits and EOF/TERM-resistant shutdown escalation. Natural
  worker exit also preserves a final 2 MiB event and its correlated response.
- Review found two transport defects: lossy UTF-8 decoding and framed stdout EOF
  leaving pending requests alive. Both were reproduced before correction. A fresh
  regression probe confirms malformed bytes no longer become accepted U+FFFD data,
  and early EOF now rejects pending outcomes and stops the surviving child.

At that adapter-only boundary, conversation materialization, catalog/IPC,
exclusive owner locking, trust restart orchestration, independent startup,
control/receipts and reconnect snapshots were unfinished. The following slices
add the catalog and private owner startup, not the remaining client/service layers. Viewer backpressure and full descendant crash ownership are not
established by private-pipe probes. Those probes did not execute Linux or Node 22.19;
see fresh B1 evidence above for the now-verified macOS Node floor.
Existing frontend launch behavior is unchanged.

## Private catalog slice

`server/src/session-catalog.ts` adds a version-1 catalog for an explicit private
profile root/channel. At the catalog-only boundary it was not wired to an owner;
the next section documents that composition. Default state paths remain unimplemented.
Host/session IDs persist across clean reopen; each owner gets a new epoch. New
sessions receive private, version-3 Pi JSONL headers before any prompt, preserving
identity and a stable filename through future trust-driven child replacement.

A mode-0700 profile and exclusive owner claim serialize writers. Mutations use a
serialized copy/commit queue, atomic replacement, and file/directory fsync requests. Unknown schemas,
wrong channels, malformed identities, symlinks and unresolved live claims are
rejected. PID metadata is diagnostic, never authority to reclaim or kill. Closing
with open sessions is refused. Missing locks do not justify reopening entries still
marked open; crash reconciliation is intentionally unimplemented.

A temporary `node catalog.mjs` macOS probe passed: competing opens; concurrent
creates; persistence and stable/dev identity separation; private modes; copied
metadata; open/close guards; changed claims; unknown schemas/channel mismatch;
failed atomic replacement; session header identity/symlink/hardlink checks; and
owner crash/missing-lock refusal. The unchanged installed Pi also opened a generated
pre-prompt file and returned its exact catalog Pi identity. Headers may change cwd
metadata without becoming a different conversation. No catalog data is auto-adopted
from legacy files, and a failed create can leave an unregistered empty file rather
than risk deleting history.

A separate `node faults.mjs` probe passed four additional checks: non-string states
cannot bypass live-ownership guards; failed initialization cleanup closes its handle
while retaining an unproven claim and original error; post-rename directory-sync
failure retains committed metadata and fences further writes; and post-unlink sync
failure cannot reopen the old writer. Directory sync operations succeeded on this
Mac. Actual power-loss durability and Linux behavior were not tested.

The catalog-only probes did not execute owner-side orchestration. The subsequent
owner slice below adds create/resume/startup; crash recovery remains unimplemented.

## Private host-owner startup slice

`server/src/host-owner.ts` composes the catalog and adapter once per explicit
host/profile. It is still not an independently running service or frontend API.
Create/resume returns an initializing handle before trust can block; simultaneous
resume calls share that handle. Lookup/list/snapshot do not start workers or rerun
setup. The owner validates the managed file and commits its open claim before spawn.

Startup follows `get_state`, extension-command discovery, `/pi-trust-setup` and
its retained `pi-project-trust` result, then `/pi-workspace-publish`. It checks
status identity/cwd and waits for `transitionPending` to clear. Workspace restoration
can replace the cwd-bound runtime within one child; startup repeats for the fresh
context, bounded to eight passes. A trust-driven process restart is bounded to one
replacement and waits for clean old-child exit before reopening the exact same
catalog file/identity. Conversation-only trust therefore survives replacement.

The owner carries its session revision across runtime/process replacement and
explicit resume within an epoch, rather than exposing the adapter's resetting
counter as session authority. Pending interactions remain inspectable/answerable
during initialization; stale revisions are rejected. `assertReady()` gates future
queue dispatch, but no user-prompt dispatcher, leases, receipts or client protocol
is implemented. At that startup-only boundary snapshots contained metadata and
interactions; the following materialization slice adds conversation state and ordering.

Explicit low-level stop awaits direct-child completion before recording saved or
interrupted state. Unexpected exit/startup failures become interrupted; failures
before an open claim do not rewrite a saved record. Failed open commits are not
blindly undone. Failed exit persistence retains ownership. The adapter now marks
known unresolved inherited pipes in its exit result; that also retains the claim
and blocks replacement, instead of merely recording an interrupted session while
a descendant may remain alive. This does not establish whole-tree cleanup when
all descriptors close, or service-death recovery. No stale lock/PID is reclaimed.

Fresh temporary macOS probes used Node 26.12.0, unchanged installed Pi 1.3.0,
isolated HOME/agent/profile/project roots and a scratch copy of this checkout's
bundled integration. The scratch package reused installed extension dependencies;
this was not a fresh Pi-package installation check. No credentials, provider calls,
Neovim, tmux or external network were used. Watchdogs preceded initialization.

```sh
cd server
npm ci --offline --ignore-scripts --no-audit --no-fund
npm run check
npm run build
# Temporary pi-owner.* scripts outside the repository:
node synthetic.mjs
node ownership-faults.mjs
node held-pipes.mjs
node real.mjs
```

- Strict server check/build passed. A scratch production copy installed with
  `npm ci --omit=dev --offline --ignore-scripts --no-audit --no-fund` imports the
  compiled owner without development dependencies.
- Synthetic checks passed: 50 simultaneous resumes produce one handle/child;
  early initializing identity/readiness gate; copied snapshots and pure repeated
  lookup; stop/resume and persisted host/session IDs across clean owner reopen;
  unattended approvals and stale replies; same-file awaited trust replacement;
  same-child workspace/cwd replacement with repeat initialization; missing/error
  setup results, bounded repeated restarts, unexpected exit, stop during approval,
  abnormal shutdown and invalid-header refusal.
- Ownership faults passed: failed open persistence never launches a child; failed
  spawn records interruption with no child; failed exit persistence retains an
  open claim and refuses replacement/another owner. A descendant holding inherited
  pipes reproduces uncertainty after the direct child exits; the corrected owner
  retains that claim and rejects replacement. The fixture descendant exits itself.
- Real Pi checks passed: no-resource startup and resume; pending conversation-only
  denial/trust with no frontend; no project-resource loading before a choice;
  denial needs no replacement, trust replaces the process after shutdown; exact
  managed file/identity and conversation decision survive clean owner reopen without
  another dialog. A seeded real managed task workspace restores through the bundled
  workspace command into its worktree within the same Pi child; readiness waits for
  completion, revision advances and another explicit resume restores it again.
- A stale old-child exit flag initially blocked trust replacement; the synthetic
  reproduction failed before correction and passed afterward. An independent
  readonly review found no concrete remaining owner-startup findings. No permanent
  tests are shipped; temporary fixtures were removed after final checks.
- Process inspection found detached host `alerter` processes from earlier scratch
  trust probes, launched by the existing bundled notification behavior. Only those
  probe-path-qualified notifiers were terminated. Final real-Pi probes suppressed
  notification delivery in the scratch fixture and supplied an inert `ALERTER`.
  Host-side notification migration remains unfinished; this owner slice does not
  establish headless notification behavior.

This is component evidence, not completion of migration gates B/C. Independent
startup/IPC/bridge/frontend switching, application commands/control/receipts/shared
queue, full history/artifact pagination, managed descendant cleanup, recovery and
dev build-change policy remained unfinished at that slice. Linux and physical
power-loss behavior remain unverified. Those probes did not execute Node 22.19;
the B1 checks above now do.

## Continuous materialization and private subscriptions

The owner constructs `PiConversation` before spawning Pi and consumes records even
with zero viewers. It retains assistant text/thinking and raw argument fragments,
then replaces blocks/messages with authoritative ends. Tool updates replace their
previous partial result, preserving structured details and nested parent IDs. Direct
bash is tracked from dispatch through deltas and its correlated final response;
Pi does not emit a final bash message event. Native queue/retry/compaction state
and recent prompt/bash acceptance/rejection/uncertain metadata are retained too.
Transport command IDs are unique across children; they are not frontend command IDs
or the future durable receipt/deduplication contract.

`get_messages` is a current-context projection, not full raw history. Initial and
idle reconciliation applies synchronously at the matching response's stdout position
before resolving its promise. Worker identity, owner runtime revision and an event
version fence prevent an older response from overwriting later live state. Settlement,
compaction/history invalidation and bash completion coalesce a refresh. Active-run
replacement is avoided: Pi has no atomic active snapshot contract, and state can
be finalized internally before a public message-end handler finishes. A runtime
transition invalidates hydration; startup cannot publish ready without a stable
baseline. Ended partial/tool/work activity is marked interrupted/uncertain rather
than presented as continuing. Runtime end retires current statuses/widgets/title
and native pending queue. Values published during startup binding before its
runtime-start record are not discarded.

Attachment is an owner-internal synchronous operation: `subscribe()` captures a
copied `snapshot` with a sequence watermark and registers a pull stream before
returning. `next()` delivers consecutive newer updates with session ID, service
epoch and owner runtime revision. There is no replay buffer/cursor. Lookup,
snapshot and subscription do not initialize/restore/stop anything. A closed or
slow subscription cannot answer a dialog, block stdout or stop another viewer.
An explicit resumed handle continues the sequence/revision within the epoch but
requires a fresh subscription; old handle subscriptions are not silently rebound.

Retained extension values are data, including complete `pi-side`/`pi-spawn-runs`
payloads and status clears. Notifications, editor text, `pi-side-response`,
`pi-tree-clone` and `pi-history-changed` are separate live-only effects. Managed
runtime/dialog records update lifetime tracking and are not replayed as frontend
actions. Snapshot rendering must not invoke legacy event handlers for navigation,
notifications, editor mutations or dialog answers. This is not yet a controller-
targeted effect delivery protocol, and no frontend/client endpoint is exposed.

Bounds are explicit: a 512-message / 16-MiB current-context tail with omitted count;
32 MiB conservative live-slot accounting / 2,048 slots; 256 tool slots and 128
recent work records; 1-MiB UTF-8-aligned bash tails with omitted-byte counts, plus
Pi's final result/truncation metadata. Live overflow fails the worker before
retaining the offending value, leaving terminal cleanup possible. Snapshots disclose
`hydrated` and a baseline replacement `historyRevision`; full history/artifact
pagination remains separate unfinished protocol work. Native queue snapshots and
recent work metadata do not implement the editable accepted queue or replay work.
Up to 32 subscriptions each retain at most 256 updates / 8 MiB; overflow frees its
queue, rejects pending/future reads and requires a fresh snapshot. Snapshot data is
bounded separately rather than counted as queued updates.

Fresh macOS/Node 26.12.0 evidence used temporary `pi-materialize.*` fixtures:

```sh
cd server
npm ci
npm run check
npm run build
# Temporary scripts outside the repository:
node reducer.mjs
node owner.mjs
node ordering.mjs
node replacement.mjs
node real.mjs
```

- Strict check/build and a scratch production-only compiled-owner import passed
  without dependency/lockfile changes. Reducer probes
  covered Unicode text/thinking/tool-argument deltas and authoritative replacement,
  nested tools, replacement partial results, native queues, retry/compaction,
  status/widget clears and title/side/spawn retention, copy isolation, effect
  separation, bash tail truncation and message/live bounds.
- A synthetic owner held startup approval while producing partial assistant/tool
  state with no viewer, then attached multiple views. Sequences were consecutive
  after the captured watermark; interleaved stale history was rejected. Detach,
  count/byte-limited slow-view eviction, viewer cap, terminal updates and explicit
  resume watermarks passed without stopping independent work/viewers.
- Focused regression probes covered same-batch `get_state`/settlement ordering,
  idle same-child runtime replacement, interrupted partial reconciliation and
  terminal cleanup after live-budget refusal. Review initially identified lost
  coalesced refreshes and unsafe post-mutation limit checks; both were corrected
  and their reproductions rerun. A separate synthetic trust-driven child replacement
  preserved owner revision/watermarks, unique work IDs and fresh hydration/startup
  values. Final independent readonly review found no consequential findings.
- An unchanged installed Pi 1.3.0 child used an isolated offline provider and
  scratch lifecycle/startup/tool fixture, not a model service or credentials.
  Startup approvals/UI values, streaming assistant/thinking/tool calls, live tool
  partial/final output, attachment mid-stream and final message projection passed.
  Direct bash streamed before completion and reconciled its final history; bash
  completed during an active agent run was reconciled at settlement. EOF stop
  was orderly. This run did not retest every bundled workspace/trust path or
  execute actual side/spawn workers, provider retries or model-driven compaction.

No permanent tests were added. Private reducer/subscription evidence does not
establish frontend transport/control, full history loading, daemon startup,
managed descendant teardown or migration gate completion. Those checks did not
execute Linux or Node 22.19; B1 above now covers macOS Node 22.19.

### Linux owner-component checklist

Before a daemon/client endpoint exists, exercise the private owner directly with
an explicit scratch root/channel and isolated agent/project directories:

1. Record Pi/Node/distro versions; run the locked server install/check/build.
2. Create a session and immediately obtain its initializing identity. Race resumes
   and verify one child. Lookup/list/snapshot must not spawn or rerun setup.
3. Use a project with trust-gated resources. Leave its dialog unanswered, then
   select conversation-only denial/trust. Verify resource-loading behavior, awaited
   replacement for trust, unchanged identity/file and no prompt readiness beforehand.
4. Stop and cleanly reopen the owner; explicitly resume. Confirm host/session IDs
   persist, epoch changes and the conversation-only decision does not prompt again.
5. Resume a managed saved workspace; observe same-child cwd/runtime replacement and
   readiness only after its pending transition clears. Reject old-revision replies.
6. Inject open/exit persistence failure and an inherited-stdio descendant. Verify
   failed open never spawns; unresolved exit ownership retains its claim and refuses
   replacement. Do not remove a lock to force recovery. Check private modes/fsync.
7. Hold an initializing approval while assistant/tool state advances without any
   view; attach two views and compare copied snapshots and consecutive sequences.
   Detach one and overflow a slow stream; work and the other view must continue.
   Reattach during assistant/tool/direct-bash output, including bash finishing in
   an active run. Verify idle reconciliation, no duplicate messages/effects, status
   clears, runtime replacement and original dialog deadlines. Exercise the documented
   message/live/viewer bounds and require a new snapshot after a dropped stream.

## Narrowed private command/control slice

The next requested area was split before implementation: editable accepted queues
remain a separate slice. `server/src/session-commands.ts` now defines a private
version-1 allowlist for control acquire/confirmed takeover/release, interaction
reply/cancel and turn abort. `OwnedSession.command()` is the admission boundary;
there is no public raw interaction-response bypass, prompt API, unrestricted RPC,
network endpoint or frontend transport. Existing Pi and extension source are
unchanged by this slice. `server/README.md` documents the exact operations/API.

Each mutation carries command/session/epoch/runtime/attachment identity and the
current control token where applicable. Authorization and durable ID reservation
precede scheduling. Accepted execution survives takeover/detach, but actual pipe
writes revalidate worker/runtime and interaction liveness. Same-mutation duplicate
IDs resolve receipts without another dispatch or grant side effect; changed
mutations conflict. Attachment/token changes permit reconnect status resolution,
not reacquisition. New commands require current authority. Transport authentication
and caller-to-attachment binding are still future responsibilities.

Grants are ephemeral and opaque. Snapshots/events contain controller label,
attachment and grant ID, never the secret token. Explicit detach/stream eviction,
release, takeover and terminal shutdown revoke grants without responding to UI or
cancelling accepted work. A 5-second heartbeat recommendation / 20-second expiry
uses the service monotonic clock. Heartbeats never acquire or recreate control and
are not durable application commands. Attachment itself stays pure with respect
to Pi startup and execution.

At this historical slice, receipts were optional schema-1 JSON data; B1 above
replaces that storage and its historical ceilings/eviction policy. Catalog IDs,
sessions and history are preserved. Acceptance precedes dispatch; outcomes are
completed/failed/uncertain and status lookup returns explicit unknown when absent.
Interaction completion means flushed, not an RPC acknowledgment. Only mutation
fingerprints, not answer text/grant secrets, are persisted. Current-epoch IDs are
never evicted/re-executable. Capacity is 1,024 records / 32 MiB receipt budget per
profile, with a 17-MiB pending-abort reservation and fixed 4-KiB slots for other
outcomes (completion cannot grow the ledger charge); current-epoch capacity exhaustion
refuses before dispatch. Prior-epoch diagnostics may be evicted and cannot authorize
replay. On a permitted catalog reopen unresolved acceptances become uncertain.
Existing unresolved process claims still block reopen; receipts do not solve crash
ownership. Catalog total is bounded at 64 MiB. The owner admits at most 128 pending
callers, snapshots expose the most recent 128 receipts, and receipt updates use
the existing sequence/backpressure stream. A large recovery update can drop a
viewer; it must resnapshot/query status, not lose text silently.

Abort retains main/side scoping and idle behavior: cancel main dialogs even when
idle, but send no native abort/queue-clear while idle. Active abort clears native
queues first and still attempts abort after a native clearing rejection. Returned
steering/follow-up text is durably checkpointed before abort as recoverable receipt
data, never an automatic editor mutation. Runtime/storage failure prevents later
writes into an unproven context. New main requests during pending abort are
cancelled; side requests keep their underlying operation's lifetime. The legacy
frontend's disposal of all picker windows on aborted settlement is not evidence
that side operations ended. No accepted application queue was introduced/deleted;
its queued/sending/failed, edit reservation and handled-command behavior is next.

Fresh macOS 27.0.1 arm64 / Node 26.12.0 checks used temporary `pi-command-core.*`
fixtures outside the checkout:

```sh
cd server
npm ci --offline --ignore-scripts --no-audit --no-fund
npm run check
npm run build
# Temporary scripts, removed after verification:
node probe.mjs
node faults.mjs
node budget.mjs
node lease.mjs
node real.mjs
```

- Locked offline install, strict check/build and a production-only compiled-owner
  import passed without dependency/lockfile changes.
- Synthetic owner probes exercised 20 concurrent identical replies with one write,
  payload conflicts, unauthorized operations/answers, explicit takeover, stale
  tokens/runtime/epoch, reconnect lookup without reacquisition, and duplicate old
  takeover not stealing a newer grant. Accepted backpressured answers survived
  takeover; runtime replacement rejected the delayed answer before delivery.
- Idle abort cancelled main but not side dialogs and sent no native abort/clear.
  Active abort ordered clear before abort and recovered Unicode steering/follow-up
  text; native clearing rejection still attempted abort. Replacement after a clear
  response retained recovery text but fenced the subsequent abort.
- Receipt diagnostics survived clean owner reopen; catalog-only unresolved
  acceptance reopened as uncertain with recovery text intact. Capacity refused
  rather than forgetting current IDs. Injected pre/post-commit reservation failure
  and post-flush outcome failure fenced the owner with no duplicate delivery.
  These are component fault injections, not physical power-loss or crash-ownership
  recovery checks.
- Review caught an overescaped stored-ID regex, reentrant slow-controller
  eviction fanout and receipt charge growth during completion near capacity.
  Reopen, slow-controller and near-full 32-MiB ledger completion/reopen regression
  probes passed after correction. The fanout probe verified consecutive observer
  sequences while dropping and revoking the slow controller.
- A real unmodified 20-second monotonic lease timer expired; a heartbeat extended
  it beyond its original deadline, and a stale heartbeat could not reacquire it.
- Unchanged installed Pi 1.3.0 ran with isolated HOME/agent/profile/project and
  scratch startup/lifecycle/dialog extensions, no credentials, provider calls or
  network. Unattended initialization, takeover/stale answer rejection, duplicate
  replies, flushed receipts, idle main-only abort, detach, retained side approval
  and orderly EOF shutdown passed. Active abort ordering was synthetic, not a
  real-provider execution. No permanent tests were added.

This command/control-only evidence was not gate B/C completion. The following
slice adds a non-slash editable queue; host-scoped create/resume deduplication,
broader mutations, targeted effects,
independent startup, IPC/HTTPS/auth, frontend integration, descendant recovery,
Linux and physical power-loss durability remain unfinished/unverified. These older
checks did not execute Node 22.19; B1 above now does. On Linux, repeat the above private two-attachment commands,
backpressure/runtime replacement, receipt failures/reopen, full 20-second lease,
and idle/active main/side abort checks before claiming owner-component parity.

## Editable non-slash accepted queue slice

The user approved a narrower boundary before implementation: slash-command safety
is separate. `prompt.submit` and `queue.edit/remove/reserve/release` extend existing
typed admission and receipts, not raw RPC. Text is nonempty, trimmed, at most 1 MiB
UTF-8, and rejected if its first non-whitespace character is `/`. No Pi, frontend,
transport or daemon changes were made. See `server/README.md` for exact payloads.

Queue state is optional per-session `acceptedQueue` in schema 1. Queue mutations
and receipt acceptance are one catalog commit; lost acknowledgments resolve the
same command/item instead of replaying. Items have stable ID, revision, original
order, epoch/runtime target and queued/sending/failed states. Edits/removals require
matching revision, refuse sending/dispatched items, and never overwrite another
save. Editing failed text explicitly requeues in its original position/current
context. Failed items remain visible while later queued work can proceed.
Snapshots/ordered updates expose `acceptedQueue: { items, reservation? }` as data.

A queue-item editor pause lasts 30 seconds on the owner's monotonic clock. Save,
remove, explicit `queue.release`, detach/drop, takeover/release/control expiry and
shutdown release it; heartbeats and duplicate commands do not renew it. Head-item
pauses preserve ordering. The display `expiresAt` is not authority. After expiration
an editor save can fail with queue conflict because dispatch already happened.
Unsent local editor text is not accepted until saved; reservations are not persisted.

Dispatch checks trust/workspace readiness, no compaction/retry/summarization, no
native pending messages, and settled execution. A separate observed-run latch
prevents `get_state.isStreaming: false` during delayed settlement handlers from
opening the gate; `agent_end` is never settlement. One sending item spans asynchronous
input preflight. Handled input hooks retire their item without awaiting a run;
started items retire after an observed user message, or fail uncertain if settled
without one. Pi emits message_end before appending history: submission/edit receipts
therefore retain `result.queueItemText` after handoff, alongside item ID/revision.
Receipt completion means accepted queue mutation, not Pi execution/history durability.
Recovery text never authorizes replay and current-epoch receipts are not evicted.
Prior-epoch diagnostics remain evictable under the existing retention boundary.

Worker/runtime/identity/readiness/execution checks run immediately before the actual
backpressured write. Proven-unsent temporary busy/readiness changes defer, not retry
an uncertain write. `pi-history-changed` advances owner revision even in the same
runtime, fencing observed branch changes. Accepted text survives controller change,
not silent retargeting. Runtime/clean resume/reopen leaves stale unfinished work
failed for review and explicit edit/removal; no automatic replay occurs. Abort retains
accepted application items and existing main/side and native clear-before-abort
boundaries. Native steering/follow-up queues remain separately materialized/cleared;
this slice adds no typed native steering/follow-up submission.

Bounds at this historical slice (receipt/catalog ceilings superseded by B1):
128 accepted items / 8 MiB per profile, charging JSON-escaped text + 4 KiB
metadata/error headroom per item. Capacity refuses before acceptance, never evicts
accepted work. Text-bearing submission/edit receipts charge escaped text + 4 KiB
against the existing 1,024-record / 32-MiB ledger, rather than a fixed 4-KiB slot.
Terminal transitions fit admitted headroom. Catalog remains capped at 64 MiB;
legacy schema-1 records without queue data remain readable. No data is auto-adopted
or deleted, and unresolved ownership still blocks reopening.

Fresh macOS arm64 / Node 26.12.0 / unchanged Pi 1.3.0 verification used temporary
`pi-accepted-queue.*` fixtures outside the repository, with watchdogs installed
before subprocess initialization and cleanup of owned workers:

```sh
cd server
npm ci --offline --ignore-scripts --no-audit --no-fund
npm run check
npm run build
# Temporary probes, not shipped:
node probe.mjs
node faults.mjs
node recovery.mjs
node real.mjs
```

- Synthetic owner checks covered concurrent duplicate submissions, payload conflicts,
  invalid/slash text, queued revision conflicts, sending-edit rejection, original
  order, retained failures/explicit edit retries, handled preflight dialogs and
  uncertain missing-user outcomes. Initial queueing waited for startup readiness.
- Readiness/compaction/retry/native gates, false streaming after agent_end, same-batch
  fast completion, actual deferred write through takeover, runtime replacement before
  write, observed same-runtime history change and copied snapshots passed. A temporary
  white-box stdin gate injected backpressure deterministically; this queue probe did
  not retest physical pipe saturation from the earlier adapter/core probes.
- Main/side dialog scoping, idle/active abort, native steering AND follow-up recovery,
  clear-before-abort, and accepted queue preservation passed. Takeover/detach released
  pauses without deleting accepted work. A real 30-second monotonic pause expired
  while control heartbeat remained alive; explicit release did not revive it.
- Fault probes checked deferred-readiness requeue, fresh runtime-bound trust/workspace
  readiness rather than old same-cwd statuses, binding-time trust publication between
  old-runtime stop and incoming-runtime start, and replacement while awaiting prompt
  acknowledgment/user events. Replaced sending items fail without freezing the queue;
  an old handled acknowledgment cannot clear a newer prompt's preflight latch.
  They also checked no reservation resurrection after detach during fsync,
  sending-checkpoint failure fencing before prompt write, atomic
  queue/receipt capacity refusal, count/byte bounds and metadata recovery headroom.
  Clean stop/reopen preserved failed items/receipts without replay; old queue-less
  schema-1 session data remained readable. Reentrant publication/detach did not
  resurrect a reservation or break its returned ID.
- Review identified the event-before-history-append recovery gap. A synthetic child
  emitted a user event then exited without history persistence: original and edited
  accepted text remained in receipts across clean owner reopen without replay.
  A near-32-MiB text receipt ledger refused more admission but allowed pending outcome
  completion/reopen with its recoverable text intact. This is not physical power-loss
  durability or Pi disk-failure recovery acceptance.
- A real unchanged Pi child used isolated HOME/agent/project/profile and scratch
  lifecycle/startup extensions plus an offline streaming provider (no credentials,
  provider network, Neovim or tmux). Two actual user/assistant turns, duplicate
  suppression, delayed `agent_settled` handlers with false `get_state` streaming,
  handled hooks without runs, input dialog cancellation through takeover and active
  abort preserving accepted queued text passed. A real fixture reload also published
  fresh trust before incoming lifecycle start and workspace afterward; a new queued
  prompt dispatched after identity refresh. This was not full bundled extension,
  real-provider retry/compaction, side/spawn or frontend/service acceptance.

No permanent tests are shipped. Slash invocation and extension-command success/error
policy remain deferred: registered commands can mutate history/workspaces before
ordinary prompt preflight, and `handled` alone is not proof of command success.
Trusted input hooks still run inside Pi; actual write fences cover observed context
changes, not arbitrary unpublished extension activity. Broader operation families,
service transport/auth/daemon, Linux and cross-crash process ownership/power-loss
behavior remain unverified. These historical probes did not execute Node 22.19;
B1 above now does. On Linux repeat these component
probes, including 30-second pause/20-second control timing, fsync failures, deferred
writes and real Pi settlement/abort before claiming parity.

## Typed explicit rename slice

The approved first extension family is only `session.rename` with `{ title }`:
nonempty, <=4,096 UTF-8 bytes, no C0/C1 controls or Unicode line/paragraph separators.
The legacy title helper normalizes/truncates to 80 JavaScript characters; an empty
normalized title fails before mutation and a completed receipt returns the effective
`result.title`. No separate confirmation is needed. Retitle/model calls, blank-title
dialogs, permission/integration settings, history/tree/workspace, side/spawn and
notification commands remain excluded. Freeform slash prompt/edit rejection is intact.

The owner requires current control/epoch/runtime/managed identity, ready trust/
workspace state and settled execution without a sending/preflight item or main dialog.
Busy requests fail before acceptance, not into a second queue. One managed-command
gate blocks application queue dispatch until the terminal outcome is persisted.
Accepted rename survives takeover/detach; actual backpressured writes recheck worker,
runtime, identity, readiness and execution. Exact command/source discovery refuses
missing/colliding registrations without slash fallthrough. The managed fixed command
exists only in opt-in service mode and validates the active runtime/session/file
before synchronous mutation; it is not an arbitrary prompt/RPC forwarding interface.

Installed Pi catches extension-command exceptions, emits uncorrelated
`extension_error` with `command:<name>`, and still replies `handled`. Early warning
returns and consumed input hooks also reply `handled`; a missing command falls through
to normal input. Fresh investigation probes confirmed all four paths, duplicate
registration suffixes, and a mutation surviving a later exception. Therefore the
owner additionally requires one private version-1 invocation/runtime/session/file-
correlated terminal result at its stdout position. Results/envelopes never enter
conversation work/status/effect streams. Failed means proven-unsent or pre-mutation
refusal. Partial mutation, missing/malformed/duplicate/mismatched results, delivery
loss or replacement are uncertain and fence/stop the worker; no automatic replay.
Unrelated extension errors keep their conservative owner policy.

Completed effective title and receipt commit together in the existing optional
schema-1 command catalog. Existing records/legacy data are preserved. Metadata
append does not advance conversational runtime revision. Pi history and catalog are
not one transaction, and observed completion is not a power-loss durability claim.
Storage failure fences dispatch/ownership as before. Accepted prompt/edit
`queueItemText` remains recoverable after queue retirement or owner reopen.

Rename adds only retained title/name/label data, no actionable editor/navigation
effects. Other families remain blocked pending their own authority/confirmation,
correlation and effect-recipient design. Runtime/history/workspace changes must gate
transitions and fail old-target queued work, not silently retarget it. Future editor/
navigation actions must be tied to the initiating attachment/grant/context, never
broadcast, replayed on reconnect or substituted for a nonempty local draft.

Fresh macOS 27.0.1 arm64 / Node 26.12.0 evidence against unchanged Pi 1.3.0 used
isolated scratch state and temporary `pi-rename-slice.*` fixtures:

```sh
cd server
npm ci --offline --ignore-scripts --no-audit --no-fund
npm run check
npm run build
# Temporary probes outside the repository, removed after verification:
node synthetic.mjs
node faults.mjs
node real.mjs
node typecheck.mjs
```

- Strict server check/build passed; targeted strict extension checks against the
  installed declarations reported zero diagnostics for both baseline and changed
  title/lifecycle modules. A scratch compiled-owner import without a dependency
  tree passed. The install emitted npm's existing `node-domexception` deprecation
  warning; dependencies/lockfiles were not changed.
- Synthetic checks passed: typed field/text bounds and slash rejection; 20 duplicate
  requests/one execution, changed-payload conflict, private result isolation,
  unchanged context revision, receipt/name persistence and clean reopen; pending
  rename queue exclusion; takeover/detach and duplicate status without reexecution.
- Actual deferred writes behind a deterministic stdin barrier rejected observed
  same-runtime history/readiness changes before sending, while accepted execution
  survived takeover. Explicit refusal/unsupported commands reopened dispatch;
  partial/missing/malformed/mismatched/duplicate/replaced/error/exit outcomes stayed
  uncertain and fenced it. Final review reproduced an array-valued failure code
  being coerced to a valid string; strict string validation now rejects it. The
  malformed-code uncertainty and catalog-reopen regression passed after correction.
  These are component/white-box fault checks, not physical
  pipe saturation or service crash recovery acceptance.
- Main/side idle abort scoping, handled input-hook preflight, native steering AND
  follow-up recovery, clear-before-active-abort and retained accepted text passed.
  Pre/post-commit persistence faults preserved receipt/name atomicity, fenced further
  dispatch, retained recovery text/ownership as appropriate, and never replayed.
  An old schema-1 catalog without commands/queue data reopened with identity/name intact.
- Real Pi used scratch copies of the actual bundled title/lifecycle modules plus
  startup/input-hook fixtures, isolated HOME/agent/project/profile and offline mode.
  Normalization, empty-normalized refusal, name/label writes, handled ordinary input,
  dedup, private result/effect separation, stable context revision and clean reopen
  passed without credentials or provider calls. A scratch-only throw after the
  name mutation produced correlated uncertainty; the actual name and uncertain
  receipt survived reopen without another write. A real probe caught completion
  persistence briefly exposing a terminal receipt before gate release; serializing
  terminal persistence/release with admission fixed immediate successive commands.

This is not full bundled startup/workspace/side/spawn or provider verification,
Linux, physical power-loss or frontend/service acceptance. These historical checks
did not execute Node 22.19; B1 above now does. No permanent
tests or Pi changes were added. On Linux repeat the typed/control/deferred-write,
uncertain/persistence and real-Pi component cases before claiming parity.

## Boundaries for the service slice

- Service: Pi/child ownership; trust/workspace startup; accepted queues; control
  leases; pending interactions; snapshots/events; saved catalog; history/tree,
  resources, review and guarded mutations on the execution host.
- Frontend: rendering, drafts, navigation/scroll/folds, local hosts configuration,
  groups/pins/order, local notification policy, tmux window focus and local
  clipboard/Zotero. Remote cwd/path strings must never become local filesystem
  operations.
- Preserve all existing status consumers: trust, access/integration modes,
  history, titles/labels, tree, todos, notifications, side, spawn, Codex usage and
  workspaces. Controller changes do not reset or broaden runtime grants.
- Use a typed, validated operation allowlist, not a raw RPC tunnel. Mutations need
  command ID, epoch and applicable session/runtime/control fences. Lookup uncertain
  commands instead of resending. Separate acceptance from completion.
- Snapshot watermark and later event ordering must be atomic with continuous Pi
  consumption. Retain partial messages/tool output, queue, interactions and status.
  Slow viewers cannot block the worker; replay cannot repeat one-shot UI effects.
- Persist qualified host/session identities and versioned schemas outside releases
  and `NVIM_APPNAME`. Isolate stable/dev session and workspace roots using
  `--session-dir` and `PI_WORKSPACE_ROOT`, without moving legacy data or secrets.
- Local IPC uses owner-only Unix sockets. Remote listeners remain opt-in HTTPS/WSS
  with validated TLS and revocable device credentials. Do not expose an unauthenticated
  proxy listener or trust forwarded requests as local administration.
- Pin the resolved application/Pi binary paths and documented environment at start;
  do not inherit frontend tmux pane context or reload mutable dev resources silently.

## Historical process ownership investigation (superseded by B2 above)

This paragraph describes the pre-B2 baseline, not current managed shutdown. Raw Pi tracks built-in Bash process groups, but that is not proof of ownership of
all descendants. `spawn.ts` currently signals children at shutdown without awaiting
exit/finalization; its escalation timer can disappear with the parent. Side shutdown
awaits its direct child but does not establish whole-tree ownership. Bundled sandbox
shutdown can wait for its command queue.

Before service lifecycle acceptance, verify awaited child shutdown, bounded
escalation and owner-death reconciliation during active sandbox/side/spawn work.
A stale PID alone must never authorize killing a process or starting a duplicate.
Do not automatically adopt or replay interrupted work.

## Linux checks for the user later

These apply after the corresponding macOS implementation, not to nonexistent
service commands today:

1. Record distro/architecture, Pi/Node versions, PATH, user-systemd environment,
   and `bwrap`/`socat`; install server-only without UI tooling.
2. Race two service starts; detach all views during main/side/subagent work and
   reattach. Verify one owner, continued work and coherent output.
3. Capture PID/PPID/PGID/SID; exercise idle/active EOF, abort, SIGTERM, forced stop
   and service crash during child finalization. Check surviving processes/locks,
   including a descendant creating another process group.
4. Disconnect during approval/submission and take control elsewhere. Reject stale
   replies; do not replay prompts, editor effects, approvals or queue items.
5. Reboot/restart, reconcile ownership, explicitly resume saved sessions, and show
   uncertain commands rather than replaying them.
6. Use a macOS client against Linux: review with conflicting saves, workspace/tree/
   fork, deletion, artifacts/skills, links/completion and shell execution. No server
   path may accidentally become a laptop filesystem operation.
7. Check TLS failure, stream revocation, offline-host responsiveness, stable/dev
   isolation and installing an update during an active turn.
8. Verify user-systemd enable/disable, logout/reboot and lingering behavior.
   Installation itself must not enable startup or interrupt work.


## Archived withdrawn-candidate evidence from the pre-B3 handoff

Historical only. The approved best-effort ownership contract supersedes the old exhaustive-containment gate; unknown escapes do not block explicit resume. The active handoff contains no implementation instructions from this withdrawn candidate.

## Historical B1 review / withdrawn B2 design (2026-10-21)

The requested B1 review inspected the specification, recorded repair evidence, SQLite activation/import, receipt/recovery retention, atomic admission/outcomes, claim preservation and actual-write execution guards. An independent read-only review found **no Critical/Important B1 blocker**. Fresh `npm ci --offline --ignore-scripts --prefix server`, strict typecheck and build passed on macOS arm64 / Node 26.12.0. After withdrawing the candidate, the original B1 code again passed strict check/build, a fresh SQLite identity/header/text-retention and uncertain-queue/stale-epoch recovery probe, and unchanged Pi 1.3.0 startup, correlated rename, direct bash and clean shutdown. Earlier B1 migration, Node-floor and storage-fault evidence above was inspected, not rerun in full.

**At withdrawal, this candidate was not shipped. This is historical, not the current B2/B3 direction.** A temporary B2 candidate used a separate SQLite lifetime lease, durable prelaunch registrations, an IPC-lifeline group anchor, explicit reconciliation, resource snapshots and inspect/offer-only recipient-fenced effects. Independent review exposed a material containment gap. The candidate was removed rather than integrating an unsafe recovery policy; only this handoff was changed.

### Reproduced blocking failure

A real Node workload launched a detached grandchild with `stdio: "ignore"`, unreferenced it, then exited. The grandchild changed process group and wrote a marker after a delay. The candidate awaited its anchor, reported `descendantsUnresolved: false`, and returned an empty managed-group inspection **before that later write occurred**. A final fresh-directory reproduction separately asserted child/pipe closure, `ESRCH` for the original group, and **no marker yet**, then verified the later marker write. Thus direct-child completion, closed pipes and absence of every registered original group still did not prove descendant quiescence. A kernel lifetime lease proved that the old owner was absent, not that its escaped work was absent. No stale PID was signalled in the probe; the escaped fixture exited on its own.

This is a blocker in the proposed B2 strategy, **not a newly discovered B1 SQLite defect**. The current B1 code intentionally retains crash-claim refusal and does not ship this reconciliation strategy. Its documented direct-child cleanup remains unfinished B2 work.

The installed Linux sandbox runtime 0.0.77 also constructs `--new-session --die-with-parent` and `--unshare-pid` boundaries (`dist/sandbox/linux-sandbox-utils.js`). Its monitor/workload lifetimes require separate proof; do not dismiss that bundled path as deliberate user daemonization. Linux execution was unavailable here.

Historical requirement at withdrawal: establish complete containment or a conservative refusal policy before retrying. **Superseded by the explicitly approved best-effort contract above**: unknown escaped work no longer blocks resume, but known live/unresolved managed work still does. Do not silently narrow shell/subagent capabilities, add stale-PID killing, clear claims from a process-table snapshot, or treat an empty group as sufficient recovery authority.

### Other candidate-review findings to preserve

- Two empty scans are not a stable registration boundary: scan A can miss a newly appended B while A exits, and scan B can miss C while B exits. Reconciliation and final artifact capture must first fence every old launcher and establish an unchanged registry boundary, not merely repeat liveness queries.
- Claim-evidence archives must publish through synchronized temporary files and atomic installation. An interrupted exclusive-create/write otherwise leaves an empty archive that prevents later reconciliation even while the original claim remains intact.
- Await spawned descendants' quiescence **before** capturing final worktree patches/status. Capturing a patch before child disposal can omit writes during shutdown escalation. Preserving workspaces alone does not make that patch complete.

### Candidate-only evidence and limits

Temporary scratch probes on **macOS 27.0.1 arm64 / Node 26.12.0**, using unchanged installed **Pi 1.3.0**, exercised clean/EOF shutdown, TERM-ignoring escalation, ordinary same-group background children, live kernel-lease refusal, owner SIGKILL, survivor refusal, and explicit reconciliation after registered groups disappeared. SQLite identity, accepted text, uncertain receipts and failed queue diagnostics survived that fixture recovery without replay.

An isolated real-Pi fixture exercised bundled startup, correlated rename, direct bash, live side/spawn groups and a TERM-ignoring shell during shutdown (about 5.2 seconds in the measured run). A two-view check rejected wrong-recipient and takeover-stale offers; editing a scratch dev source after staging did not change that staged run. These positive component checks **do not overcome the reproduced escaped-descendant failure, establish a complete B2 design, or verify frontend application behavior**. Several initial probe fixtures failed because of fixture setup (undrained updates, missing provider metadata/tools); only the corrected runs supported these observations. No successful external-provider, Linux, Node-22, power-loss, full-filesystem or operational attachment acceptance was rerun. All candidate code and temporary probes were removed; none of these are shipped commands or tests.
