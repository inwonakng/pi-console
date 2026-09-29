#!/usr/bin/env bash

set -eu

repository=https://github.com/inwonakng/pi-console.git
releases_api=https://api.github.com/repos/inwonakng/pi-console/releases/latest
install_root=${PI_CONSOLE_INSTALL_DIR:-"${XDG_DATA_HOME:-$HOME/.local/share}/pi-console"}
bin_dir=${PI_CONSOLE_BIN_DIR:-"$HOME/.local/bin"}
requested_version=
requested_ref=
tmux_mode=ask

usage() {
    cat >&2 <<'EOF'
Usage: install.sh [--version VERSION | --ref REF] [--configure-tmux | --no-configure-tmux]

Options:
  --version VERSION   Install a release tag (for example, 0.1.0 or v0.1.0).
  --ref REF           Install a specific Git branch or tag.
  --configure-tmux    Add the pi-console integration to the tmux configuration.
  --no-configure-tmux Do not offer to edit the tmux configuration.
EOF
    exit "${1:-2}"
}

while [ "$#" -gt 0 ]; do
    case "$1" in
        --version)
            [ "$#" -ge 2 ] || usage
            [ -z "$requested_ref" ] || {
                printf '%s\n' 'Use only one of --version and --ref.' >&2
                exit 2
            }
            requested_version=$2
            shift 2
            ;;
        --ref)
            [ "$#" -ge 2 ] || usage
            [ -z "$requested_version" ] || {
                printf '%s\n' 'Use only one of --version and --ref.' >&2
                exit 2
            }
            requested_ref=$2
            shift 2
            ;;
        --configure-tmux)
            tmux_mode=yes
            shift
            ;;
        --no-configure-tmux)
            tmux_mode=no
            shift
            ;;
        -h|--help)
            usage 0
            ;;
        *)
            printf 'Unknown option: %s\n' "$1" >&2
            usage
            ;;
    esac
done

case "$install_root" in
    ''|/|"$HOME")
        printf 'Refusing unsafe installation directory: %s\n' "$install_root" >&2
        exit 1
        ;;
    /*) ;;
    *)
        printf 'Installation directory must be absolute: %s\n' "$install_root" >&2
        exit 1
        ;;
esac
case "$bin_dir" in
    /*) ;;
    *)
        printf 'Command directory must be absolute: %s\n' "$bin_dir" >&2
        exit 1
        ;;
esac

missing=
required_commands='curl git node npm nvim pi tmux fzf cargo cc realpath rg'
if [ "$(uname -s)" = Linux ]; then
    required_commands="$required_commands bwrap socat"
fi
for command in $required_commands; do
    if ! command -v "$command" >/dev/null 2>&1; then
        missing="$missing $command"
    fi
done
if [ -n "$missing" ]; then
    printf 'Missing required commands:%s\n' "$missing" >&2
    exit 1
fi

marker_path="$install_root/.pi-console-install"
launcher_path="$bin_dir/pi-console"
launcher_marker='# Managed by the pi-console installer.'

if [ -e "$install_root" ] && [ ! -d "$install_root" ]; then
    printf 'Refusing to replace non-directory installation path: %s\n' "$install_root" >&2
    exit 1
fi
if [ -d "$install_root" ] && [ ! -f "$marker_path" ]; then
    printf 'Refusing to replace an installation directory not owned by pi-console: %s\n' "$install_root" >&2
    exit 1
fi
if [ -e "$launcher_path" ] || [ -L "$launcher_path" ]; then
    if [ ! -f "$launcher_path" ] || ! grep -Fqx "$launcher_marker" "$launcher_path"; then
        printf 'Refusing to replace an unmanaged command: %s\n' "$launcher_path" >&2
        exit 1
    fi
fi

install_parent=$(dirname -- "$install_root")
mkdir -p "$install_parent" "$bin_dir"
staging_root=$(mktemp -d "$install_parent/.pi-console-install.XXXXXX")
staged_source="$staging_root/source"
backup_root=$(mktemp -d "$install_parent/.pi-console-backup.XXXXXX")
backup_path="$backup_root/application"
had_previous_install=no
previous_moved=no
swapped=no
package_registered=no
installation_finalized=no

cleanup() {
    status=$?
    if [ "$status" -ne 0 ] && [ "$installation_finalized" = no ]; then
        if [ "$swapped" = yes ]; then
            rm -rf "$install_root"
        fi
        if [ "$previous_moved" = yes ] && [ -d "$backup_path" ]; then
            mv "$backup_path" "$install_root"
        fi
        if [ "$package_registered" = yes ] && [ "$had_previous_install" = no ]; then
            pi remove "$install_root/pi" >/dev/null 2>&1 || true
        fi
    fi
    rm -rf "$backup_root" "$staging_root"
    trap - EXIT
    exit "$status"
}
trap cleanup EXIT

if [ -n "$requested_version" ]; then
    case "$requested_version" in
        v*) install_ref=$requested_version ;;
        *) install_ref="v$requested_version" ;;
    esac
elif [ -n "$requested_ref" ]; then
    install_ref=$requested_ref
else
    release_response="$staging_root/latest-release.json"
    http_status=$(curl -sS -L -o "$release_response" -w '%{http_code}' "$releases_api" || true)
    case "$http_status" in
        200)
            install_ref=$(node - "$release_response" <<'NODE'
const fs = require("node:fs");
const release = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (typeof release.tag_name !== "string" || release.tag_name.length === 0) {
  process.exit(1);
}
process.stdout.write(release.tag_name);
NODE
            )
            ;;
        404)
            install_ref=main
            printf '%s\n' 'No published release was found; installing the main branch.'
            ;;
        *)
            printf 'Could not determine the latest release (GitHub returned HTTP %s).\n' "$http_status" >&2
            printf '%s\n' 'Retry later or select a branch or tag with --ref.' >&2
            exit 1
            ;;
    esac
fi

printf 'Downloading pi-console ref %s...\n' "$install_ref"
git clone --quiet --depth 1 --branch "$install_ref" "$repository" "$staged_source"
installed_commit=$(git -C "$staged_source" rev-parse HEAD)
installed_package_version=$(node - "$staged_source/pi/package.json" <<'NODE'
const fs = require("node:fs");
const packageJson = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
process.stdout.write(packageJson.version);
NODE
)

printf '%s\n' 'Installing Pi package dependencies...'
(cd "$staged_source/pi" && npm ci --omit=dev)
rm -rf "$staged_source/.git"
cat >"$staged_source/.pi-console-install" <<EOF
ref=$install_ref
version=$installed_package_version
commit=$installed_commit
source=$repository
EOF

staged_launcher="$staging_root/pi-console"
printf '#!/usr/bin/env bash\n%s\nexec %q "$@"\n' \
    "$launcher_marker" "$install_root/bin/pi-console" >"$staged_launcher"
chmod 755 "$staged_launcher"

previous_ref=
previous_commit=
if [ -f "$marker_path" ]; then
    had_previous_install=yes
    previous_ref=$(awk -F= '$1 == "ref" { print substr($0, index($0, "=") + 1); exit }' "$marker_path")
    previous_commit=$(awk -F= '$1 == "commit" { print substr($0, index($0, "=") + 1); exit }' "$marker_path")
    mv "$install_root" "$backup_path"
    previous_moved=yes
fi
mv "$staged_source" "$install_root"
swapped=yes

printf '%s\n' 'Registering the global Pi package...'
pi install "$install_root/pi"
package_registered=yes
mv "$staged_launcher" "$launcher_path"
installation_finalized=yes
swapped=no
if [ "$previous_moved" = yes ]; then
    rm -rf "$backup_path"
    previous_moved=no
fi

configure_tmux=no
case "$tmux_mode" in
    yes) configure_tmux=yes ;;
    no) ;;
    ask)
        answer=
        if printf 'Add the pi-console integration to your tmux configuration? [y/N] ' >/dev/tty 2>/dev/null \
            && IFS= read -r answer </dev/tty 2>/dev/null; then
            case "$answer" in
                y|Y|yes|YES|Yes) configure_tmux=yes ;;
            esac
        fi
        ;;
esac

if [ "$configure_tmux" = yes ]; then
    home_tmux_config="$HOME/.tmux.conf"
    xdg_tmux_config="${XDG_CONFIG_HOME:-$HOME/.config}/tmux/tmux.conf"
    if [ -f "$home_tmux_config" ]; then
        tmux_config=$home_tmux_config
    elif [ -f "$xdg_tmux_config" ]; then
        tmux_config=$xdg_tmux_config
    else
        tmux_config=$home_tmux_config
    fi
    tmux_marker='# >>> pi-console >>>'
    tmux_line='if-shell "command -v pi-console >/dev/null 2>&1" "run-shell '\''pi-console --tmux setup'\''"'
    if [ -f "$tmux_config" ] && grep -Fqx "$tmux_line" "$tmux_config"; then
        printf 'tmux integration is already present in %s.\n' "$tmux_config"
    elif [ -f "$tmux_config" ] && grep -Fqx "$tmux_marker" "$tmux_config"; then
        printf 'The pi-console block in %s is incomplete; leaving it unchanged.\n' "$tmux_config" >&2
    else
        mkdir -p "$(dirname -- "$tmux_config")"
        if [ -f "$tmux_config" ]; then
            tmux_backup=$(mktemp "$tmux_config.pi-console.bak.XXXXXX")
            cp "$tmux_config" "$tmux_backup"
            printf 'Backed up the tmux configuration to %s.\n' "$tmux_backup"
        fi
        cat >>"$tmux_config" <<'EOF'

# >>> pi-console >>>
if-shell "command -v pi-console >/dev/null 2>&1" "run-shell 'pi-console --tmux setup'"
# <<< pi-console <<<
EOF
        printf 'Added the tmux integration to %s.\n' "$tmux_config"
    fi
fi

if [ -n "$previous_commit" ] && [ "$previous_commit" = "$installed_commit" ]; then
    printf '\npi-console is already current at %s (%s).\n' "$install_ref" "$installed_commit"
elif [ -n "$previous_commit" ]; then
    printf '\nUpdated pi-console from %s (%s) to %s (%s).\n' \
        "${previous_ref:-unknown}" "$previous_commit" "$install_ref" "$installed_commit"
else
    printf '\nInstalled pi-console %s (%s).\n' "$install_ref" "$installed_commit"
fi
printf 'Command: %s\n' "$launcher_path"
printf 'Application: %s\n' "$install_root"
printf '%s\n' 'Restart running Pi/Neovim processes before using the updated extensions.'
