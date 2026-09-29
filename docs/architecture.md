# Architecture

pi-console is distributed as one repository with three cooperating components.

## Neovim application

`nvim/` is a dedicated Neovim configuration started with
`NVIM_APPNAME=pi-console`. It launches Pi in RPC mode and exposes the
conversation, history, tree, workspace, subagent, and overview interfaces.

The UI communicates with Pi through the documented JSONL RPC protocol. Richer
workflow state is carried through extension UI status messages and slash
commands supplied by the bundled Pi package. The Neovim and extension code are
released together because those private payloads form one application contract.

## Pi package

`pi/` contains the extension suite, default subagent profiles, notification
assets, and workspace review helpers. It is installed into the user's existing
Pi configuration as a package; it does not replace `PI_CODING_AGENT_DIR`.

Credentials, model settings, `AGENTS.md`, skills, prompts, and other packages
remain under `~/.pi/agent`. Project `.pi` resources continue to load through
Pi's normal trust and configuration rules.

## tmux backend

`tmux/pi-console.conf` contains only the options and bindings owned by
pi-console. The user's primary tmux configuration asks the installed
`pi-console` command to source this file, and its bindings route back through
that command. The shell helpers maintain a persistent `agents` session
containing one overview window and zero or more conversation windows.

Neovim session snapshots are published as tmux pane options. Cross-instance
controls connect to each Neovim RPC server, so the dashboard is not coupled to
terminal keystroke injection.
