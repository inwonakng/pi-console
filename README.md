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

## Repository layout

```text
bin/pi-console          launcher
nvim/                   dedicated Neovim configuration and RPC client
pi/                     installable Pi extension package
tmux/pi-console.conf    sourceable tmux integration
tmux/scripts/           popup and session helpers
scripts/                 development installer and uninstaller
docs/                   architecture documentation
```

See [`docs/architecture.md`](docs/architecture.md) for component boundaries.

## Requirements

The application is currently developed against Neovim 0.12, Pi 0.87.1, and
tmux 3.7. It also requires:

- Git, Bash, Node.js, npm, and `realpath`;
- `fzf`;
- Rust/Cargo to build `blink.cmp`;
- a C compiler and parser toolchain for Tree-sitter;
- network access during initial package, plugin, and parser installation.
- as well as some neovim plugins (TODO: list them with git links here.)

Optional or feature-specific dependencies:

- a Nerd Font and a true-color terminal for the intended interface;
- `alerter` for desktop notifications, which are currently macOS-only;
- `diffview.nvim` in the regular Neovim configuration used by workspace review;
- `fd` or `fdfind` for faster file completion;
- `trash` or `gio trash` to move deleted sessions to the OS trash instead of
  permanently deleting them;

## tmux integration

After installing the command, add this path-independent line to the main tmux
configuration:

```tmux
if-shell "command -v pi-console >/dev/null 2>&1" "run-shell 'pi-console --tmux setup'"
```

The command resolves the installed symlink and sources the integration from the
corresponding checkout. Reload tmux, then use:

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

## Project status

Work remaining before the first public release includes a public installer,
cross-platform notifications, clean-home validation, supported version ranges,
and public package/update instructions.

## Local development setup

Install dependencies and register the checkout as a local Pi package:

```sh
bash ~/Documents/projects/pi-console/scripts/install-dev.sh
```

The installer checks required commands, runs `npm ci`, registers the local
package, and links `pi-console` into `~/.local/bin`. The launcher resolves that
symlink before locating the application files.

Pi keeps using the regular `~/.pi/agent` directory. The bundled subagent
profiles are defaults: user profiles override bundled profiles with the same
name, and trusted project profiles override both.

Run the application with:

```sh
pi-console
```

By default, Neovim installs the pinned `nvim-extras` package. To load an
editable checkout instead, register it at the shared development path:

```sh
mkdir -p ~/.local/share/nvim-dev
ln -s $NVIM_EXTRAS_PATH ~/.local/share/nvim-dev/nvim-extras
```

where `$NVIM_EXTRAS_PATH` is where you cloned the `nvim-extras` repository.

To remove the development registration without deleting the checkout or user
configuration:

```sh
bash ~/Documents/projects/pi-console/scripts/uninstall-dev.sh
```

## License

[MIT](LICENSE)
