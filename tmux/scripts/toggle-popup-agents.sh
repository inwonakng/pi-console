#!/usr/bin/env bash

set -eu

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
    printf 'Usage: %s PANE_ID [CLIENT_NAME]\n' "${0##*/}" >&2
    exit 2
fi

pane_id=$1
client_name=${2-}
script_dir=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
source "$script_dir/../../bin/channel-env.sh"
current_session=$(tmux display-message -p -t "$pane_id" '#{session_name}')

if [ "$current_session" = "$PI_CONSOLE_TMUX_SESSION" ]; then
    # Never guess the invoking client from a pane shared by multiple views.
    [ -n "$client_name" ] || exit 0
    clients=$(tmux list-clients -F $'#{client_name}\t#{client_pid}\t#{client_tty}\t#{session_name}')
    while IFS=$'\t' read -r name pid terminal session; do
        if [ "$name" = "$client_name" ] && [ "$session" = "$PI_CONSOLE_TMUX_SESSION" ]; then
            case "$pid" in ''|*[!0-9]*) exit 0 ;; esac
            owner=$(tmux show-options -gqv "@pi_console_popup_$pid")
            if [ -n "$terminal" ] && [ "$owner" = "$terminal" ]; then
                tmux detach-client -t "$client_name"
            fi
            exit 0
        fi
    done <<< "$clients"
else
    bash "$script_dir/open-agents-overview.sh" --ensure "$pane_id" "$client_name" >/dev/null
    exec bash "$script_dir/attach-agents.sh" "$pane_id" "$client_name"
fi
