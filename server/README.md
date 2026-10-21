# Host-side Pi owner (in development)

This package contains the owner components and **opt-in local-service/Neovim
attachment with C typed single-session operations and D1 opt-in HTTPS/WSS**.
D1 stops for security/protocol review; it does not complete D or authorize D2/E/F.
See [`../docs/SERVER-MODE-C.md`](../docs/SERVER-MODE-C.md) for the mutation inventory,
protocol/outcome rules, fresh macOS evidence and remaining boundaries. The plans and
active B3 handoff are unchanged. B1–B3 evidence in the contracts report remains
historical unless explicitly rerun for C. Ordinary launches keep their current
transport; installed Pi is unchanged.

## Build

Node >=22.19.0:

```sh
cd server
npm ci
npm run check
npm run build
```

Dependencies are locked. Pi is a development dependency for its exported RPC
**types**, not an embedded SDK execution engine. Built JavaScript uses Node
built-ins, the locked `ws` transport dependency and the repository's shared `pi/scripts/managed-process.mjs`; actual execution uses the explicitly selected installed Pi CLI.
Installers do not build/launch this package yet.

## B3 opt-in usage

This is a development slice, not full installer/default-workflow delivery. Build manually above;
installers do not build/start the service. Keep the service profile on private local
storage. Never delete `owner.lock`, adopt old editor state or auto-replay a mutation.
The default root is `HOME/.local/state/pi-console/service/<channel>`.

```sh
# Independent execution host: no Neovim/tmux required. Use an absolute Pi binary.
bin/pi-console server run --binary /absolute/path/to/pi
bin/pi-console server start --binary /absolute/path/to/pi
bin/pi-console server status
bin/pi-console server list
bin/pi-console server create --cwd /absolute/project --id explicit-request-id
# Client: create a new conversation, attach live, or explicitly resume saved.
bin/pi-console --service
bin/pi-console --service --attach SERVICE_SESSION_ID
bin/pi-console --service --resume SERVICE_SESSION_ID
```

Use `--root /short/private/path` on both service and frontend for an isolated profile;
Unix socket paths over 100 bytes refuse. Service CLI also accepts `--channel stable|dev`;
the launcher selects its existing channel. The frontend displays the target channel,
host/build and controller separately from Pi tool permissions. Another dev checkout
cannot administer the same dev profile. Explicit compatible attachment remains allowed.
Missing service/build/version/channel errors do not start local Pi as a fallback.

Normal `server stop` / `restart --binary ...` saves/stops idle sessions but refuses active
work, accepted queues, approvals, startup/transitions or known managed nested work.
An intentional `--force` interrupts owned work, retains history/workspaces and waits
for managed cleanup. Cleanup failure exits the owner with its claim retained; it does
not leave a falsely healthy listener or authorize replacement. SIGTERM/SIGINT are
explicit forced administrative shutdown, not frontend detach. Boot/login supervisor
setup and headless installer mode remain excluded. C's confirmed session restart/kill
are attachment-bound commands, separate from these service administration actions.

After owner death, `server reconcile` invokes the existing B2 managed recovery gate;
then explicitly `server start` and `server resume --session ID`. Neither ordinary
start nor resume performs reconciliation. Known unresolved managed work blocks it;
possible unknown escaped descendants do not. No command/queue/approval replay is
allowed. The operational recovery path passed macOS B3 checks on Node 26.12 and actual
22.19; Linux remains unexecuted.

### D1 explicit remote attachment

The owner still starts with local IPC only unless `server run/start/restart` receives
`--tls-config /private/listener.json`. That owner-only JSON file contains
`{"bind":"0.0.0.0","port":8443,"certFile":"/absolute/fullchain.pem","keyFile":"/absolute/key.pem"}`.
The operator supplies a currently valid certificate/key pair and network reachability.
Clients validate the certificate chain, validity and hostname; there is no plaintext,
proxy, redirect or insecure fallback. Restart is explicit when configuration changes.

Issue credentials through the running owner's private local IPC, one per device:

```sh
bin/pi-console server credentials issue --label laptop --output /private/device/laptop.json
bin/pi-console server credentials list
bin/pi-console server credentials revoke --device DEVICE_ID
bin/pi-console --service --remote https://host.example:8443 \
  --credential-file /private/device/laptop.json --attach SESSION_ID
```

Transfer the credential file out of band into an owner-only 0700 directory/0600 file.
Issuance exclusively creates the output file; it never prints the secret. The owner
stores only SHA-256 verification hashes. `--ca-file /path/to/operator-ca.pem` explicitly
selects a private CA trust bundle when the certificate is not publicly trusted.
Only file paths, never bearer secrets, belong in arguments. A credential pins the
host identity and channel; another identity requires explicitly issued credentials.
Use the matching launcher channel. A remote launch without an attachment opens the
existing session selector rather than creating work using the frontend's local cwd.

The bridge uses the authenticated WSS `/v1/stream` endpoint on that HTTPS listener;
HTTP routes expose no session/admin data. Every operation rechecks device validity,
including inside asynchronous durable admission. Local-only credential administration
and service shutdown are absent from the remote allowlist. Browser origins are refused.
Revocation closes all streams and grants for that device; accepted work remains owned
by the service. Reconnect starts as viewer and never replays mutations. Remote capacity
is separate from local IPC; frames, output and subscriptions remain bounded, and a
dropped subscription destroys its transport even when its writer is backpressured.
Neovim displays the endpoint, host/channel identity and control role.

### Attachment UI

C adds typed model/thinking/mode pickers and cycles, owner `!` / `!!` shell,
native steering / `:PiFollowUp`, retry/compaction settings through the command picker,
history navigation/fork/clone/delete, `:PiWorkspace` enter/integrate/discard,
side/spawn controls, retitle/notifications/usage and confirmed owner-session restart.
`:PiKill` kills the session and closes only this frontend after preserving drafts.
`:PiOperations` inspects outcomes/recovered history text; `:PiHostRequest` reviews an
unresolved create/resume ID. These do not replay work. See the C report for exact
arguments, confirmations and what completion means.

- `:PiControl`, confirmed `:PiTakeover`, `:PiRelease`; reconnect starts as viewer.
- `<C-CR>` non-slash text or explicit owner `!` / `!!` shell, `<Esc><Esc>` abort; shared queue via `:PiQueue` / `<leader>pq`.
  Queue editors are local drafts until `:write`; their 30-second pause may expire.
  A stale revision or dispatched item refuses saving and retains local text.
- `:PiPending` inspects full retained payloads/previews; only the current controller
  gets answer/cancel options. Closing a dialog is not cancellation. Answer draft
  `:write` is explicit submission; stale callbacks are fenced by transport/grant/runtime.
- `:PiOffers` retrieves inspect-only offers into separate draft buffers, never the
  input buffer or navigation handlers. Snapshots contain no offers.
- `:PiDetach`, `:PiReconnect`, `:PiConsoleRestart` affect only the frontend/bridge.
  Accepted work remains owned by the service. Restart retains local input/draft
  buffers and unresolved command IDs without replay or grant reacquisition.
- `:PiSubmissions` inspects unresolved prompt IDs and authoritative receipt status.
  Lost-ack input is visibly protected, not an unsent draft; identical text cannot be
  submitted as new work until explicit review permits it. Status lookup never replays
  work. A completed prompt receipt means queue acceptance, not a finished turn.
- `:PiDrafts` explicitly offers frontend-local recovery files for inspection/copy.
  Files under `${XDG_STATE_HOME:-$HOME/.local/state}/pi-console/frontend/<channel>/service-drafts/`
  are private recovery, never execution authority. Recovery survives `NVIM_APPNAME`/
  stable-release changes and remains isolated between stable and dev.
- Freeform slash commands and excluded overview/resource actions report unavailable.
  Tool inspection shows recorded text only; it never reads owner full-output paths,
  spawn artifacts or workspace review data from the local filesystem. History text
  may be offered in a separate live, initiating-grant-bound draft, never input replacement
  or snapshot/reconnect replay. No raw RPC tunnel, local owner-path lookup or implicit
  local Pi fallback exists. Zotero completion stays frontend-local; the host still
  needs its own resource/provider configuration.

### Local protocol v1

The same-user security boundary is the 0700 profile and 0600 Unix socket. This is not
remote authentication or isolation from other processes running as that user. Each
connection must handshake `{id,method:"hello",payload:{version:1,channel}}` before other
requests. Responses are `{type:"response",id,success,result|error}`; updates are
`{type:"update",update}` with the owner's epoch/session/runtime/sequence. The handshake
reports capabilities, host/channel, service epoch, resolved application path, running
service build and separate runtime-resource fingerprint. CLI status compares the
selected service build; it never silently restarts a different running build.

Methods: `health`, `sessions`, `host.command`, `host.status`, `attach`, `detach`,
`snapshot`, typed `session.read`, `command`, `grant`, `heartbeat`, `command.status`, `effect.inspect`,
`service.stop`; local administration also has `credentials.issue/list/revoke`. All have typed allowlisted fields; raw RPC is rejected. A connection
owns at most one subscription. `command` accepts the existing version-1 session
command **without** `attachmentId`; the service stamps its own transport attachment
and rejects caller-supplied attachment IDs or other targets. Tokens are returned only
by `grant`, never in snapshots/receipts. `attach` returns a copied watermark snapshot
before strictly newer updates. Detach or slow-view eviction revokes that attachment,
not accepted work. UI snapshot replacement is a pure render coalesced after updates.

Host `host.create` / `host.resume` commands contain `{id,serviceEpoch,operation,payload}`.
Their receipt means allocation/scheduling, **not ready() or completed agent work**.
Same ID/payload resolves disk state without launching twice; changed payload conflicts.
Use status lookups for lost acknowledgments. New epochs never reauthorize old envelopes.
No client automatically retries a mutation. Administrative stop is separately guarded
by the current service epoch and an explicit boolean `force`; it is not a Pi RPC call.

Input is strict UTF-8/LF JSONL, limited to 2 MiB/request; output frames to 80 MiB for
bounded materialized snapshots/recovery. There are 64 connections, 32 in-flight requests
per connection and bounded output/subscription buffers. A slow attachment may be dropped
and must reconnect for a fresh snapshot; it cannot backpressure the owner's Pi reducer.
The stdio Node bridge relays requests/events only and retains no execution authority.

**Fresh local verification:** macOS/unchanged Pi 1.3.0/Neovim 0.12.6 passed startup
races, two actual frontends, streaming/approval late attach with zero frontends,
lost-ack lookup/deduplication, restart/draft protection, explicit CLI crash recovery,
overlap/failed-shutdown/dev-management regressions and malformed/oversized/slow peers,
on both Node 26.12.0 and actual 22.19.0. A 50-ms lease busy wait coordinates concurrent
starts; exhaustion still refuses ownership. The separate catalog timeout remains zero.
Linux is unexecuted; offline provider/approval fixtures are not external-provider or
complete third-party-dialog acceptance. See the contracts report for scoped evidence.

## Component boundary

- `src/host-owner.ts` opens one catalog per host/profile. Create/resume registers
  an initializing handle before startup; concurrent resume returns that handle.
  It validates managed history, commits open ownership before spawning, runs
  trust/workspace initialization, and awaits child exit before recording saved or
  interrupted state. Lookup/list/snapshot are reads, never startup operations.
- `src/pi-process.ts` starts one owned RPC child, reads LF-framed records using a
  fatal streaming UTF-8 decoder, correlates responses and serializes stdin writes
  with backpressure. Worker environment comes from the host owner, with frontend,
  tmux and inherited child-role markers removed. Application/Pi executable symlinks
  are resolved before launch.
- `src/pi-conversation.ts` continuously reduces assistant deltas, tool/bash output,
  native queue/execution state and retained extension values before startup. It
  separates live-only effects from snapshot data and bounds retained state.
- `src/session-subscription.ts` implements owner-internal pull subscriptions with
  snapshot watermarks and local slow-view eviction. It is not a client transport.
- `src/pi-interactions.ts` consumes the bundled `pi-console-runtime` and
  `pi-console-dialog` statuses. It retains current pending interactions, fences
  replies to the owning runtime, reserves answers before dispatch, and cancels
  invalidated raw editor callbacks. Returned interaction snapshots are copies.
- `src/session-catalog.ts` owns serialized SQLite transactions in an explicit
  private profile root, claims one writer, and creates stable Pi JSONL headers
  before a first prompt. `src/catalog-storage.ts` defines the schema, validates
  and converts the former service JSON catalog, and guards activation. Neither
  starts Pi or changes legacy editor-owned state.
- `src/pi-records.ts` uses Pi's exported types and checks raw record envelopes.
  It is **not** an application-protocol validator or a client-command allowlist.

`PiProcess.request()` is private to the host owner. Never forward arbitrary
frontend records to it. `src/session-commands.ts` now defines a private version-1
allowlist, attachment-bound control and durable command admission. This is not a
complete application protocol or authenticated client endpoint.
`PiProcess.ready()` means the subprocess RPC and lifecycle extension are available; it does
not perform the owner's trust/workspace initialization or authorize prompts.

The adapter callbacks receive records for the host, not remote viewer streams.
The owner now provides bounded conversation snapshots/subscriptions internally;
B3 wraps these components with local IPC/independent startup; its bounded protocol
and platform-scoped verification are described above.

### Best-effort execution ownership and effects (B2)

This section describes the underlying private B2 component API. B3 candidate startup/IPC
composes it without changing its ownership contract. The revised contract
in `plans/server-mode.md` intentionally accepts unknown escaped descendants.

- `HostOwner.open()` defaults to `HOME/.local/state/pi-console/service/<channel>`
  on macOS and Linux. Stable/dev profiles remain distinct. Host `environment` is
  optional; it is sanitized of Neovim/tmux/UI and inherited service-role variables,
  preserves provider/settings discovery, and supplies a documented default PATH.
  `binary` and `appRoot` remain explicit absolute host paths.
- Resolved bundled/installed Pi resource trees and dependencies are fingerprinted;
  `buildId` identifies those resources. Full checks before top-level workers and
  inherited stat/realpath/dependency-resolution checks before nested launches
  refuse changed dev resources. Bundled same-child workspace/session switches are
  checked before reloading. This is restart-required change detection, not an atomic
  source snapshot, hot reload, or a pin on arbitrary user/project extensions.
- Main/side/spawn and bundled model-facing/RPC Bash use stable-ID detached supervisors and trusted workload anchors.
  `processes.sqlite` stores prelaunch intents, grants, ancestor launch fences and
  terminal cleanup evidence. Owner death disconnects the supervisor lifeline and
  initiates cleanup; it does **not** automatically restart a conversation.
- Model sandboxed/approved-unrestricted Bash and explicit user/RPC Bash register
  before execution; user Bash retains its existing unrestricted-shell semantics.
  Supervisors also observe stdio MCP, sandbox bridges/monitors and other
  descendants through live process-table sampling. They retain observed identities
  in memory, recheck before signals, and defer registered nested supervisors to
  their own cleanup/publication. TERM begins after 2s, KILL after 5s; unresolved
  local work is reported after 8s, nested evidence after at most 12s (plus bounded
  process-table work). These are shutdown policies, not generation deadlines.
- `HostOwner.reconcile({root, channel})` is explicit administration. It first takes
  the old owner's kernel lifetime lease, seals the epoch transactionally, cancels
  ungranted intents and waits for known jobs. Live/unresolved granted jobs refuse
  replacement. PID files, closed pipes and empty groups are never recovery authority.
  Supervisor/anchor loss without sufficient completion evidence remains unresolved.
- Exact old claim bytes are immutably stored by a FULL SQLite commit in
  `processes.sqlite.recoveries` before changing the main catalog or unlinking the
  claim. Repeating reconciliation after interrupted publication/catalog commit is
  idempotent. Legacy B1 claims have no such evidence and still require inspection.
  Session/Pi/host identities and all recovery text remain intact. Reopen marks
  unresolved receipts uncertain and unfinished queue items failed; resume is explicit.
- Spawn waits for managed cleanup before final patch capture; a durable child
  workspace marker blocks capture, integration and removal after incomplete cleanup.
  Cleanup Git commands are awaited and have a 10s service-only bound. Failed artifact
  publication can leave a conservative marker requiring inspection. No finality is
  promised against escaped writers or external modifications.
- Desktop notifier launch is intentionally disabled in service workers: clients
  will implement notification policy. Sanitized TMUX prevents host-side reviewer UI;
  existing retained-workspace/manual-review data remains. Existing external tmux,
  HTTP MCP, remote jobs and explicitly handed-off services are not descendants to kill.

**Limit:** detached/reparented processes between samples, group/PID namespace changes,
privilege changes, hostile PID churn and work handed to existing external services can
escape tracking. Same-user process sampling is not a security boundary or pidfd-strength
identity. Unknown escaped work may keep writing after cleanup and explicit resume; it
alone does not block resume. Known unresolved work does. No VM/cgroup/privileged helper
or new production package is required. The registry, recovery evidence and per-epoch
resource manifests currently have no garbage collection.

Live frontend effects are now **inspection-only offers**, not legacy editor/navigation
instructions. Offers carry owned-stream provenance, recipient attachment/grant and
runtime/cwd context. Nonrecipients and stale buffered deliveries receive the sequence
envelope without an effect. `OwnedSession.inspectEffect(attachmentId, token, update)`
rechecks current grant/token, epoch, owner runtime revision, cwd/readiness and storage
before returning copied data. Offers are absent from snapshots, never replayed, limited
to 128 / 4 MiB (2 MiB each), and may be evicted. There is no promise that an uncorrelated
effect originated from that attachment. B3 must preserve drafts and recheck local context
before offering any application; B2 contains no actionable frontend handler.

Fresh evidence and remaining platform gaps are in `docs/SERVER-MODE-CONTRACTS.md`.

### SQLite storage (B1)

`catalog.sqlite` is the authoritative service ledger (SQLite `user_version=1`).
Indexed tables hold profile identity, session metadata/ownership, ordered queue
items, epoch-wide unique command IDs/fingerprints/outcomes and separate recovery
payloads. A nullable command session reference permits future host-scoped receipts;
B3 host create/resume admission uses that nullable reference without a schema change. Queue-plus-admission and
rename-plus-outcome are single `BEGIN IMMEDIATE` transactions. No transaction
awaits Pi, filesystem work or a client. Pi JSONL remains Pi's history source.

The built-in `node:sqlite` driver runs on the declared Node 22.19 floor (experimental
warning on that release) and Node 26.12. No production dependency was added.
Settings are checked at open: WAL, `synchronous=FULL`, `fullfsync=ON`,
`checkpoint_fullfsync=ON`, foreign keys on, zero busy timeout and automatic
checkpoints off. SQLite's page cache is 4 MiB. Short synchronous writes yield
between transactions. Passive checkpoints run after 128 commits or approximately
8 MiB of charged writes, whichever comes first; successful close requires a
nonbusy truncating checkpoint. Passive partial checkpoints retain the WAL; they
are not evidence of lost commits. Filesystem/physical power-loss durability is
not established by these process probes.

**Conversion/activation:** exclusive `owner.lock` ownership is required first.
Existing claims and unresolved session ownership are never removed to migrate.
The bounded schema-1 source and managed Pi headers are validated before conversion.
An atomic, synchronized, exact-byte `catalog.schema-1.json` source copy is retained.
Then `catalog.json` becomes a schema-2 activation guard (host/channel, source hash,
`initializing`/`ready` phase), which schema-1 owners reject. Schema creation/import
commits atomically; activation becomes ready afterward. An interrupted initializing
conversion can continue from the validated source/empty database, or recognize its
already committed import, **only after ownership has been independently reconciled**.
A ready profile with a missing database refuses; it never falls back to JSON.
Unknown newer JSON/SQLite schemas refuse before writable database opening.
The source copy is not a current backup and must never be restored over a running
profile or copied back as a writable `catalog.json` downgrade.

Profile/session/workspace directories are 0700; database, WAL/SHM/journal, guard,
source copy and claim are private owner files (0600 on creation). Existing foreign,
linked or group/world-accessible storage files refuse. Temporary activation/source
files are private and can remain after a failed write; they are not authoritative.
For backup, stop all owned sessions, cleanly close the catalog, then copy the whole
profile to a private destination, preserving session/workspace data. Do not copy a
live database without its WAL or edit/restore files while an owner exists. Restore
only a complete quiescent profile, preserving the activation guard and identity;
never launch a backup as a second owner of that identity. There is no online
backup/restore command or supported writable downgrade.

**Retention/pressure:** no receipt-count ceiling, TTL, automatic old-epoch deletion
or whole-ledger cache exists. Full indexed `commandStatus` lookup joins recovery
text. Recent snapshots contain at most 128 compact receipts with at most 2 MiB of
recovery JSON; omitted blobs set `recoveryAvailable: true`, retrievable through the
existing status lookup. No text is truncated/deleted on disk. Current-epoch IDs
must not be cleaned up. Future old-epoch cleanup may remove only terminal,
unreferenced diagnostics with no unresolved outcome, accepted work or sole
recovery-text obligation; this slice deliberately retains all such data. Disk
usage therefore grows. Old envelopes always reject, even if diagnostics are absent.

Admission checks filesystem available bytes against twice the outstanding accepted
outcome reservations plus the new slot, leaving 64 MiB for ordinary admission or
16 MiB for control/approval/abort/removal/release. `storage_pressure` refuses before
dispatch and does not fence otherwise healthy storage. These are logical headroom
checks, not preallocated space or a guarantee against other disk writers. Pending
abort and history navigation/fork slots reserve 17 MiB; text slots charge escaped
recovery text + 4 KiB; other slots reserve 4 KiB. Outcome growth cannot exceed its admitted slot. Actual SQLite-full,
I/O, rollback/commit ambiguity or checkpoint errors fence mutation and retain the
claim; acknowledged Pi execution is not rolled back. No control operation bypasses
journaling. The latched catalog failure synchronously fences create/resume, startup
and every actual RPC pipe write, including accepted writes waiting on backpressure
and internal interaction cleanup. The adapter checks again after callbacks, immediately
before writing; making SQLite writable again never clears this fence.

A one-shot failure notification runs outside SQLite transactions and retires all
owned sessions, clearing ephemeral edit pauses without reading the database,
revoking control and initiating the existing stdin/signal shutdown. Diagnostic
reads remain available where storage can still be read; cleanup failures retain
open ownership and the claim. These actions require no successful durable write.
They cannot undo already-dispatched work or establish complete descendant cleanup.
Explicit reconciliation is implemented as B2 above; operational guarded shutdown remains B3. Low-level `stop()` is not
a new reliable service-stop API.

### Private owner startup

`HostOwner.open()` takes explicit private root/channel, absolute Pi/application
paths and host launch environment. It pins resolved paths and copies the environment;
default per-channel roots and resource-change refusal are described above. This is
not an atomic dev runtime snapshot. `create(cwd)`
returns after catalog creation, not after trust setup. `resume(id)` returns the
same initializing/live handle for concurrent callers. Observe `snapshot()` and
answer its pending interactions **before** awaiting `ready()` when setup needs a
choice; waiting first would deadlock an unattended trust dialog.

Startup runs `get_state`, `get_commands`, `/pi-trust-setup`, checks the retained
trust result, then `/pi-workspace-publish`. A successful extension-command receipt
is not enough: trust and workspace statuses must match the active managed runtime,
and a pending workspace transition must finish. A same-child cwd/runtime replacement
repeats initialization (at most eight passes). One trust-driven process replacement
is allowed; the old child must exit cleanly before the same session file is reopened.
Repeated restart requests fail instead of looping.

The owner maintains `runtimeRevision` across child/runtime replacement and explicit
resume within its service epoch. Interaction responses now go through `command()`;
there is no public raw `respond()` bypass. The adapter checks runtime/interaction
liveness at the actual stdin write position, including under backpressure.
`assertReady()` rejects dispatch before trust/workspace readiness. The editable
non-slash accepted queue below rechecks this gate at its actual pipe write position.
All APIs remain owner-internal.
`ready()` records initial startup completion; use the current snapshot/gate to
check later availability, not that already-resolved promise.

Snapshots contain copied startup/interactions and materialized conversation state.
`lookup()` and `subscribe()` never start or restore anything.
`OwnedSession.stop()` is explicit low-level owner shutdown, not detach and not an
unrestricted frontend stop endpoint. `HostOwner.close()` refuses active/initializing
sessions or in-flight creation; it never silently stops them.

The catalog's exclusive claim is not proof that all worker descendants have died.
It refuses stale claims and unresolved open entries rather than guessing from a
PID or replaying work. The owner marks an entry open before launching
its child and marks it stopped only after managed terminal evidence is available.
A live catalog cannot be closed. Failed exit persistence or known unresolved managed
jobs retain open ownership and refuse replacement. Explicit reconciliation and default
per-channel roots follow the best-effort B2 contract above. A failed/ambiguous SQLite commit,
checkpoint or initialization write retains the claim and fences further mutations
rather than overwriting a possibly committed entry. A failed create may
also leave an unregistered empty history file; nothing is auto-adopted or deleted.
Actual power-loss durability has not been tested.

### Continuous state and ordering

The reducer exists before spawning the worker and runs with zero viewers, including
while trust blocks startup. Assistant text/thinking and serialized tool-call argument
deltas are retained until authoritative block/message ends replace them. Tool partial
results replace previous results; nested parent IDs survive. Correlated direct-bash
responses finish retained output even though Pi emits no final bash message event.

Initial history and idle reconciliation use `get_state`/`get_messages`. History is
applied synchronously at its response's stdout position, fenced by worker/runtime
and intervening event version. Settlement, compaction, history invalidation and
bash completion request a coalesced refresh. Active-run history replacement is
avoided: Pi has no atomic active snapshot and omits partial assistants. Runtime
replacement invalidates hydration; ended activity is marked interrupted/uncertain,
not silently continued. Runtime-scoped statuses/widgets/title and native pending
queue are retired on runtime end. Startup must hydrate before publishing ready.

`session.subscribe()` synchronously captures a copied `snapshot` and registers a
pull stream. `next()` yields strictly newer, consecutive `sequence` values within
the session/service epoch, with the owner runtime revision. Updates carry owner
metadata, reducer changes or a distinct live-only `effect`. There is no cursor
replay. Closing a subscription only detaches that view. A dropped view must take
a fresh snapshot; it cannot silently continue after a gap. Watermarks survive
explicit resume within the same owner epoch; subscriptions remain tied to their
original handle, so explicitly resubscribe to a resumed handle.

Notifications, editor text and bundled side/clone receipts/history refresh signals
are not in snapshots. Managed lifecycle closure is consumed by interaction tracking,
not retained as a frontend effect. Other status/widget/title values are **data**:
a frontend must not run its legacy event handlers over snapshot values. Side and
spawn payloads remain opaque retained snapshots, not actionable child approvals.

`conversation.messages` is a bounded tail of Pi's current projected context, not
all branches or pre-compaction history. `omittedMessages`, `historyRevision` (baseline
replacement counter) and `hydrated` disclose truncation/reconciliation. Full history
pagination belongs to the later resource/protocol slice. Native queue snapshots
and recent dispatch/acceptance/rejection/uncertain work metadata are diagnostic;
these transport IDs are **not** frontend command receipts, deduplication or the
editable accepted queue. Application receipts are separately exposed by
`commands` in the snapshot and `command` updates. The editable queue is separately
exposed as `acceptedQueue`; no raw RPC endpoint exists.

### Private command/control core

`subscribe(label)` creates an opaque attachment ID without granting control or
rerunning startup. The original B3 operations below remain supported; C extends
this allowlist with the explicit families in [`SERVER-MODE-C.md`](../docs/SERVER-MODE-C.md).
There is still no arbitrary command endpoint.

- `control.acquire` (only if unclaimed), `control.takeover` (requires
  `{ confirmed: true }`), and `control.release`.
- `interaction.respond` with `{ requestId, answer: { value } | { confirmed } }`,
  or `interaction.cancel` with `{ requestId }`. These work during startup too.
- `turn.abort` with an empty payload.
- `session.rename` with `{ title }`: the bounded managed extension capability below.
- `prompt.submit` with `{ text }`, `queue.edit` with `{ itemId, expectedRevision,
  text }`, `queue.remove` and `queue.reserve` with `{ itemId, expectedRevision }`,
  and `queue.release` with `{ reservationId }`.

Only nonempty, non-slash text up to 1 MiB UTF-8 is accepted (trimmed on save).
Leading-whitespace slash text is rejected too. `prompt.submit` never forwards shell,
freeform slash commands or raw RPC. C provides shell/settings/history/workspace/lifecycle
through separate typed operations. Explicit `session.rename` remains a private fixed
bundled command, not accepted prompt text.

Every envelope carries `version: 1`, `id`, `sessionId`, `serviceEpoch`,
`runtimeRevision`, `attachmentId`, `operation`, and `payload`. All but acquisition
and confirmed takeover require `controlToken`. Unknown fields/operations and
mismatched answer types are rejected. Answer text is limited to 1 MiB.
Typed `CommandError.code` values distinguish invalid commands, stale epoch/runtime,
unavailable runtime, closed attachment, required/revoked/claimed control,
resolved interactions, command conflict, queue conflict, expired reservations,
busy sessions, unsupported managed commands and capacity limits.

`controlGrant(attachmentId)` returns the current holder's secret token only to that
attachment; snapshots/events/receipts contain only controller label, attachment ID
and grant ID. These private methods do not authenticate a device: a later transport
must bind the caller to its attachment and protect grant delivery. Attachment IDs
are not device credentials. Heartbeat every 5 seconds with
`heartbeat(attachmentId, token)`; expiry is 20 seconds on `performance.now()`, not
client/wall-clock time. Heartbeats are ephemeral liveness checks, not durable
commands, and never reacquire a grant. Timer/authority checks expire old grants.
Clean detach, slow-view drop, explicit release, takeover and session shutdown
revoke control without answering dialogs or cancelling accepted execution.

A short serialized admission lane checks authority and reserves the ID durably
before any dispatch; a long abort does not block takeover or interaction answers.
Command IDs are host/epoch-wide. Duplicate ID + same target/revision/operation/
payload returns the existing receipt, even after takeover or attachment reconnect;
a changed mutation is `command_conflict`. Attachment/token are delivery authority,
not payload identity. A duplicate never renews/recreates/releases control again.
New commands under revoked tokens fail. Already accepted execution survives
control transfer/detach, but still checks its worker/runtime/interaction immediately
before writing; it cannot land in a replacement context.

Acceptance and outcome are separate. `command()` returns after durable acceptance;
use `commandStatus(epoch, id)` for `accepted`, `completed`, `failed`, `uncertain`,
or explicit `unknown`, and consume ordered `command` updates. Interaction
`completed` with `result.delivery: "flushed"` means only that stdin flushed, not
that Pi acknowledged the answer. Native rejection is failed; unproven delivery is
uncertain. Receipt persistence failure fences/stops the owner rather than retrying.
`commands` snapshots include up to 128 recent receipts as data, never instructions;
large recovery payloads obey the separate snapshot byte budget above.

Receipts use indexed SQLite rows; schema-1 service data is converted without
changing host/session identity or Pi files. SHA-256 fingerprints identify mutations; answer
payloads and grant tokens are not retained. Submission/edit receipts additionally
retain `result.queueItemText` as recoverable accepted text, with `queueItemId` and
`queueItemRevision`. Pi emits user `message_end` before appending history, so an
observed handoff must not erase the only durable text copy. Recovery data is never
an instruction to replay. Current-epoch IDs are never evicted and historical count
does not consume an active-memory budget. The SQLite retention/headroom policy
above replaces the former 1,024-record / 32-MiB historical ceiling. Old-epoch
envelopes always fail and unknown IDs are never an instruction to resend. On a permitted clean catalog reopen, unresolved
acceptances become uncertain without replay. Existing crash claims/open entries
still require ownership recovery; receipts do not authorize reclaiming them or
establish exactly-once execution across a crash. B3 host create/resume deduplication
and private local delivery wrap this core; remote delivery remains later work.

Abort preserves the existing main-dialog and queue boundaries: idle abort explicitly
cancels main dialogs but sends no native `clear_queue`/`abort`; side dialogs retain
their underlying lifetimes. Active abort cancels main dialogs, sends `clear_queue`
before `abort`, and still attempts abort after a native clearing rejection. Cleared
steering **and** follow-up text is checkpointed in the receipt before abort as
recoverable data, without overwriting any frontend draft. A partial failure retains
that result. Storage failure or runtime replacement prevents the later write.
Abort also cancels new main dialogs while its operation is pending. It never
deletes accepted application queue items. They remain dispatchable once execution
settles and readiness returns, unless their controller explicitly removes/edits
them or holds a finite edit reservation. Native queues remain separate.
The old frontend's disposal of side picker windows on aborted settlement is not
an owner-side cancellation of still-live side operations.

### Editable non-slash accepted queue

`src/session-queue.ts` defines session-owned items (`id`, `revision`, `serviceEpoch`,
`runtimeRevision`, `text`, `status`, optional `error`) and ephemeral edit reservations.
Snapshots and ordered updates expose `acceptedQueue: { items, reservation? }`.
Queue mutation and command-ID reservation are a single catalog commit, before
receipt publication or dispatch. Command `completed` means the queue mutation
completed, **not** Pi delivery or turn completion; inspect the item's state and
conversation separately. Duplicate commands return the same item/result, never a
second item or a renewed pause.

Items retain insertion order and `queued`/`sending`/`failed` states. Edit/remove
requires the exact item revision and refuses sending or already-dispatched items
with `queue_conflict`. Editing failed text explicitly requeues it in its original
position, binding it to the current epoch/context. Failed items remain visible
but do not block later queued work. Empty edits are rejected; remove is explicit.
A snapshot is copied data, never an instruction to resend.

`queue.reserve` pauses dispatch of its item for 30 seconds on `performance.now()`;
head-of-queue editing blocks later items rather than reordering them. The returned
`reservationId` identifies cancellation through `queue.release`. Expiry, save,
removal, detach/slow-view drop, takeover/release/control expiry and shutdown release
the pause. Heartbeats do not extend it; another explicit reservation is needed
for more editing time. `expiresAt` is a display deadline only. Local editor text
remains a draft until accepted save, and expiry may allow dispatch before save.
Reservations never survive an owner restart or carry control tokens.

Dispatch is serialized with admission but does not hold that lane while Pi waits
on input hooks/dialogs. It waits for trust/workspace readiness, no compaction/
retry/summarization, no native pending messages, and settled execution—not
`agent_end` or `get_state.isStreaming: false` during settlement handlers. Only one
prompt is sending. A started run remains gated through `agent_settled`; a handled
input-hook result retires its item without inventing an agent run. A started item
retires after an observed user message; if settlement arrives without one it stays
failed/uncertain. Text remains recoverable in its receipt even after retirement.
Native rejection retains a failed item; unproven delivery is never auto-retried.

At the actual backpressured write, worker/runtime/identity and readiness/execution
are rechecked. Trust/workspace status must belong to the current worker runtime,
not merely an earlier runtime with matching cwd/file. Fresh binding-time statuses
between old-runtime stop and incoming-runtime start are attributed to the incoming
revision. A not-yet-written temporary readiness/busy change defers the item;
a replaced context fails it without sending. Replacement also retires an old
sending/preflight item as failed; a late acknowledgment cannot change a newer
prompt's dispatch latch. `pi-history-changed` advances the
owner revision even for same-runtime branch edits. Accepted text survives control
transfer, not automatic retargeting to a new branch. Clean stop/reopen retains
unfinished items as failed diagnostics; editing explicitly authorizes retry in
the new context. No automatic replay occurs across owner epochs.

Freeform slash dispatch is deliberately deferred: Pi can execute registered `/commands`
before ordinary prompt preflight, including broader history/workspace mutations;
`handled` alone also does not prove extension-command success. C adds typed native
steering/follow-up and fixed bundled capabilities with positive correlated outcomes,
not broader slash dispatch. The explicit managed rename below retains its result policy. Trusted input hooks
still execute inside unchanged Pi; the
owner fences observed context changes, not arbitrary unpublished extension work.

### Bounded typed extension capability: explicit rename

`session.rename` takes exactly `{ title: string }`. Input must be nonempty, at most
4,096 UTF-8 bytes, and contain no C0/C1 controls or Unicode line/paragraph separators.
The existing bundled title helper normalizes whitespace/title prefixes/punctuation
and truncates to 80 JavaScript characters. An empty normalized title is refused;
the completed receipt returns `result.title` with the effective title. No separate
confirmation is required for this explicit, reversible metadata change.

Admission requires control, current epoch/runtime/managed identity, ready trust and
workspace state, and settled execution without a sending/preflight queue item or
pending main dialog. Busy requests are rejected, not placed in another queue.
One rename gates application queue dispatch through durable outcome persistence;
queue text/edit reservations/native queues remain separate. Controller transfer or
detach does not cancel accepted execution. Worker/runtime/readiness/execution are
checked again at the actual backpressured stdin write. A rename appends metadata,
not a different conversational context, so it does not advance owner runtime revision.

The owner discovers the exact bundled `auto-title.ts` registration on each invocation;
missing/wrong-source/colliding names refuse without sending a slash prompt. It builds
only `/pi-console-rename` with a private version-1 JSON payload containing invocation,
managed runtime, Pi session/file identity and title. This command exists only with
`PI_CONSOLE_SERVICE=1` and executes only in RPC mode. The extension validates identity
and idle state immediately before synchronous mutation and shares the existing title/
label helper. Legacy `/pi-title`, `/pi-rename` and `/pi-retitle` behavior is unchanged.

Pi's `handled` response covers warning returns, exceptions and handled input hooks,
not command success. The owner additionally requires one matching managed terminal
result, consumed at its stdout position. Completed means the helper finished and
its effective title plus receipt were committed together in one SQLite transaction.
Failed means a proven-unsent refusal or correlated pre-mutation rejection. Partial
mutation, missing/malformed/duplicate/mismatched results, lost delivery or context
replacement are uncertain; the owner fences/stops the child rather than reopening
dispatch from `handled` alone. Unrelated native extension errors retain their existing
conservative policy. Persistence failure also fences execution. Neither a native
exception nor an uncertain receipt proves rollback. Pi history and catalog commits
are not a cross-file transaction or a power-loss guarantee.

Managed envelopes/results are absent from conversation work/status/effect streams;
only normal title/label/name data and application receipts are published. No editor
text or navigation action is introduced by rename. Rename is not a generic dispatcher;
C's separately typed operations handle supported retitle/model/modes/history/workspace/
side/spawn/notification controls. History completion text is initiating-grant-bound
recovery, not a broadcast editor action or receipt/snapshot/reconnect replay. Runtime/history/
workspace replacements still fence old-context accepted text for explicit review;
`queueItemText` recovery receipts remain intact and uncertain work is never replayed.

### Bounds and shutdown

- Individual input/output JSONL record: 16 MiB.
- Command admission lane: 128 pending callers. Historical receipts stay on disk
  without a count ceiling; recent snapshots have the separate count/byte budget
  above. Full native queue text is retained, so a live receipt update larger than
  a viewer's 8-MiB limit drops that viewer; resubscribe and use status lookup for
  the full recovery payload rather than silently truncating it.
- Accepted items: 128 / 8 MiB per profile, charging JSON-escaped text plus 4 KiB
  metadata/error headroom per item. Capacity refuses before acceptance; no queued
  work is evicted. Queue rows retain per-session insertion order and revisions.
- Outstanding commands and queued stdin records: 128 each; queued stdin data:
  32 MiB.
- Pending dialogs: 256 and 32 MiB total; retained stderr tail: 8,192 characters.
- Conversation tail: 512 messages / 16 MiB, with an explicit omitted count.
- Live conversation accounting: 32 MiB / 2,048 retained slots; assistant delta
  accounting is conservative. Oversize live state fails the worker explicitly
  before retaining the offending value. Completed/interrupted tool slots: 256;
  recent work slots: 128, evicting terminal/accepted records before dispatched work.
- Direct-bash stream tail: 1 MiB per work item, UTF-8 aligned, with omitted-byte
  count; the final Pi result separately retains truncation/full-output metadata.
- Viewers: 32 per handle; each queue: 256 updates / 8 MiB. Overflow rejects its
  pending/future reads and frees queued data without stopping Pi or another view.
  Snapshot data is separately bounded above; it does not count as queued updates.
- Stop closes stdin and requests supervisor cleanup under the B2 policy above.
  Final output is drained; pipes retained after supervisor exit are abandoned after
  a further 5-second grace. `descendantsUnresolved` now means known managed cleanup
  lacks terminal evidence, not a claim about all possible descendants.

Malformed/oversize output, invalid UTF-8, broken response correlation or unexpected
stdout EOF fail clearly and retire the child. Native RPC command failure rejects
only that request. Unresolved outcomes are uncertain; the adapter never retries
mutations. A flushed interaction response is not a Pi acknowledgment.

This does not establish complete descendant cleanup. Best-effort crash reconciliation,
awaited side/spawn cleanup and restart-required resource checks are implemented as B2
components above; operational independently started service lifecycle remains B3.

Bundled dialogs have explicit closure tracking. Untagged third-party dialogs are
identified by their absent lifecycle tag; do not present them as having verified
retained timeout/signal support.

## Verification

Fresh C local-service and actual two-Neovim evidence and its platform limits are in
[`SERVER-MODE-C.md`](../docs/SERVER-MODE-C.md). The reports below are historical.

The B1 shared-storage fence repair was separately verified on macOS 27.0.1 arm64 /
Node **26.12.0**. Actual-child deferred prompts/replies/rename, isolated pipe and
post-callback barriers, read/full/checkpoint faults, nonfatal pressure and retained
claims passed. Unchanged Pi 1.3.0 passed startup/trust, rename/dedup, takeover, idle
abort, missing-credential prompt, cross-session failure and clean resume/no-replay
checks. No successful provider turn, Node 22 or Linux run was repeated for this
repair. See the handoff and contracts document for reproduction steps and limits.

Earlier B1 probes on macOS 27.0.1 arm64 passed with Node **22.19.0 and 26.12.0**,
unchanged Pi 1.3.0 and isolated offline state. They cover SQLite conversion/reopen,
interrupted conversion, newer-schema/ownership guards, admission and rename
atomicity, engine `SQLITE_FULL`, pressure/control headroom, commit/checkpoint faults,
recovery text and no replay. Quiescent whole-profile backup/restore passed on both
runtimes with preserved identity/recovery/Pi header and database hash. A 6,166-command
epoch retained early IDs. Bounded-memory
probes used 8,000 small commands, 160 one-MiB text receipts and 16-MiB abort recovery;
recent recovery hydration stayed below 2 MiB. Real bundled startup plus a scratch
offline provider/dialog exercised 1,807 owner commands, early retry/conflict,
approval, two queued/edited turns, rename, stop/reopen and explicit resume on both
Node versions. Strict typecheck/build passed; compiled imports remain Node built-ins
and local modules. See the **B1 SQLite evidence** section in
`../docs/SERVER-MODE-CONTRACTS.md` for measurements, commands and remaining limits.
Those B1 probes did not verify B2/B3. Fresh B2/B3 evidence is recorded above/in the contracts document; Linux, actual full-host disk exhaustion and physical power loss remain unverified.

The following are historical pre-SQLite component reports. Their JSON capacity and
Node-floor gaps are superseded above; they are not fresh reruns of every behavior.

Temporary macOS probes covered real Pi startup, bundled trust/workspace commands,
unattended access approval, stale/duplicate reply rejection, runtime replacement,
editor cleanup, Unicode streaming, command failures and orderly exit. Synthetic
children exercised framing, fatal decoding/EOF, response ordering, size/queue
bounds and shutdown escalation. Separate catalog probes checked concurrency,
persistence, failure/ownership/schema guards, directory-sync error handling and
real Pi header compatibility. Owner probes additionally covered concurrent resume,
startup failure/ownership fencing, unattended trust choices, awaited replacement,
persisted conversation trust and real bundled saved-workspace restoration. No
permanent tests are shipped. Additional materialization probes covered pre-ready
partial state without viewers, watermark ordering, copy isolation, effect separation,
slow-view limits, same-batch settlement/runtime replacement and live-budget cleanup.
An unchanged real Pi with an offline fixture exercised assistant/thinking/tool-call
streaming, tool partial/final output and direct bash (including completion during
an active run and reconciliation at settlement). This was not a full side/spawn,
real-provider retry/compaction or frontend acceptance check. See
`../docs/SERVER-MODE-CONTRACTS.md` for evidence and remaining platform checks.
Command/control probes additionally covered concurrent duplicates, takeover and
reconnect fencing, backpressured writes/runtime replacement, main/side abort
scoping, clear-before-abort and clearing rejection, recovered queue text, receipt
reopen/capacity/failure cases and consecutive fanout after slow-controller eviction.
A real 20-second lease/renewal check passed. Unchanged Pi exercised unattended
startup dialogs, stale-controller replies, duplicate suppression, idle abort and
side reply through an isolated scratch extension fixture; no provider calls were
needed. Active abort ordering was synthetic, not a real-provider run. Physical
power loss, Linux and frontend/service acceptance remain unverified; those
pre-SQLite probes did not execute Node 22.19.

Non-slash queue checks additionally passed typed duplicate/revision/state/order,
readiness and settlement gates, handled hooks/dialogs, takeover/detach, real
30-second edit-pause expiry, deterministic deferred-write/runtime fences, retained
native/main/side abort behavior, stop/reopen and copy isolation. Fault probes
covered atomic capacity refusal, sending-checkpoint failure before dispatch,
no pause resurrection, schema compatibility and text/metadata headroom. Review
identified Pi's user-event-before-history-append gap; a synthetic history-loss
fixture verified recoverable original/edited text in receipts after reopen, and
near-capacity text receipts completed/reopened without growing their ledger charge.
An unchanged Pi child with an isolated offline streaming provider exercised two
actual turns, duplicate suppression, delayed settled handlers with false streaming
state, handled input hooks, dialog takeover/cancellation and active abort preserving
accepted text. These are macOS component checks, not full bundled extension,
real-provider recovery, Linux or frontend/service acceptance, and did not run on
Node 22.19. Temporary
probe scripts are not shipped. See the contracts document for commands and limits.

Rename checks additionally passed synthetic duplicate/control-transfer/detach,
actual deferred-write readiness/history fences, private-result isolation, queue
exclusion/reopening, native/main/side abort boundaries, uncertain outcomes, atomic
receipt/name persistence faults and old schema-1 compatibility. Unchanged Pi 1.3.0
with isolated state and scratch startup/input-hook extensions exercised the real
bundled title/lifecycle modules: normalization, refusal, name/label persistence,
handled hooks, immediate successive commands and clean reopen without replay.
A scratch-only helper fault after the name write verified partial-mutation uncertainty.
These historical checks used macOS/Node 26.12, not Node 22.19, and were not full
bundled startup, provider, Linux or frontend/service acceptance. Fresh B1 checks
above now cover bundled startup and Node 22.19; see the contracts document.
