#!/usr/bin/env bash

set -eu
[ "$#" -eq 0 ] || { [ "$#" -eq 1 ] && [ "$1" = --apply ]; } || {
    printf 'Usage: setup.sh [--apply]\n' >&2
    exit 2
}
script_dir=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
source "$script_dir/../../bin/channel-env.sh"
app_root=$PI_CONSOLE_APP_ROOT
# Persist the selection path, not the setup-time release. Rollback and updates
# then affect future bindings without another configuration edit.
if [ -f "$app_root/.pi-console-install" ] && [ "$(basename -- "$(dirname -- "$app_root")")" = versions ]; then
    app_root="$(dirname -- "$(dirname -- "$app_root")")/current"
fi

if [ "$#" -eq 0 ]; then
    node "$script_dir/setup-config.mjs" "$app_root/tmux/scripts/setup.sh" "$PI_CONSOLE_CHANNEL"
    if server_status=$(tmux list-sessions 2>&1); then
        :
    else
        case "$server_status" in
            *'no server running'*|*'No such file or directory'*|*'Connection refused'*)
                printf 'Saved %s as your tmux default; bindings will load when tmux starts.\n' "$PI_CONSOLE_CHANNEL"
                exit 0 ;;
            *)
                printf 'Configuration saved, but could not reach tmux: %s\n' "$server_status" >&2
                exit 1 ;;
        esac
    fi
fi

printf -v launch 'bash %q' "$app_root/bin/pi-console"
tmux source-file "$script_dir/../pi-console.conf"
node "$app_root/tmux/scripts/client-enter.mjs" --install "$(tmux display-message -p '#{socket_path}')"
bash "$app_root/tmux/scripts/popup-client.sh" --install-hooks "$(tmux display-message -p '#{socket_path}')"
tmux bind-key g run-shell -b "$launch tmux toggle '#{pane_id}' '#{client_name}'"
tmux bind-key G run-shell -b "$launch tmux new '#{pane_id}' '#{client_name}'"
tmux bind-key o run-shell -b "$launch tmux overview '#{pane_id}' '#{client_name}'"
tmux bind-key O run-shell "$launch tmux sidebar '#{pane_id}'"
if [ "$#" -eq 0 ]; then
    printf 'Applied %s bindings to the running tmux server.\n' "$PI_CONSOLE_CHANNEL"
fi
