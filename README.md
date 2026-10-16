# pi-console

A Neovim frontend for the [Pi coding agent](https://pi.dev), with tmux to keep multiple conversations running and an overview to keep track of them so you no longer need to bounce back and forth between your favorite editor and the TUI.

Your existing Pi credentials, instructions, skills, settings, and packages carry over; the extensions needed by the UI are bundled.

This is a work in progress. The main reason for sharing this repository is to serve as an inspiration for others who want to build something similar. I use this project daily so I will continue to improve/add features, but I do not guarantee that it will be maintained or supported in the future. If you want to use it, please read the requirements and installation instructions carefully (or have your agent do it).

![A conversation in a tmux popup, with the transcript above the prompt buffer](assets/regular.png)

The transcript and prompt are both Neovim buffers, so you can search, select,
resize splits, or open a buffer in another tab just as you would while editing
code. The transcript uses [render-markdown.nvim](https://github.com/MeanderingProgrammer/render-markdown.nvim)
with some extra highlighting; the prompt is a regular editable buffer. The
statusline keeps the model, thinking level, token and context usage, and cost
in view.

## Features

- **Conversations in Neovim.** Editable Markdown prompts and rendered
  transcripts, with tool output and thinking available to open when you need
  them. Consecutive visible tool calls with the same tool name form inline
  groups: `<CR>` toggles a group or opens an individual output. Single calls
  open directly. Groups expand while their calls execute and collapse as soon as
  those calls finish, even while the assistant continues generating. Another
  consecutive call reopens its group unless manually toggled; running and failed
  calls remain labeled in collapsed summaries. Switch models and thinking levels, or queue prompts while a run is
  active. Use `<leader>pq` to preview, edit, or delete queued messages; the
  statusline shows the queue count. Messages run in order after the active run
  finishes, waiting if the next message is being edited.
- **Multiple sessions without losing your place.** A persistent tmux session
  holds your conversations. The overview shows who's working, idle, or waiting
  for you, along with each session's project and workspace.
- **History you can navigate.** Fuzzy-find sessions with transcript previews,
  resume old work, and archive, restore, or trash conversations. The session
  tree lets you revisit earlier messages and explore a different branch.
- **Control over agent changes.** Choose an access mode, inspect approval
  requests with highlighted commands and diffs, and work in isolated Git
  workspaces. Review workspace changes before integrating them. Integration
  results list changed files and added/deleted line counts; open the tool-result
  float and press `d` to review the historical diff in Diffview. These read-only
  snapshots remain available after workspace cleanup and later checkout edits.
  Each result describes its own integration attempt; partially applied failures
  keep their own diff. Binary files have no line counts; included ignored files
  are listed separately and are not part of the Git diff.
- **Subagents you can follow.** Delegate work to foreground or background
  agents and inspect their transcripts without leaving the parent conversation.
- **Decisions and progress in the UI.** Multiple-choice questions with a
  freeform response option, structured task lists, and desktop notification
  controls.
- **Usage at a glance.** Session token, context, and cost information in the
  statusline, plus OpenAI Codex quota and reset times in a dedicated view.
  In a Pi task worktree, an orange summary before cost shows added/removed lines
  and changed files relative to the task's creation baseline, including new
  non-ignored files. Binary files count as changed files but have no line totals.

## Project trust

The bundled global Pi extension owns trust checks and metadata. Neovim only
runs its startup handshake, displays standard RPC dialogs, and restarts Pi when
requested. An undecided project starts untrusted; agent work and automatic
workspace restoration wait for setup. Approval restarts Pi before loading project
resources. Already-decided projects do not need this extra restart.

When Pi's policy is `ask` and no decision applies, the picker offers trust,
parent-folder trust, conversation-only trust, or decline. `<C-q>` declines for this
conversation; `<Esc>` hides the picker and `<leader>pa` reopens it. `AGENTS.md`
alone does not require approval; Pi gates project configuration and executable
resources, not ordinary context files.

Permanent choices use Pi's native `trust.json`, including parent inheritance and
`PI_CODING_AGENT_DIR`. Conversation-only decisions live separately beneath
`<agent-dir>/pi-console/session-trust/`, keyed by canonical session filename and
project directory (an exact match, not blanket parent-folder approval). They
survive RPC and full-console restarts without modifying the conversation JSONL or
the global trust store. New conversations and unrelated projects do not inherit
them. Forking asks before copying a conversation-only decision to the fork.

Managed external workspaces inherit their originating project's decision through
validated workspace/session records, including nested child workspaces. Unknown
or unrelated worktrees get their own decision. Workspace/history transitions
check the destination before switching; the session picker and new-session action
restart RPC to avoid reusing another conversation's cached trust. Finish or abort
active work before changing conversations.

The global pi-console package must be enabled (verified with Pi 1.3.0). Personal
trust handlers that run before ours retain Pi's precedence. There are no
`--approve` overrides or separate Neovim-side JavaScript helpers. Trust setup
errors keep agent work blocked rather than implicitly approving resources.
Project trust controls resource loading, not tool permissions or filesystem access.

## Screenshots

### Session overview

This is where I go when I've lost track of which conversation is doing what.
It lists open sessions, whether they're working, idle, or waiting for me, and
their directories and workspaces. Press `p` on a saved session to toggle its pin
(``). Pinned sessions move into the ` Pinned` group above the regular sessions.
They stay in the overview after their windows close and across restarts, with
status `Not Open`. Enter focuses an open session or reopens a
closed pinned session; `dd` closes its window without removing the pin. Unpinning
a closed session removes it from the overview, not from session history. I keep
this bound to `<prefix>o` so I don't have to remember where each conversation lives.

![Session overview showing working, idle, and waiting conversations](assets/overview.png)

<details>
<summary>Session picker and transcript preview</summary>

When I want to pick up an older conversation, I search for it here and check
the transcript preview before opening it. Like the other pickers, this uses
[fzf-lua](https://github.com/ibhagwan/fzf-lua). You can also select several
sessions at once to archive or delete them.

![Session history picker with a preview of the selected conversation](assets/session-picker.png)

</details>

<details>
<summary>Conversation tree</summary>

The tree lets you revisit earlier messages, take a different branch, or remove
messages you no longer need. I find this useful for asking clarifying questions:
once I understand the answer, I can go back to the original message and ask the
agent to start working, without keeping that whole detour in context.

![Conversation tree showing multiple branches and the current message](assets/tree-view.png)

</details>

<details>
<summary>Tool output and reasoning trace</summary>

Tool output, reasoning traces, and skill invocations open in floating buffers
when you want a closer look. This screenshot shows the agent's reasoning trace.
Press `q` to close it, or use `<C-h/j/k/l>` to return to the conversation.

Codemode's internal tools stay within its parent call rather than appearing as
separate transcript entries. Its detail view shows JavaScript-highlighted source
and wrapped output, reading Pi's full saved output when available. If that
temporary file is unavailable, the view labels the truncated recorded fallback.

![The agent's reasoning trace in a floating buffer over the conversation](assets/reasoning-view.png)

</details>

<details>
<summary>Subagent transcript</summary>

You can check what a subagent is doing without leaving the parent conversation.
The subagent menu lets you open its transcript or send actions to it; this
screenshot shows a reviewer's transcript.

![Subagent transcript opened over the parent conversation](assets/subagent-transcript.png)

</details>

<details>
<summary>Question picker</summary>

When the agent asks a multiple-choice question, you can pick an answer or type
your own. If you need to reread the conversation first, you can hide the picker
and come back to it later. The agent still waits for your answer, and other
pickers stay unavailable until you resolve the question. `<Esc>` hides a pending
choice/confirmation, `<leader>pa` reopens it, and `<C-q>` cancels its request.
Freehand input uses a Markdown float: `:wq` submits; closing without writing
(for example `:q!`) returns to the choices. This presentation also works for
standard dialogs from other extensions. The question tool itself is supplied by a
separately installed extension.

![Question picker with multiple choices and a custom response option](assets/question-picker.png)

</details>

<details>
<summary>OpenAI Codex usage</summary>

A quick way to check how much Codex quota is left before starting another task.
It shows the remaining five-hour and weekly quotas, when they reset, and how
long until then.

![OpenAI Codex usage view showing remaining quotas and reset times](assets/codex-usage.png)

</details>

## Requirements

The application is currently developed against Neovim 0.12, Pi 1.3.0, and
tmux 3.7. It also requires:

- Git, Bash, curl, Node.js 20.11 or newer, npm, `realpath`, and `ripgrep`;
- `fzf`;
- on Linux, `bubblewrap` and `socat` for OS-enforced command sandboxing;
- Rust/Cargo to build `blink.cmp`;
- a C compiler and parser toolchain for Tree-sitter;
- network access during initial package, plugin, and parser installation.

Optional or feature-specific dependencies:

- a Nerd Font and a true-color terminal for the intended interface;
- `alerter` for desktop notifications, which are currently macOS-only;
- `diffview.nvim` in the regular Neovim configuration used by workspace review (only if you want to view diff from workspace changes)
- `fd` or `fdfind` for faster file completion;
- `trash` or `gio trash` to move deleted sessions to the OS trash instead of
  permanently deleting them;

## Installation

Install the latest published release:

```sh
curl -fsSL https://raw.githubusercontent.com/inwonakng/pi-console/main/scripts/install.sh | bash
```

Until the first release is published, the installer reports that it is using
the `main` branch. It installs the application under
`~/.local/share/pi-console`, registers `pi/` as a global Pi package, and writes
the `pi-console` command to `~/.local/bin`. Set `XDG_DATA_HOME`,
`PI_CONSOLE_INSTALL_DIR`, or `PI_CONSOLE_BIN_DIR` to override those locations.

Running the installer again updates the existing managed installation. To
select a release or another Git ref explicitly:

```sh
curl -fsSL https://raw.githubusercontent.com/inwonakng/pi-console/main/scripts/install.sh | bash -s -- --version v0.1.0
curl -fsSL https://raw.githubusercontent.com/inwonakng/pi-console/main/scripts/install.sh | bash -s -- --ref main
```

The installer offers to add the tmux integration when it has access to an
interactive terminal. Pass `--configure-tmux` or `--no-configure-tmux` to make
that choice non-interactively.

## tmux integration

The installer can add this path-independent line to the main tmux
configuration:

```tmux
if-shell "command -v pi-console >/dev/null 2>&1" "run-shell 'pi-console --tmux setup'"
```

The command resolves its application directory and sources the matching tmux
keybindings and modified-key settings. It does not enable graphics passthrough
or install graphics-depth hooks. Reload tmux, then use:

| Binding | Action |
|---|---|
| `<prefix>g` | Toggle the `agents` popup |
| `<prefix>G` | Start a conversation in the current pane's directory |
| `<prefix>o` | Open or focus the persistent overview; close the popup if already focused |

You can also run `pi-console` directly from a project directory. Inside
pi-console, `<leader>?` shows the complete context-sensitive key list.
In directory prompts, `<C-f>` opens up to 10 unique recently used Pi working
directories, oldest to newest, while retaining your current input for editing.
Directory history persists across launches and accumulates as Pi sessions open
or change working directory.

Use `:PiConsoleRestart` or `<leader>pR` to restart both Neovim and Pi in the
same terminal/pane, preserving the conversation, working directory, unsent
prompt, and access/integration modes. Restart is refused while Pi work or
requests are pending; save or discard modified file buffers first. This
requires starting through `pi-console`. `:PiRestart` / `<leader>pr` continues
to restart only Pi.

### Zotero references

In the prompt buffer, type `@z:paper:`, `@z:collection:`, or `@z:tag:` to search
your local personal library. `@z:` also completes those namespaces. Queries can
contain spaces; papers match titles, short titles, citation keys, authors, and
tags. Choose a suggestion with the regular completion keys. Other sources,
including file completion, stay out of Zotero queries.

Keep Zotero running and enable **Settings → Advanced → Allow other applications
on this computer to communicate with Zotero**. Completion reads metadata from
`127.0.0.1:23119`, caches it in memory, and refreshes on use after a minute. If
Zotero is unavailable, a warning appears and any cached suggestions remain;
failed requests retry after ten seconds. It does not read PDFs/notes or write
to your library, and does not include group libraries.

Paper and collection suggestions insert readable native Zotero links. Tag
suggestions insert local API tag links with the exact tag name (metadata, not a
PDF); Zotero has no native tag-selection URI. Agent operations are separate: install `zotero-cli`
and supply agent instructions for resolving these references (the console does
not bundle a Zotero skill). The ordinary Pi terminal UI needs its own autocomplete
extension; RPC does not forward Pi autocomplete providers to Neovim. Restart the
console after updating the frontend.

### Optional LaTeX graphics in tmux

Display equations use the Kitty graphics protocol through
[nvim-extras](https://github.com/inwonakng/nvim-extras). They require a compatible
terminal (such as Kitty or Ghostty), `pdflatex`, ImageMagick, and the TeX packages
listed in the [renderer documentation](https://github.com/inwonakng/nvim-extras/blob/main/lua/latex_renderer/README.md).
Inline equations use `utftex`.

Graphics passthrough is a host-wide tmux policy, so the default integration and
installer leave it to your main tmux configuration. For standalone installations
that do not already configure it, explicitly source
[`tmux/graphics.conf`](tmux/graphics.conf) from your main tmux config:

```tmux
# Default managed installation; adjust for a custom install directory or checkout.
source-file "$HOME/.local/share/pi-console/tmux/graphics.conf"
```

This optional file enables `allow-passthrough` and focus events globally and
installs graphics-depth hooks at index 90. The hooks set the session option
`@graphics-nest-count` to 1 for ordinary terminal clients or 2 for nested tmux
clients (identified by their terminal name matching `default-terminal`). The
renderer reads that option on startup and focus changes so popup graphics pass
through both tmux layers. These settings affect all applications on that tmux
server, not just pi-console. Keep them in your own config **or** source the
optional file; do not install both copies of the hooks.

After upgrading from the previously automatic setup, choose one of those
locations for the graphics settings. Reload your main tmux config and reopen
the popup so the client hooks run. Existing hooks remain in a running server
until removed or the server exits; reloading only `pi-console --tmux setup`
does not remove them. Without an explicit graphics setup, a fresh server will
no longer enable passthrough automatically.

## Configuration

Optional extension overrides may be copied from
[`pi/pi-console-config.example.yaml`](pi/pi-console-config.example.yaml) to
`~/.pi/agent/pi-console-config.yaml`.

Defaults and access paths can be changed with:

```yaml
notifications:
  default: enabled
integration-mode:
  default: ask
access-mode:
  default: ask
  read-paths: ["/"]
  write-paths: ["/tmp"]
  # temp-dir-prefix: /tmp/pi-console-
```

Omitted defaults use the values shown. `notifications.default` accepts `enabled`
or `disabled`; `access-mode.default` accepts `readonly`, `ask`, `edit`, or `full`;
`integration-mode.default` accepts `ask` or `allowed`. Defaults apply on session
start and tree navigation when there is no saved choice on the active branch.
Saved session choices take precedence; spawned subagents also retain their
explicit access-mode override. Editing these defaults does not change an active
session immediately.

Omitted path lists use the defaults shown. Lists contain absolute or `~/` paths,
not wildcards, and include descendants. They add to workspace/system reads and
mode-specific writes. `read-paths: []` restricts reads to that baseline;
`write-paths: []` removes automatic `/tmp` writes. Writable paths are also
readable. Read/write changes apply to subsequent tool calls.

Each Pi process creates a unique scratch directory under the OS temp directory
(`os.tmpdir()`, normally under `/var/folders/…` on macOS). An optional full
`temp-dir-prefix` changes where it is generated on the next Pi session:
`/tmp/pi-console-` becomes `/tmp/pi-console-XXXXXX`. Missing parent directories
are created. The scratch directory becomes Bash's `$TMPDIR`, is automatically
writable by both Bash and file tools in every mode, and is removed on shutdown.
Only the generated directory is removed, not its configured parent.

pi-console uses the existing Pi agent directory, including credentials,
instructions, skills, prompts, models, and other packages. Its dedicated
Neovim application is named `pi-console-nvim`, so its Neovim configuration,
data, state, and cache remain separate from both the installed application and
the user's normal Neovim setup.

## Bundled Pi extensions

The global Pi package loads these extensions in pi-console and ordinary Pi
sessions:

| Extension | Capability |
|---|---|
| `access-mode` | Sandboxed read-only, approval, edit, and unrestricted access modes |
| `auto-title` | Automatic and explicit session titles |
| `codex-usage` | OpenAI Codex usage status |
| `history` | Session history, archive, restore, and transcript operations |
| `notifications` | Completion and input-request notifications |
| `spawn` | Background and foreground subagents |
| `tree` | Session-tree navigation helpers |
| `workspace` | Isolated Git workspaces and integration |

General-purpose `question`, `todowrite`, `web_search`/`web_fetch`, and LiteLLM
extensions are not bundled. Install them separately through ordinary Pi extension
discovery. The console supports standard choice, confirmation, and input dialogs
from any extension, and optionally renders todo results from saved history. Console
installation does not install or require personal dotfiles extensions. When
upgrading an existing web extension setup, move `web-search.providers` from
`pi-console-config.yaml` to `webSearch.providers` in Pi `settings.json`, then remove
the old YAML section; the console no longer accepts that section.

### Optional tool selection

`spawn`, `spawn_control`, and `workspace` register inactive. To enable them by
default, add this to `~/.pi/agent/settings.json` (merge it with existing tool choices):

```json
{
  "defaultTools": ["+spawn", "+spawn_control", "+workspace"]
}
```

A trusted project's `.pi/settings.json` can subtract from that selection:

```json
{
  "defaultTools": ["-spawn", "-spawn_control", "-workspace"]
}
```

Their commands and lifecycle hooks remain loaded, including workspace state updates
needed by the frontend. Selection applies at startup; restart after removing tools
from settings because Pi's `/reload` does not deactivate previously selected tools.
Explicit CLI tool choices override settings. This is not a permission policy.

### Access modes

The access modes are:

- `readonly`: configured reads and scratch writes; other writes and shell network access denied;
- `ask`: configured reads, configured writes (default `/tmp`), and scratch writes;
  approval for additional writes, restricted reads, and shell network access;
- `edit`: the same as `ask`, plus automatic workspace writes; and
- `full`: unrestricted host-user filesystem and network access.

There is one permission rule: access allowed by the configuration, mode, or an
existing grant proceeds; additional access asks in interactive `ask`/`edit` and
is denied explicitly in `readonly`. Configured write paths and remembered grants
do not permit non-scratch writes in `readonly`.

**Reads are unrestricted by default, including credentials and private files.**
There is no special-directory or credential-name blacklist. The shell inherits
its normal environment without secret-name filtering.

Bash and file tools share read/write permissions, including the scratch directory.
File tools request additional access to their target automatically. For Bash,
declare only additional `writePaths` before execution. `readPaths` is needed
only when reads are configured to be restricted; request specific required paths,
not whole-filesystem access for incidental configuration lookups. A write grant
includes reads of that path. Directory grants cover descendants.
`workspaceWriteAccess: true` is shorthand for including the current directory in
`writePaths`. The existing `broadReadAccess: true` explicitly requests all reads
for one command when configured reads are restricted; it is unnecessary with the
default configuration and grants neither writes nor network access.
`networkAccess: true` requests outbound network access to any host **for that
command only**, before execution. This can send data the command can read,
including inherited environment values; it does not lift filesystem restrictions
or the runtime's network safeguards. Network access is routed through the sandbox
proxy; it never opens a permission prompt while a command is running. Undeclared
access is denied, with the destination reported when available.

On macOS, `unixSocketPaths` requests Unix-socket binding and connections at
literal socket paths or directories (directory approval includes descendants).
Inspect Bash's `$TMPDIR` to find Neovim's temporary socket directory, then pass
its literal path rather than `$TMPDIR` as a string. Socket approval does not grant
filesystem reads/writes, outbound-network access, or TCP binding. Access to Unix
sockets can expose powerful local services; approve only the needed paths. The
runtime cannot enforce path-scoped socket grants on Linux, so such requests are
rejected before execution rather than widened to all sockets.

Scoped filesystem approvals offer Allow once, Allow for session, or Deny.
Network access offers Allow once or Deny and is never saved. Existing saved
read/write and host-specific network grants are retained on resume, but not
inherited by new/forked sessions or subagents. A saved host grant does not grant
access to other hosts. Approval previews distinguish the **Access scope** being
requested from the **Command CWD** where the command starts.

Explicitly user-entered `!`/`!!` commands run through Pi's normal shell path with
host-user permissions, without this extension's sandbox or approval checks.
Agent-generated Bash commands remain access-controlled.

Bash has no default execution timeout. The agent is instructed to use `timeout`
for diagnostic probes expected to finish quickly or when the user requests an
execution deadline, and to omit it otherwise. Probe deadlines should match the
expected execution time, not impose arbitrary limits on builds, installs, or
other legitimately long-running work. Command-level timeouts such as
`curl --max-time`, `curl --connect-timeout`, or the `timeout` utility remain
reserved for explicit user requests or testing timeout behavior. All upfront
approvals finish before the shell and its execution timer start.

Agent-written diagnostic scripts must terminate after collecting results and
exit nonzero on initialization or execution failure. Headless Neovim probes
should catch initialization errors and exit with `cquit`; a Lua error alone does
not terminate the editor. Any watchdog must be installed before loading plugins
or other fallible initialization, so an earlier error cannot bypass it.

If granular permissions cannot support an operation (for example, raw networking
or a literal path containing sandbox wildcard characters), request
`unsandboxed: true`. This explicitly asks to run that command with unrestricted
host filesystem, environment, and network access, without changing the
session's mode. The same fallback is offered when the sandbox is unavailable or
cannot prepare a command before execution. The picker offers Allow once,
Allow this command outside the sandbox for this session, or Deny. Session approval
matches the **exact command text and canonical Command CWD**, not a prefix. It
includes future changes to scripts and execution of child processes with
unrestricted host access; it does not confine their effects to the script's
directory. Different arguments, appended shell commands, or a different CWD need
new approval. Keep script modifications in separate calls from the stable run
command to reuse approval. Remembered approval is only consulted when a command
needs unsandboxed execution; it never moves a normally sandboxed run outside the
sandbox.

Unsandboxed and Unix-socket session grants are held only in memory. They expire
on session/branch replacement or process exit, are not saved for resume, and are
not inherited by forks or subagents. Both are blocked in `readonly`. Approval is
never offered as an automatic rerun after partial execution.

Detected sandbox denials are reported with available diagnostics and partial
output, even when the command exits zero. Commands are never automatically
rerun after a sandbox block: inspect what already happened, then request the
needed access with an appropriate continuation command (`networkAccess: true`
for a proxy allowlist denial, `readPaths`/`writePaths` for filesystem denials,
`unixSocketPaths` for Unix-socket denials on macOS).
Network permission does not fix DNS, TLS, or server errors. Detection is best-effort;
suppressed errors may not be observable. `readonly` and noninteractive sessions
do not prompt for additional access.

The package registers the tool names `bash`, `spawn`, `spawn_control`, and
`workspace`. Pi resolves duplicate tool names by extension precedence and then
registration order: project and
user extension resources take precedence over package resources, and the first
package registration wins between packages. Users can therefore override a
bundled tool with a project or user extension, or reorder package declarations
when two packages register the same name. `pi config` can disable individual
package extensions, although disabling an extension also disables the related
pi-console feature.

The profiles under `pi/agents/` are defaults used by the bundled `spawn`
extension, not a standard Pi resource directory. Additional profiles can be
placed in `~/.pi/agent/agents/` or a trusted project's `.pi/agents/` directory.
A user profile overrides a bundled profile with the same name, and a project
profile overrides both.

Delegation primarily serves read-heavy work: research, investigation,
summarization, review, and verification. The bundled `researcher`, `reviewer`,
and `verifier` profiles default to read-only access. The main agent normally
implements changes; `worker` defaults to edit access in an isolated child worktree
for approved, self-contained tasks with settled requirements, non-overlapping
ownership, and independently verifiable results. Delegate writing only when its
benefit outweighs briefing and integration overhead; keep tightly coupled changes
and evolving design decisions in the main session.

## Development

For a checkout-based setup, run [`scripts/install-dev.sh`](scripts/install-dev.sh)
from the repository root. It registers the local Pi package and links
`pi-console` to the checkout. Restart running Pi/Neovim processes after edits.

## License

[MIT](LICENSE)
