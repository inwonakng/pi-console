#!/usr/bin/env bash
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
project_root=$(CDPATH= cd -- "$script_dir/.." && pwd -P)
. "$script_dir/install-common.sh"
bin_dir=${PI_CONSOLE_BIN_DIR:-"$HOME/.local/bin"}
bin_dir=${bin_dir%/}
validate_directory "$bin_dir"
mode=
case "$#:${1-}" in
    0:) ;;
    1:--full) mode=full ;;
    1:--server-only) mode=server-only ;;
    *) fail 'Usage: install-dev.sh [--full | --server-only]' ;;
esac
dev_install_root
mkdir -p "$(dirname -- "$install_root")"
install_lock="$install_root.install-lock"
mkdir -- "$install_lock" 2>/dev/null || fail "Installer already running or stale lock: $install_lock"
trap 'rmdir -- "$install_lock"' EXIT
# Recheck ownership after acquiring the installation lock.
dev_install_root
if [ -z "$mode" ] && [ -L "$install_root/current" ]; then
    selected_marker="$install_root/current/.pi-console-install"
    [ ! -L "$selected_marker" ] && [ -f "$selected_marker" ] \
        && [ "$(value "$selected_marker" channel)" = dev ] \
        && [ "$(value "$selected_marker" checkout)" = "$project_root" ] || fail 'Invalid selected dev runtime marker.'
    mode=$(value "$selected_marker" mode)
fi
mode=${mode:-full}
case "$mode" in full|server-only) ;; *) fail "Unknown installation mode: $mode" ;; esac
missing=
required_commands='pi node npm git realpath rg tar'
if [ "$mode" = full ]; then required_commands="$required_commands nvim tmux fzf cargo cc"; fi
if [ "$(uname -s)" = Linux ]; then required_commands="$required_commands bwrap socat"; fi
for command in $required_commands; do
    if ! command -v "$command" >/dev/null 2>&1; then missing="$missing $command"; fi
done
[ -z "$missing" ] || fail "Missing required commands:$missing"
node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 19) ? 0 : 1)' \
    || fail 'Node.js 22.19.0 or newer is required. Update Node.js and retry.'
[ "$(pi --version)" = 1.3.0 ] || fail 'Pi 1.3.0 is required by this build. Select that Pi version and retry; the installer does not modify Pi.'

staging=$(mktemp -d "$(dirname -- "$install_root")/.pi-console-dev.XXXXXX")
trap 'rm -rf -- "$staging"; rmdir -- "$install_lock"' EXIT
for name in pi-console-dev pi-dev; do
    case "$name" in pi-console-dev) target=pi-console ;; pi-dev) target=pi-shell ;; esac
    dev_wrapper "$install_root/current/bin/$target" >"$staging/$name"
    chmod 755 "$staging/$name"
    # Accept the exact wrapper from this checkout's previous installer too.
    dev_wrapper "$project_root/bin/$target" >"$staging/old-$name"
    if [ ! -L "$bin_dir/$name" ] && [ -f "$bin_dir/$name" ] && cmp -s "$bin_dir/$name" "$staging/old-$name"; then
        continue
    fi
    check_wrapper "$bin_dir/$name" "$staging/$name"
done
commit=$(git -C "$project_root" rev-parse HEAD)
[[ "$commit" =~ ^[0-9a-f]{40}$ ]] || fail 'Invalid checkout commit.'
dirty=0
[ -z "$(git --no-optional-locks -C "$project_root" status --porcelain)" ] || dirty=1
mkdir "$staging/source"
# Copy current sources (including uncommitted edits), never live dependencies/builds.
# Extract only after tar succeeds; a failed source copy must not be activated.
tar -C "$project_root" --exclude=node_modules --exclude=dist --exclude=.DS_Store \
    -cf "$staging/source.tar" bin nvim pi server tmux scripts
tar -C "$staging/source" -xf "$staging/source.tar"
bash "$staging/source/scripts/build-runtime.sh"
printf 'channel=dev\nref=checkout\ncommit=%s\ndirty=%s\nmode=%s\ncheckout=%s\n' \
    "$commit" "$dirty" "$mode" "$project_root" >"$staging/source/.pi-console-install"
release="$commit-$mode-${staging##*.}"
# Retire only the exact old registration after a successful build, before activation.
remove_old_registration "$project_root/pi"
mkdir -p "$install_root/versions" "$bin_dir"
[ ! -e "$install_root/versions/$release" ] && [ ! -L "$install_root/versions/$release" ] || fail 'Runtime already exists.'
mv -- "$staging/source" "$install_root/versions/$release"
printf 'checkout=%s\n' "$project_root" >"$staging/marker"
mv -f -- "$staging/marker" "$marker"
ln -s "versions/$release" "$staging/current"
case "$(uname -s)" in
    Darwin) mv -fh -- "$staging/current" "$install_root/current" ;;
    *) mv -fT -- "$staging/current" "$install_root/current" ;;
esac
for name in pi-console-dev pi-dev; do mv -f -- "$staging/$name" "$bin_dir/$name"; done
remove_checkout_link "$bin_dir/pi-console" "$project_root/bin/pi-console"
printf '\nDevelopment commands: %s/pi-console-dev and %s/pi-dev\n' "$bin_dir" "$bin_dir"
printf 'Mode: %s. Snapshot: %s/versions/%s\n' "$mode" "$install_root" "$release"
printf 'Rerun this installer after checkout edits. Old snapshots and running sessions are retained.\n'
printf 'Stable commands, tmux selection and service startup were left unchanged.\n'
