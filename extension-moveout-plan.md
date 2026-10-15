# Extension move-out and context filtering

**Status: Revised implementation scope, approved in conversation.** Use native optional-tool selection instead of adding a context-filtering extension. Keep standard `input()` for question freehand answers, with its cancellation signal. This document does not authorize unrelated refactoring.

## Outcome and scope

Move general-purpose extensions from `pi-console` into `~/dotfiles/pi/agent/extensions/`. Register optional tools inactive and enable the existing tools through global Pi `defaultTools`, so trusted projects can subtract from that startup selection. Use native path-based resource settings for skill exclusions; do not add a custom filtering extension.

Move:

- `pi/extensions/web-search.ts`: `web_search` and `web_fetch`, with their supporting code.
- `pi/extensions/litellm.ts`: provider registration, discovery, and refresh command.
- `pi/extensions/todowrite.ts`: task-list tool, state reconstruction, and `/todos` command.
- `pi/extensions/question.ts`: question workflow, after removing console-specific dependencies.

Keep all other current extensions in `pi-console`, including `spawn`, access control, workspace/history/tree integration, auto-title, notifications, and Codex usage. In particular, subagent orchestration is intentionally console-owned. The console may retain optional rendering support for externally supplied tools such as `todowrite`.

Do not add agent profiles, profile switching, Zotero configuration, a pack-management framework, or skill-directory reorganization. Do not change permissions or erase session history. Leave `TODO.md` untouched; add no Alt-bound shortcuts or permanent tests.

## Current integration points

- `~/.pi` links to `~/dotfiles/pi`. Global `agent/settings.json` loads the console package; `pi/package.json` discovers all top-level `extensions/*.ts`.
- Web tools import `shared/web-content.ts`, `shared/web-providers.ts`, and provider settings from `shared/extension-settings.ts`. Their extraction libraries are currently console dependencies.
- `todowrite.ts` uses standard Pi APIs only. Its tool-result `details` and `pi-todos` status are consumed by `nvim/lua/pi-integration/events.lua` and `tool-output.lua`.
- `question.ts` imports console notification and interaction-mode helpers. In RPC mode it embeds `pi_question_select` / `pi_question_response` JSON in dialog titles.
- `events.lua` uses those markers for question presentation, resumability, waiting state, and a floating multiline answer editor. Standard RPC `editor` requests currently receive an unsupported response.
- `notifications.ts` already listens to `ui_prompt_start`; question-specific notification calls duplicate responsibilities at another layer.
- `spawn.ts` and `workspace.ts` refresh tool definitions and explicitly contribute tool guidelines in `before_agent_start`. Deactivating their tools alone must not leave their guidance advertised.
- Pi exposes `getSettings()`, `getActiveTools()`, `setActiveTools()`, and mutable `before_agent_start.systemPromptOptions.skills`. Tool deactivation is not equivalent to unregistering tools: deferred/codemode tools can remain discoverable or callable. The installed Pi has CLI/SDK `excludeTools`, but no equivalent native settings field.

## 1. Migrate extension ownership

Use ordinary Pi extension discovery under `~/dotfiles/pi/agent/extensions/`: standalone files where sufficient, or a directory with `index.ts` and private helpers/dependencies for a multi-file extension. Do not create a `general-tools` pack merely to hold these files.

- Move implementations, not wrappers importing back into the console checkout. General extensions must work without the console package loaded.
- Preserve tool names, parameter/result contracts, commands, provider ID, and saved state formats. Existing `todowrite` history must reconstruct after migration.
- Move the web helper files and their exclusive dependencies (`@mozilla/readability`, `linkedom`, `turndown`, `turndown-plugin-gfm`, and associated types). Check actual import ownership before removing dependencies. Keep sandbox/YAML dependencies wherever remaining code needs them. Update applicable manifests and lockfiles without unrelated upgrades; do not bundle Pi host libraries.
- Move web-provider selection out of `pi-console-config.yaml` into a `webSearch.providers` field in Pi settings, read by the web extension. Preserve provider order, defaults, and validation. Migrate any existing personal value and remove the old console schema/example entry. This is an explicit configuration migration, not a second parallel settings source.
- Preserve LiteLLM environment variables, auth representation, cache paths, and refresh behavior. Do not copy credentials into tracked files.
- Remove the old entrypoints only as the destination becomes usable. Verify each tool/provider registers once; avoid retaining a second loading path in global settings.
- Update the console README/config examples to identify what remains bundled. Console installation must not install personal dotfiles extensions or depend on an absolute dotfiles path. Document personal extension setup in the dotfiles as appropriate.

## 2. Decouple the question workflow

The question extension owns validation, choices, the extra freehand option, answer/result construction, and cancellation behavior. The frontend owns presentation and pending-dialog state.

### Standard UI contract

- Use `ctx.ui.select(question, displayedOptions, { signal })` for choices and `ctx.ui.input(question, placeholder, { signal })` for freehand answers. Pass plain human-readable titles, not console-specific JSON.
- In native Pi, these render within Pi's terminal UI. In RPC mode, Pi emits UI requests and awaits the frontend's response; no terminal input widget runs behind Neovim.
- Present ordinary RPC `input` requests using the existing floating Markdown editor, with generic request ownership and cleanup. Submit `value` or `cancelled` with the matching request ID. Adding standard RPC `editor` support is out of scope.
- Standard pending dialogs must contribute waiting state and readable overview summaries. Ordinary select/confirm requests should be hideable/reopenable while pending, without requiring the question marker. Preserve existing specialized permission/workspace presentation.
- Distinguish hiding a picker from cancelling its request. Preserve timeout behavior and ensure abort, session replacement, reload, and shutdown cannot submit stale answers or leave orphaned buffers/pending state.
- Remove obsolete question-title parsing once standard requests supply the required behavior. Do not replace it with another question-specific protocol or infer behavior from tool names/title wording.

### Behavior to preserve

- Selecting an option returns its label. Cancelling the initial choice ends the question. Cancelling freehand entry returns to choices; an empty answer requests another response.
- Keep input validation, result details, and model-facing instructions stable.
- Respect `PI_INTERACTION_MODE=noninteractive` and missing UI availability. A spawned RPC child can have `hasUI=true` while still being noninteractive; do not replace the existing check with `hasUI` alone. Implement this small check locally rather than importing console helpers.
- Remove direct desktop-notification calls from the question extension. Console notifications should react generically to Pi requesting input, retain the existing notification toggle, and avoid duplicate notifications for the same request. A genuinely new dialog may generate a new generic notification. Do not remove suppression helpers still needed by permission/workspace flows.

**API decision:** keep `input`/`select` and their supported abort options. Do not introduce a Pi editor API patch.

## 3. Native optional-tool and skill selection

- Register `spawn`, `spawn_control`, `workspace`, `question`, `todowrite`, `web_search`, and `web_fetch` with `defaultActive: false` and direct exposure. Keep the sandboxed `bash` replacement active as before.
- Add those seven tools to global `defaultTools` using `+name` entries, preserving ordinary built-ins and unrelated settings. Do not enable previously unused codemode/tool search.
- Trusted projects can use `defaultTools: ["-spawn", "-spawn_control", "-todowrite"]` to subtract from the inherited selection. This is Pi's native startup selection, not a persistent exclusion or permission policy. CLI choices may override it, and `/reload` does not disable tools removed from settings; restart after removing tools.
- Keep current skills enabled globally. Document native `skills` path-based filtering. For globally discovered skills, the installed resolver requires an explicit project resource entry paired with its exact exclusion. Unloading a skill also removes its manual `/skill:name` invocation; this replaces the original advertisement-only requirement.
- Do not rewrite prior messages, loaded skill instructions, or user-authored `AGENTS.md`.
- `spawn` and `workspace` definition refreshes must not activate unselected tools or reinsert their guidance. Their commands and hooks remain functional, particularly workspace state publication needed by the frontend.
- No custom loadout extension, private runtime mutation, or Pi core patch.

## Implementation order

1. Inspect current code in both repositories and confirm the UI/native-selection API boundaries above. Keep the two repositories' changes separately reviewable.
2. Implement generic dialog handling/notifications and migrate `question`; migrate the other three extensions with helpers, dependencies, and settings.
3. Set optional registrations inactive, enable existing tools globally, and coordinate console guideline refreshes with native selection.
4. Verify the combined setup and console-only setup, update documentation, and remove obsolete entrypoints/configuration/imports.

## Verification and acceptance

Use temporary probes outside the repositories where useful; do not commit tests or generated artifacts. No live provider calls are needed to prove resource loading or filtering. Report native-terminal/manual behaviors not actually exercised.

- **Discovery:** with console plus general extensions, each moved tool/provider loads once. With general extensions only, none imports console code. With console only, startup completes and optional todo/question features are not assumed present.
- **Migration:** web provider settings retain effective behavior; search/fetch result contracts, LiteLLM registration/cache/auth paths, and todo reconstruction/rendering remain intact. No dangling imports or exclusive dependencies remain in the console.
- **Dialogs:** exercise choice, freehand multiline submission, empty answer, cancellation/backtracking, hide/reopen, abort, timeout where supported, and session replacement. Verify generic waiting summaries and notification on/off behavior. Check noninteractive children return unavailable without waiting for UI. Check standard dialogs from an unrelated extension, not just `question`.
- **Native selection:** inspect actual outgoing request tool declarations and structured prompt sections using a local provider stub. Project-disabled tool schemas/guidelines must be absent; globally enabled resources must remain. A registry-list assertion alone is insufficient.
- **Lifecycle/configuration:** exercise global defaults, trusted project subtractions, untrusted projects, reload, and definition refreshes. Document native startup/reload/CLI limitations rather than implementing a second policy layer.
- **Skills:** verify native project resource filtering removes a selected global skill, and document that its manual skill command is also removed. No permission behavior changes.
- **Console regression:** exclude `workspace` and `spawn` from advertisement while retaining their extensions; console readiness/state updates must still work. Without exclusions, subagent UI and workspace navigation must retain existing behavior.

Completion requires both repositories' relevant changes and checks; moving files alone is not sufficient. Preserve unrelated work, credentials, sessions, and existing configuration values throughout.
