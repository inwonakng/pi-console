# pi-console

A Neovim-powered conversation and session console for the
[Pi coding agent](https://pi.dev), with tmux-backed multi-session management.

pi-console runs as a dedicated Neovim application rather than modifying the
user's normal Neovim configuration. It bundles the Pi extensions used by the
UI while preserving the user's existing Pi credentials, instructions, skills,
settings, and packages.

## Features

- Streaming Pi RPC conversation UI with editable Markdown input.
- Persistent tmux session with one overview and multiple conversations.
- Session history, archive, restore, trash, and transcript previews.
- Tool approval previews, access modes, workspaces, and subagents.
- OpenAI Codex usage display and desktop notification controls.
- Markdown rendering supplied by the `nvim-extras` Neovim package.

## Requirements

The application is currently developed against Neovim 0.12, Pi 0.87.1, and
tmux 3.7. It also requires:

- Git, Bash, curl, Node.js 20.11 or newer, npm, `realpath`, and `ripgrep`;
- `fzf`;
- on Linux, `bubblewrap` and `socat` for OS-enforced command sandboxing;
- Rust/Cargo to build `blink.cmp`;
- a C compiler and parser toolchain for Tree-sitter;
- network access during initial package, plugin, and parser installation.
- as well as some neovim plugins (TODO: list them with git links here.)

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

Inside pi-console, `<leader>?` shows the complete context-sensitive key list.

## Configuration

Optional extension overrides may be copied from
[`pi/pi-console-config.example.yaml`](pi/pi-console-config.example.yaml) to
`~/.pi/agent/pi-console-config.yaml`.

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
| `web-search` | DuckDuckGo search and page fetching |
| `workspace` | Isolated Git workspaces and integration |

The access modes are:

- `readonly`: project reads with persistent writes and shell network access denied;
- `ask`: the read-only baseline, with capability prompts after a sandbox denial;
- `edit`: automatic workspace writes with prompts for shell network access; and
- `full`: unrestricted host-user filesystem and network access.

Capability prompts offer one-command and session-scoped grants. Existing
`~/.pi/agent/bash-access.json` files from earlier releases are left untouched
but are no longer read.

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

## Project status

Work remaining before the first public release includes cross-platform
notifications, clean-home validation, and supported version ranges.

## Development

See [`docs/development.md`](docs/development.md) for the checkout-based setup.

## License

[MIT](LICENSE)
