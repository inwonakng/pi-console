#!/usr/bin/env bash
# Shared by the installation scripts; never sourced from an installed release.

fail() { printf '%s\n' "$*" >&2; exit 1; }

validate_directory() {
    case "$1" in
        ''|/|"$HOME"|*/../*|*/..|*/./*|*/.|*//*|*$'\n'*|*$'\r'*)
            fail "Refusing unsafe directory: $1" ;;
        /*) ;;
        *) fail "Directory must be absolute: $1" ;;
    esac
    [ ! -L "$1" ] || fail "Refusing symlink directory: $1"
    [ ! -e "$1" ] || [ -d "$1" ] || fail "Not a directory: $1"
}

# Compare the entire wrapper, not just a marker that another installation shares.
check_wrapper() {
    local path=$1 expected=$2
    if [ -e "$path" ] || [ -L "$path" ]; then
        [ ! -L "$path" ] && [ -f "$path" ] && cmp -s "$path" "$expected" \
            || fail "Refusing to replace an unrelated command: $path"
    fi
}

dev_wrapper() {
    printf '#!/usr/bin/env bash\n# Managed by the pi-console dev installer.\nexec %q "$@"\n' "$1"
}

value() { awk -v key="$2" 'index($0, key "=") == 1 { print substr($0, length(key) + 2); exit }' "$1"; }

dev_install_root() {
    install_root=${PI_CONSOLE_DEV_INSTALL_DIR:-"${XDG_DATA_HOME:-$HOME/.local/share}/pi-console-dev"}
    install_root=${install_root%/}
    validate_directory "$install_root"
    [ "$install_root" != "$bin_dir" ] || fail 'Application and command directories must differ.'
    case "$bin_dir/" in "$install_root/"*) fail 'Command directory must be outside the application directory.' ;; esac
    marker="$install_root/.pi-console-dev-install"
    if [ -e "$install_root" ]; then
        [ ! -L "$marker" ] && [ -f "$marker" ] && [ "$(value "$marker" checkout)" = "$project_root" ] \
            || fail "Dev installation belongs to another checkout or is unowned: $install_root"
        [ ! -L "$install_root/versions" ] && [ -d "$install_root/versions" ] || fail 'Invalid dev versions directory.'
        [ -L "$install_root/current" ] || fail 'Invalid dev current link.'
        local selected
        selected=$(readlink "$install_root/current")
        [[ "$selected" =~ ^versions/[0-9a-f]{40}-(full|server-only)-[a-zA-Z0-9]{6}$ ]] \
            || fail 'Unmanaged dev current link.'
        [ ! -L "$install_root/$selected" ] && [ -d "$install_root/$selected" ] \
            && [ ! -L "$install_root/$selected/.pi-console-install" ] \
            && [ -f "$install_root/$selected/.pi-console-install" ] \
            && [ "$(value "$install_root/$selected/.pi-console-install" checkout)" = "$project_root" ] \
            && [ "$(value "$install_root/$selected/.pi-console-install" channel)" = dev ] \
            || fail 'Invalid selected dev runtime.'
    fi
}

remove_old_registration() {
    local output
    if ! output=$(pi remove "$1" 2>&1); then
        case "$output" in
            *"No matching package found"*) ;;
            *) fail "Could not remove legacy Pi registration for $1: $output" ;;
        esac
    fi
}

remove_checkout_link() {
    local path=$1 target=$2
    if [ -L "$path" ] && [ "$(readlink "$path")" = "$target" ]; then
        rm -- "$path"
    fi
}
