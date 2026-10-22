# Maintaining pi-console

For installation and everyday use, see the [README](README.md) and
[user guide](docs/USAGE.md).

## Development setup

From your checkout, run:

```sh
scripts/install-dev.sh
pi-console-dev
```

The installer builds locked Pi/service dependencies in an immutable snapshot of
this checkout, including current source edits, and selects it through the dev
`current` link. It does not update stable or alter checkout dependencies. Use
`scripts/install-dev.sh --server-only` for a headless host; use `--full` to switch
back. Omitting a mode flag preserves the selected mode (initially full).

| Interface | Installed release | Development checkout |
|---|---|---|
| Neovim frontend | `pi-console` | `pi-console-dev` |
| Pi terminal UI | `pi-stable` | `pi-dev` |

Rerun the dev installer after source or dependency changes, then relaunch the
frontend/TUI or explicitly restart the service when appropriate. Existing processes
retain their original snapshot. To use dev with tmux shortcuts:

```sh
pi-console-dev tmux setup
```

Switch back with `pi-console tmux setup`. Installing either version does not
change the selected tmux shortcuts. `scripts/uninstall-dev.sh` removes this
checkout's development commands and old package registration. It does not stop
services or remove runtime snapshots, state, credentials or workspaces. Another
checkout's dev installation is refused; unrelated wrappers are left untouched.

### Repository layout

| Path | Purpose |
|---|---|
| `bin/` | Launchers and release/development selection |
| `nvim/` | Dedicated Neovim configuration and Pi RPC client |
| `pi/` | Bundled extensions and subagent profiles |
| `tmux/` | Popup, overview, and sidebar integration |
| `scripts/` | Installation and release scripts |

## Publish a release

Start from a clean `main` checkout that has been pushed to origin. The release
script needs an authenticated GitHub CLI (`gh`).

Before publishing, manually check startup and the changed behavior, then exercise
prompting, streaming, tool execution, and approvals. Also check session resume,
restarts, subagents, and overview/sidebar navigation. Keep a working installed
release available while developing.

```sh
scripts/release.sh
```

The script suggests a tag in the form `vYYYY.MM.DD.N`, starting at 1 each day.
Accept it or enter another tag, then confirm the commit to publish. To supply
the tag upfront:

```sh
scripts/release.sh v2026.10.05.2
```

After confirmation, the script creates an annotated tag, pushes it, and publishes
a GitHub Release marked latest. It does not publish to npm or update your local
installed release. The npm package version is separate from application tags.

Tags are immutable. If publication fails after the tag was pushed, create the
GitHub Release for that existing tag with GitHub or `gh`; do not replace the tag.

## Install or recover a release

From a checkout:

```sh
# Latest published release
bash scripts/install.sh

# A specific published release
bash scripts/install.sh --version v2026.10.05.1
```

Both `pi-console` and `pi-stable` use the selected release. If dev breaks, launch
one of these directly; it starts a fresh process. Installing requires network
access, and a first frontend launch may also download plugins or parsers. Install
and launch a working release beforehand if you need an offline fallback.

The default installer requires a published release and never falls back to
`main`. To deliberately install an unpublished candidate, use
`bash scripts/install.sh --ref main` (or another branch/tag).

Close and relaunch through `pi-console` or `pi-stable` to use the selected
release. `:PiConsoleRestart` keeps the process's original release. Check the
running build with `:PiConsoleVersion`, or the selected build with
`pi-console --version`.
The UI labels development builds with `DEV`; a star marks a checkout that was
dirty when the process started.

### Installation paths and shared data

Releases and their npm dependencies are stored in
`~/.local/share/pi-console/versions/<commit>-<mode>-<unique>`. Legacy
`versions/<commit>` directories remain untouched. Each install gets a fresh tree,
including same-commit mode changes; no existing dependencies/builds/markers are
rewritten. The `current` link selects the installed runtime atomically after both
locked dependency installs and the TypeScript build succeed. Production server
dependencies remain; build-only dependencies are pruned.

Dev snapshots use `~/.local/share/pi-console-dev/versions/` with independent ownership
by source checkout. Launchers go in `~/.local/bin`. Override paths with
`XDG_DATA_HOME`, `PI_CONSOLE_INSTALL_DIR`, `PI_CONSOLE_DEV_INSTALL_DIR`, or
`PI_CONSOLE_BIN_DIR`. Do not point stable and dev roots at the same directory.
Installation/uninstallation uses a sibling `<root>.install-lock` directory; after
an interrupted installer, confirm it has exited before manually removing that lock.

Each installed revision has separate Neovim plugin data, state, and cache, using
`pi-console-release-<commit>`. Development uses `pi-console-dev-nvim`. Neither
changes your normal Neovim configuration. Release launches use the locked
`nvim-extras` plugin rather than a local development override.

Old stable/dev runtime directories remain so running sessions are not disrupted.
Neither installer starts/stops services or installs supervisor definitions. Service
status can compare the running and selected builds; restart is explicit and guarded.
Server-only mode installs both command names but refuses frontend/tmux operations
with instructions to install `--full`. It still requires Pi 1.3.0, Node >=22.19,
Bash/Git/ripgrep and the sandbox runtime prerequisites (Linux bubblewrap/socat).
The installer never upgrades the external Pi/Node executables; changing those can
invalidate live service resource checks, so keep them unchanged during live work.
Selecting an older release does not roll back Pi, Node, Neovim, personal packages, or user
data. Credentials, settings, and history remain shared. Back them up before
incompatible changes, and do not edit one conversation in multiple processes.

## Migrate an older installation

Run `scripts/install-dev.sh` from the checkout, then install a release. The dev
installer removes only the old checkout-owned `pi-console` symlink and package
registration; there may be no `pi-console` command until the release is installed.
Other Pi packages and the underlying `pi` executable are left alone.

Neither installer globally registers the bundled package. Use `pi-stable` or
`pi-dev` when you need its tools in Pi's terminal UI. Remove any additional copies
you registered manually with `pi remove <exact-source>`.

An old managed, unversioned installation is preserved under `versions/<commit>`.
Choose a release with the channel-aware launchers; older releases lack
`pi-stable`. Restart existing sessions after migration, then run your chosen
channel's `tmux setup` to select its shortcuts.
