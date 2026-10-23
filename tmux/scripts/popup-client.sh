#!/usr/bin/env bash
# Own nested clients without changing the session's detach-on-destroy policy.
set -eu

prefix=@pi_console_popup_
mode=${1-}
case "$mode" in
    --install-hooks|--owned|--changed|--switch) shift ;;
    *) mode=attach ;;
esac
[ "$#" -ge 1 ] || { printf 'Missing tmux socket\n' >&2; exit 2; }
socket_path=$1
shift

# Match a live client by name, PID and terminal, never by a shared pane.
lookup_owned_client() {
    owned_pid=
    tracked_session=
    host_pane=
    parent_client=
    parent_pid=
    [ -n "$1" ] || return 0
    local clients name pid terminal record owner
    clients=$(tmux -S "$socket_path" list-clients -F $'#{client_name}\t#{client_pid}\t#{client_tty}') || exit 1
    while IFS=$'\t' read -r name pid terminal; do
        [ "$name" = "$1" ] || continue
        case "$pid" in ''|*[!0-9]*) return 0 ;; esac
        record=$(tmux -S "$socket_path" show-options -gqv "$prefix$pid") || exit 1
        read -r owner tracked_session host_pane parent_client parent_pid <<< "$record"
        if [ -n "$terminal" ] && [ "$owner" = "$terminal" ]; then
            owned_pid=$pid
            owned_terminal=$terminal
        fi
        return 0
    done <<< "$clients"
}

# Query membership rather than a cached session: the container can be moved,
# and its window can be linked into more than one session.
contains_popup() {
    [[ "$host_pane" =~ ^%[0-9]+$ ]] || return 1
    local panes pane
    panes=$(tmux -S "$socket_path" list-panes -s -t "$1" -F '#{pane_id}') || exit 1
    while read -r pane; do
        [ "$pane" != "$host_pane" ] || return 0
    done <<< "$panes"
    return 1
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
    --switch)
        [ "$#" -eq 2 ] || exit 2
        client=$1
        next_session=$(tmux -S "$socket_path" display-message -p -t "$2:" '#{session_id}')
        lookup_owned_client "$client"
        if [ -n "$owned_pid" ] && contains_popup "$next_session"; then
            # Hand navigation back to the original client. Validate its PID so
            # a reused terminal name cannot redirect an unrelated attachment.
            clients=$(tmux -S "$socket_path" list-clients -F $'#{client_name}\t#{client_pid}')
            while IFS=$'\t' read -r name pid; do
                if [ "$name" = "$parent_client" ] && [ "$pid" = "$parent_pid" ]; then
                    tmux -S "$socket_path" switch-client -c "$name" -t "$next_session" \; \
                        detach-client -t "$client"
                    exit 0
                fi
            done <<< "$clients"
            # Still close the popup if its original client has disappeared.
            tmux -S "$socket_path" detach-client -t "$client"
            printf 'The original tmux client is no longer attached\n' >&2
            exit 1
        fi
        exec tmux -S "$socket_path" switch-client -c "$client" -t "$next_session"
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
        # Native tmux choosers bypass --switch. Break self-attachment even on
        # the initial attach, before considering the tracked session marker.
        if contains_popup "$next_session"; then
            exec tmux -S "$socket_path" detach-client -t "$client"
        fi
        # Old wrappers may still be alive during an upgrade, without a session ID.
        [[ "$tracked_session" =~ ^\$[0-9]+$ ]] || exit 0
        [ "$tracked_session" != "$next_session" ] || exit 0
        # Explicit switches retain old_session even if it is deleted before
        # this handler runs. Destruction clears it before assigning a fallback.
        if [ -n "$old_session" ]; then
            tmux -S "$socket_path" set-option -g "$prefix$owned_pid" "$owned_terminal $next_session $host_pane $parent_client $parent_pid"
        else
            tmux -S "$socket_path" detach-client -t "$client"
        fi
        exit 0
        ;;
esac

[ "$#" -eq 4 ] || { printf 'Usage: %s SOCKET SESSION HOST_PANE CLIENT_NAME CLIENT_PID\n' "${0##*/}" >&2; exit 2; }
session=$1
host_pane=$2
parent_client=$3
parent_pid=$4
session_id=$(tmux -S "$socket_path" display-message -p -t "=$session:" '#{session_id}')
terminal=$(tty)
unset TMUX

# Register before exec so even the initial client-session-changed hook sees the
# marker. exec preserves the child's PID as the tmux client's PID.
bash -eu -c '
    socket=$1; session=$2; terminal=$3; prefix=$4
    host_pane=$5; parent_client=$6; parent_pid=$7
    if ! error=$(tmux -S "$socket" set-option -g "$prefix$$" "$terminal $session $host_pane $parent_client $parent_pid" </dev/null 2>&1); then
        printf "%s\n" "$error" >&2
        exit 1
    fi
    exec tmux -S "$socket" attach-session -t "$session"
' popup-client "$socket_path" "$session_id" "$terminal" "$prefix" "$host_pane" "$parent_client" "$parent_pid" <&0 &
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
