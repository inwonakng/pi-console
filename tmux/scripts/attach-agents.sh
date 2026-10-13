#!/usr/bin/env bash

set -eu

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
    printf 'Usage: %s PANE_ID [CLIENT_NAME]\n' "${0##*/}" >&2
    exit 2
fi

pane_id=$1
client_name=${2-}

# Query the running server, which may differ from the installed tmux binary.
commands=$(tmux list-commands)
modal_supported=0
while read -r name alias flags rest; do
    if [ "$name" = "new-pane" ] && [[ "$flags" == *O* && "$flags" == *K* && "$flags" == *W* ]]; then
        modal_supported=1
        break
    fi
done <<< "$commands"

if [ "$modal_supported" -eq 1 ]; then
    socket_path=$(tmux display-message -p '#{socket_path}')
    # Forward every key, including the prefix, without using Escape to dismiss.
    # -W preserves display-popup's wait-until-detached behavior. Force only the
    # container to close on exit, even if its host has remain-on-exit enabled.
    exec tmux new-pane -O -K -W -B none -t "$pane_id" -x 80% -y 85% -X 10% -Y 7% \
        bash -eu -c '
            tmux -S "$1" set-option -p -t "$TMUX_PANE" remain-on-exit off
            unset TMUX
            exec tmux -S "$1" attach-session -t "=agents"
        ' pi-agents "$socket_path"
fi

if [ -n "$client_name" ]; then
    exec tmux display-popup -B -c "$client_name" -w 80% -h 85% -E tmux attach-session -t '=agents'
else
    exec tmux display-popup -B -t "$pane_id" -w 80% -h 85% -E tmux attach-session -t '=agents'
fi
