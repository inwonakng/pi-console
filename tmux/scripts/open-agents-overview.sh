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
launcher="$repo_root/bin/pi-console"
current_path=$(tmux display-message -p -t "$pane_id" '#{pane_current_path}')

# Serialize discovery and creation, but never hold the lock while a popup is open.
lock_name=pi-agents-overview
tmux wait-for -L "$lock_name"
release_lock() {
    tmux wait-for -U "$lock_name"
}
trap release_lock EXIT

overview_id=
if tmux has-session -t '=agents' 2>/dev/null; then
    overview_id=$(tmux list-panes -s -t '=agents' -f '#{&&:#{==:#{@pi_overview},1},#{&&:#{==:#{@pi_overview_pane},#{pane_id}},#{!=:#{pane_dead},1}}}' -F '#{window_id}' | head -n 1)
fi

if [ -z "$overview_id" ]; then
    if tmux has-session -t '=agents' 2>/dev/null; then
        overview_id=$(tmux new-window -d -P -F '#{window_id}' -t '=agents:' -n Pi-Overview -c "$current_path" bash "$launcher" --overview)
    else
        overview_id=$(tmux new-session -d -P -F '#{window_id}' -s agents -n Pi-Overview -c "$current_path" bash "$launcher" --overview)
    fi
    overview_pane=$(tmux display-message -p -t "$overview_id" '#{pane_id}')
    tmux set-option -w -t "$overview_id" @pi_overview 1
    tmux set-option -w -t "$overview_id" @pi_overview_pane "$overview_pane"
fi
release_lock
trap - EXIT

if [ "$ensure_only" -eq 1 ]; then
    printf '%s\n' "$overview_id"
    exit 0
fi

current_session=$(tmux display-message -p -t "$pane_id" '#{session_name}')
tmux select-window -t "$overview_id"
overview_pane=$(tmux show-options -wv -t "$overview_id" @pi_overview_pane)
tmux select-pane -t "$overview_pane"

if [ "$current_session" != "agents" ]; then
    if [ -n "$client_name" ]; then
        tmux display-popup -c "$client_name" -w 80% -h 85% -E tmux attach-session -t '=agents'
    else
        tmux display-popup -t "$pane_id" -w 80% -h 85% -E tmux attach-session -t '=agents'
    fi
fi
