#!/usr/bin/env bash
# Regenerate README screenshots from a scripted, isolated demo environment.
#
# Starts a private pi-console service, a scripted model endpoint and separate
# tmux servers under a throwaway HOME, drives real frontends through tmux, then
# renders the screens and the web UI with Playwright. Your own service,
# sessions, settings and tmux are not touched. See MAINTAINING.md.
set -euo pipefail

here=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
repo=$(CDPATH= cd -- "$here/../.." && pwd -P)
app=$(CDPATH= cd -- "${PI_CONSOLE_APP:-$repo}" && pwd -P)
out=${SCREENSHOT_OUT:-$repo/assets}
demo=${SCREENSHOT_ROOT:-/tmp/pi-demo}
model_port=${SCREENSHOT_MODEL_PORT:-18490}
service_port=${SCREENSHOT_SERVICE_PORT:-18443}
cols=${SCREENSHOT_COLS:-180}
rows=${SCREENSHOT_ROWS:-50}
tmux_conf=${SCREENSHOT_TMUX_CONF:-$here/tmux.conf}
marker=.pi-console-screenshots

[ -d "$here/node_modules/playwright" ] || {
    printf 'Missing screenshot dependencies. Run:\n  npm ci --prefix scripts/screenshots\n  npx --prefix scripts/screenshots playwright install chromium\n' >&2
    exit 1
}
[ -f "$app/server/dist/cli.js" ] && [ -d "$app/pi/node_modules" ] || {
    printf 'pi-console build missing in %s. Build it (see MAINTAINING.md) or set PI_CONSOLE_APP to an installed release.\n' "$app" >&2
    exit 1
}
if [ -e "$demo" ] && [ ! -e "$demo/$marker" ]; then
    printf 'Refusing to replace %s: it was not created by this script. Set SCREENSHOT_ROOT.\n' "$demo" >&2
    exit 1
fi
eval "$(bash -c 'source "$1/bin/channel-env.sh" && printf "channel=%q agents=%q\n" "$PI_CONSOLE_CHANNEL" "$PI_CONSOLE_TMUX_SESSION"' _ "$app")"
config_name=config.yaml
[ "$channel" = stable ] || config_name=config-dev.yaml

# The demo HOME holds the service profile, Pi settings, frontend state and the
# example projects. Plugin data and caches stay real so Neovim starts offline.
real_home=$HOME
export XDG_DATA_HOME=${XDG_DATA_HOME:-$real_home/.local/share}
export XDG_CACHE_HOME=${XDG_CACHE_HOME:-$real_home/.cache}
export HOME=$demo XDG_CONFIG_HOME=$demo/.config XDG_STATE_HOME=$demo/.local/state
export COLORTERM=truecolor TERM=xterm-256color
unset TMUX TMUX_PANE PI_CODING_AGENT_DIR PI_CODING_AGENT_SESSION_DIR

launcher=(bash "$app/bin/pi-console")
demo_tmux() { tmux -L pi-console-demo -f "$tmux_conf" "$@"; }
shot_tmux() { tmux -L pi-console-shot -f /dev/null "$@"; }
scenario() { node "$here/scenario.mjs" "$@"; }
render() { (cd "$here" && HOME=$real_home node render.mjs "$@"); }
log() { printf '==> %s\n' "$*" >&2; }

model_pid=
cleanup() {
    shot_tmux kill-server 2>/dev/null || true
    demo_tmux kill-server 2>/dev/null || true
    "${launcher[@]}" server stop --force >/dev/null 2>&1 || true
    [ -z "$model_pid" ] || kill "$model_pid" 2>/dev/null || true
    pkill -f "fake-model.mjs .* $model_port\$" 2>/dev/null || true
}

# wait_for DESCRIPTION SECONDS COMMAND...
wait_for() {
    local description=$1 deadline=$((SECONDS + $2))
    shift 2
    until "$@"; do
        if [ "$SECONDS" -ge "$deadline" ]; then
            printf 'Timed out waiting for %s\n' "$description" >&2
            return 1
        fi
        sleep 0.5
    done
}
pane_has() { demo_tmux capture-pane -p -t "$1" | grep -qF -- "$2"; }
show_pane() {
    printf -- '--- Screen of the waiting pane:\n' >&2
    demo_tmux capture-pane -p -t "$1" | grep -v '^[[:space:]]*$' >&2 || true
}
# Neovim installs the frontend's plugins on first launch after asking for
# confirmation. Do not answer for the user; they live in the real data dir.
conversation_ready() {
    if pane_has "$1" "These plugins will be installed"; then
        printf 'This pi-console build has not installed its Neovim plugins yet. Launch it once\n(%s), accept the plugin installation, quit, then rerun this script.\n' \
            "$app/bin/pi-console" >&2
        exit 1
    fi
    pane_has "$1" "Send a message to begin."
}
screen_has() { shot_tmux capture-pane -p | grep -qF -- "$1"; }
titled_sessions() { [ "$("${launcher[@]}" server status --json | scenario titled)" -ge "$1" ]; }
capture() {
    shot_tmux capture-pane -p -e -N > "$work/$1.ansi"
    render terminal "$work/$1.ansi" "$out/$1.png" "$cols" "$rows"
}

# A previous run may have been interrupted or kept; stop it before reuse.
if [ -d "$demo" ]; then cleanup; fi
rm -rf -- "$demo"
if [ "${SCREENSHOT_KEEP-}" = 1 ]; then
    trap 'log "Kept the demo running: tmux -L pi-console-demo attach. The next run stops it."' EXIT
else
    trap cleanup EXIT
fi

log "Preparing demo home in $demo"
mkdir -p "$demo/.pi/agent" "$XDG_CONFIG_HOME/pi-console" "$demo/projects"/{homepage/styles,thesis,dotfiles}
touch "$demo/$marker"
node -e '
const [scenario, port] = process.argv.slice(1);
const { model } = JSON.parse(require("fs").readFileSync(scenario, "utf8"));
console.log(JSON.stringify({ providers: { [model.provider]: { baseUrl: `http://127.0.0.1:${port}/v1`,
  api: "openai-completions", apiKey: "demo", models: [{ id: model.id, name: model.name, reasoning: true,
  input: ["text"], cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 32000 }] } } }));
' "$here/scenario.json" "$model_port" > "$demo/.pi/agent/models.json"
node -e '
const { model } = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
console.log(JSON.stringify({ defaultProvider: model.provider, defaultModel: model.id, defaultThinkingLevel: "medium" }));
' "$here/scenario.json" > "$demo/.pi/agent/settings.json"
# No default /tmp write grant: the demo lives in /tmp, and file writes should
# ask for approval so a session shows as Waiting.
cat > "$XDG_CONFIG_HOME/pi-console/$config_name" <<'EOF'
server:
  webui:
    enabled: true
access-mode:
  write-paths: []
EOF
cat > "$demo/projects/homepage/styles/hero.css" <<'EOF'
.hero {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 2rem;
  height: 520px;
  padding: 4rem 6rem;
}

.hero h1 {
  font-size: 3.5rem;
  line-height: 1.1;
}

.hero .cta {
  align-self: end;
  padding: 0.75rem 1.5rem;
  border-radius: 999px;
}
EOF

log "Starting scripted model and service"
node "$here/fake-model.mjs" "$here/scenario.json" "$model_port" > "$demo/fake-model.log" 2>&1 &
model_pid=$!
sleep 0.5
kill -0 "$model_pid" 2>/dev/null || { printf 'Scripted model failed to start; is port %s in use?\n' "$model_port" >&2; exit 1; }
"${launcher[@]}" server start --port "$service_port" >/dev/null

demo_tmux new-session -d -s main -x "$cols" -y "$rows" -n editor -c "$demo/projects/homepage" \
    nvim --clean -c 'set number termguicolors' styles/hero.css
demo_tmux source-file "$app/tmux/pi-console.conf"
main_pane=$(demo_tmux display-message -p -t main '#{pane_id}')

count=0
while IFS=$'\t' read -r dir prompt; do
    log "Starting conversation in $dir"
    if [ "$count" -eq 0 ]; then
        pane=$(demo_tmux new-session -d -P -F '#{pane_id}' -s "$agents" -x "$cols" -y "$rows" -n 'New Session' \
            -c "$demo/projects/$dir" "${launcher[@]}" --new)
    else
        pane=$(demo_tmux new-window -d -P -F '#{pane_id}' -t "=$agents:" -n 'New Session' \
            -c "$demo/projects/$dir" "${launcher[@]}" --new)
    fi
    # Same tab metadata as tmux/scripts/open-agents-window.sh.
    demo_tmux set-option -wo -t "$pane" @pi_console_tab "{\"pane\":\"$pane\",\"name\":\"New Session\"}"
    wait_for "the new conversation in $dir" 60 conversation_ready "$pane" || { show_pane "$pane"; exit 1; }
    demo_tmux send-keys -t "$pane" i
    demo_tmux send-keys -t "$pane" -l -- "$prompt"
    demo_tmux send-keys -t "$pane" Escape C-s
    count=$((count + 1))
done < <(scenario prompts)

log "Waiting for $count conversations to get titles"
wait_for "conversation titles" 120 titled_sessions "$count"

# Groups live in the frontend's organization store; write them directly.
organization_dir="$XDG_STATE_HOME/pi-console/frontend/$channel"
mkdir -p -m 700 "$organization_dir"
"${launcher[@]}" server status --json | scenario organization > "$organization_dir/organization.json"
chmod 600 "$organization_dir/organization.json"

# A detached outer tmux hosts the demo client, so capturing its pane records
# exactly what that client displays, including popups and the status line.
shot_tmux start-server \; set-option -g default-terminal tmux-256color \; \
    set-option -as terminal-features ',*:RGB' \; \
    new-session -d -x "$cols" -y "$rows" "env -u TMUX tmux -L pi-console-demo attach -t main"
wait_for "demo client" 10 bash -c '[ -n "$(tmux -L pi-console-demo list-clients -F x)" ]'
client=$(demo_tmux list-clients -F '#{client_name}' | head -n 1)
work=$demo/captures
mkdir -p "$work" "$out"

log "Capturing the overview"
demo_tmux run-shell -b "bash '$app/tmux/scripts/open-agents-overview.sh' '$main_pane' '$client'"
wait_for "the overview" 30 screen_has "Pi sessions"
sleep 2
capture overview

log "Capturing a conversation"
IFS=$'\t' read -r index title < <(scenario conversation)
# Conversation windows render once displayed; they were created in scenario order.
demo_tmux select-window -t "=$agents:$index"
wait_for "the conversation" 30 screen_has "$title"
sleep 2
capture regular

log "Capturing the web UI"
render web "http://127.0.0.1:$service_port/" "$out" "$count" "$title"
log "Wrote overview.png, regular.png, webui-overview.png and webui-conversation.png to $out"
