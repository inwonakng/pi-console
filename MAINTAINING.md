# Maintaining pi-console

Development, release publishing, and installation/channel reference. For setup
and everyday use, see the [README](README.md) and [user guide](docs/USAGE.md).

## Repository layout

| Path | Purpose |
|---|---|
| `bin/pi-console` | Frontend launcher |
| `nvim/` | Dedicated Neovim configuration and RPC client |
| `pi/` | Bundled Pi extension package and subagent profiles |
| `tmux/` | tmux integration and popup/session helpers |
| `scripts/` | Installation, uninstallation, and release scripts |

## Development

Run [`scripts/install-dev.sh`](scripts/install-dev.sh) from the repository root.
It installs `pi-console-dev` and `pi-dev` wrappers and checkout npm dependencies,
without updating stable. Restart processes after edits; reinstall when dependencies
or installer-managed launchers change. `scripts/uninstall-dev.sh` removes only
this checkout's development commands and old registration.

```sh
scripts/install-dev.sh
pi-console-dev
# Use the checkout's Pi terminal UI:
pi-dev
# Opt in to development tmux bindings:
pi-console-dev tmux setup
```

## Publishing a release

Tags use `vYYYY.MM.DD.N`, starting at 1 each day. The npm package version remains
separate; four-part application tags are not npm versions. From a clean `main`
checkout already pushed to origin, with authenticated GitHub CLI (`gh`):

```sh
scripts/release.sh
# Or choose the tag explicitly:
scripts/release.sh v2026.10.05.2
```

The script fetches tags and prompts for a version: press Enter to accept the
suggested next counter, or type another tag. Passing a tag explicitly skips this
prompt. It validates the tag, shows the commit, and asks for confirmation with
`[y/N]` before creating an annotated tag, pushing it, and publishing the latest
GitHub Release. Tags are immutable. It does not publish npm packages or
update stable. If publishing fails after pushing the tag, finish creating the
Release for that existing tag through GitHub/`gh`; never move or replace it.

Before releasing, use dev for normal work and manually exercise:

- startup and the changed behavior;
- prompting, streaming, tool execution, and approvals;
- session resume, frontend/Pi restart, and subagents;
- overview/sidebar navigation, dev badges, and version identity;
- stable startup while dev is broken, and installing a specified working release.

Then publish. Install a release when needed with `scripts/install.sh` (latest) or
`scripts/install.sh --version <TAG>`. Installing at failure time needs network
access; installing beforehand provides an offline fallback. Run `pi-console`
directly for recovery, or `pi-console tmux setup` to also switch your shortcuts.
Return to dev with `pi-console-dev tmux setup`. No extra known-good registry or
promotion step is needed.
Diagnose regressions through stable while using a separate Git worktree and
`git bisect` between the working and failing revisions.

## Installation and channel behavior

The installer requires a published release by default; it never silently falls
back to `main`. Applications and npm dependencies live under
`~/.local/share/pi-console/versions/<commit>`, with `current` pointing to the
installed version. The commands installed under `~/.local/bin` are:

| Interface | Installed release | Development checkout |
|---|---|---|
| Neovim | `pi-console` | `pi-console-dev` |
| Pi terminal UI | `pi-stable` | `pi-dev` |

Both stable interfaces use the same selected version. Set `XDG_DATA_HOME`,
`PI_CONSOLE_INSTALL_DIR`, or `PI_CONSOLE_BIN_DIR` to override installation paths.
Running the installer again explicitly updates stable. From a checkout:

```sh
bash scripts/install.sh --version v2026.10.05.1
# Deliberately install a candidate branch/tag instead of a release:
bash scripts/install.sh --ref main
```

An explicit `--ref` selects a candidate, not evidence that it works. Pushing,
publishing, and editing development code never automatically update stable.
Neither installer registers the bundled Pi package globally.

### Recovery and version identity

Use dev daily. If it breaks, install the latest release with `bash scripts/install.sh`
and run `pi-console` or `pi-stable`. If already installed, simply launch stable.
Each starts a fresh process instead of focusing a broken dev view. To return to a
specific working release, use the same installer:

```sh
bash scripts/install.sh --version v2026.10.05.1
pi-console                 # or pi-stable
```

Installation selects the version for both stable commands, not existing processes
or your checkout. Installing requires network access; first frontend launch may
also download plugins/parsers. Existing windows keep their original revision
until closed or restarted. Old application/plugin directories are left untouched
so running sessions are not disrupted; there is no separate version manager or
previous-version selection.

The conversation footer shows the build after cost: `$1.24·DEV abc1234*` or
`$1.24·2026.10.05.1`. Overview/sidebar statuslines identify the viewer; dev
conversation rows have a `DEV` badge. Narrow views shorten the dev label to `DEV`.
The star records a dirty checkout at startup. `:PiConsoleVersion` and every
launcher's `--version` show channel, commit, and installation path. The UI reports
its startup identity, not a newer commit edited beneath an already-running process.

Credentials, personal Pi settings, and conversation history remain shared. Do not
edit the same conversation in two processes. When it is open in another
installation, close that frontend before resuming it here; explicitly selecting
an open overview/sidebar row can still focus it. Pi, Node, Neovim, personal
packages, and persisted user data are not rolled back. Back up shared data before
incompatible format changes.

### Migrating an existing setup

Run `scripts/install-dev.sh` from your checkout, then install the first release.
The dev installer removes only the old exact checkout-owned `pi-console` symlink
and local Pi package registration. Until a release is installed, there may be no
`pi-console` fallback. Other Pi packages and the underlying `pi` executable are
left alone. Plain `pi` no longer automatically loads pi-console's bundled tools;
use `pi-stable` or `pi-dev` for them.

An old managed, unversioned installation is preserved under `versions/<commit>`.
Install a release containing the channel-aware launchers; older revisions relied
on a global registration and lack `pi-stable`. Running sessions are not killed;
restart them after migration.

Neither installer edits tmux configuration or changes the selected channel. Each
prints the matching setup command.

### Neovim isolation

The dedicated Neovim application uses `pi-console-dev-nvim` for development and
`pi-console-release-<commit>` for each installed revision. Configuration, plugin
data, state, and cache are separate from each other and normal Neovim. Release
launches use the locked `nvim-extras` plugin, never the local development override.
