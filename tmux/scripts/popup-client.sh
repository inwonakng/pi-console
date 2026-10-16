#!/usr/bin/env bash
# Own one nested client for the lifetime of its popup/modal terminal.
set -eu

[ "$#" -eq 2 ] || { printf 'Usage: %s SOCKET SESSION\n' "${0##*/}" >&2; exit 2; }
socket_path=$1
session=$2
terminal=$(tty)
unset TMUX

tmux -S "$socket_path" attach-session -t "=$session" <&0 &
attach_pid=$!
marker="@pi_console_popup_$attach_pid"
cleanup() {
    tmux -S "$socket_path" set-option -gu "$marker"
}
trap cleanup EXIT
trap 'kill "$attach_pid"; exit 1' HUP INT TERM
# The process PID plus its terminal identifies this attachment, not the shared
# session or pane. No client-specific environment queries are needed on 3.4.
if ! tmux -S "$socket_path" set-option -g "$marker" "$terminal"; then
    kill "$attach_pid"
    exit 1
fi
wait "$attach_pid"
