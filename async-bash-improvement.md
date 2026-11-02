# Async Bash improvement

Status: Implementation complete across all six phases; targeted Linux/RPC/Neovim verification and reviewer corrections complete. Pending final integration.

## Purpose

Add explicit background Bash execution without weakening per-command permissions, changing ordinary foreground results, or tying command lifetime to a frontend connection. Implement this in this repository's `pi/` package alongside its sandbox integration, not in sibling `../pi-extensions`. The tools must work in general Pi TUI, RPC, and headless use; pi-console adds job controls and live status.

This document records approved behavior and the implementation sequence. Revalidate repository state and dependency APIs before editing. Technical choices such as patch delivery and worker synchronization transport remain implementation details within these constraints, not unresolved product decisions.

## Approved behavior

### Tools, output, and ownership

- Extend regular `bash` with explicit `background: true`. Foreground remains the default, with its existing output schema, nonzero-exit behavior, and truncation behavior unchanged.
- Add `bash_control` with `list`, `status`, `output`, `join`, and `stop` actions.
- A background launch returns a genuine job identity and current state, not a fabricated exit code. Use distinct background-start and terminal-result schemas.
- Capture stdout and stderr with bounded in-memory responses and file-backed full logs. Terminal results record exit code or signal, sandbox-blocked information, and cleanup outcome separately.
- Persist metadata, full logs, and killed job identities for inspection after stop and resume. Resume never restarts commands, adopts old PIDs, resurrects processes, or replays completion notifications.
- Jobs survive agent replies and frontend detach while their owning runtime remains alive. They end naturally, on an explicit deadline, on agent/user stop, or on owner session termination.
- Start deadlines after permission approval, not while the user is deciding. Do not automatically convert foreground timeouts into background jobs.
- Canceling `join` stops only the wait. Explicit `stop` waits for process and descendant cleanup and reports unresolved cleanup truthfully.
- Retain managed supervision's existing best-effort limits; do not claim containment of arbitrary escaped descendants.
- Session termination stops all owned jobs and awaits cleanup before shared sandbox reset. Child jobs belong to the child session and stop when that session ends.
- No interactive stdin or PTY support in the initial implementation.

### Interruption and completion delivery

- On user interrupt, stop the agent first, then ask whether to stop its running background commands too.
- No, cancel, or dismissal leaves commands running. With no running jobs, show no question. Headless operation must not hang waiting for this answer; leave jobs until their owner stops.
- Coalesce repeated interrupts instead of opening repeated questions or racing independent stop flows.
- Hold automatic completion delivery after interrupt until the next explicit user prompt or explicit collection/join. A completion must not immediately restart the just-interrupted agent.
- Continue live job-status updates while automatic agent delivery is held.
- Deliver each completion once. Explicit join/collection and automatic delivery must deduplicate one another.
- Track queued and actually delivered notifications separately: `clear_queue` can discard queued custom messages, so enqueueing is not proof of delivery.
- Use hidden follow-up delivery where needed, not visible transcript status chatter or fabricated user prompts.

### Future-only permissions, including subagents

- Permission-mode changes affect future actions only. Never kill or revoke an already admitted Bash job because its session's mode changes.
- Revalidate pending launches against current authority before admission, including launches that waited for approval or a preparation lock.
- Capture effective permissions at launch as an immutable snapshot, including effective session grants. Later grants apply to subsequent launches rather than silently expanding a running job's authority.
- Preserve existing once/session/domain permission UI semantics. One-use approval authorizes one execution, including its descendants and lifetime, not another launch.
- Apply mode changes to subagents too, without stopping the workers merely because the mode changed.
- Synchronize the new permission revision and effective authority before future child actions. Fence new admission until synchronization is acknowledged.
- Cover child local baseline, full-access, session-grant, and parent-delegated actions; all must obey updated authority. Updating only the parent router is insufficient.
- Preserve worker access ceilings. A readonly worker must not become writable when its parent broadens permissions.
- Keep already admitted child Bash jobs on their launch snapshot. Separate mode invalidation from session/branch teardown.
- Explicit user interrupt and session shutdown remain distinct worker-cancellation paths; do not redesign unrelated subagent lifecycle behavior.

### Rollback and workspace transitions

- Enroll canonical file paths only through explicit `edit` and `write`. Persist enrollment per session/workspace/branch, including no-diff edits.
- Snapshot enrolled files at later turn checkpoints. These are whole-file checkpoints, not writer- or hunk-attributed changes: other actors' later changes to enrolled files may be captured and restored.
- Do not enroll Bash-only paths through Git dirty scans. Reduced Bash rollback coverage is intentional and approved.
- Preserve legacy rollback records without interpreting their Bash-touched paths as new enrollment.
- Retain existing conflict checks and post-dialog rechecks. Changes after the recorded after-state must cause a conflict, not silent overwrite.
- Active or unresolved jobs block rollback, destructive workspace transitions, and runtime replacement until completed or stopped. Recheck guards after waits and dialogs and at mutation admission.
- Terminal jobs and unread results must not permanently block history navigation.

### User interfaces and resources

- Provide Neovim job list/details, bounded output paging and refresh, join, and stop.
- Show a separate running-command count in overview and statusline, including updates for completions while the agent is idle.
- Reuse existing status transport and typed service operations. Do not dump logs into status or inject status messages into the transcript.
- Provide basic native TUI command/status access. RPC confirmation must be generic and service-wide, compatible with the web interrupt path; a full web job dashboard is not required.
- Keep UI stop usable while a join operation blocks. Treat join cancellation as cancellation, not an uncertain session failure.
- Authorize durable output reads by owning session and job ID. Do not accept arbitrary frontend-supplied filesystem paths.
- Add no Alt-bound keys.

## Current context

Repository paths to inspect during implementation:

| Area | Paths |
| --- | --- |
| Bash, sandbox, permissions | `pi/extensions/access-mode.ts`; `pi/extensions/shared/{bash-sandbox,managed-bash,permissions,access-state}.ts`; `pi/scripts/managed-process.mjs` |
| Child authority and tool availability | `pi/extensions/spawn.ts`; `pi/extensions/shared/subagent-state.ts`; `pi/agents/*.md`; `pi/extensions/side.ts` tool allowlists |
| Checkpoints and transitions | `pi/extensions/{history,workspace,tree}.ts`; `pi/extensions/shared/{workspace-navigation,session-clone}.ts` |
| Service ownership and resources | `pi/extensions/shared/service-operation.ts`; `server/src/{host-owner,session-bundled,pi-conversation,resource-reads}.ts` |
| Neovim | `nvim/lua/pi-integration/{service-frontend,statusline,session-list,service-hosts,state,keymaps,service-resources}.lua` |
| Dependency and delivery | `pi/package.json`; `pi/package-lock.json`; `scripts/{build-runtime,install,install-dev,_install-common}.sh` |

A small shared Bash-jobs module is appropriate; do not introduce a generic task framework.

The checked repository and installed sandbox pin are `@anthropic-ai/sandbox-runtime` 0.0.77. The approved target is released 0.0.81. That version requires Node >=22.12; supported project installer/service paths already require >=22.19. Verify custom `PI_BINARY` paths rather than assuming they meet the requirement.

The existing execution-wide queue must become a short preparation lock plus independent lifetime ownership. Host workspace inspection still needs a true-idle barrier. These are different synchronization mechanisms.

Existing child fixed baseline local/full/session paths can bypass the parent router. Removing a mode-change stop listener alone would therefore be unsafe.

## Ordered implementation

### 1. Upgrade the sandbox and enable concurrent execution safely

1. Pin 0.0.81 and update the lockfile. Recheck exact released APIs before applying changes.
2. Add the approved narrow, maintained dependency patch: allow exactly `'*'` in **per-command registration validation only**. Preserve global schema validation and all filtering, explicit-deny, and address safeguards.
3. Deliver the patch through a reproducible, reviewed build-applied patch/artifact mechanism. Check the expected dependency source and fail on mismatch. Do not manually modify installed `node_modules` or select an unrelated patch framework without assessing project delivery paths.
4. Equivalent released upstream support may replace the patch only after checking identical semantics. No publishing or pushing is required.

Why the patch is necessary:

- 0.0.80 introduced `registerCommandNetworkLists` and its unregister counterpart.
- In 0.0.81, per-command `allowedDomains` validation rejects `'*'` although the matcher supports it. An upgrade alone cannot preserve one-use `networkAccess: true` any-host approval.
- The supported ask callback receives only `{host, port}`, with no command identity. HTTP request filtering is not a universal CONNECT/SOCKS authorization substitute.

Use one initialized manager with shared proxies, bridge, and monitor, not per-command initialization or a worker pool:

- Keep stable global `allowedDomains: []`, `strictAllowlist: false`, and an absent or permanently false ask callback. Global strict-allowlist mode disables the registration API.
- Copy each launch's approved domains or any-host scope into its own registration. Register `['*']` only after any-host approval.
- Generate a never-reused per-command ID with at least 128 random bits, for example `randomBytes(16).toString('base64url')`. UUIDv4 supplies only 122 random bits.
- Register before launch; unregister only after managed cleanup. Unregister failed starts too, and prevent stale callbacks from releasing another job's resources.
- Preserve deny rules and address guards. Do not silently replace current literal-IP or parent-proxy behavior with a blanket private-IP block.

Replace execution-wide serialization with a short preparation mutex:

- Cover scratch `process.env` mutation and macOS manager `allowUnixSockets` save/set/wrap/restore inside the mutex. Snapshot each launch's socket rules.
- Keep filesystem policy per wrap. The shared true-idle inspection barrier must still wait for active execution ownership, not merely for this mutex.
- Track active leases. Call `cleanupAfterCommand` exactly once per successful wrap; failed wraps already unwind their own count.
- Do not reset or globally clean up until processes and managed descendants are proven stopped. `managedUnresolved` retains ownership/resources and blocks conflicting operations.

Handle dependency compatibility explicitly:

- Since 0.0.79, filesystem path types are `string | {path, literal: true}`. Keep wrapper-generated profiles string-only or narrow the union correctly.
- 0.0.80 namespace restrictions can affect nested sandboxes and Chromium. Do not silently weaken policy to restore compatibility.
- Retain per-job denials from a store subscription, not only the global last-100-event tail at exit. The filesystem monitor's initial-policy limitation remains; do not promise complete diagnostics.
- Verify unchanged foreground behavior before building background tooling on this runner.

### 2. Make permission changes future-only across parent and children

Implement launch snapshots, permission revisions, and pending-launch revalidation before enabling independent jobs. Separate mode invalidation from teardown and synchronize child authority with admission fencing.

Update every child execution route, including local baseline/full/session grants and delegated requests. Keep the worker ceiling and existing permission UI semantics. Ensure synchronization neither revokes a running execution nor silently widens a readonly worker.

### 3. Add job ownership, control, persistence, and ordered teardown

Build the job registry and runner on managed-process supervision and sandbox leases. Define explicit running, terminal, and unresolved-cleanup states and distinct launch/terminal result contracts.

Expose `bash` background admission and `bash_control` actions, bounded output reads, file-backed logs, explicit deadlines, and independent join cancellation. Update tool allowlists where necessary.

Persist inspection metadata and logs without creating a restart mechanism. On owner teardown, stop owned jobs, await managed cleanup, release registrations/leases, and only then reset shared state. Keep child ownership tied to child session termination.

### 4. Add stop-first interruption and once-only delivery

Route interrupt through agent cancellation before the optional running-command confirmation. Implement headless behavior and repeated-interrupt coalescing.

Track held, queued, delivered, and explicitly collected completion state so abort, `clear_queue`, join, and natural completion cannot restart the agent unexpectedly or duplicate results. Keep status publication independent of automatic agent delivery.

### 5. Narrow checkpoint enrollment and guard transitions

Persist edit/write enrollment and carry those files through later turn checkpoints without Git-based Bash enrollment. Preserve old records and existing conflict behavior.

Integrate active/unresolved job guards with rollback, workspace changes, runtime replacement, and mutation leases. Recheck after asynchronous confirmation and immediately before destructive admission. Completed or merely unread jobs must not lock history indefinitely.

### 6. Connect service operations, resources, and frontends

Expose typed job status/control and session-scoped output resources, then add Neovim list/details, paging/refresh, join/stop, and running counts. Ensure control requests can progress while another request waits in join.

Wire generic RPC confirmation for the interrupt flow across service frontends, including web compatibility, and basic native TUI access. Publish idle completions through existing status mechanisms without transcript chatter.

Phase 6 contract clarification: frontend/native user joins and stops are observational;
only agent collection consumes a completion or releases its interrupt hold. Public
`bash.list/status/join/stop/cancel-wait` use bounded, invocation-correlated operation
flights separate from the mutation lane. Cancel-wait targets the join's returned
`waitId` and produces a typed cancellation, not session uncertainty. Durable output
uses `kind: "bash-job"`, opaque `jobId`, and `stdout`/`stderr` only. Retired side
logs are inspectable by known ID through their parent's immutable owner manifests;
the main live list/control UI remains scoped to its own session. Append-only log
paging preserves identity versions across growth; refresh starts at offset zero.

## Verification and acceptance

Use temporary, terminating scratch probes as needed; do not commit tests or probe artifacts. Run Linux and macOS execution checks separately and report unavailable platform coverage explicitly.

### Sandbox and authority

- Run overlapping commands A and B: A has no network permission; B has one-use any-host permission. A stays denied while B runs and after B exits; neither receives the other's scope.
- Exercise domain approvals, explicit denies, and existing address safeguards, including relevant literal-IP/parent-proxy cases. Verify unique registration IDs, failed-start release, and cleanup after stop.
- Confirm only per-command validation accepts `'*'`; global validation remains unchanged. Confirm the patch applies reproducibly and rejects unexpected dependency source.
- Switch modes while jobs run: their launch authority stays fixed, while new and pending launches use updated authority. Add later session grants and confirm they affect subsequent launches only.
- Repeat mode changes through child local baseline, full, session-grant, and delegated paths; test acknowledgment races and readonly ceilings.
- On macOS, overlap launches with different Unix-socket permissions and check no preparation-state leakage.
- Compare initialization counts and representative launch overhead to the current implementation; confirm no repeated expensive manager initialization. Report measurements, not an unsupported benchmark claim.
- Check filesystem union handling, nested-sandbox/Chromium compatibility, and per-job denial retention without silently weakening policy.

### Job lifecycle and interruption

- Check foreground success, nonzero exits, output truncation, and sandbox denials retain their existing contract.
- Check real background identity, stdout/stderr capture, bounded paging, final exit/signal/blocked/cleanup fields, and deadline timing after a delayed approval.
- Exercise join cancellation, concurrent stop while join waits, repeated stop, natural-exit/stop races, and failed cleanup. Unresolved cleanup stays explicit and retains resources/guards.
- Interrupt with and without jobs: agent stops before confirmation; no/cancel/dismiss keeps jobs; headless does not wait; repeated interrupt coalesces.
- Complete a job during abort, during held delivery, after queue clearing, and concurrently with join. It must not immediately restart the agent or deliver twice.
- Detach/reconnect a frontend without ending its owner; jobs continue. Terminate parent and child owners and confirm owned cleanup precedes shared reset.
- Resume stopped sessions: metadata, full logs, and killed identities remain readable, with no PID adoption, restart, or completion replay.

### Checkpoints and frontends

- Verify edit/write canonical enrollment, including no-diff edits and later checkpoints; Bash-only files remain unenrolled. Explain whole-file behavior when another actor edits an enrolled file.
- Exercise legacy rollback records, changes after recorded after-state, and post-dialog conflicts; never silently overwrite those changes.
- Race job admission/completion with rollback, mutation leases, destructive transitions, and runtime replacement. Rechecks block active/unresolved ownership but not terminal unread results.
- Verify overview/statusline counts update on idle completion and logs stay out of status/transcript messages.
- Exercise output paging remotely and reject cross-session/job access and arbitrary path requests. Confirm stop remains usable during join and cancellation does not mark the session uncertain.
- Check TUI, RPC/web confirmation, and Neovim paths without Alt bindings or fabricated prompts.

## Constraints and exclusions

- Do not implement a generic scheduler, per-command sandbox manager pool, interactive terminal, automatic timeout conversion, process resurrection, or full web job dashboard.
- Keep existing permission UI once/session/domain behavior and explicit denial safeguards; do not replace them with broad global network permission.
- Attribution IDs are the approved isolation assumption. Third-party code can intentionally impersonate an ID; protection against that attack and dedicated capability proxies are outside scope. Do not reopen this accepted tradeoff as a prerequisite.
- Preserve unrelated work. Do not add committed tests, unrelated cleanup, dependencies beyond the approved delivery need, or transcript status items.

## Evidence and assumptions

The prior checks established source/API behavior and one successful Linux concurrent filesystem-cleanup probe. They did not establish upgraded network behavior at runtime: a live network probe was blocked in readonly mode. macOS findings were source-only. None of this constitutes implementation or security acceptance; the verification above remains required.

Versioned references for revalidation:

- [0.0.80 release](https://github.com/anthropics/sandbox-runtime/releases/tag/v0.0.80)
- [0.0.81 manager implementation](https://unpkg.com/@anthropic-ai/sandbox-runtime@0.0.81/dist/sandbox/sandbox-manager.js)
- [0.0.81 manager declarations](https://unpkg.com/@anthropic-ai/sandbox-runtime@0.0.81/dist/sandbox/sandbox-manager.d.ts)
- [0.0.81 domain-pattern validation](https://raw.githubusercontent.com/anthropics/sandbox-runtime/v0.0.81/src/sandbox/domain-pattern.ts)
- [Checkpointing reference](https://code.claude.com/docs/en/checkpointing), context for snapshot semantics, not the source of this plan's requirements.
