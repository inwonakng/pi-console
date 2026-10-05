# pi-console

A Neovim frontend for the [Pi coding agent](https://pi.dev), with tmux to keep multiple conversations running and an overview to keep track of them so you no longer need to bounce back and forth between your favorite editor and the TUI.

Your existing Pi credentials, instructions, skills, settings, and packages carry over; the extensions needed by the UI are bundled.

This is a work in progress. The main reason for sharing this repository is to serve as an inspiration for others who want to build something similar. I use this project daily so I will continue to improve/add features, but I do not guarantee that it will be maintained or supported in the future. If you want to use it, please read the requirements and installation instructions carefully (or have your agent do it).

![Regular conversation view with the transcript, prompt buffer, and session status](assets/regular.png)

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
  for you, along with each session's directory and workspace.
- **History you can navigate.** Fuzzy-find sessions with transcript previews,
  resume old work, and archive, restore, or trash conversations. The session
  tree lets you revisit earlier messages and explore a different branch.
- **Control over agent changes.** Choose an access mode, inspect approval
  requests with highlighted commands and diffs, and work in isolated Git
  workspaces. Review workspace changes before integrating them.
- **Subagents you can follow.** Delegate work to foreground or background
  agents and inspect their transcripts without leaving the parent conversation.
- **Decisions and progress in the UI.** Multiple-choice questions with a
  freeform response option, structured task lists, and desktop notification
  controls.
- **Usage at a glance.** Session token, context, and cost information in the
  statusline, plus OpenAI Codex quota and reset times in a dedicated view.

## Screenshots

### Session overview

See which conversations need attention, check their workspaces, and jump into
one from a single overview.

![Session overview showing working, idle, and waiting conversations](assets/overview.png)

<details>
<summary>Session picker and transcript preview</summary>

Search saved conversations and read a preview before resuming. Archive and
trash actions are available in the same picker.

![Session history picker with a preview of the selected conversation](assets/session-picker.png)

</details>

<details>
<summary>Conversation tree</summary>

Navigate conversation branches and jump back to an earlier message, with an
optional summary when switching context.

![Conversation tree showing multiple branches and the current message](assets/tree-view.png)

</details>

<details>
<summary>Subagent transcript</summary>

Open a delegated agent's transcript alongside the parent conversation.

![Subagent transcript opened over the parent conversation](assets/subagent-transcript.png)

</details>

<details>
<summary>Question picker</summary>

Choose an answer or write your own response when the agent needs a decision.

![Question picker with multiple choices and a custom response option](assets/question-picker.png)

</details>

<details>
<summary>OpenAI Codex usage</summary>

Check the remaining five-hour and weekly quotas, with reset times.

![OpenAI Codex usage view showing remaining quotas and reset times](assets/codex-usage.png)

</details>

## Requirements

The application is currently developed against Neovim 0.12, Pi 0.87.1, and
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
integration. Reload tmux, then use:

| Binding | Action |
|---|---|
| `<prefix>g` | Toggle the `agents` popup |
| `<prefix>G` | Start a conversation in the current pane's directory |
| `<prefix>o` | Open or focus the persistent overview |

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

## Configuration

Optional extension overrides may be copied from
[`pi/pi-console-config.example.yaml`](pi/pi-console-config.example.yaml) to
`~/.pi/agent/pi-console-config.yaml`.

Access defaults can be changed with:

```yaml
access-mode:
  read-paths: ["/"]
  write-paths: ["/tmp"]
  # temp-dir-prefix: /tmp/pi-console-
```

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
| `litellm` | LiteLLM model provider support |
| `notifications` | Completion notifications |
| `question` | Structured multiple-choice questions |
| `spawn` | Background and foreground subagents |
| `todowrite` | Structured task lists |
| `tree` | Session-tree navigation helpers |
| `web-search` | Keyless multi-provider web search and structured page fetching |
| `workspace` | Isolated Git workspaces and integration |

### Web search and fetching

`web_search(query, limit)` queries Exa, Parallel, Firecrawl, and Keenable concurrently,
without API keys or model-provider credentials. It interleaves results, deduplicates
URLs (ignoring fragments, preserving query parameters), and reports contributing
providers and partial failures. Available snippets, excerpts, and page content are
returned without local summarization or relevance filtering. The default result
limit is 5, with up to 20 supported. These anonymous services may throttle requests;
a failed provider does not discard results from the others.

`web_fetch(url, maxChars)` first fetches the page directly and converts readable HTML
to Markdown, preserving links, headings, lists, tables, and code. When direct
retrieval or extraction fails, it tries the configured hosted providers in order.
Responses include requested and returned URLs, extraction provider, content format,
failed attempts, and whether the returned text was truncated. `contentKind` identifies
page content versus provider excerpts; `totalChars` counts the extracted text before
local truncation, not necessarily the complete original page. The default character
limit is 12,000; `maxChars` accepts 1,000–50,000. Requests have a 30-second deadline
per provider and respect tool cancellation.

To select providers, add this to `~/.pi/agent/pi-console-config.yaml`:

```yaml
web-search:
  providers: [exa, parallel, firecrawl, keenable]
```

The list must be non-empty, contain no duplicates, and use those provider names.
Changes are read on each call. Search queries are sent to every selected provider;
hosted fetching sends the requested URL to a provider only after direct fetching
fails. No hosted-service signup or browser installation is required.

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

Bash has no default execution timeout. The agent is instructed to omit `timeout`
unless the user requests an execution deadline, and to use that harness-enforced
deadline instead of embedding timeouts in shell commands. Command-level timeouts
are reserved for explicit user requests or testing timeout behavior. All upfront
approvals finish before the shell and its execution timer start.

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

The package registers the tool names `bash`, `question`, `spawn`, `spawn_control`,
`todowrite`, `web_search`, `web_fetch`, and `workspace`. Pi resolves duplicate
tool names by extension precedence and then registration order: project and
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
