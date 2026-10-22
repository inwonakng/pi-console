#!/usr/bin/env bash
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
project_root=$(CDPATH= cd -- "$script_dir/.." && pwd -P)
. "$script_dir/install-common.sh"
bin_dir=${PI_CONSOLE_BIN_DIR:-"$HOME/.local/bin"}
bin_dir=${bin_dir%/}
validate_directory "$bin_dir"
[ "$#" -eq 0 ] || fail 'Usage: uninstall-dev.sh'
dev_install_root
mkdir -p "$(dirname -- "$install_root")"
install_lock="$install_root.install-lock"
mkdir -- "$install_lock" 2>/dev/null || fail "Installer already running or stale lock: $install_lock"
trap 'rmdir -- "$install_lock"' EXIT
dev_install_root

# Only remove wrappers whose full contents identify this checkout. Other dev
# checkouts and both stable commands are deliberately left alone.
staging=$(mktemp -d "${TMPDIR:-/tmp}/pi-console-uninstall-dev.XXXXXX")
trap 'rm -rf -- "$staging"; rmdir -- "$install_lock"' EXIT
remove_old_registration "$project_root/pi"
for name in pi-console-dev pi-dev; do
    case "$name" in pi-console-dev) target=pi-console ;; pi-dev) target=pi-shell ;; esac
    for runtime in "$project_root" "$install_root/current"; do
        dev_wrapper "$runtime/bin/$target" >"$staging/$name"
        if [ ! -L "$bin_dir/$name" ] && [ -f "$bin_dir/$name" ] && cmp -s "$bin_dir/$name" "$staging/$name"; then
            rm -- "$bin_dir/$name"
        fi
    done
done
remove_checkout_link "$bin_dir/pi-console" "$project_root/bin/pi-console"
printf 'Removed this checkout\047s development commands and old Pi registration.\n'
printf 'Stable commands, runtime snapshots, running services/sessions, state, credentials and user configuration were left unchanged.\n'
printf 'No service is stopped and no session/workspace data is deleted by uninstall.\n'
