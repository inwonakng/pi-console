#!/usr/bin/env bash
# Own nested clients without changing the session's detach-on-destroy policy.
set -eu

prefix=@pi_console_popup_
mode=${1-}
case "$mode" in
    --install-hooks|--owned|--changed) shift ;;
    *) mode=attach ;;
esac
[ "$#" -ge 1 ] || { printf 'Missing tmux socket\n' >&2; exit 2; }
socket_path=$1
shift

# Match a live client by name, PID and terminal, never by a shared pane.
lookup_owned_client() {
    owned_pid=
    tracked_session=
    [ -n "$1" ] || return 0
    local clients name pid terminal record owner
    clients=$(tmux -S "$socket_path" list-clients -F $'#{client_name}\t#{client_pid}\t#{client_tty}') || exit 1
    while IFS=$'\t' read -r name pid terminal; do
        [ "$name" = "$1" ] || continue
        case "$pid" in ''|*[!0-9]*) return 0 ;; esac
        record=$(tmux -S "$socket_path" show-options -gqv "$prefix$pid") || exit 1
        read -r owner tracked_session <<< "$record"
        if [ -n "$terminal" ] && [ "$owner" = "$terminal" ]; then
            owned_pid=$pid
            owned_terminal=$terminal
        fi
        return 0
    done <<< "$clients"
}

case "$mode" in
    --install-hooks)
        [ "$#" -eq 0 ] || exit 2
        # Preserve stable/current and dotfile symlinks across future updates.
        script_path=${BASH_SOURCE[0]}
        [[ "$script_path" = /* ]] || script_path="$PWD/$script_path"
        printf -v handler 'bash %q --changed #{q:socket_path} #{q:hook_client} "#{q:hook_new_session}" "#{q:hook_old_session}"' "$script_path"
        # Quote for tmux's parser as well as the shell it will launch.
        handler=${handler//\\/\\\\}
        handler=${handler//\"/\\\"}
        handler=${handler//\$/\\\$}
        tmux -S "$socket_path" set-hook -g 'client-session-changed[81]' "run-shell \"$handler\""
        exit 0
        ;;
    --owned)
        [ "$#" -eq 1 ] || exit 2
        lookup_owned_client "$1"
        [ -z "$owned_pid" ] || printf '1\n'
        exit 0
        ;;
    --changed)
        [ "$#" -eq 3 ] || exit 2
        client=$1
        next_session=$2
        old_session=$3
        # tmux 3.8 records the transition in the event payload. Older servers
        # lack this evidence: leave their clients alone rather than guessing.
        [[ "$next_session" =~ ^\$[0-9]+$ ]] || exit 0
        lookup_owned_client "$client"
        [ -n "$owned_pid" ] || exit 0
        # Old wrappers may still be alive during an upgrade, without a session ID.
        [[ "$tracked_session" =~ ^\$[0-9]+$ ]] || exit 0
        [ "$tracked_session" != "$next_session" ] || exit 0
        # Explicit switches retain old_session even if it is deleted before
        # this handler runs. Destruction clears it before assigning a fallback.
        if [ -n "$old_session" ]; then
            tmux -S "$socket_path" set-option -g "$prefix$owned_pid" "$owned_terminal $next_session"
        else
            tmux -S "$socket_path" detach-client -t "$client"
        fi
        exit 0
        ;;
esac

[ "$#" -eq 1 ] || { printf 'Usage: %s SOCKET SESSION\n' "${0##*/}" >&2; exit 2; }
session=$1
session_id=$(tmux -S "$socket_path" display-message -p -t "=$session:" '#{session_id}')
terminal=$(tty)
unset TMUX

# Register before exec so even the initial client-session-changed hook sees the
# marker. exec preserves the child's PID as the tmux client's PID.
bash -eu -c '
    socket=$1; session=$2; terminal=$3; prefix=$4
    if ! error=$(tmux -S "$socket" set-option -g "$prefix$$" "$terminal $session" </dev/null 2>&1); then
        printf "%s\n" "$error" >&2
        exit 1
    fi
    exec tmux -S "$socket" attach-session -t "$session"
' popup-client "$socket_path" "$session_id" "$terminal" "$prefix" <&0 &
attach_pid=$!
cleanup() {
    local error
    # tmux restores terminal streams to blocking on exit: bookkeeping must not
    # use the attachment's shared terminal descriptors.
    if ! error=$(tmux -S "$socket_path" set-option -gu "$prefix$attach_pid" </dev/null 2>&1); then
        printf '%s\n' "$error" >&2
    fi
}
trap cleanup EXIT
trap 'kill "$attach_pid"; exit 1' HUP INT TERM
wait "$attach_pid"
