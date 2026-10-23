#!/usr/bin/env bash

set -eu

usage() {
    printf 'Usage: %s [--ensure] PANE_ID [CLIENT_NAME]\n' "${0##*/}" >&2
    exit 2
}

ensure_only=0
if [ "${1-}" = "--ensure" ]; then
    ensure_only=1
    shift
fi

[ "$#" -ge 1 ] && [ "$#" -le 2 ] || usage
pane_id=$1
client_name=${2-}
script_dir=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
repo_root=$(CDPATH= cd -- "$script_dir/../.." && pwd -P)
source "$repo_root/bin/channel-env.sh"
launcher="$repo_root/bin/pi-console"
# Match the two-cell icon area used by conversation tab names.
overview_name='󰕮 '

# Serialize discovery and creation, but never hold the lock while attached.
lock_name="pi-overview-$PI_CONSOLE_TMUX_SESSION"
tmux wait-for -L "$lock_name"
release_lock() {
    tmux wait-for -U "$lock_name"
}
trap release_lock EXIT

overview_info=
session_exists=0
if tmux has-session -t "=$PI_CONSOLE_TMUX_SESSION" 2>/dev/null; then
    session_exists=1
    # Compare whole names in tmux, so tabs/newlines in a custom title cannot
    # look like a managed title when parsing the discovery record.
    managed_title='#{||:#{==:#{window_name},Pi-Overview},#{||:#{==:#{window_name},󰕮 Overview},#{==:#{window_name},󰕮}}}'
    overview_info=$(tmux list-panes -s -t "=$PI_CONSOLE_TMUX_SESSION" -f '#{&&:#{==:#{@pi_overview},1},#{&&:#{==:#{@pi_overview_pane},#{pane_id}},#{!=:#{pane_dead},1}}}' -F $'#{window_id}\t#{pane_id}\t'"$managed_title" | head -n 1)
fi

created=0
if [ -z "$overview_info" ]; then
    current_path=$(tmux display-message -p -t "$pane_id" '#{pane_current_path}')
    if [ "$session_exists" -eq 1 ]; then
        overview_info=$(tmux new-window -d -P -F $'#{window_id}\t#{pane_id}' -t "=$PI_CONSOLE_TMUX_SESSION:" -n "$overview_name" -c "$current_path" bash "$launcher" --overview)
    else
        overview_info=$(tmux new-session -d -P -F $'#{window_id}\t#{pane_id}' -s "$PI_CONSOLE_TMUX_SESSION" -n "$overview_name" -c "$current_path" bash "$launcher" --overview)
    fi
    created=1
fi
IFS=$'\t' read -r overview_id overview_pane rename_overview <<< "$overview_info"
if [ "$created" -eq 1 ]; then
    tmux set-option -w -t "$overview_id" @pi_overview 1 \; \
        set-option -w -t "$overview_id" @pi_overview_pane "$overview_pane"
elif [ "$rename_overview" = 1 ]; then
    # Refresh old managed titles without replacing a user's custom name.
    tmux rename-window -t "$overview_id" "$overview_name"
fi
release_lock
trap - EXIT

if [ "$ensure_only" -eq 1 ]; then
    printf '%s\n' "$overview_id"
    exit 0
fi

current_session=$(tmux display-message -p -t "$pane_id" '#{session_name}')
if [ "$current_session" = "$PI_CONSOLE_TMUX_SESSION" ] && [ "$pane_id" = "$overview_pane" ]; then
    exec bash "$script_dir/toggle-popup-agents.sh" "$pane_id" "$client_name"
fi

tmux select-window -t "$overview_id" \; select-pane -t "$overview_pane"

if [ "$current_session" != "$PI_CONSOLE_TMUX_SESSION" ]; then
    exec bash "$script_dir/attach-agents.sh" "$pane_id" "$client_name"
fi
