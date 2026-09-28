#!/usr/bin/env bash

set -eu

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
    printf 'Usage: %s PANE_ID [CLIENT_NAME]\n' "${0##*/}" >&2
    exit 2
fi

pane_id=$1
client_name=${2-}
script_dir=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
current_session=$(tmux display-message -p -t "$pane_id" '#{session_name}')

if [ "$current_session" = "agents" ]; then
    if [ -n "$client_name" ]; then
        tmux detach-client -t "$client_name"
    else
        tmux detach-client
    fi
else
    bash "$script_dir/open-agents-overview.sh" --ensure "$pane_id" "$client_name" >/dev/null
    if [ -n "$client_name" ]; then
        tmux display-popup -c "$client_name" -w 80% -h 85% -E tmux attach-session -t '=agents'
    else
        tmux display-popup -t "$pane_id" -w 80% -h 85% -E tmux attach-session -t '=agents'
    fi
fi
