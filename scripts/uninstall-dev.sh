#!/usr/bin/env bash

set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
project_root=$(CDPATH= cd -- "$script_dir/.." && pwd -P)
package="$project_root/pi"
bin_dir=${PI_CONSOLE_BIN_DIR:-"$HOME/.local/bin"}
command_path="$bin_dir/pi-console"

remove_output=
if ! remove_output=$(pi remove "$package" 2>&1); then
    case "$remove_output" in
        *"No matching package found"*) ;;
        *)
            printf '%s\n' "$remove_output" >&2
            exit 1
            ;;
    esac
fi

if [ -L "$command_path" ] && [ "$(readlink "$command_path")" = "$project_root/bin/pi-console" ]; then
    rm "$command_path"
fi

printf 'Development install removed. Remove the pi-console source-file lines from tmux when no longer needed.\n'
printf 'The checkout, dependencies, and user configuration were left unchanged.\n'
