#!/usr/bin/env bash

set -eu
[ "$#" -eq 0 ] || { [ "$#" -eq 1 ] && [ "$1" = --apply ]; } || {
    printf 'Usage: setup.sh [--apply]\n' >&2
    exit 2
}
script_dir=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
source "$script_dir/../../bin/channel-env.sh"
app_root=$PI_CONSOLE_APP_ROOT
# Persist the selection path, not the setup-time release. Rollback and updates
# then affect future bindings without another configuration edit.
if [ -f "$app_root/.pi-console-install" ] && [ "$(basename -- "$(dirname -- "$app_root")")" = versions ]; then
    app_root="$(dirname -- "$(dirname -- "$app_root")")/current"
fi

if [ "$#" -eq 0 ]; then
    node "$script_dir/setup-config.mjs" "$app_root/tmux/scripts/setup.sh" "$PI_CONSOLE_CHANNEL"
    if server_status=$(tmux list-sessions 2>&1); then
        :
    else
        case "$server_status" in
            *'no server running'*|*'No such file or directory'*|*'Connection refused'*)
                printf 'Saved %s as your tmux default; bindings will load when tmux starts.\n' "$PI_CONSOLE_CHANNEL"
                exit 0 ;;
            *)
                printf 'Configuration saved, but could not reach tmux: %s\n' "$server_status" >&2
                exit 1 ;;
        esac
    fi
fi

printf -v launch 'bash %q' "$app_root/bin/pi-console"
tmux source-file "$script_dir/../pi-console.conf"
# Install the selected launcher before helpers: a helper failure must not leave
# temporary PATH-based bindings that can launch the other channel.
keys=(g G o O)
actions=(toggle new overview sidebar)
expected_bindings=()
# Let tmux render the expected commands rather than duplicating its quoting.
# A private, unattached key table cannot affect clients' active bindings.
verification_table="pi-console-setup-$$"
trap 'tmux unbind-key -a -T "$verification_table"' EXIT
for i in "${!keys[@]}"; do
    command="$launch tmux ${actions[$i]} '#{pane_id}'"
    run_shell=(run-shell)
    if [ "${keys[$i]}" != O ]; then
        command+=" '#{client_name}'"
        run_shell+=(-b)
    fi
    tmux bind-key -T "$verification_table" "${keys[$i]}" "${run_shell[@]}" "$command"
    expected=$(tmux list-keys -T "$verification_table" "${keys[$i]}")
    expected_bindings+=("${expected/"-T $verification_table "/"-T prefix "}")
    tmux bind-key "${keys[$i]}" "${run_shell[@]}" "$command"
done
node "$app_root/tmux/scripts/client-enter.mjs" --install "$(tmux display-message -p '#{socket_path}')"
bash "$app_root/tmux/scripts/popup-client.sh" --install-hooks "$(tmux display-message -p '#{socket_path}')"
node "$app_root/tmux/scripts/resurrect.mjs" --install "$(tmux display-message -p '#{socket_path}')" "$app_root"
for i in "${!keys[@]}"; do
    actual=$(tmux list-keys -T prefix "${keys[$i]}")
    if [ "$actual" != "${expected_bindings[$i]}" ]; then
        printf 'Could not verify %s tmux binding %s.\nExpected: %s\nActual: %s\n' \
            "$PI_CONSOLE_CHANNEL" "${keys[$i]}" "${expected_bindings[$i]}" "$actual" >&2
        exit 1
    fi
done
tmux unbind-key -a -T "$verification_table"
trap - EXIT
if [ "$#" -eq 0 ]; then
    printf 'Applied and verified %s bindings on the running tmux server.\n' "$PI_CONSOLE_CHANNEL"
fi
