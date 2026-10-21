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
repo_root=$(CDPATH= cd -- "$script_dir/../.." && pwd -P)
launcher="$repo_root/bin/pi-console"
current_path=$(tmux display-message -p -t "$pane_id" '#{pane_current_path}')
current_session=$(tmux display-message -p -t "$pane_id" '#{session_name}')

# Ensure the channel's agents session exists without changing the current view.
bash "$script_dir/open-agents-overview.sh" --ensure "$pane_id" "$client_name" >/dev/null
frontend_args=()
if [ "${PI_CONSOLE_SERVICE_FRONTEND-}" = 1 ] || [ "$(tmux display-message -p -t "$pane_id" '#{@pi_service_frontend}')" = 1 ]; then
    frontend_args=(--service --new)
fi
conversation_pane=$(tmux new-window -P -F '#{pane_id}' -t "=$PI_CONSOLE_TMUX_SESSION:" -n 'New Session' -c "$current_path" bash "$launcher" "${frontend_args[@]}")
# Launcher-created windows follow the Pi title until manually renamed.
tmux set-option -wo -t "$conversation_pane" @pi_console_tab "{\"pane\":\"$conversation_pane\",\"name\":\"New Session\"}"

if [ "$current_session" != "$PI_CONSOLE_TMUX_SESSION" ]; then
    exec bash "$script_dir/attach-agents.sh" "$pane_id" "$client_name"
fi
