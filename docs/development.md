# Development setup

The development installer registers the checkout directly so launcher and Pi
extension changes are available without reinstalling pi-console.

## Install the checkout

```sh
bash ~/Documents/projects/pi-console/scripts/install-dev.sh
```

The installer checks required commands, runs `npm ci`, registers `pi/` as a
local global Pi package, and links `pi-console` into `~/.local/bin`. The
launcher resolves that symlink before locating the application files.

Pi continues using the regular `~/.pi/agent` directory. The dedicated Neovim
application uses `NVIM_APPNAME=pi-console-nvim`, so it does not modify the
user's normal Neovim configuration.

Restart running Pi or Neovim processes after changing extension or launcher
code.

## Develop nvim-extras alongside pi-console

By default, Neovim installs the pinned `nvim-extras` package. To load an
editable checkout instead, register it at the shared development path:

```sh
mkdir -p ~/.local/share/nvim-dev
ln -s "$NVIM_EXTRAS_PATH" ~/.local/share/nvim-dev/nvim-extras
```

## Remove the development registration

```sh
bash ~/Documents/projects/pi-console/scripts/uninstall-dev.sh
```

The uninstaller removes only the matching package registration and launcher
symlink. It leaves the checkout, dependencies, Pi configuration, and Neovim
data unchanged.
