#!/usr/bin/env bash
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
project_root=$(CDPATH= cd -- "$script_dir/.." && pwd -P)
. "$script_dir/install-common.sh"
bin_dir=${PI_CONSOLE_BIN_DIR:-"$HOME/.local/bin"}
bin_dir=${bin_dir%/}
validate_directory "$bin_dir"
[ "$#" -eq 0 ] || fail 'Usage: install-dev.sh'

missing=
for command in nvim pi tmux node npm git fzf cargo cc realpath; do
    if ! command -v "$command" >/dev/null 2>&1; then missing="$missing $command"; fi
done
[ -z "$missing" ] || fail "Missing required commands:$missing"
node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 19) ? 0 : 1)' \
    || fail 'Node.js 22.19.0 or newer is required by Pi. Update Node.js and retry.'
[ -f "$project_root/bin/pi-shell" ] || fail 'Missing terminal launcher: bin/pi-shell'

staging=$(mktemp -d "${TMPDIR:-/tmp}/pi-console-dev.XXXXXX")
trap 'rm -rf -- "$staging"' EXIT
for name in pi-console-dev pi-dev; do
    case "$name" in pi-console-dev) target=pi-console ;; pi-dev) target=pi-shell ;; esac
    dev_wrapper "$project_root/bin/$target" >"$staging/$name"
    chmod 755 "$staging/$name"
    check_wrapper "$bin_dir/$name" "$staging/$name"
done

(cd "$project_root/pi" && npm ci)
remove_old_registration "$project_root/pi"
mkdir -p "$bin_dir"
for name in pi-console-dev pi-dev; do
    mv -f -- "$staging/$name" "$bin_dir/$name"
done
remove_checkout_link "$bin_dir/pi-console" "$project_root/bin/pi-console"

printf '\nDevelopment commands: %s/pi-console-dev and %s/pi-dev\n' "$bin_dir" "$bin_dir"
printf 'Stable commands and their selected release were left unchanged.\n'
printf 'Tmux selection was not changed. To make dev your tmux default,\nsave that choice, and apply the bindings now, run:\n\n  pi-console-dev tmux setup\n\n'
printf 'The launchers use this checkout and scoped Pi extensions. Restart running sessions after edits.\n'
