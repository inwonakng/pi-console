#!/usr/bin/env bash

set -eu

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
    printf 'Usage: %s PANE_ID [CLIENT_NAME]\n' "${0##*/}" >&2
    exit 2
fi

pane_id=$1
client_name=${2-}
script_dir=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
repo_root=$(CDPATH= cd -- "$script_dir/../.." && pwd -P)
launcher="$repo_root/bin/pi-console"
current_path=$(tmux display-message -p -t "$pane_id" '#{pane_current_path}')
current_session=$(tmux display-message -p -t "$pane_id" '#{session_name}')

bash "$script_dir/open-agents-overview.sh" --ensure "$pane_id" "$client_name" >/dev/null
tmux new-window -t '=agents:' -n pi -c "$current_path" bash "$launcher"

if [ "$current_session" != "agents" ]; then
    if [ -n "$client_name" ]; then
        tmux display-popup -c "$client_name" -w 80% -h 85% -E tmux attach-session -t '=agents'
    else
        tmux display-popup -t "$pane_id" -w 80% -h 85% -E tmux attach-session -t '=agents'
    fi
fi
