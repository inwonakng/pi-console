#!/usr/bin/env bash
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
project_root=$(CDPATH= cd -- "$script_dir/.." && pwd -P)
. "$script_dir/install-common.sh"
bin_dir=${PI_CONSOLE_BIN_DIR:-"$HOME/.local/bin"}
bin_dir=${bin_dir%/}
validate_directory "$bin_dir"
service_args=()
while [ "$#" -gt 0 ]; do
    case "$1" in
        --force) service_args+=(--force); shift ;;
        --root|--supervisor-dir)
            [ "$#" -ge 2 ] || fail 'Missing service option value.'
            service_args+=("$1" "$2"); shift 2 ;;
        *) fail 'Usage: uninstall-dev.sh [--force] [--root PRIVATE_PROFILE] [--supervisor-dir DIR]' ;;
    esac
done
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
# Guarded shutdown precedes any command removal. The installed CLI checks both
# the live owner and the exact startup definition against this checkout.
if [ -f "$install_root/current/server/dist/cli.js" ]; then
    bash "$install_root/current/bin/pi-console" server disable "${service_args[@]}"
else
    fail 'No installed service manager is available. Retaining commands; build/install this checkout before guarded uninstall.'
fi
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
printf 'This checkout\047s service startup was disabled and idle sessions stopped/saved (active work requires --force).\n'
printf 'Stable/unrelated commands and services, runtime snapshots, session/workspace data, credentials and user configuration were retained.\n'
