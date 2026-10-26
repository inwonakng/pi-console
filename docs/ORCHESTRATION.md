# Orchestration and role models

Say "use subagents" or "orchestrate" to activate the packaged `orchestration` skill for the approved task, including later "go ahead" messages. The parent handles decisions, assignments, and acceptance; subagents perform investigation, implementation, verification, and detailed code review. The parent inspects returned evidence and diffs but does not take over task execution, even for small changes, without an explicit user request. If delegation is blocked, it reports the blocker.

Without an orchestration request, ordinary task handling stays unchanged. For substantial work with separable assignments, the agent may offer orchestration and wait for approval before switching. Individual subagent assignments still follow the skill's delegation procedures. Discussing orchestration does not activate it, and orchestration does not authorize implementation when the user requested only discussion or planning. These are model instructions, not a token budget or a runtime ban on parent tools.

## Configure models

Use `${XDG_CONFIG_HOME:-~/.config}/pi-console/config.yaml` for stable and `config-dev.yaml` for dev. Dev never falls back to stable. The existing validated reader reloads settings on demand; unknown keys, malformed YAML, missing provider/model fields, and invalid IDs are errors. An absent file or omitted role inherits the next default.

```yaml
subagents:
  models:
    worker:
      provider: exact-provider-id
      model: exact-model-id
    researcher:
      provider: another-provider-id
      model: exact-model-id
```

`subagents` accepts only `models`, a mapping from role names to mappings containing exactly `provider` and `model`. All are non-empty strings without whitespace; provider IDs cannot contain `/`. Model IDs can contain `/` and `:`. IDs are case-sensitive and must exist in the running Pi registry. No presets or display-name aliases are provided.

Selection for a new worker is:

1. User-authorized `spawn.model` override.
2. YAML default for the selected profile name, or the generic `role` when no profile is selected.
3. Profile frontmatter `model`, unless omitted or `inherit`.
4. The parent's current provider/model.

A profile selected by `agent` takes priority over a different `role` label. Bundled profiles inherit and contain no personal model choices. A YAML role without a profile can be used with `spawn(role=...)`; it does not create a profile or change access defaults. Generic workers without a role inherit the parent.

Overrides and profile model strings accept exact `provider/model-id` references. A bare ID remains accepted only when exactly one registered model has that ID, regardless of which providers are authenticated. This intentionally replaces the previous fuzzy CLI matching and credential-dependent provider selection. Migrate fuzzy profile/override strings to exact identities. YAML defaults now override profile models; remove the YAML role entry if the profile should own that choice. Unknown or unavailable choices fail visibly; a broken higher-priority choice never falls through to a lower-priority default. The child's actual selection is checked before each assignment is sent.

Use configured defaults without asking. Selecting an alternative requires user authorization for the relevant scope; an agent's own assertion or summary is not that authorization. This is model-facing policy, not a new permission-grant mechanism. No personal YAML is edited by the package. Use Pi's `/model` picker to identify exact provider/model IDs and configure authentication through Pi, not by reading credential files. Display names such as Astra or 6.1 Sol do not establish registry identities.

These defaults select spawned workers only. Select/save the orchestrator's parent model with Pi's existing `/model` interface. A YAML `orchestrator` entry would be an ordinary spawn role, not an automatic switch of the parent model. Existing workers retain their original provider/model, including conversational corrections resumed after process cleanup. Editing YAML or changing the parent's model affects new workers only.

## Discover roles and inspect selection

`spawn_control({action: "models"})` returns model-visible JSON text and the same data in tool `details`:

- `parentModel`: current `{provider, id}` or null.
- `roles`: union of configured role names and discovered profiles, with `role`, `profile` (source/path/description/accessMode/model, or null), `configuredModel`, `resolvedModel` (`provider`, `id`, `source`), `available`, and an `error` on failure.
- `precedence` and `appliesTo` describe the contract.

Profiles resolve bundled -> personal -> trusted project overrides. Discovery uses the supported Pi model registry and configured-auth availability check, never credential contents. Availability means registered with configured authentication, not that a remote request has succeeded. Invalid YAML fails the discovery call; an unavailable role remains visible with its error.

Worker list/status results, status artifacts, and `pi-spawn-runs` expose `modelSelection` (requested provider/id and source) separately from `selectedModel` (child-confirmed provider/id, initially null). The terminal tool status, service child activity, browser child rows, and Neovim child inspection show the confirmed identity. A startup selection mismatch fails before assignment delivery rather than accepting a substitute.

## Delegate and review

Use bounded lifetime for a single assignment. Both lifetimes support clarification and permission requests. Conversational lifetime supports readonly/no-isolation workers and isolated edit workers; edit conversations accept corrections only before acceptance. Every worker must call `spawn_report`; ordinary text is not completion. Restricted profiles retain `spawn_question` and `spawn_report`, while nested spawn/control are unavailable.

Only one unresolved writer is supported. The parent cannot write the repository or run unsandboxed Bash while a child owns a contribution, including during input waits, review, failure, and cleanup. There is no override. Readonly research/review can run in parallel. Inspect with `join`, `status`, `report`, and `diff`; none integrate. Answer clarification through `reply`, permissions through `approve`/`deny` with exact request/runtime identities and the existing approval UI. Request conversational corrections with `followup`, review again, then `accept` explicitly. After acceptance, further writing needs a new worker/baseline. `stop` retains ownership; `discard` explicitly disposes a quiescent unwanted contribution. Final parent integration keeps the configured integration policy.

## Worker views and lifecycle

Workers stay grouped under their orchestrator in the Neovim overview/sidebar and browser session list, including input waits, review, failures and unresolved contributions. Expand the session to see its workers. Rows identify the confirmed provider/model, execution state, assignment and pending request IDs, and integration/ownership state. Closed workers remain available for artifact inspection.

In Neovim, open the orchestrator and use `<leader>ps` to inspect current assignments, questions, permissions, results and recovery artifacts. In the browser, open the orchestrator's Options -> Subagents; expand a worker to read its transcript, result, brief, status, prompt or patch. Artifact reads are read-only, attachment/runtime-bound and paginated. A missing artifact is reported rather than replaced with another worker's output.

Worker questions go to the orchestrator; they are not direct user-approval dialogs. The orchestrator can answer from the approved scope or ask the user through the existing question UI. Permission escalation uses the existing approval dialog, with worker/assignment/request attribution. Only the current controller can answer; observers can inspect. Agent-authored assignments and replies retain their sender in stored/model-visible context and are labeled as agent messages when displayed. Runtime wakeups and management snapshots do not add routine transcript rows.

Disconnecting a frontend does not stop service-owned Pi or its workers. Reattach to the same orchestrator to inspect current state and unanswered dialogs. Completed actions are not replayed. Stop/abort and explicit shutdown still cancel work and invalidate its pending authority; stopping a writer retains its unresolved contribution and recovery artifacts. Guarded service shutdown refuses active workers and unresolved contributions. Runtime/history/workspace changes retain the existing cleanup and ownership gates. Process/service/machine termination does not automatically restart or replay assignments or approvals.

## Compaction

Ordinary Pi manual and automatic compaction retain the orchestrator's session identity. When that session has workers, `session_before_compact` uses Pi's exported compaction helper with the existing preparation/cut, file tracking, cancellation signal and manual instructions, plus guidance to retain approved scope, decision rationale and provenance, assignment dependencies, unresolved questions, review state, evidence references and next steps. If customization fails, ordinary Pi compaction handles the outcome without retiring the worker runtime; cancellation does not request another summary.

Worker status artifacts persist assignment/request identities, delivery state, workspace ownership and permission decisions outside the summary. Live management state is reconciled at model-request boundaries without starting an extra turn. Summary text is never an acceptance or permission authority. Compaction does not restart workers or replay requests; fresh runtime startup restores historical workers as terminal/interrupted records, not live processes.

## Package loading

`pi/package.json` exports `./skills` alongside extensions. The terminal wrapper, service session launcher, and spawn child launcher each pass `-e <matching-release>/pi`; Pi loads both resource types from that package. Child discovery does not authorize nested delegation: the skill has a worker-only section, the child extension returns before registering parent controls, and restricted tool lists add only the required worker protocol tools.

Use the normal development/install snapshot workflow in [MAINTAINING.md](../MAINTAINING.md), then restart the matching terminal/service sessions to load the new package. Source edits do not update running immutable snapshots. No global duplicate package registration or copying into personal skill directories is needed. Pi advertises skill name/description/path on startup; `/skill:orchestration` explicitly loads it. Check startup resource diagnostics for collisions or filtered-out skills.

## Personal-skill migration

The old `~/.pi/agent/skills/subagent-delegation/SKILL.md` is external personal state. This package never edits or deletes it. Before retiring it:

1. Inspect personal and trusted project instructions/settings for `subagent-delegation`, duplicate `orchestration` skills/package entries, and policies saying the parent normally implements everything or allowing concurrent writers. For example:
   ```bash
   rg -n 'subagent-delegation|orchestration|normally implements|concurrent.writer' \
     ~/.pi/agent/AGENTS.md ~/.pi/agent/skills ~/.pi/agent/settings.json .pi AGENTS.md
   ```
   Omit nonexistent paths. Also inspect `~/.agents/skills`, project `.agents/skills`, custom resource paths, and `PI_CODING_AGENT_DIR` when used. Do not print credentials.
2. With user approval, move the old skill outside all discovered skill roots, or replace its body with a short instruction to load the packaged `orchestration` skill through its advertised path. Do not copy the new skill into personal directories. A redirect retains the old name for instructions still referencing it; remove conflicting old content rather than appending a correction.
3. Redirect references to the packaged skill and remove the old policy that writing delegation is exceptional. In always-loaded personal instructions, route "use subagents" and "orchestrate" requests to the packaged skill and allow suggesting orchestration before substantial, separable work. Keep inline-work exceptions out of active orchestration. Change only the relevant instructions; keep unrelated personal instructions/skills untouched. Do not globally register a second console package.
4. Restart or `/reload` and inspect skill diagnostics. Same-name collisions keep the first discovered skill and warn; differently named old/new skills can both load without a collision warning and still contradict each other.

The old personal skill says join integrates contributions. Current join only inspects/waits; acceptance is explicit. Its brief/evidence and scope-control guidance remains applicable, while packaged guidance adds model discovery, questions, permission routing, correction conversations, strict writer ownership, and automatic continuation within approved scope.
