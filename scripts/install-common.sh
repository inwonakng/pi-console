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
