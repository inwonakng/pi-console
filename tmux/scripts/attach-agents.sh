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
socket_path=$(tmux display-message -p '#{socket_path}')
client_script="$script_dir/popup-client.sh"
owned=$(bash "$client_script" --owned "$socket_path" "$client_name")
if [ "$owned" = 1 ]; then
    # Overview/new/toggle can be invoked after intentionally switching away.
    # Reuse the owned attachment instead of opening another popup inside it.
    exec tmux switch-client -c "$client_name" -t "=$PI_CONSOLE_TMUX_SESSION"
fi

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
    # Forward every key, including the prefix, without using Escape to dismiss.
    # -W preserves display-popup's wait-until-detached behavior. Force only the
    # container to close on exit, even if its host has remain-on-exit enabled.
    exec tmux new-pane -O -K -W -B none -t "$pane_id" -x 80% -y 85% -X 10% -Y 7% \
        -s "$(tmux show-options -gv popup-style)" \
        bash -eu -c '
            tmux -S "$1" set-option -p -t "$TMUX_PANE" remain-on-exit off
            tmux -S "$1" set-option -p -t "$TMUX_PANE" synchronize-panes off
            exec bash "$3" "$1" "$2"
        ' pi-agents "$socket_path" "$PI_CONSOLE_TMUX_SESSION" "$client_script"
fi

if [ -n "$client_name" ]; then
    exec tmux display-popup -B -c "$client_name" -w 80% -h 85% -E bash "$client_script" "$socket_path" "$PI_CONSOLE_TMUX_SESSION"
else
    exec tmux display-popup -B -t "$pane_id" -w 80% -h 85% -E bash "$client_script" "$socket_path" "$PI_CONSOLE_TMUX_SESSION"
fi
