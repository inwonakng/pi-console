# pi-console

A Neovim frontend for the [Pi coding agent](https://pi.dev). Write prompts and
read responses in Neovim, with optional tmux popups and an overview for managing
multiple conversations.

It uses your existing Pi credentials, settings, and history, and keeps its
Neovim configuration separate from your regular editor.

This is a work in progress that I use daily and share as inspiration for similar
setups. Future maintenance and support are not guaranteed.

![A conversation in a tmux popup, with the transcript above the prompt buffer](assets/regular.png)

## Features

- Edit Markdown prompts and search transcripts with Neovim controls.
- Resume conversations from a history picker, or branch from an earlier message.
- Track multiple conversations in a tmux popup, overview, or sidebar.
- Open tool output, reasoning traces, and subagent transcripts when needed.
- Review permissions and changes before approving them.

![Session overview showing working, idle, and waiting conversations](assets/overview.png)

## Requirements

Developed with **Neovim 0.12, Pi 1.3.0, and tmux 3.7**. The optional tmux
integration supports **tmux 3.4+**.

Install these before starting:

- Git, Bash, curl, Node.js 20.11+, npm, `realpath`, `ripgrep`, and `fzf`.
- Rust/Cargo, a C compiler, and the Tree-sitter parser toolchain for Neovim plugins.
- On Linux, `bubblewrap` and `socat` for command sandboxing.

Initial setup downloads packages, plugins, and parsers, so it needs network
access. A Nerd Font and true-color terminal are recommended.

## Install and launch

Install the latest published release:

```sh
curl -fsSL https://raw.githubusercontent.com/inwonakng/pi-console/main/scripts/install.sh | bash
```

Make sure `~/.local/bin` is on your `PATH`, then run from your project directory:

```sh
pi-console
```

The installer also adds `pi-stable`, which runs Pi's terminal UI with the same
bundled extensions. Your regular `pi` command is unchanged.

Run the install command again to update, then close and relaunch `pi-console`.
For a specific release or a development checkout, see
[Maintaining pi-console](MAINTAINING.md).

## Your first conversation

Answer the project-trust prompt if one appears. Type in the prompt buffer and
press **Ctrl+Enter** to send. Prompts submitted while Pi is working are queued.

`<leader>` means Space; for example, `<leader>s` means Space followed by `s`
in normal mode.

| Key | Action |
|---|---|
| `<leader>?` | Show help and the full key list |
| `<leader>s` | Resume a saved conversation |
| `<leader>h` | Open the searchable conversation history tree |
| `<leader>m` / `<leader>t` | Choose the model / thinking level |
| `<leader>pq` | Review queued prompts |
| `<leader>pa` | Reopen a pending question or approval |

The [user guide](docs/USAGE.md) covers conversation controls, screenshots, and
optional features.

## Use with tmux

Enable shortcuts with:

```sh
pi-console tmux setup
```

This backs up changed configuration, saves the bindings, and applies them to the
running server. Detach and reattach existing clients when first enabling it.

On tmux 3.8+, destroying the session currently viewed in a popup closes that
popup. Intentional session switches keep it open, and normal clients retain
your `detach-on-destroy` policy. Older servers still support launching popups,
but do not automatically close their attachments after session destruction.

| Key | Action |
|---|---|
| `<prefix>g` | Toggle the conversation popup |
| `<prefix>G` | Start a conversation in the current pane's directory |
| `<prefix>o` | Open or focus the overview |
| `<prefix>O` | Toggle the sidebar |

`<prefix>` is your tmux prefix key. In the overview or sidebar, use `j`/`k` and
Enter to select a conversation. See [tmux integration](docs/USAGE.md#tmux-integration)
for setup details.

## Permissions and configuration

**By default, the agent can read all files your user can read, including
credentials and private files.** The default `ask` mode requests approval for
writes outside configured paths and for shell network access. User-entered
`!`/`!!` shell commands bypass the agent sandbox.

Project trust controls whether Pi loads a project's configuration and executable
resources; it does not restrict file access. Credentials, settings, and history
are shared with your other Pi installations. Avoid opening the same conversation
for editing in multiple processes.

See the user guide to [change defaults](docs/USAGE.md#configuration),
[choose an access mode](docs/USAGE.md#access-modes), or
[enable subagents and workspaces](docs/USAGE.md#bundled-pi-extensions).

## Development

See [Maintaining pi-console](MAINTAINING.md) for checkout setup and publishing
releases.

## License

[MIT](LICENSE)
