#!/usr/bin/env bash

set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
project_root=$(CDPATH= cd -- "$script_dir/.." && pwd -P)
bin_dir=${PI_CONSOLE_BIN_DIR:-"$HOME/.local/bin"}
command_path="$bin_dir/pi-console"

missing=
for command in nvim pi tmux node npm git fzf cargo cc realpath; do
    if ! command -v "$command" >/dev/null 2>&1; then
        missing="$missing $command"
    fi
done
if [ -n "$missing" ]; then
    printf 'Missing required commands:%s\n' "$missing" >&2
    exit 1
fi

(cd "$project_root/pi" && npm ci)
pi install "$project_root/pi"

mkdir -p "$bin_dir"
if [ -L "$command_path" ]; then
    if [ "$(readlink "$command_path")" != "$project_root/bin/pi-console" ]; then
        printf 'Refusing to replace unrelated symlink: %s\n' "$command_path" >&2
        exit 1
    fi
elif [ -e "$command_path" ]; then
    printf 'Refusing to replace existing path: %s\n' "$command_path" >&2
    exit 1
else
    ln -s "$project_root/bin/pi-console" "$command_path"
fi

printf '\nDevelopment install complete. Load the tmux integration with:\n\n'
printf '  if-shell "command -v pi-console >/dev/null 2>&1" "run-shell '\''pi-console --tmux setup'\''"\n\n'
printf 'The Pi package and pi-console command use this checkout directly.\n'
printf 'Restart running Pi/Neovim processes after edits.\n'
