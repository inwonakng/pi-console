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

Install these before starting (both installers check versions and required capabilities):

- Pi >=1.3.0, Node.js >=22.19.0, Git >=2.45.0, Bash, curl, tar, npm, `realpath`, and `ripgrep`.
  Git must support `merge-tree --write-tree --merge-base` with raw tree operands.
- For a full client: Neovim >=0.12.0 with `vim.pack.add` and Tree-sitter runtime ABI >=13,
  tmux, `fzf`, Rust/Cargo, a C compiler, and Tree-sitter CLI >=0.26.1
  (`tree-sitter generate` and `tree-sitter build`; install through a package manager, not npm).
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

A local launch ensures the independent service and opens an unstarted frontend in
the invocation directory. The first prompt or shell command creates a conversation.
Closing Neovim leaves started conversations running.
Every service also listens on all IPv4 interfaces, port `8443` by default.
**Anyone who can reach that port can view and control sessions. There is no
authentication or encryption; restrict access with your VPN/network and firewall.**
Connect with `pi-console --remote http://HOST:8443`; `pi-console server status`
reports candidate URLs. Use `server start/restart/enable --port PORT` for another port.
`pi-console --overview` and `--sidebar` create no conversation. Use `--attach ID`
for a live conversation or `--resume ID` for a saved service conversation.

The installer also adds `pi-stable`, which runs Pi's terminal UI directly with the
same bundled extensions. Your regular `pi` command is unchanged.

Run the install command again to update. New frontends/TUIs use the selected
runtime. A running service, including conversations created after the update,
keeps its pinned runtime until an explicit guarded restart. The installer builds
the service/bridge using locked dependencies and never starts or restarts a service.
For a specific release or a development checkout, see
[Maintaining pi-console](MAINTAINING.md).

### Headless execution host

```sh
curl -fsSL https://raw.githubusercontent.com/inwonakng/pi-console/main/scripts/install.sh | bash -s -- --server-only
pi-console server start --binary /absolute/path/to/pi
```

Server-only mode needs no Neovim, tmux, fzf, Cargo or Tree-sitter tooling. It includes
the service, bridge and bundled extensions; `pi-stable` remains a direct Pi TUI.
Updates without a mode flag preserve the selected mode; use `--full` to switch back.
A full client can attach with `pi-console --attach ID`. See
[service usage](server/README.md) for private profiles and remote setup.

### Service management

Installation never enables startup. Enable it explicitly with macOS launchd or
Linux user-systemd:

```sh
pi-console server enable --binary /absolute/path/to/pi
pi-console server status
pi-console server restart
pi-console server disable
```

Normal stop/restart/disable refuses active work, queued prompts and approvals;
`--force` intentionally interrupts owned work. Idle conversations are stopped and
saved. Disable preserves histories, workspaces and credentials. Updates leave the
running release pinned; status reports running/selected builds and restart needs.
Startup captures an explicit PATH and Pi/Node paths, without shell initialization.
LaunchAgents require login; Linux execution after logout requires user lingering.
Sleep suspends execution. See [service environment and startup](server/README.md#service-environment-and-startup).

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
| `<prefix>G` | Start a conversation in the agents session, using the current pane's directory |
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
