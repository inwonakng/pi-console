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
snapshot. `:PiSideReset` cancels side work, clears side history, and captures fresh
main context; `:PiSideAbort` stops only the side run. Select side transcript lines
and use `:PiSteer` to explicitly send them to the main run.

Side history and drafts are stored inside the parent session and restored on
restart. Send a main prompt first to create the saved parent session. Navigating
within the parent's history does not rewind the side conversation; a different
parent session has its own side conversation. Stop side work before restarting.

### Restarting

Use `<leader>pR` or `:PiConsoleRestart` to restart Neovim and Pi in the same
terminal, keeping the conversation and unsent prompt. Finish or abort active
work, resolve pending requests, and save or discard modified file buffers first.
This requires launching through `pi-console`. After installing a new release,
close and relaunch `pi-console` instead; the restart command keeps the old release.

To restart only Pi, use `<leader>pr` or `:PiRestart`. Check the running build
with `:PiConsoleVersion`.

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
with status `Not Open`. Enter focuses an open session or reopens a closed pin.
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

The tree lets you revisit earlier messages, take a different branch, or remove
messages you no longer need. I find this useful for asking clarifying questions:
once I understand the answer, I can go back to the original message and ask the
agent to start working, without keeping that whole detour in context.

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
| `<prefix>G` | Start a conversation in the current pane's directory |
| `<prefix>o` | Open or focus the overview; close the popup if already focused |
| `<prefix>O` | Toggle the sidebar in the current window |

The popup uses a modal pane on servers that support it. Closing it leaves the
conversations running. Release and development builds use separate tmux sessions,
but their overview lists can show conversations from both.

Focus the sidebar with normal tmux pane navigation, then use the
[overview controls](#session-overview). Press `o` for the full overview or `q`
to close the sidebar. It needs at least 20 columns of available space and stays
in the window where you opened it.

Conversation window icons show activity: blue for working, yellow for waiting
for you, green for a completed unread turn, and red for an error. Focusing a
completed conversation clears its unread indicator. Manually renaming a window
opts it out of automatic icon naming.

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
- Shell network approval applies to one command and can reach any host. It can
  send any data that command can read, including environment values. Existing
  saved host-specific grants still apply.
- An **unsandboxed** command has unrestricted host access, including its child
  processes. Session approval covers the exact command and working directory,
  including future edits to scripts it runs.
- On macOS, Unix-socket approval grants access to the named socket paths, which
  may expose local services. It does not grant file writes or network access.
  Path-scoped socket grants are unavailable on Linux.

Unsandboxed and socket approvals expire on session/branch replacement or process
exit. Saved file and host grants can survive resume. Grants are not inherited by
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

**Commands you type with `!` or `!!` bypass the agent sandbox and its approvals.**

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
