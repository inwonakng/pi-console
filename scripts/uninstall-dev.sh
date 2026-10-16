#!/usr/bin/env bash
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
project_root=$(CDPATH= cd -- "$script_dir/.." && pwd -P)
. "$script_dir/install-common.sh"
bin_dir=${PI_CONSOLE_BIN_DIR:-"$HOME/.local/bin"}
bin_dir=${bin_dir%/}
validate_directory "$bin_dir"
[ "$#" -eq 0 ] || fail 'Usage: uninstall-dev.sh'

# Only remove wrappers whose full contents identify this checkout. Other dev
# checkouts and both stable commands are deliberately left alone.
staging=$(mktemp -d "${TMPDIR:-/tmp}/pi-console-uninstall-dev.XXXXXX")
trap 'rm -rf -- "$staging"' EXIT
remove_old_registration "$project_root/pi"
for name in pi-console-dev pi-dev; do
    case "$name" in pi-console-dev) target=pi-console ;; pi-dev) target=pi-shell ;; esac
    dev_wrapper "$project_root/bin/$target" >"$staging/$name"
    if [ ! -L "$bin_dir/$name" ] && [ -f "$bin_dir/$name" ] && cmp -s "$bin_dir/$name" "$staging/$name"; then
        rm -- "$bin_dir/$name"
    fi
done
remove_checkout_link "$bin_dir/pi-console" "$project_root/bin/pi-console"
printf 'Removed this checkout\047s development commands and old Pi registration.\n'
printf 'Stable commands, the checkout, dependencies, and user configuration were left unchanged.\n'
