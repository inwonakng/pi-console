#!/usr/bin/env bash

set -eu

mode=toggle
if [ "${1-}" = --reflow ]; then
    mode=reflow
    shift
fi
if [ "$#" -ne 1 ]; then
    printf 'Usage: %s [--reflow] PANE_OR_WINDOW_ID\n' "${0##*/}" >&2
    exit 2
fi

target=$1
script_dir=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
source "$script_dir/../../bin/channel-env.sh"
window=$(tmux display-message -p -t "$target" '#{window_id}')
# Serialize toggles and resize hooks for this window, not the entire server.
lock="pi-sidebar-${window#@}"
tmux wait-for -L "$lock"
release_lock() {
    tmux wait-for -U "$lock"
}
trap release_lock EXIT
nvim --clean -l "$script_dir/sidebar.lua" "$mode" "$target"
