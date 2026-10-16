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
    if [ -z "$client_name" ]; then
        client_name=$(tmux display-message -p -t "$pane_id" '#{client_name}')
    fi
    # The same agents pane can be visible in both a popup and a main client.
    # Only detach clients launched by attach-agents.sh, never the main view.
    if [ -n "$client_name" ] && [ "$(tmux display-message -p -c "$client_name" '#{I/e:PI_CONSOLE_POPUP}')" = "1" ]; then
        tmux detach-client -t "$client_name"
    fi
else
    bash "$script_dir/open-agents-overview.sh" --ensure "$pane_id" "$client_name" >/dev/null
    exec bash "$script_dir/attach-agents.sh" "$pane_id" "$client_name"
fi
