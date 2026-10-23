# User guide

For installation, start with the [README](../README.md). For development and
releases, see [Maintaining pi-console](../MAINTAINING.md).

- [Conversation controls](#conversation-controls)
- [Sessions and dialogs](#sessions-and-dialogs)
- [tmux integration](#tmux-integration)
- [Configuration](#configuration)
- [Access modes](#access-modes)
- [Project trust](#project-trust)
- [Subagents and extensions](#bundled-pi-extensions)
- [Optional dependencies](#optional-dependencies)
- [Zotero references](#zotero-references)
- [LaTeX graphics](#optional-latex-graphics-in-tmux)

## Launch and service controls

`pi-console` ensures the local service and selects the invocation directory.
The first prompt creates a session; an unused frontend creates none.
`--overview` and `--sidebar` show discovery without creating a conversation.
`--attach ID` selects a live service conversation; `--resume ID` explicitly resumes
saved history. Neither starts a replacement owner when the target is unavailable.
Legacy file-based history remains available through `pi-stable`/`pi-dev --session PATH`.

Closing Neovim detaches; work, accepted prompts and pending approvals remain owned
by the service. `:PiHosts` / `<leader>ph` manages local or saved HTTP hosts. Select
a host, then "Attach current frontend" to switch this conversation frontend to it,
or choose a connection, editing or forgetting action. `:PiCd` / `<leader>pC` chooses
a directory on that host. These selections leave existing sessions running. Explicit remote
launches accept `--remote http://HOST:8443`; remote creation selects a directory on
that host, never this machine's cwd. Every service listens on all IPv4 interfaces,
port `8443` by default (`server start/restart/enable --port PORT` overrides it). There
is no authentication or encryption: restrict access using your trusted network/VPN
and firewall. `server status` reports candidate connection URLs. Forgetting a host
only disconnects and removes its saved entry. See [service usage](../server/README.md).

`server status` reports running/selected builds and restart needs. `server
stop|restart|disable` saves/stops idle conversations but refuses active work,
accepted queues, approvals and transitions. `--force` intentionally interrupts
owned work while retaining data. Installation never enables startup; use `server
enable --binary /absolute/path/to/pi` explicitly. Startup PATH is captured without
shell rc files; login/logout and sleep constrain execution. See
[environment and startup](../server/README.md#service-environment-and-startup).

## Conversation controls

The prompt and transcript are Neovim buffers. Use normal editing and search
commands, and press Ctrl+Enter to send a prompt. `<leader>` means Space in
normal mode; `<leader>?` opens context-sensitive help.

### Prompts and tool output

Submitting a prompt while Pi is working adds it to a queue. Open the queue with
`<leader>pq` to preview, edit, or delete messages. They run in order after the
current turn finishes. In the message editor, `:wq` saves and `:q!` cancels.

Press Enter on a tool group in the transcript to expand it, or on an individual
call to inspect its output. Tool groups expand while running and collapse when
finished unless you toggle them yourself.

For workspace changes, the orange statusline shows the change totals. Open a
workspace integration result and press `d` to review its saved diff in Diffview,
even after the workspace has been cleaned up.

To stop the current run, press Escape twice in the transcript buffer.

### Steering and side conversations

Use `<leader>pS` or `:PiSteer` while Pi is working to open a steering editor.
`:wq` sends the instruction after the current assistant turn's tool calls;
`:q!` cancels. A visual selection followed by `:PiSteer` prefills the editor.
If Pi finishes first, the unsent instruction remains in the steer draft.

Use `<leader>pb` or `:PiSide` to toggle an independent side conversation.
It has a transcript float above an editable input float. Normal Vim editing,
including Escape and macro recording, remains available. In normal mode,
Ctrl+K focuses the transcript and Ctrl+J focuses the input. Ctrl+Enter sends.
The toggle or `:q` hides both floats without resetting the conversation or draft.

Side conversations use fixed `ask` access mode and built-in file/shell tools
plus codemode, independently of the main agent's access mode. Approvals share
the normal dialog UI and wait their turn if another request is open. The main
agent keeps working; neither side prompts nor answers enter its model context.

The first side prompt captures finalized main context. Follow-ups retain that
snapshot. In either side buffer, normal-mode `<leader>n` (or `:PiSideNew`) starts
a new side conversation: it cancels side work, clears side history and the draft,
and captures fresh main context. `:PiSideAbort` stops only the side run. Select
side transcript lines and use `:PiSteer` to explicitly send them to the main run.

Side history and drafts are stored inside the parent session and restored on
restart. Send a main prompt first to create the saved parent session. Navigating
within the parent's history does not rewind the side conversation; a different
parent session has its own side conversation. Stop side work before restarting.

### Restarting

Use `<leader>pR` or `:PiConsoleRestart` to restart only the frontend in the same
terminal, retaining the selection, drafts and unresolved request IDs. Execution
continues independently; reconnect does not reacquire control or replay mutations.
This requires launching through `pi-console`. To use a newly installed frontend,
close and relaunch with `--attach ID`; the restart command keeps the old release.

To explicitly restart the selected Pi session, use `<leader>pr` or `:PiRestart`.
To change the running service release, use `pi-console server restart`; active
work refuses unless interruption is explicitly authorized. Check frontend identity
with `:PiConsoleVersion`, and service builds with `pi-console server status`.

## Sessions and dialogs

### Session overview

This is where I go when I've lost track of which conversation is doing what.
It lists open sessions, whether they're working, idle, done, or waiting for me,
and their directories and workspaces. `Done` means a turn finished normally while
I was elsewhere; focusing that conversation clears it to `Idle`. `Waiting` means
an outstanding question or approval still needs a response. Reopened sessions
start idle; unread status is not saved. The overview and sidebar share named
groups and manual ordering. Pins (``) stay within their groups: press `p` on a
saved session to keep it visible after its window closes and across restarts,
with status `Not Open`. Enter attaches here to an open session or explicitly
resumes a stopped pin on its owning host.
Unpinning a closed session hides it, without removing its history or group assignment.

Both lists use the same controls:

| Binding | Action |
|---|---|
| `j` / `k`, arrows | Select a group or session; skip display-only rows |
| `Tab` | Expand/collapse a group or a session's running subagents |
| `Enter` | Focus/reopen a session, or expand/collapse a group |
| `J` / `K` | Move a session within its group, or reorder a selected group |
| `g` | Assign a session to an existing/new group; on a header, create an empty group |
| `p` | Toggle a session's pin |
| `dd` | Kill/close a session, or delete a group without killing its sessions |
| `<leader>?` | Show the list's keys |

Deleting a nonempty group asks for confirmation and appends all its sessions,
including remembered closed sessions, to Ungrouped in their existing order.
Pins are preserved. Ungrouped cannot be deleted or reordered and stays last;
it hides when empty. Explicit groups remain even when empty. Closing an unpinned
session hides its row but preserves its group and position for reopening.

Collapsed groups show session-status icon counts. Collapsed sessions show their
running-subagent count; expanded sessions show one display-only row per running
subagent. Collapse state is independent in each viewer. These are highlight-only
lists, with the normal cursor restored in inputs and dialogs. Ordinary Neovim
scrolling is unchanged; there are no Shift-Enter or Ctrl-x list bindings.
The overview also provides `/` to filter and `c` to clear the filter. Filtering
hides groups without matching sessions but never deletes them. I keep the overview
bound to `<prefix>o` so I don't have to remember where each conversation lives.

![Session overview showing working, idle, and waiting conversations](../assets/overview.png)

<details>
<summary>Session picker and transcript preview</summary>

When I want to pick up an older conversation, I search for it here and check
the transcript preview before opening it. Like the other pickers, this uses
[fzf-lua](https://github.com/ibhagwan/fzf-lua). Search uses ripgrep regex over
the displayed title, directory, and timestamp; `pwd:.*console` filters by directory.
You can also select several sessions at once to archive or delete them.

![Session history picker with a preview of the selected conversation](../assets/session-picker.png)

</details>

<details>
<summary>Conversation tree</summary>

`<leader>h` opens the conversation history tree on the active turn. Selection
uses a line highlight, without a text cursor; search and other editors retain
the normal cursor. Assistant messages and their tool round-trips stay grouped
into turns; the lower pane previews the full text. The compact header highlights
common keys in blue; `?` shows all bindings, including preview scrolling, summary
jumps, and refresh.

- `b` toggles the full tree and the current branch. `o` cycles entry-type filters.
- `/` searches full user/assistant turn text with fuzzy matching, keeping tree
  order and dimmed ancestors for context. Enter accepts the search without
  navigating the conversation; `n` / `N` select the next/previous matching turn.
  The preview highlights matches. Use `/` and clear the query to restore the tree
  while keeping the located turn selected; Esc cancels search editing.
- Enter jumps to a turn; `S` jumps with a branch summary. These preserve history.
- `c` clones the path through the selected user/assistant turn, **including it**,
  into a new session in a new window. The original stays open. Cloning is blocked
  inside managed workspaces; return to the origin checkout first. This copies
  conversation history, not project files or rollback snapshots. Permission
  grants and live workspace ownership are not inherited.
- `d` deletes the selected turn and **all descendants**, including other branches
  below it. Choose **History only** to keep existing file changes (existing
  workspace cleanup rules still apply), or **History + undo work** to also roll
  back recorded changes on the active path. Undo work is offered only for turns
  on that path. Confirmations describe affected history, files, and workspaces;
  arbitrary external effects cannot be undone.
- `<C-f>` / `<C-b>` scroll the preview, `r` refreshes, and `q` closes the tree.

![Conversation tree showing multiple branches and the current message](../assets/tree-view.png)

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

![The agent's reasoning trace in a floating buffer over the conversation](../assets/reasoning-view.png)

</details>

<details>
<summary>Subagent transcript</summary>

You can check what a subagent is doing without leaving the parent conversation.
The subagent menu lets you open its transcript or send actions to it; this
screenshot shows a reviewer's transcript.

![Subagent transcript opened over the parent conversation](../assets/subagent-transcript.png)

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

![Question picker with multiple choices and a custom response option](../assets/question-picker.png)

</details>

<details>
<summary>OpenAI Codex usage</summary>

A quick way to check how much Codex quota is left before starting another task.
It shows the remaining five-hour and weekly quotas, when they reset, and how
long until then.

![OpenAI Codex usage view showing remaining quotas and reset times](../assets/codex-usage.png)

</details>

## tmux integration

Run this once to enable the installed release's shortcuts:

```sh
pi-console tmux setup
```

For a development checkout, use `pi-console-dev tmux setup` instead. Running
either command selects that version for the shortcuts; installing or updating
alone does not switch between release and development.

Setup backs up changed configuration and adds a managed block to `~/.tmux.conf`
(or the existing `$XDG_CONFIG_HOME/tmux/tmux.conf`). It preserves symlinks and
unrelated settings, and applies the bindings to the current/default running
server. If no server is running, they take effect next startup. A custom
`tmux -f` configuration must source this main configuration.

| Key | Action |
|---|---|
| `<prefix>g` | Toggle the conversation popup |
| `<prefix>G` | Start a conversation in the agents session, using the current pane's directory |
| `<prefix>o` | Open or focus the overview; close the popup if already focused |
| `<prefix>O` | Toggle the sidebar in the current window |

The popup uses a modal pane on servers that support it. Closing it leaves the
conversations running. Release and development builds use separate central popup
sessions, but their overview lists can show conversations from both and from any
other session on the same tmux server.

For independent terminal windows, create a separate tmux session in each and run
`pi-console` or `pi-console-dev` there. `<leader>pN` opens an unstarted frontend tab
in that same tmux session, inheriting the current host and workspace directory. `<prefix>G` always
creates in the channel's central agents session and opens its popup when invoked
from another session; `<prefix>g` toggles access to that popup.
The overview stays global: selecting a running conversation visits its existing
location; reopening a stopped conversation creates a tab in the overview's own
session. Enter in the overview/sidebar carries the sending tmux client's identity,
so a cross-session jump switches only that terminal or popup, even when several
clients display the overview. Clients attached to the same tmux session still
share that session's selected window; use separate sessions for independent tabs.
The client bridge is installed automatically when either list opens and preserves
any existing root Enter binding outside an active overview/sidebar list.

Focus the sidebar with normal tmux pane navigation, then use the
[overview controls](#session-overview). Press `o` for the full overview or `q`
to close the sidebar. It needs at least 20 columns of available space and stays
in the window where you opened it.

Each window displays its label followed by one status icon per conversation
pane, ordered by numeric pane ID. Icons show activity independently: blue for
working, yellow for waiting for you, green for a completed unread turn, and red
for an error. Focusing a completed conversation clears its unread indicator.
Icons follow panes when moved, disappear when their frontend exits, and do not
become part of the actual window name.

A single conversation in an automatically named window uses its short Pi slug;
launcher-created tabs do too. The title model generates both the full title and a
1–4-word lowercase, dash-joined slug (for example, `zotero-tag-cleanup`) in one
request. The overview and history picker keep the full title. Both labels are
saved with the conversation and restored on reopen.

Existing sessions without a slug keep the truncated-title fallback; reopening
one does not request a model call. Use `/pi-retitle` to regenerate both labels.
An explicit Pi rename (`/pi-title` or `/pi-rename`) clears the previous slug and
uses the new title until regenerated. Failed generation keeps the existing
labels, or uses the deterministic title fallback for an untitled conversation.

Manually named tmux windows retain their label, and renaming a window overrides
only the label, not the icons. Multi-pane windows
keep their existing label instead of choosing between conversation titles.
Standard tab formats display labels up to 40 characters; themes with their own
name expression keep their formatting. The full window name and overview title
remain available.
When the last conversation leaves, the previous tab display format is restored.

Rerun setup after updates to pick up changed bindings, and close and relaunch
frontends to use the new release. When enabling focus reporting for the first
time, detach and reattach existing tmux clients. Graphics need the
[separate setup below](#optional-latex-graphics-in-tmux).

## Configuration

Copy [the example configuration](../pi/pi-console-config.example.yaml) to
`~/.pi/agent/pi-console-config.yaml` and change only the settings you need.
The main defaults are:

```yaml
notifications:
  default: enabled
integration-mode:
  default: ask
access-mode:
  default: ask
  read-paths: ["/"]
  write-paths: ["/tmp"]
  macos-denial-monitor: false
```

- Notifications accept `enabled` or `disabled`.
- Integration mode `ask` requests confirmation before integrating or discarding
  workspaces. `allowed` skips that confirmation. Choose with `<leader>I`.
- Access mode controls file and shell permissions, as described below.

Saved choices in a conversation take precedence over these defaults. Changing a
default does not immediately change the active session. Read/write path changes
apply to subsequent tool calls.

Path lists accept absolute or `~/` paths, include descendants, and do not accept
wildcards. They add to the workspace/system access built into each mode.
`read-paths: []` removes the default permission to read everything;
`write-paths: []` removes automatic writes to `/tmp`.

Every Pi process also has a writable scratch directory, exposed to Bash as
`$TMPDIR` and removed on shutdown. The example config includes an optional
`temp-dir-prefix` for changing its location.

## Access modes

**Reads are unrestricted by default, including credentials and private files.**
The shell also inherits its normal environment. Choose a mode with `<leader>A`.

| Mode | File access | Shell network access |
|---|---|---|
| `readonly` | Configured reads; writes only to scratch space | Denied |
| `ask` (default) | Configured reads/writes and scratch space; approval for additional access | Approval required |
| `edit` | Same as `ask`, plus workspace writes | Approval required |
| `full` | Unrestricted host-user access | Unrestricted |

Existing grants can also allow access. In `readonly`, grants and configured write
paths cannot enable writes outside scratch space.

### Responding to approval requests

Check the requested access scope as well as the command's working directory.
Approving a directory includes its descendants.

- File access can be allowed once or for the session.
- Shell network access can be allowed once or with **Allow network for this
  session**. The session choice permits subsequent commands to reach any host,
  including after resuming this conversation, without changing the access mode
  or lifting filesystem restrictions. Commands can send any data they can read,
  including environment values. Sandbox network safeguards still apply, and
  `readonly` mode still blocks shell network access. Existing saved host-specific
  grants also apply.
- An **unsandboxed** command has unrestricted host access, including its child
  processes and future edits to scripts it runs. Choose **Allow once**, **Deny**,
  or one of three session scopes:
  - **Allow this command outside the sandbox for this session**: only the exact
    command text and canonical working directory.
  - **Allow any command outside the sandbox from this working directory for this
    session**: any command starting in that exact canonical directory, not its
    descendants.
  - **Allow any command outside the sandbox for this session**: any command,
    regardless of its working directory.
  A working-directory scope controls which executions qualify, not what they can
  access: commands can still change directories, access other files, spawn child
  processes, and use the network. These grants do not change the access mode or
  move normally sandboxed commands outside the sandbox.
- On macOS, Unix-socket approval grants access to the named socket paths, which
  may expose local services. It does not grant file writes or network access.
  Path-scoped socket grants are unavailable on Linux.

Unsandboxed and socket approvals expire on session/branch replacement or process
exit. Saved file and network grants survive resume. Grants are not inherited by
new conversations, forks, or subagents.

A sandbox error can occur after a command has partly run. Check what changed
before approving another attempt; the console does not automatically rerun it.

On macOS, the diagnostic log reader is off by default to avoid continuous idle
CPU use. Sandbox restrictions and approval rules remain enforced. Command output
and exit status are retained, and directly recorded proxy denials still produce
blocked-command reports. A program that suppresses a filesystem or socket denial
and exits successfully may therefore appear to succeed.

For troubleshooting, set `access-mode.macos-denial-monitor: true` in the config
and start a new Pi session. This restores the existing best-effort OS-log
collection, including reports for some commands that exit zero. The reader runs
continuously until session shutdown, including while idle. Set it back to
`false` and start a new session when finished. Linux monitoring is unchanged.

## Project trust

Project trust controls loading project configuration and executable resources.
It is separate from the access modes above; `AGENTS.md` alone does not require
trust approval.

When a project needs a decision, agent work waits for you to trust the project,
trust its parent folder, trust it for this conversation, or decline. Escape
hides the dialog, `<leader>pa` reopens it, and Ctrl+q declines for the conversation.

A conversation-only choice survives restarts but does not apply to unrelated
projects or new conversations. Managed workspaces inherit their originating
project's decision. Trust setup errors leave agent work blocked.

## Bundled Pi extensions

The console includes access controls, session history and branching, automatic
titles, notifications, and Codex usage. It also includes subagent and workspace
tools, but those tools are disabled by default.

To enable them, merge this into `~/.pi/agent/settings.json` and restart:

```json
{
  "defaultTools": ["+spawn", "+spawn_control", "+workspace"]
}
```

Preserve any existing tool choices. A trusted project's `.pi/settings.json` can
disable these tools with `-spawn`, `-spawn_control`, and `-workspace`.
Tool selection is separate from permissions.

The bundled `researcher`, `reviewer`, and `verifier` profiles use read-only
access. `worker` edits in an isolated child worktree. Custom profiles go in
`~/.pi/agent/agents/` or a trusted project's `.pi/agents/`; project profiles
override user profiles, which override bundled profiles with the same name.

The matching bundle loads through `pi-console`, `pi-console-dev`, `pi-stable`,
or `pi-dev`, not plain `pi`. Do not register another copy globally: duplicate
tool registrations can conflict.

Question, todo, web-search, and LiteLLM extensions must be installed separately
through Pi. The console can display standard dialogs from other extensions.
For older web-search setups, move `web-search.providers` out of the console YAML
and into `webSearch.providers` in Pi's `settings.json`.

## Optional dependencies

| Feature | Additional setup |
|---|---|
| Desktop notifications | `alerter` (macOS only) |
| Workspace diff review | `diffview.nvim` in your regular Neovim configuration |
| Faster file completion | `fd` or `fdfind` |
| Send deleted sessions to the OS trash | `trash` or `gio trash`; otherwise deletion is permanent |
| Zotero completion | Running Zotero with its local API enabled |
| Equation rendering | Tools and terminal support described below |

## Zotero references

Keep Zotero running and enable **Settings -> Advanced -> Allow other applications
on this computer to communicate with Zotero**.

In the prompt buffer, type `@z:paper:`, `@z:collection:`, or `@z:tag:` followed
by a search. Queries can contain spaces. Paper searches match titles, citation
keys, authors, and tags; select a result with the regular completion keys.

Completion reads metadata from your local personal library at
`127.0.0.1:23119` and inserts a link. It does not read PDFs or notes, change
your library, or search group libraries. Cached suggestions remain available
if Zotero disconnects.

For the agent to act on those references, install `zotero-cli` and provide
instructions for using it. The console does not bundle a Zotero skill.
Pi's terminal UI needs its own autocomplete extension.

## Optional LaTeX graphics in tmux

Display equations use the Kitty graphics protocol through
[nvim-extras](https://github.com/inwonakng/nvim-extras). You need a compatible
terminal such as Kitty or Ghostty, `pdflatex`, ImageMagick, and the TeX packages
in the [renderer documentation](https://github.com/inwonakng/nvim-extras/blob/main/lua/latex_renderer/README.md).
Inline equations use `utftex`.

If your tmux configuration does not already handle graphics passthrough, add:

```tmux
# Adjust this path for a custom installation or development checkout.
source-file "$HOME/.local/share/pi-console/current/tmux/graphics.conf"
```

Reload your main tmux configuration and reopen the popup. This optional file
enables passthrough and installs hooks for nested tmux clients. Its settings
affect every application on that server. Use your own graphics hooks or this
file, not both.

`pi-console tmux setup` does not enable graphics or remove hooks left by older
installations. After removing old hooks from your configuration, they remain
active until removed from the running server or the server exits.
