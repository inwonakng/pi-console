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

The selected installation's bundled Pi extension owns trust checks and metadata. Neovim only
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

The launchers explicitly load their matching pi-console package (verified against
Pi 1.3.0). Personal trust handlers that run before ours retain Pi's precedence. There are no
`--approve` overrides or separate Neovim-side JavaScript helpers. Trust setup
errors keep agent work blocked rather than implicitly approving resources.
Project trust controls resource loading, not tool permissions or filesystem access.

## Screenshots

### Session overview

This is where I go when I've lost track of which conversation is doing what.
It lists open sessions, whether they're working, idle, done, or waiting for me,
and their directories and workspaces. `Done` means a turn finished normally while
I was elsewhere; focusing that conversation clears it to `Idle`. `Waiting` means
an outstanding question or approval still needs a response. Reopened sessions
start idle; unread status is not saved. Press `p` on a saved session to toggle its pin
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

The installer requires a published release by default; it never silently falls
back to `main`. Applications and npm dependencies live under
`~/.local/share/pi-console/versions/<commit>`, with `current` pointing to the
installed version. The commands installed under `~/.local/bin` are:

| Interface | Installed release | Development checkout |
|---|---|---|
| Neovim | `pi-console` | `pi-console-dev` |
| Pi terminal UI | `pi-stable` | `pi-dev` |

Both stable interfaces use the same selected version. Set `XDG_DATA_HOME`,
`PI_CONSOLE_INSTALL_DIR`, or `PI_CONSOLE_BIN_DIR` to override installation paths.
Running the installer again explicitly updates stable. From a checkout:

```sh
bash scripts/install.sh --version v2026.10.05.1
# Deliberately install a candidate branch/tag instead of a release:
bash scripts/install.sh --ref main
```

An explicit `--ref` selects a candidate, not evidence that it works. Pushing,
publishing, and editing development code never automatically update stable.
Neither installer registers the bundled Pi package globally.

### Recovery and version identity

Use dev daily. If it breaks, install the latest release with `bash scripts/install.sh`
and run `pi-console` or `pi-stable`. If already installed, simply launch stable.
Each starts a fresh process instead of focusing a broken dev view. To return to a
specific working release, use the same installer:

```sh
bash scripts/install.sh --version v2026.10.05.1
pi-console                 # or pi-stable
```

Installation selects the version for both stable commands, not existing processes
or your checkout. Installing requires network access; first frontend launch may
also download plugins/parsers. Existing windows keep their original revision
until closed or restarted. Old application/plugin directories are left untouched
so running sessions are not disrupted; there is no separate version manager or
previous-version selection.

The conversation footer shows the build after cost: `$1.24·DEV abc1234*` or
`$1.24·2026.10.05.1`. Overview/sidebar statuslines identify the viewer; dev
conversation rows have a `DEV` badge. Narrow views shorten the dev label to `DEV`.
The star records a dirty checkout at startup. `:PiConsoleVersion` and every
launcher's `--version` show channel, commit, and installation path. The UI reports
its startup identity, not a newer commit edited beneath an already-running process.

Credentials, personal Pi settings, and conversation history remain shared. Do not
edit the same conversation in two processes. When it is open in another
installation, close that frontend before resuming it here; explicitly selecting
an open overview/sidebar row can still focus it. Pi, Node, Neovim, personal
packages, and persisted user data are not rolled back. Back up shared data before
incompatible format changes.

### Migrating an existing setup

Run `scripts/install-dev.sh` from your checkout, then install the first release.
The dev installer removes only the old exact checkout-owned `pi-console` symlink
and local Pi package registration. Until a release is installed, there may be no
`pi-console` fallback. Other Pi packages and the underlying `pi` executable are
left alone. Plain `pi` no longer automatically loads pi-console's bundled tools;
use `pi-stable` or `pi-dev` for them.

An old managed, unversioned installation is preserved under `versions/<commit>`.
Install a release containing the channel-aware launchers; older revisions relied
on a global registration and lack `pi-stable`. Running sessions are not killed;
restart them after migration.

Neither installer edits tmux configuration or changes the selected channel. Each
prints the matching setup command.

## tmux integration

Choose your tmux default with **one command**:

```sh
pi-console-dev tmux setup   # development
# Or, after installing a release:
pi-console tmux setup       # stable
```

Setup saves your choice in the main tmux configuration and immediately applies
the bindings to the current/default running server. If none is running, it saves
the choice for next startup without starting a server. No manual config edit or
reload is needed. Run the other channel's setup command to switch back; installing
or updating either application alone never changes this choice.

Setup backs up changed configuration and maintains one `pi-console` block at the
end of `~/.tmux.conf` (or the existing `$XDG_CONFIG_HOME/tmux/tmux.conf`). Dotfile
symlinks are preserved. Old installer blocks are replaced; unrelated settings and
included files are left alone. The final block overrides older bindings loaded
by includes. Custom configurations started with `tmux -f` must source this main
configuration to load the saved choice. Startup only applies bindings; it does
not rerun configuration editing.

The keys stay the same. Dev uses `agents-dev`; each installed commit uses
`agents-<commit-prefix>`, preventing recovery from attaching to a different
build's broken overview. Viewers can still list both channels. Stable setup
follows the installed `current` selection after installing another release.

Setup also enables modified-key settings and focus reporting, but not graphics
passthrough or graphics-depth hooks. When first enabling focus reporting, detach
and reattach existing clients. Then use:

| Binding | Action |
|---|---|
| `<prefix>g` | Toggle the selected channel's agents popup |
| `<prefix>G` | Start a conversation in the current pane's directory |
| `<prefix>o` | Open or focus the persistent overview; close the popup if already focused |
| `<prefix>O` | Toggle the compact overview sidebar in the current window |

The sidebar shows open and pinned conversations with colored status icons,
conversation titles, projects, and current activity. Focus it with normal tmux
pane navigation, then use `j`/`k` to select a conversation, `Enter` to focus or
reopen it, `o` for the full overview, and `q` to close the sidebar. It is only a
viewer and does not start an agent.

The sidebar is normally 34 columns wide, capped at one third of the window and
shrunk further if the content panes need the space. Opening it requires at
least 20 sidebar columns. Toggling inserts/removes only its marked pane and
resizes the current content layout proportionally; edits to that layout while
it is open are retained. Terminal resizing keeps the width while the sidebar
remains a full-height left pane. If you rearrange it into another layout, tmux
controls its size until you toggle it off and on. It does not follow you to
other windows or sessions. Native tmux zoom hides other panes as usual.

The `tmux` subcommands are `setup`, `toggle`, `new`, `overview`, and `sidebar`.
Only `setup` is normally needed manually; the keybindings use the other actions.
For example, `pi-console-dev tmux sidebar "$TMUX_PANE"` toggles the dev sidebar.
After updates, rerun your chosen channel's `tmux setup` to apply changed bindings;
restart existing frontends to pick up UI changes.

Conversation windows created by the launcher use a fixed two-cell state icon
instead of the `pi` window name (requires a Nerd Font):

| State | Tab/sidebar icon | Color |
|---|---|---|
| Done / unread | `` | Green |
| Working / retrying | `` | Blue |
| Waiting for you | `` | Yellow |
| Compacting | `` | Mauve |
| Loading / starting | `` | Blue |
| Idle | `` | Muted |
| Error / stopped / unresponsive | `` | Red |
| Pinned, not open (sidebar only) | `` | Muted |

The bell follows the overview's unread state and clears when the conversation
is focused. Tab titles and sidebar icons share the same RGB colors. Only managed
conversation tabs receive title-color overrides; window indices, backgrounds,
and ordinary tabs retain their theme styling. Formats using direct `#W` or
`#{window_name}` title tokens are supported, including the default and
Catppuccin formats. Complex/indirect title expressions are left unchanged rather
than rewritten. Manually renaming a window opts it out of icon naming and
coloring; review splits do not take over its icon. On normal frontend exit, an
icon-named window returns to `pi` and its original title formats are restored.

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
source-file "$HOME/.local/share/pi-console/current/tmux/graphics.conf"
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
until removed or the server exits; running only `pi-console tmux setup`
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
Neovim application uses `pi-console-dev-nvim` for development and
`pi-console-release-<commit>` for each installed revision. Configuration, plugin
data, state, and cache are separate from each other and normal Neovim. Release
launches use the locked `nvim-extras` plugin, never the local development override.

## Bundled Pi extensions

Each frontend/terminal launcher explicitly loads its matching package for that
process, including its subagents. These extensions are available through
`pi-console`, `pi-console-dev`, `pi-stable`, and `pi-dev`, not automatically through
plain `pi`:

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

The bundle registers `bash`, `spawn`, `spawn_control`, and `workspace`. Other
personal/trusted-project resources still load; avoid competing tool registrations.
Do not globally register another pi-console checkout or release: explicit loading
is additive, not a replacement for another copy. Remove additional manually
registered copies with `pi remove <exact-source>`. Installers migrate only the
registrations whose ownership they can establish.

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

Run [`scripts/install-dev.sh`](scripts/install-dev.sh) from the repository root.
It installs `pi-console-dev` and `pi-dev` wrappers and checkout npm dependencies,
without updating stable. Restart processes after edits; reinstall when dependencies
or installer-managed launchers change. `scripts/uninstall-dev.sh` removes only
this checkout's development commands and old registration.

### Publishing a release

Tags use `vYYYY.MM.DD.N`, starting at 1 each day. The npm package version remains
separate; four-part application tags are not npm versions. From a clean `main`
checkout already pushed to origin, with authenticated GitHub CLI (`gh`):

```sh
scripts/release.sh
# Or choose the tag explicitly:
scripts/release.sh v2026.10.05.2
```

The script fetches tags, suggests the next counter, shows the commit, and asks you
to type the tag before creating an annotated tag, pushing it, and publishing the
latest GitHub Release. Tags are immutable. It does not publish npm packages or
update stable. If publishing fails after pushing the tag, finish creating the
Release for that existing tag through GitHub/`gh`; never move or replace it.

Before releasing, use dev for normal work and manually exercise:

- startup and the changed behavior;
- prompting, streaming, tool execution, and approvals;
- session resume, frontend/Pi restart, and subagents;
- overview/sidebar navigation, dev badges, and version identity;
- stable startup while dev is broken, and installing a specified working release.

Then publish. Install a release when needed with `scripts/install.sh` (latest) or
`scripts/install.sh --version <TAG>`. Installing at failure time needs network
access; installing beforehand provides an offline fallback. Run `pi-console`
directly for recovery, or `pi-console tmux setup` to also switch your shortcuts.
Return to dev with `pi-console-dev tmux setup`. No extra known-good registry or
promotion step is needed.
Diagnose regressions through stable while using a separate Git worktree and
`git bisect` between the working and failing revisions.

## License

[MIT](LICENSE)
