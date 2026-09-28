# pi-console

A Neovim-powered conversation and session console for the
[Pi coding agent](https://pi.dev), with tmux-backed multi-session management.

pi-console runs as a dedicated Neovim application rather than modifying the
user's normal Neovim configuration. It bundles the Pi extensions used by the
UI while preserving the user's existing Pi credentials, instructions, skills,
settings, and packages.

> [!NOTE]
> This repository is an initial extraction from a personal dotfiles repository.
> The source and development layout are in place, but there is not yet a public
> installer or a compatibility guarantee.

## Features

- Streaming Pi RPC conversation UI with editable Markdown input.
- Persistent tmux session with one overview and multiple conversations.
- Session history, archive, restore, trash, and transcript previews.
- Tool approval previews, access modes, workspaces, and subagents.
- OpenAI Codex usage display and desktop notification controls.
- Markdown rendering supplied by the sibling `nvim-extras` project.

## Repository layout

```text
bin/pi-console          launcher
nvim/                   dedicated Neovim configuration and RPC client
pi/                     installable Pi extension package
tmux/pi-console.conf    sourceable tmux integration
tmux/scripts/           popup and session helpers
docs/                   architecture documentation
```

See [`docs/architecture.md`](docs/architecture.md) for component boundaries.

## Requirements

The application is currently developed against Neovim 0.12, Pi 0.87.1, and
tmux 3.7. It also requires:

- Git, Bash, Node.js, and npm;
- `fzf`;
- Rust/Cargo to build `blink.cmp`;
- a C compiler and parser toolchain for Tree-sitter;
- a local checkout of [`nvim-extras`](https://github.com/inwonakng/nvim-extras);
- network access during initial package, plugin, and parser installation.

Neovim installs the pinned Catppuccin, fzf-lua, render-markdown,
nvim-treesitter, which-key, blink.cmp, blink.lib, and oil.nvim revisions on the
first launch. The checked-in Neovim lockfile is copied to pi-console's isolated
Neovim configuration directory before those plugins load.

Optional or feature-specific dependencies:

- a Nerd Font and a true-color terminal for the intended interface;
- `alerter` for desktop notifications, which are currently macOS-only;
- `diffview.nvim` in the regular Neovim configuration used by workspace review;
- `fd` or `fdfind` for faster file completion;
- `trash` or `gio trash` to move deleted sessions to the OS trash instead of
  permanently deleting them;
- OpenAI Codex authentication through Pi for the usage display;
- the additional math-rendering programs documented by `nvim-extras`.

## Local development setup

Place `pi-console` and `nvim-extras` beside one another:

```text
~/Documents/projects/
├── pi-console/
└── nvim-extras/
```

Install the Pi package dependencies and register the local package with the
existing Pi agent directory:

```sh
npm ci --prefix ~/Documents/projects/pi-console/pi
pi install ~/Documents/projects/pi-console/pi
```

Pi keeps using the regular `~/.pi/agent` directory. The bundled subagent
profiles are defaults: user profiles override bundled profiles with the same
name, and trusted project profiles override both.

Run the application directly with:

```sh
bash ~/Documents/projects/pi-console/bin/pi-console
```

Set `NVIM_EXTRAS_PATH` when the extras checkout is not a sibling:

```sh
NVIM_EXTRAS_PATH=/path/to/nvim-extras bash /path/to/pi-console/bin/pi-console
```

## tmux integration

Add these lines to the main tmux configuration, adjusting the path:

```tmux
set -g @pi_console_root "$HOME/Documents/projects/pi-console"
source-file "$HOME/Documents/projects/pi-console/tmux/pi-console.conf"
```

Reload tmux, then use:

| Binding | Action |
|---|---|
| `<prefix>g` | Toggle the `agents` popup |
| `<prefix>G` | Start a conversation in the current pane's directory |
| `<prefix>o` | Open or focus the persistent overview |

Inside pi-console, `<leader>?` shows the complete context-sensitive key list.

## Configuration

pi-console intentionally does not ship an agent-level `settings.json`. Pi uses
the user's existing provider, model, credentials, instructions, and resource
configuration.

Optional extension overrides may be copied from
[`pi/extension-settings.example.yaml`](pi/extension-settings.example.yaml) to
`~/.pi/agent/extension-settings.yaml`.

## Project status

Work remaining before the first public release includes an idempotent installer,
cross-platform notifications, clean-home validation, supported version ranges,
and public package/update instructions.

## License

[MIT](LICENSE)
