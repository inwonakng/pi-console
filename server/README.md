# Host-side Pi owner (in development)

This package contains the independent service and default Neovim attachment,
typed single-session operations, HTTP/WS hosts, owner resource reads/completion,
workspace review/guarded saves, saved-session archival/deletion and live frontend
effects. Stable/dev full and server-only packaging includes explicit macOS launchd
and Linux user-systemd startup management. Symlink/submodule staging/restoration
remains unsupported. Cross-host/no-shared-storage, Linux and Node 22 verification
remain open for the current delivery; macOS delivery does not establish full
server-mode acceptance.
See [`../docs/SERVER-MODE-C.md`](../docs/SERVER-MODE-C.md) for the mutation inventory,
protocol/outcome rules, fresh macOS evidence and remaining boundaries. The plans and
active B3 handoff are unchanged. B1–B3 evidence in the contracts report remains
historical unless explicitly rerun. Ordinary launches use the local service;
installed Pi is unchanged.

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
built-ins, the locked `ws` transport dependency and the repository's shared `pi/scripts/managed-process.mjs`; actual execution uses the installed Pi CLI discovered on PATH.
Both installers build this package in a staged runtime, then prune build-only
dependencies. `scripts/install.sh [--full|--server-only]` selects stable;
`scripts/install-dev.sh [--full|--server-only]` selects an immutable dev snapshot.
Mode is preserved when omitted. Old runtime trees remain unchanged across updates,
including same-commit mode changes. Installation never starts/restarts services.
Installers do not require Pi. Local startup discovers an external `pi` CLI on PATH
and fails if it is missing or older than 1.3.0. Installing Pi later requires no pi-console reinstall,
and remote clients need no local Pi. Installers require Node >=22.19.0 and never
modify those executables. Both installation modes require Git >=2.45.0 and verify
`merge-tree --write-tree --merge-base` with raw tree operands, as used by workspace
integration. Full mode additionally checks Neovim >=0.12.0, `vim.pack.add`,
Tree-sitter runtime ABI >=13 and Tree-sitter CLI >=0.26.1 (`generate`/`build`),
plus the compiler/download tools listed in the main README. Server-only mode
performs no Neovim or Tree-sitter checks. Keep executable resources unchanged
while work is running.

## Service usage

Ordinary local launches ensure the service, create in the invocation directory and
attach. Overview/sidebar launches ensure discovery without creating a conversation.
Explicit attach/resume never starts a replacement owner. `--service` remains an
optional spelling for existing scripts. No failure falls back to editor-owned Pi.
Source-only use can build manually above. Keep the service profile on private local
storage. Never delete `owner.lock`, adopt old editor state or auto-replay a mutation.
The default root is `~/.local/state/pi-console/service/<channel>` on macOS and Linux.
`XDG_STATE_HOME` does not affect service state. Use explicit `--root` for a different
profile; no state migration is performed. Frontend organization/drafts have separate
XDG-aware paths.

```sh
# Independent execution host: no Neovim/tmux required. Discovers pi on PATH.
bin/pi-console server run
bin/pi-console server start
bin/pi-console server status
bin/pi-console server list
bin/pi-console server create --cwd /absolute/project --id explicit-request-id
# Full client: new in this directory, discovery only, attach live, or resume saved.
bin/pi-console
bin/pi-console --overview
bin/pi-console --sidebar
bin/pi-console --attach SERVICE_SESSION_ID
bin/pi-console --resume SERVICE_SESSION_ID
```

Use `--root /short/private/path` on both service and frontend for an isolated profile;
Unix socket paths over 100 bytes refuse. Each running profile needs a separate network
port; use `server start/run/enable --port PORT` (default `8443`), or `server restart
--port PORT` to change it. Stable and dev instances also need distinct ports. Service CLI also accepts `--channel stable|dev`;
the launcher selects its existing channel. The frontend displays the target channel,
host/build and controller separately from Pi tool permissions. Another dev checkout
or stable installation cannot administer the same profile. Explicit compatible
attachment remains allowed. Legacy `--session PATH` files remain untouched; open
those explicitly through `pi-stable`/`pi-dev --session PATH`, not a service identity.
Missing service/build/version/channel errors do not start local Pi as a fallback.

Normal `server stop` / `restart` saves/stops idle sessions but refuses active
work, accepted queues, approvals, startup/transitions or known managed nested work.
An intentional `--force` interrupts owned work, retains history/workspaces and waits
for managed cleanup. Cleanup failure exits the owner with its claim retained; it does
not leave a falsely healthy listener or authorize replacement. SIGTERM/SIGINT are
explicit forced administrative shutdown, not frontend detach. Headless installation
is available through `--server-only`. Confirmed session restart/kill
are attachment-bound commands, separate from these service administration actions.

After owner death, `server reconcile` invokes the existing B2 managed recovery gate;
then explicitly `server start` and `server resume --session ID`. Neither ordinary
start nor resume performs reconciliation. Known unresolved managed work blocks it;
possible unknown escaped descendants do not. No command/queue/approval replay is
allowed. The operational recovery path passed macOS B3 checks on Node 26.12 and actual
22.19; Linux remains unexecuted.

### Service environment and startup

Installation never enables startup. On macOS, `server enable` installs a per-user
LaunchAgent; on Linux it enables a user-systemd unit. Enable also starts/discovers
the service. `start` uses that supervisor when configured, or a detached process
otherwise. Neither policy automatically restarts after exit/crash: retained claims
must be inspected, never automatically reconciled. `stop` leaves startup enabled;
`disable` performs guarded IPC shutdown before unregistering startup. Normal
stop/restart/disable refuses work at the owner's execution boundary, not from a
previous status snapshot. `--force` is intentional authorization to interrupt
owned work; an in-flight host lifecycle admission can still refuse and require
an explicit retry. Idle sessions are stopped and saved, not resumed on restart.

Neovim Hosts (`<leader>ph`) and the web Hosts panel offer a confirmed Restart
server action for local or connected hosts. `service.restart` accepts only the
current host ID/epoch, a request ID, explicit confirmation and a force boolean.
A detached coordinator uses the same guarded management path as the CLI, selects
the target installation's current build and records its outcome in private
`service-restart.json`. `service.restart.status` reads the original request
(`serviceEpoch`/`id`), or the latest durable outcome with an empty payload.
Frontends reconnect and verify the replacement epoch/build without replaying the
mutation or automatically resuming saved sessions. Last server restart / Last
restart inspects the latest outcome. A failed replacement can require shell-based
inspection of the service log, outcome and retained claims. Installation and
frontend restart remain separate.

Restart/status are exposed on unauthenticated direct and registered-host streams,
under the same trusted-network restrictions as session control. `service.stop`
remains local-only. In-epoch request IDs are deduplicated (128 attempts per owner);
only the latest durable restart outcome is retained across owners. An unresolved
accepted outcome blocks another frontend restart; it is never treated
as permission to replay or reconcile. The coordinator detaches its IPC before
shutdown and requires the existing systemd `KillMode=process` policy.

```sh
pi-console server enable
pi-console server status
pi-console server stop
pi-console server start
pi-console server restart
pi-console server disable                 # --force only to interrupt work
```

Use the matching `pi-console-dev` commands for dev. `--root` selects a private
profile for every command. Enable accepts `--supervisor-dir DIR` for isolated
LaunchAgent/unit definitions; disable/status discover that directory from the
private profile registration. A launchd definition outside `~/Library/LaunchAgents`
is for isolated/manual bootstrap and is not discovered automatically at login.
Enabling while a detached owner is live writes future-startup registration without
launching a competing owner. Labels include the channel and profile path hash.
Exact definitions, loaded-definition paths and installation/checkout ownership
are checked before management. Changed/unrelated definitions refuse rather than
being overwritten or unloaded. Management commands serialize through
`<profile>/management.lock`; remove a stale lock only after confirming no manager
is running. A retained owner claim with no reachable service refuses enable before
any startup registration, including from the original checkout; inspect/reconcile
explicitly first. A live owner must belong to the same installation/checkout.

Startup registration is published as complete, synchronized JSON before publishing
the complete definition. Interrupted setup can leave registration without a
definition: status reports `definitionPresent: false` and `enabled: false`; retry
`enable`/`start` to publish it, or `disable` to remove registration.
Failed writes never publish partial JSON/definitions; temporary `.tmp` files are
not startup definitions. Disable removes registration last and can be retried after
interrupted definition removal. Changed/unowned definitions still refuse management.
A stale management lock still requires the inspection described above.

Startup definitions reference the installation's `current` selection for the next
process; a running owner resolves and pins its release. Updates change neither
the registration nor live processes. Status summarizes the server, login startup,
version, sessions, connection URLs and file paths. `server status --json` retains
full details, including `buildId` (running), `selectedBuildId`, `restartRequired`
and startup registration. A stopped profile reports `running: false` and
`claimPresent` in JSON; the summary warns when an owner lock remains.
Restart waits for the departing endpoint and supervisor process before starting
selected code. Old runtime trees must remain while their processes run.

Supervised processes run without a shell under `env -i`: HOME, PATH and available
USER/LOGNAME/LANG/LC_ALL/TMPDIR/PI_CODING_AGENT_DIR are captured at enable time.
Desktop session variables (including DBUS_SESSION_BUS_ADDRESS and XDG_RUNTIME_DIR),
ALERTER and PI_NOTIFICATION_*/PI_COMPLETION_*/PI_PERMISSION_* notification settings
are also captured. Desktop notifications run on the execution host without requiring
an open frontend or overview; Linux requires `notify-send` and access to the user's
notification service, and macOS requires `alerter`.
`--path` overrides PATH and must include Node (for Pi's shebang) and required tool
executables. Pi is discovered from the invoking PATH, and Pi/Node paths are resolved
and saved internally for startup. Provider, model and TLS configuration paths
supplied at enable are retained. Shell rc files,
frontend tmux variables, shell-exported API keys, SSH agent sockets and unrelated
environment variables are not inherited. Store provider credentials/settings on
the execution host through Pi's normal private agent directory. To change the
captured startup environment, Pi installation or options, disable then enable
again; repeating enable retains the registered configuration. Detached startup instead uses its invoking host shell
environment, with worker frontend/tmux markers filtered by the owner. A frontend
connecting to an existing service never changes its environment. Keep external Pi
and Node resources unchanged during live work; installation does not upgrade them.

Default definitions live in `~/Library/LaunchAgents` or
`${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user`. macOS user LaunchAgents require a
GUI login and do not promise execution before login or after logout. Linux
user-systemd requires a working user manager; execution without a login/after
logout requires administrator-approved lingering (`loginctl enable-linger USER`).
This command is never run automatically. Laptop sleep suspends execution; a sleeping
host is unreachable and cannot continue tools until awake. OS shutdown/logout may
interrupt work independently of guarded CLI commands. No uninterrupted execution
across restart, reboot or sleep is promised.

Disable/uninstall retains service catalogs, Pi JSONL, workspaces, recovery data,
credentials and runtime snapshots. There is no automatic data purge. Back up a
quiescent complete profile before any separately authorized manual removal.

### Remote attachment

Every service listens on all IPv4 interfaces (`0.0.0.0`), port `8443` by default.
No opt-in, device credential, TLS configuration or certificate is required.
**Anyone who can reach this port can view and control sessions as the execution
host's user. Traffic is unencrypted.** Use a trusted network/VPN and firewall rules;
pi-console does not limit the listener to VPN interfaces or provide authentication.

`server start`, `restart` and `enable` confirm the running version and print a
localhost URL, with a warning if the running build differs from the selected build.
`server enable` confirms login startup separately from the running process and
states when an existing server was left running without a restart.
`server stop` confirms successful shutdown, or reports that the server is already
stopped. `server status` shows a readable summary; `server status --json` retains the full JSON,
including `network.bind`, `network.port` and candidate HTTP URLs using the machine
hostname and IPv4 addresses. Use a hostname or VPN IP reachable from the client;
hostname resolution and firewall access are external.

```sh
bin/pi-console server start
# On another machine, using the matching launcher channel:
bin/pi-console --remote http://host.example:8443 --attach SESSION_ID
```

`:PiHosts` adds an HTTP origin and optional alias, confirms the service identity and
saves it for later connections. Removing a host disconnects and forgets that entry;
it does not stop execution or change the other machine's configuration. Each service
reports only its own sessions, so reciprocal registration does not forward remote
summaries recursively. An unavailable enabled host is shown as unreachable.
A remote launch without an attachment opens the session selector rather than creating
work using the frontend's local cwd. Saved host identities and protocol/channel checks
remain in effect; these detect accidental replacements, not impersonation.

The bridge and browser frontend use WS `/v1/stream`. The optional web UI is disabled
by default. Set `server.webui.enabled: true` in
`${XDG_CONFIG_HOME:-~/.config}/pi-console/config.yaml` (`config-dev.yaml` for dev),
restart the matching service, then open `http://HOST:8443/` (or its configured port).
The page uses the serving host's channel automatically. The UI uses the same
trusted-network access policy without authentication. Browser WebSockets require
an enabled web UI and either its direct HTTP origin or an exact origin listed in
`server.webui.allowed-origins` (for example `https://pi.hyrax-pollux.ts.net` behind
a reverse proxy). The list defaults to empty and changes require a service restart.
Forwarded headers do not grant access; unrelated website origins are rejected.
The web Overview combines open sessions across registered hosts through the read-only
`/v1/hosts` registry and same-origin `/v1/hosts/<key>/stream` relays. Relay targets come
only from enabled host registrations; saved identities and channel checks apply.
Relayed local profiles cannot perform local-only service administration. Session
history and explicit resume are separate from the overview. See
[web frontend usage and limitations](../web/README.md).

Service shutdown remains local-only. Neovim attach/reconnect acquires control if
unclaimed, otherwise stays view-only, and never replays mutations. Remote capacity
is separate from local IPC; frames, output and subscriptions remain bounded, and a
dropped subscription destroys its transport even when its writer is backpressured.
Neovim displays the endpoint, host/channel identity and control role.

Existing saved HTTPS hosts are read as HTTP with the same address/port; obsolete
credential/CA references are dropped when the host list is next saved. Credential,
CA and certificate files are left untouched. Old startup `--tls-config` arguments
are ignored without reading the file; the default port applies unless `--port` is
set. Explicit start/restart/enable of a stopped registered service removes obsolete
startup arguments. Existing running services retain their old runtime until restarted.

### Attachment UI

C adds typed model/thinking/mode pickers and cycles, owner `!` / `!!` shell,
native steering / `:PiFollowUp`, retry/compaction settings through the command picker,
history navigation/fork/clone/delete, `:PiWorkspace` enter/integrate/discard,
side/spawn controls, retitle/notifications/usage and confirmed owner-session restart.
`:PiKill` / `<leader>pk` stops the session worker and closes this frontend after
preserving drafts. `<leader>qq` only closes the frontend; the worker keeps running.
In the Neovim overview, `dd` stops the selected session and closes the controller
attachment captured when the stop is accepted. Other attachments remain open.
`<leader>pi` interrupts the selected turn without stopping the worker or taking control.
Pinned sessions without a runtime display `Inactive`; an unreachable host displays
`(unreachable)` in the Host column and its session activity is `Unknown`.
`:PiOperations` inspects outcomes/recovered history text; `:PiHostRequest` reviews an
unresolved create/resume ID. These do not replay work. See the C report for exact
arguments, confirmations and what completion means.

- `:PiControl` / `<leader>pc` acquires control, confirming before replacing another
  controller. Attach/reconnect automatically acquires unclaimed control; otherwise
  it stays view-only. `<leader>ph` / `:PiHosts` manages hosts;
  select a host and "Attach current frontend" to switch the conversation frontend
  to it. `<leader>pC` / `:PiCd` selects a directory on that host. These
  selections and new frontend windows create no session until the first prompt
  or shell submission. Pre-start settings are applied before that submission.
- `<C-CR>` text or slash commands, `<Esc><Esc>` abort; shared queue via `:PiQueue` / `<leader>pq`.
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
- Transcript Enter opens existing thinking/skill/tool inspectors, nested retained
  tool output, subagent artifacts and execution-relative Markdown/file links through
  the owner. `:PiTranscript` (also in the history picker) renders managed history,
  including branches and pre-compaction records, separately from the live tail.
  Skill `f` inspects the current discovered owner file; ordinary inspection shows
  recorded skill content. `@` completion uses the execution cwd on the owner.
  `:PiNew` selects an owner, then browses its directories without changing frontend cwd.
- E1 resource buffers are host/channel/session/context-qualified, non-writing views.
  Large text uses 64-KiB pages: `n` next, `p` first, `r` reload. Complete rendered
  documents are limited to 4 MiB; larger documents explicitly open as paged text.
  Reads need authentication and a live attachment/context, but no control grant.
  Context/selection changes, disconnect and revocation fence pending reads; reconnect
  does not replay mutations or reacquire control. Only the latest completion query
  is cached, for two seconds, qualified by host/channel/epoch/session/revision/cwd.
- `:PiWorkspaceReview` / the diff shortcut opens the current owner's workspace review;
  `:PiWorkspaceReviews` selects current/historical task reviews. Workspace tool output
  `d` opens its owner review, pinning historical comparisons to the recorded result.
  The integration preview's explicit "Review / modify" choice also opens the review
  here without integrating. The frontend renders metadata, ignored-file notices and
  before/after diffs.
  Current supported text buffers use `:write`; historical buffers are read-only.
  In the summary, `S` stages the reviewed working paths and `U` resets the entire
  owner index to HEAD. Staged-only differences are marked `=` and are not staged by
  `S`. In a file view, `s` stages, `u` unstages and `X` confirms baseline restoration.
  Restoration checks for unsaved review edits both before confirmation and immediately
  before sending the confirmed action.
  `r` in the summary opens fresh versions without replacing local drafts.
  `gO` opens current owner content separately, `gD` opens the owner patch, and `gS`
  looks up the original review command ID. Uncertain/disconnected operations retain
  that identity; local text and its recovery remain separate and never replay.
- `/` completion and `:PiCommand` / `<leader>/` discover the attached runtime's
  extension commands, prompt templates and skills. They never use a frontend-local
  command list. Slash submissions run through the owner's shared prompt queue;
  TUI-only built-ins are not provided by Pi RPC. Excluded resource actions report
  unavailable. No raw RPC tunnel, frontend-local owner-path lookup or implicit
  Pi fallback exists. Owner `file://` links never reach the OS opener; only HTTP(S)
  links may open externally. Other received URI schemes refuse. Clipboard/Zotero and
  explicitly local helpers remain frontend-local; owner provider setup is separate.

### E1 resource scopes

The typed transport exposes `resource.read`, `resource.complete` and host-level
`host.directories`; these are read operations, never commands or tool execution.
Session resource payloads include the current `runtimeRevision`; directory requests
include `serviceEpoch`. The owner checks context/authentication across asynchronous
work and revalidates before returning data.

| Read | Allowed owner scope |
| --- | --- |
| `history` | Exact catalog-managed Pi JSONL, after header/identity/ownership validation. No arbitrary session-file input. |
| `file`, file completion | Active published workspace/repository root, resolving relative paths against execution cwd. Original/retained checkouts outside that root are not implicitly readable. |
| `skill` | Exact currently discovered skill files, including configured paths outside the workspace. This does not grant their supporting directories. Recorded content remains inspectable. |
| `output` | Exact `fullOutputPath` metadata observed in managed history/live results or validated child transcripts. The file must be inside the owner's temporary root, single-linked, regular and service-user-owned. Arbitrary path mentions are not authorization. Missing retained output refuses. |
| `spawn` | Fixed brief/result/transcript/status/subagent-prompt files for a run whose persisted parent belongs to the managed conversation; bounded validated child ancestry is supported. Patches additionally require the matching child-workspace/recovery relation and fixed artifact path. |
| Host directories | Directory names on the owner before attachment, including explicit absolute project selection. This grants neither arbitrary host file reads nor frontend cwd changes. |

Paths containing traversal/control characters refuse. Below trusted canonical roots,
all symlink components (including in-root links) refuse. File descriptors are opened
nonblocking with `O_NOFOLLOW`; type/ownership and path/stat identity are checked before
and after reads. Continuations carry a stat-based version; changed files return
`resource_conflict`, never mixed-version content. UTF-8 chunks are at most 64 KiB;
binary/invalid UTF-8 content refuses. These checks are not isolation from hostile
same-user filesystem mutation.

Directory pages contain at most 128 entries, with a 10,000-entry scan limit. Output
reference discovery limits individual JSONL records to 16 MiB, total history/transcript
scanning to 256 MiB/128 files, run discovery to 256 runs/16 ancestors, and aggregate
provenance metadata to 16 MiB. Resource filesystem work has four global slots; session
preflight also has four slots. Limits refuse explicitly and yield during scans; slow
resource peers do not hold Pi's reduction lane. Historical nested output not retained
by Pi remains unavailable; E1 does not fabricate it or alter Pi's JSONL format.

### E3 saved sessions and live effects

`:PiSessions` offers archive/unarchive and deletion on the selected owner. Open
conversations remain protected; use current control to explicitly kill them first.
`host.saved {serviceEpoch, sessionId}` returns a versioned preview and the owner's
trash/permanent mode. Host-scoped `host.archive {sessionId, expectedVersion,
archived, confirmed: true}` and `host.delete {sessionId, expectedVersion, mode,
confirmed: true}` use the existing durable IDs/status lookup and serialized lifecycle
lane. Archival is catalog metadata; session paths and workspace associations stay
unchanged. Deleted identities retain receipts/queue recovery data but cannot resume.

Deletion confirmation lists linked worktrees, recovery patches and ignored-file loss.
The owner revalidates the preview before admission and again inside its fixed unsaved
Pi helper. Linked workspaces in use, retained child workspaces and unresolved managed
writers block removal. Recovery capture and removal share the workspace lock. A
finalized retained worktree with newer edits refuses removal rather than overwriting
its existing integration snapshot. Workspace records/patches and applied destination
changes remain. Partial/unproven cleanup is uncertain; unresolved helper execution
fences the owner until shutdown and explicit reconciliation.

`:PiSavedOperations` only looks up original IDs. Uncertain/unknown requests protect
the selected conversation until explicit review permits a new request; reconnect
never repeats them. Frontend notifications and editor effects are live-only,
attachment/grant/runtime/cwd-bound offers revalidated through `effect.inspect`.
Editor text opens a separate recoverable draft. Main-turn, side-input and background
subagent notifications retain their initiating recipients; ambiguous overlapping
sources are dropped. Desktop executables, sounds/timeouts and icons are frontend-local.
Snapshots and reconnect never deliver these effects. `:PiOffers` remains inspect-only.

### E2 review and save boundary

`resource.read` additionally accepts `workspaceReviews`, `workspaceReview {workspaceId?}`
and `workspaceReviewFile {reviewId, path, resourceId?}`. These authenticated reads need
no controller. Review IDs bind the owner/session/runtime and exact workspace metadata;
file reads return signed resource references plus the E1 stat version and content hash.
Action snapshots are captured before asynchronous file rendering and rechecked after
the final await; changed bytes cannot receive a reference for an older displayed diff.
Historical `before`/`after` inputs must match a workspace result in managed Pi history;
client-supplied repositories or arbitrary Git revisions never grant access. Historical
ignored-file bytes were never retained; notices remain available. Partial integration
comparisons describe the intended merge rather than a post-failure snapshot.

`workspace.review.save {resourceId, expectedVersion, text}` replaces only existing,
single-linked, service-user-owned regular UTF-8 files originally read in the current
managed task review. This includes existing untracked files and entry-selected ignored
files. A text save never creates/deletes/stages files or edits binary/symlink/submodule
resources. It is separate from the narrow index/restoration operations below.

`workspace.review.stage {actionId}` and `workspace.review.unstage {actionId}` accept
signed references from a file page or the summary's distinct `stageId`/`unstageId`.
Stage-all includes only reviewed baseline-to-worktree changes and untracked files;
it preserves staged-only content whose working bytes equal the baseline. Unstage-all
resets the full index to HEAD without reading worktree files, including when an
unrelated worktree resource is too large or unsupported. Individual actions bind
that file's bytes/mode/parent identity plus the exact index and HEAD.

`workspace.review.restore {actionId, confirmed: true}` requires an individually
reviewed current file. As in local Diffview, a baseline-existing regular file is
restored in both worktree and index, including recreation of deleted parents/files
and baseline executable mode. A baseline-absent working file is removed without
changing its index entry, even if its addition was staged. Original bytes, existence
and mode are durably checkpointed before restoration as
`command.status.result.reviewRecovery` (`encoding: "base64"`, `content`, `path`,
`existed`, `mode`). Partial outcomes retain this recovery in the original receipt;
it is data for explicit inspection, never an instruction to restore/replay.
Regular binary/non-UTF-8 files support index actions and raw baseline restoration,
although their bytes cannot be edited as text and their patch may be unrenderable.
Stage/restore of symlink/submodule resources is unsupported, including staging their
deletions. Full unstage changes only the index and may clear such staged changes.
Integrate/discard confirmations and the legacy local Diffview workflow are unchanged.

Saving rechecks authentication/current control, epoch/session/runtime/workspace,
metadata, path components, opened inode/stat version and exact original bytes after
asynchronous work and immediately before synchronous descriptor writes. A deferred save
loses authority on takeover, detach, revocation or context replacement, unlike accepted
prompt work. Conflicts fail without overwriting owner content. Write/I/O uncertainty
stays uncertain in the original receipt; no automatic new-ID save occurs. These checks,
like E1, do not isolate the service from hostile same-user filesystem mutation.

Index/restoration references additionally bind the task's Git directory to its
recorded destination repository's common directory. Preparation uses a private
alternate index while holding the real `index.lock`; it never changes HEAD or runs
hooks/clean/process filters. After preparation and the durable recovery checkpoint,
a synchronous boundary rechecks authority, workspace metadata, paths/parents, HEAD,
index and current bytes before touching the worktree or publishing the index by
rename. Any error after worktree/index mutation starts is uncertain. Reads disable
Git's automatic index refresh as well as optional locks, so viewing a stat-dirty
file cannot rewrite the index and invalidate its own reference.

Review responses are limited to 4 MiB, text edits/blobs to 1 MiB, changed files and
ignored-file notices to 512 each. Catalog scans allow 1,024 records with the existing
aggregate 16-MiB metadata budget. Read-only Git helpers have a 10-second bound and
4-MiB output budget; configured clean/process filters, external diffs, textconv and
filesystem monitors are disabled. Index snapshots allow 16 MiB; stage-all permits
4 MiB of current bytes and 128 KiB of paths. Per-file content/restoration is limited
to 1 MiB. Full unstage has no worktree byte requirement. Compact review receipts
reserve 40 KiB; restore reserves 2 MiB for its base64 recovery, stored in SQLite's
existing recovery table. SQLite schema, receipt retention, queues and Pi JSONL stay
unchanged.

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
`snapshot`, typed `session.read`, `resource.read`, `resource.complete`, `host.directories`, `command`, `grant`, `heartbeat`, `command.status`, `effect.inspect`,
`service.restart`, `service.restart.status`, and `service.stop` (local-only). All have typed allowlisted fields; raw RPC is rejected. A connection
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
The stdio Node bridge relays requests/events and renews an existing attachment's
control grant independently of Neovim's UI loop. It never acquires control or replays
execution. Ordinary bridge/client requests use at most 30 slots, reserving capacity
for grant lookup and renewal. Frontend EOF, process death, or output failure closes
the attachment; blocked output remains bounded.

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
  It validates managed history, claims ownership before spawning, runs
  trust/workspace initialization, and awaits managed cleanup before releasing ownership.
  Session rows expose an optional `live` runtime summary instead of a stored lifecycle
  status. `stopReason` retains user-stop, service-shutdown, or error information for
  recovery; it is not an activity status. Lookup/list/snapshot never start workers.
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
  source snapshot for direct checkout launches, hot reload, or a pin on arbitrary
  user/project extensions. F1 dev installs instead ship immutable application/dependency
  snapshots; rerun the dev installer after edits. Management across snapshots checks
  their source-checkout ownership, without accepting another checkout's dev service.
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
- Desktop notifier launch is disabled in service workers. E3 publishes live intents
  for recipient-bound frontend delivery. Sanitized TMUX prevents host-side reviewer UI;
  existing retained-workspace/manual-review data remains. Existing external tmux,
  HTTP MCP, remote jobs and explicitly handed-off services are not descendants to kill.

**Limit:** detached/reparented processes between samples, group/PID namespace changes,
privilege changes, hostile PID churn and work handed to existing external services can
escape tracking. Same-user process sampling is not a security boundary or pidfd-strength
identity. Unknown escaped work may keep writing after cleanup and explicit resume; it
alone does not block resume. Known unresolved work does. No VM/cgroup/privileged helper
or new production package is required. The registry, recovery evidence and per-epoch
resource manifests currently have no garbage collection.

B2 introduced inspection-only offers; E3 adds the bounded live frontend handlers
above. Offers carry owned-stream provenance, recipient attachment/grant and
runtime/cwd context. Nonrecipients and stale buffered deliveries receive the sequence
envelope without an effect. `OwnedSession.inspectEffect(attachmentId, token, update)`
rechecks current grant/token, epoch, owner runtime revision, cwd/readiness and storage
before returning copied data. Offers are absent from snapshots, never replayed, limited
to 128 / 4 MiB (2 MiB each), and may be evicted. There is no promise that an uncorrelated
effect originated from that attachment. E3 binds recognized execution effects to their
initiators and drops ambiguous overlapping sources; local drafts remain separate.

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
not itself an atomic dev runtime snapshot; F1 installers supply a staged snapshot.
`create(cwd)`
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
accepted queue below rechecks this gate at its actual pipe write position.
All APIs remain owner-internal.
`ready()` records initial startup completion; use the current snapshot/gate to
check later availability, not that already-resolved promise.

Snapshots contain copied startup/interactions and materialized conversation state.
`lookup()` and `subscribe()` never start or restore anything.
`OwnedSession.stop()` is explicit low-level owner shutdown, not detach and not an
unrestricted frontend stop endpoint. `HostOwner.close()` refuses active/initializing
sessions or in-flight creation; it never silently stops them.

The catalog's exclusive claim is not proof that all worker descendants have died.
It refuses stale claims and unresolved ownership rather than guessing from a
PID or replaying work. Ownership is claimed before child launch and released only
after managed terminal evidence is available. User-stop intent is persisted at
command acceptance, without releasing that ownership fence. SQLite catalog v2
removes the old lifecycle state column and migrates its recovery information into
`stopReason`; histories and command receipts are retained.
A live catalog cannot be closed. Failed exit persistence or known unresolved managed
jobs retain ownership and refuse replacement. Explicit reconciliation and default
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

Nonempty text up to 1 MiB UTF-8 is accepted (trimmed on save), including slash
commands. Pi dispatches registered extension commands and expands templates/skills.
`prompt.submit` never forwards raw RPC; shell/settings/history/workspace/lifecycle
also have separate typed operations. Explicit `session.rename` remains a private
fixed bundled command.

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
and grant ID. The transport binds each caller to its attachment; these grants control
session editing, not network access. Heartbeat every 5 seconds with
`heartbeat(attachmentId, token)`; expiry is 20 seconds on `performance.now()`, not
client/wall-clock time. Heartbeats are ephemeral liveness checks, not durable
commands, and never reacquire a grant. Timer/authority checks expire old grants.
Neovim's bridge renews control while the editor process remains alive and connected,
including during modal prompts. Queue-edit reservation renewal still depends on the
visible Neovim editor, so an interrupted editing pause can expire without losing
session control. Control-loss reasons appear in the frontend header and `:PiLogs`
without opening another modal notification. Neovim attach/reconnect makes one
acquisition attempt if unclaimed; it never automatically takes over or reacquires
after losing control.
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

### Editable accepted queue

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

Slash commands use the same controller admission and trust/workspace dispatch gates
as ordinary prompts. A `handled` response retires the queue item without waiting
for a user message or `agent_settled`, even when the handler changed the context;
state is refreshed after handling. Command-handler errors are reported to the
frontend without disabling subsequent submissions. `handled` establishes handling,
not extension-command success. Typed bundled operations and explicit managed rename
retain their correlated result policies. Trusted input hooks still execute inside
Pi; the owner fences observed context changes, not arbitrary unpublished extension work.

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
