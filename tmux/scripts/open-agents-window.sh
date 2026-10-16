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
conversation_pane=$(tmux new-window -P -F '#{pane_id}' -t '=agents:' -n '󰞌 ' -c "$current_path" bash "$launcher")
# Only launcher-created conversation windows opt into state-icon names.
tmux set-option -wo -t "$conversation_pane" @pi_console_tab "{\"pane\":\"$conversation_pane\",\"name\":\"󰞌 \"}"

if [ "$current_session" != "agents" ]; then
    exec bash "$script_dir/attach-agents.sh" "$pane_id" "$client_name"
fi
