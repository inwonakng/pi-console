# Maintaining pi-console

For installation and everyday use, see the [README](README.md) and
[user guide](docs/USAGE.md).

## Development setup

From your checkout, run:

```sh
scripts/install-dev.sh
pi-console-dev
```

The installer installs npm dependencies and creates commands that use this
checkout. It does not update the installed release.

| Interface | Installed release | Development checkout |
|---|---|---|
| Neovim frontend | `pi-console` | `pi-console-dev` |
| Pi terminal UI | `pi-stable` | `pi-dev` |

Restart after code changes. Rerun the dev installer when dependencies or
installer-managed launchers change. To use dev with tmux shortcuts:

```sh
pi-console-dev tmux setup
```

Switch back with `pi-console tmux setup`. Installing either version does not
change the selected tmux shortcuts. `scripts/uninstall-dev.sh` removes this
checkout's development commands and old package registration.

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
`~/.local/share/pi-console/versions/<commit>`. The `current` link selects the
installed release; launchers go in `~/.local/bin`. Override the paths with
`XDG_DATA_HOME`, `PI_CONSOLE_INSTALL_DIR`, or `PI_CONSOLE_BIN_DIR`.

Each installed revision has separate Neovim plugin data, state, and cache, using
`pi-console-release-<commit>`. Development uses `pi-console-dev-nvim`. Neither
changes your normal Neovim configuration. Release launches use the locked
`nvim-extras` plugin rather than a local development override.

Old version directories remain so running sessions are not disrupted. Selecting
an older release does not roll back Pi, Node, Neovim, personal packages, or user
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
