#!/usr/bin/env bash
set -eu

repository=https://github.com/inwonakng/pi-console.git
releases_api=https://api.github.com/repos/inwonakng/pi-console/releases/latest
install_root=${PI_CONSOLE_INSTALL_DIR:-"${XDG_DATA_HOME:-$HOME/.local/share}/pi-console"}
bin_dir=${PI_CONSOLE_BIN_DIR:-"$HOME/.local/bin"}
install_root=${install_root%/}
bin_dir=${bin_dir%/}
requested_version=
requested_ref=
requested_mode=
fail() { printf '%s\n' "$*" >&2; exit 1; }
usage() {
    printf '%s\n' 'Usage: install.sh [--full | --server-only] [--version VERSION | --ref REF]' >&2
    printf '%s\n' 'Defaults to the latest published GitHub Release; --ref explicitly selects a branch or tag.' >&2
    exit "${1:-2}"
}
while [ "$#" -gt 0 ]; do
    case "$1" in
        --version|--ref)
            [ "$#" -ge 2 ] && [ -n "$2" ] || usage
            [ -z "$requested_version$requested_ref" ] || fail 'Use only one version or ref selector.'
            if [ "$1" = --version ]; then requested_version=$2; else requested_ref=$2; fi
            shift 2 ;;
        --full|--server-only)
            [ -z "$requested_mode" ] || fail 'Use only one installation mode flag.'
            if [ "$1" = --full ]; then requested_mode=full; else requested_mode=server-only; fi
            shift ;;
        -h|--help) usage 0 ;;
        *) usage ;;
    esac
done

# This installer is intentionally self-contained so it can be piped to bash.
validate_directory() {
    case "$1" in
        ''|/|"$HOME"|*/../*|*/..|*/./*|*/.|*//*|*$'\n'*|*$'\r'*) fail "Unsafe directory: $1" ;;
        /*) ;;
        *) fail "Directory must be absolute: $1" ;;
    esac
    [ ! -L "$1" ] || fail "Refusing symlink directory: $1"
    [ ! -e "$1" ] || [ -d "$1" ] || fail "Not a directory: $1"
}
value() { awk -v key="$2" 'index($0, key "=") == 1 { print substr($0, length(key) + 2); exit }' "$1"; }
valid_commit() {
    [ "${#1}" -eq 40 ] || return 1
    case "$1" in *[!0-9a-f]*) return 1 ;; esac
}
valid_release() {
    valid_commit "$1" && return 0
    [[ "$1" =~ ^[0-9a-f]{40}-(full|server-only)-[a-zA-Z0-9]{6}$ ]]
}
remove_registration() {
    local output
    if ! output=$(pi remove "$1" 2>&1); then
        case "$output" in
            *"No matching package found"*) ;;
            *) fail "Could not remove legacy Pi registration for $1: $output" ;;
        esac
    fi
}
validate_directory "$install_root"
validate_directory "$bin_dir"
[ "$install_root" != "$bin_dir" ] || fail 'Application and command directories must differ.'
case "$bin_dir/" in "$install_root/"*) fail 'Command directory must be outside the application directory.' ;; esac

# Serialize selection/build/activation, including mode discovery. No service is stopped.
mkdir -p "$(dirname -- "$install_root")"
install_lock="$install_root.install-lock"
mkdir -- "$install_lock" 2>/dev/null || fail "Installer already running or stale lock: $install_lock (remove only after confirming no installer is running)."
trap 'rmdir -- "$install_lock"' EXIT
legacy=no
marker="$install_root/.pi-console-install"
if [ -d "$install_root" ] && [ ! -e "$marker" ] && [ ! -L "$marker" ]; then
    # Older Neovim configurations stored plugins/parsers here before an
    # application was installed. Preserve site/, but never adopt other data.
    for path in "$install_root"/* "$install_root"/.[!.]* "$install_root"/..?*; do
        [ -e "$path" ] || [ -L "$path" ] || continue
        if [ "$path" = "$install_root/site" ] && [ -d "$path" ] && [ ! -L "$path" ]; then
            continue
        fi
        fail "Refusing an unowned installation directory: $install_root (unexpected path: $path)"
    done
elif [ -d "$install_root" ]; then
    [ ! -L "$marker" ] && [ -f "$marker" ] && [ "$(value "$marker" source)" = "$repository" ] \
        || fail "Refusing an unowned installation directory: $install_root"
    layout=$(value "$marker" layout)
    if [ "$layout" != versioned ]; then
        [ -z "$layout" ] || fail "Unknown installation layout: $layout"
        legacy=yes
        legacy_commit=$(value "$marker" commit)
        valid_commit "$legacy_commit" || fail 'Legacy installation has an invalid commit marker.'
        [ -f "$install_root/bin/pi-console" ] && [ -d "$install_root/pi/node_modules" ] \
            || fail 'Legacy installation is incomplete; leaving it unchanged.'
    else
        [ ! -L "$install_root/versions" ] && [ -d "$install_root/versions" ] || fail 'Invalid versions directory.'
        for name in current; do
            if [ -L "$install_root/$name" ]; then
                link=$(readlink "$install_root/$name")
                case "$link" in versions/*) valid_release "${link#versions/}" || fail "Invalid $name link." ;; *) fail "Unmanaged $name link." ;; esac
                selected="$install_root/$link"
                [ ! -L "$selected" ] && [ -d "$selected" ] \
                    && [ ! -L "$selected/.pi-console-install" ] && [ -f "$selected/.pi-console-install" ] \
                    && [ "$(value "$selected/.pi-console-install" source)" = "$repository" ] \
                    || fail 'Invalid selected stable runtime.'
            elif [ -e "$install_root/$name" ]; then
                fail "Refusing unmanaged path: $install_root/$name"
            fi
        done
    fi
fi

mode=$requested_mode
if [ -z "$mode" ] && [ "$legacy" = no ] && [ -L "$install_root/current" ]; then
    selected_marker="$install_root/current/.pi-console-install"
    [ ! -L "$selected_marker" ] && [ -f "$selected_marker" ] \
        && [ "$(value "$selected_marker" source)" = "$repository" ] || fail 'Invalid selected release marker.'
    mode=$(value "$selected_marker" mode)
fi
mode=${mode:-full}
case "$mode" in full|server-only) ;; *) fail "Unknown installation mode: $mode" ;; esac
missing=
required_commands='curl git node npm pi realpath rg'
if [ "$mode" = full ]; then required_commands="$required_commands nvim tmux fzf cargo cc"; fi
if [ "$(uname -s)" = Linux ]; then required_commands="$required_commands bwrap socat"; fi
for command in $required_commands; do
    if ! command -v "$command" >/dev/null 2>&1; then missing="$missing $command"; fi
done
[ -z "$missing" ] || fail "Missing required commands:$missing"
node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 19) ? 0 : 1)' \
    || fail 'Node.js 22.19.0 or newer is required. Update Node.js and retry.'
[ "$(pi --version)" = 1.3.0 ] || fail 'Pi 1.3.0 is required by this build. Select that Pi version and retry; the installer does not modify Pi.'
if [ -e "$install_root/pi" ] || [ -L "$install_root/pi" ]; then
    [ "$legacy" = yes ] || { [ -L "$install_root/pi" ] && [ "$(readlink "$install_root/pi")" = current/pi ]; } \
        || fail 'Unmanaged compatibility package link.'
fi
mkdir -p "$bin_dir"
staging=$(mktemp -d "$(dirname -- "$install_root")/.pi-console-install.XXXXXX")
migration_started=no
activation_done=no
cleanup() {
    local status=$?
    if [ "$status" -ne 0 ] && [ "$migration_started" = yes ] && [ "$activation_done" = no ]; then
        # Restore the original tree AND command paths on any activation failure.
        # Its Pi registration has not been removed yet.
        if [ ! -d "$staging/legacy" ] && [ -d "$install_root/versions/$legacy_commit" ]; then
            mv -- "$install_root/versions/$legacy_commit" "$staging/legacy" || return
        fi
        if [ -d "$staging/legacy" ]; then
            rm -rf -- "$install_root"
            mv -- "$staging/legacy" "$install_root" || return
            for name in pi-console pi-stable; do
                rm -f -- "$bin_dir/$name"
                if [ -e "$staging/commands/$name" ] || [ -L "$staging/commands/$name" ]; then
                    cp -P -- "$staging/commands/$name" "$bin_dir/$name" || return
                fi
            done
        else
            printf 'Could not locate the original installation; recovery files retained at %s.\n' "$staging" >&2
            return
        fi
    fi
    rm -rf -- "$staging"
    rmdir -- "$install_lock"
}
trap cleanup EXIT
source_dir="$staging/source"

# Generate stable wrappers now and preflight every destination before downloads.
legacy_checkout=
for name in pi-console pi-stable; do
    case "$name" in
        pi-console) target='current/bin/pi-console' ;;
        pi-stable) target='current/bin/pi-shell' ;;
    esac
    {
        printf '#!/usr/bin/env bash\n# Managed by the pi-console installer.\n'
        printf 'exec %q "$@"\n' "$install_root/$target"
    } >"$staging/$name"
    chmod 755 "$staging/$name"
    path="$bin_dir/$name"
    if [ -e "$path" ] || [ -L "$path" ]; then
        owned=no
        if [ ! -L "$path" ] && [ -f "$path" ]; then
            if cmp -s "$path" "$staging/$name"; then owned=yes; fi
            if [ "$name" = pi-console ] && [ "$legacy" = yes ]; then
                printf '#!/usr/bin/env bash\n# Managed by the pi-console installer.\nexec %q "$@"\n' \
                    "$install_root/bin/pi-console" >"$staging/old-wrapper"
                if cmp -s "$path" "$staging/old-wrapper"; then owned=yes; fi
            fi
        elif [ "$name" = pi-console ] && [ -L "$path" ] && [ -n "${BASH_SOURCE[0]:-}" ]; then
            # Only the exact symlink created by this checkout's old dev installer.
            script_dir=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
            checkout=$(CDPATH= cd -- "$script_dir/.." && pwd -P)
            if [ "$(readlink "$path")" = "$checkout/bin/pi-console" ]; then
                owned=yes
                legacy_checkout=$checkout
            fi
        fi
        [ "$owned" = yes ] || fail "Refusing to replace an unrelated command: $path"
    fi
    if [ "$legacy" = yes ] && { [ -e "$path" ] || [ -L "$path" ]; }; then
        mkdir -p "$staging/commands"
        cp -P -- "$path" "$staging/commands/$name"
    fi
done

if [ -n "$requested_version" ]; then
    case "$requested_version" in v*) install_ref=$requested_version ;; *) install_ref="v$requested_version" ;; esac
elif [ -n "$requested_ref" ]; then
    install_ref=$requested_ref
else
    http_status=$(curl -sS -L -o "$staging/release.json" -w '%{http_code}' "$releases_api") \
        || fail 'Could not fetch the latest GitHub Release.'
    [ "$http_status" = 200 ] || fail "No latest GitHub Release is available (HTTP $http_status); select --version or an explicit --ref."
    install_ref=$(node - "$staging/release.json" <<'NODE'
const release = JSON.parse(require("node:fs").readFileSync(process.argv[2], "utf8"));
if (release.draft || release.prerelease || typeof release.tag_name !== "string" || !release.tag_name) process.exit(1);
process.stdout.write(release.tag_name);
NODE
    ) || fail 'Invalid latest-release response.'
fi
case "$install_ref" in ''|-*|*$'\n'*|*$'\r'*) fail 'Invalid installation ref.' ;; esac
git check-ref-format --branch "$install_ref" >/dev/null || fail 'Invalid branch or tag name.'
printf 'Downloading pi-console ref %s...\n' "$install_ref"
git clone --quiet --depth 1 --branch "$install_ref" "$repository" "$source_dir"
commit=$(git -C "$source_dir" rev-parse HEAD)
valid_commit "$commit" || fail 'Git returned an invalid commit.'
[ -f "$source_dir/bin/pi-console" ] && [ -f "$source_dir/bin/pi-shell" ] \
    && [ -f "$source_dir/bin/channel-env.sh" ] || fail 'Selected ref does not contain the channel-aware launchers.'
[ -f "$source_dir/scripts/build-runtime.sh" ] || fail 'Selected ref predates service packaging; select a release with F1 packaging.'
printf 'Building %s runtime with locked dependencies...\n' "$mode"
bash "$source_dir/scripts/build-runtime.sh"
rm -rf -- "$source_dir/.git"
printf 'ref=%s\ncommit=%s\nsource=%s\nchannel=stable\nmode=%s\n' "$install_ref" "$commit" "$repository" "$mode" >"$source_dir/.pi-console-install"
# Every activation gets a fresh immutable directory, including same-commit mode changes.
release="$commit-$mode-${staging##*.}"

# Keep legacy registrations intact until filesystem activation succeeds. During
# migration the compatibility package link keeps ordinary Pi usable as well.
if [ "$legacy" = yes ]; then
    mv -- "$install_root" "$staging/legacy"
    migration_started=yes
fi
mkdir -p "$install_root/versions"
if [ "$legacy" = yes ]; then
    mv -- "$staging/legacy" "$install_root/versions/$legacy_commit"
    ln -s "versions/$legacy_commit" "$install_root/current"
    ln -s current/pi "$install_root/pi"
fi
printf 'layout=versioned\nsource=%s\n' "$repository" >"$staging/root-marker"
mv -f -- "$staging/root-marker" "$install_root/.pi-console-install"
[ ! -e "$install_root/versions/$release" ] && [ ! -L "$install_root/versions/$release" ] \
    || fail "Refusing to replace a runtime: $release"
mv -- "$source_dir" "$install_root/versions/$release"
# Activate only after downloads and dependency installation have succeeded.
ln -s "versions/$release" "$staging/current"
case "$(uname -s)" in
    Darwin) mv -fh -- "$staging/current" "$install_root/current" ;;
    *) mv -fT -- "$staging/current" "$install_root/current" ;;
esac
for name in pi-console pi-stable; do
    mv -f -- "$staging/$name" "$bin_dir/$name"
done
activation_done=yes
# Remove only known old registrations, not other user packages. If this fails,
# the selected release and compatibility package remain usable; retry migration.
if [ -n "$legacy_checkout" ]; then remove_registration "$legacy_checkout/pi"; fi
if [ "$legacy" = yes ] || [ -L "$install_root/pi" ]; then
    [ "$(readlink "$install_root/pi")" = current/pi ] || fail 'Unmanaged compatibility package link.'
    remove_registration "$install_root/pi"
    rm -- "$install_root/pi"
fi

printf '\nInstalled stable commands in %s.\nApplication: %s\n' "$bin_dir" "$install_root"
printf '%s\n' 'To install another release, rerun install.sh --version <TAG>.'
printf 'Mode: %s. Existing services/sessions were not restarted; old runtimes are retained.\n' "$mode"
printf '%s\n' 'New launches use the selected runtime. Service restart remains explicit and guarded.'
if [ "$mode" = full ]; then
    printf '\nTmux selection was not changed. To select stable bindings, run: pi-console tmux setup\n'
else
    printf '%s\n' 'Headless commands: pi-console server ... and pi-stable. No supervisor was enabled.'
fi
