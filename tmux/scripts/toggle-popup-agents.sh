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
socket_path=$(tmux display-message -p '#{socket_path}')
owned=$(bash "$script_dir/popup-client.sh" --owned "$socket_path" "$client_name")

if [ "$current_session" = "$PI_CONSOLE_TMUX_SESSION" ]; then
    [ "$owned" != 1 ] || tmux detach-client -t "$client_name"
    exit 0
fi
bash "$script_dir/open-agents-overview.sh" --ensure "$pane_id" "$client_name" >/dev/null
exec bash "$script_dir/attach-agents.sh" "$pane_id" "$client_name"
