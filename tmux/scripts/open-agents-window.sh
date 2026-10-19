#!/usr/bin/env bash

set -eu

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
    printf 'Usage: %s PANE_ID [CLIENT_NAME]\n' "${0##*/}" >&2
    exit 2
fi

pane_id=$1
script_dir=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
source "$script_dir/../../bin/channel-env.sh"
repo_root=$(CDPATH= cd -- "$script_dir/../.." && pwd -P)
launcher="$repo_root/bin/pi-console"
current_path=$(tmux display-message -p -t "$pane_id" '#{pane_current_path}')
current_session=$(tmux display-message -p -t "$pane_id" '#{session_id}')

conversation_pane=$(tmux new-window -P -F '#{pane_id}' -t "$current_session:" -n 'New Session' -c "$current_path" bash "$launcher")
# Launcher-created windows follow the Pi title until manually renamed.
tmux set-option -wo -t "$conversation_pane" @pi_console_tab "{\"pane\":\"$conversation_pane\",\"name\":\"New Session\"}"
