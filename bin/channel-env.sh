#!/usr/bin/env bash
# Shared by the frontend, terminal UI, and tmux helpers. Never source settings
# or installation markers as shell code.

pi_console_bin=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
export PI_CONSOLE_APP_ROOT=$(dirname -- "$pi_console_bin")
pi_console_marker="$PI_CONSOLE_APP_ROOT/.pi-console-install"
export PI_CONSOLE_BUILD_DIRTY=0
if [ -f "$pi_console_marker" ]; then
    export PI_CONSOLE_CHANNEL=stable
    export PI_CONSOLE_BUILD_REF=$(awk -F= '$1 == "ref" { print substr($0, index($0, "=") + 1); exit }' "$pi_console_marker")
    export PI_CONSOLE_BUILD_COMMIT=$(awk -F= '$1 == "commit" { print substr($0, index($0, "=") + 1); exit }' "$pi_console_marker")
    case "$PI_CONSOLE_BUILD_COMMIT" in
        ''|*[!a-fA-F0-9]*) printf 'Invalid installation commit in %s\n' "$pi_console_marker" >&2; return 1 ;;
    esac
    export PI_CONSOLE_NVIM_APPNAME="pi-console-release-$PI_CONSOLE_BUILD_COMMIT"
    export PI_CONSOLE_TMUX_SESSION="agents-${PI_CONSOLE_BUILD_COMMIT:0:12}"
    if [[ "$PI_CONSOLE_BUILD_REF" =~ ^v[0-9]+(\.[0-9]+)+$ ]]; then
        # Dots are reserved separators in tmux targets, not session names.
        export PI_CONSOLE_TMUX_SESSION="agents-${PI_CONSOLE_BUILD_REF//./_}"
    fi
else
    export PI_CONSOLE_CHANNEL=dev
    export PI_CONSOLE_BUILD_REF=checkout
    # Helpers need installation identity, not an inherited or freshly queried
    # checkout snapshot. Launchers fill this in immediately before startup.
    export PI_CONSOLE_BUILD_COMMIT=
    export PI_CONSOLE_NVIM_APPNAME=pi-console-dev-nvim
    export PI_CONSOLE_TMUX_SESSION=agents-dev
fi

pi_console_build_snapshot() {
    if [ "$PI_CONSOLE_CHANNEL" = dev ]; then
        local changes
        PI_CONSOLE_BUILD_COMMIT=$(git -C "$PI_CONSOLE_APP_ROOT" rev-parse HEAD) || return
        changes=$(git --no-optional-locks -C "$PI_CONSOLE_APP_ROOT" status --porcelain) || return
        PI_CONSOLE_BUILD_DIRTY=0
        [ -z "$changes" ] || PI_CONSOLE_BUILD_DIRTY=1
        export PI_CONSOLE_BUILD_COMMIT PI_CONSOLE_BUILD_DIRTY
    fi
}

pi_console_version() {
    printf 'Channel: %s\nRef: %s\nCommit: %s\nDirty at startup: %s\nInstallation: %s\n' \
        "$PI_CONSOLE_CHANNEL" "$PI_CONSOLE_BUILD_REF" "$PI_CONSOLE_BUILD_COMMIT" \
        "$PI_CONSOLE_BUILD_DIRTY" "$PI_CONSOLE_APP_ROOT"
}
