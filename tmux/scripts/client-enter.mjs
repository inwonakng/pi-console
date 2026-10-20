#!/usr/bin/env node
// Enter is a blocking tmux binding: place its trigger behind earlier PTY input,
// then deliver its exact client context while that trigger awaits the RPC.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const [action, socket, pane, name, clientPid] = process.argv.slice(2);
const option = "@pi_console_input";
const shellQuote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
const vimQuote = (value) => "'" + value.replaceAll("'", "''") + "'";
function tmux(args, allowMissing = false) {
    const result = spawnSync("tmux", ["-S", socket, ...args], { encoding: "utf8" });
    if (result.error) throw result.error;
    if (result.status !== 0 && !(allowMissing && result.status === 1)) {
        throw new Error(result.stderr.trim() || "tmux command failed");
    }
    return result.status === 0 ? result.stdout.trimEnd() : "";
}

function install() {
    const current = tmux(["list-keys", "-T", "root", "Enter"], true);
    const installed = tmux(["show-options", "-gqv", "@pi_console_enter_binding"]);
    if (current !== installed) {
        // list-keys produces a sourceable command. Keep its command body intact,
        // including command lists and format expansion in the original binding.
        const fallback = current
            ? current.replace(/^bind-key\s+(?:-r\s+)?-T\s+root\s+Enter\s+/, "")
            : "send-keys Enter";
        if (fallback === current && current) throw new Error("Cannot preserve root Enter binding: " + current);
        tmux(["set-option", "-g", "@pi_console_enter_fallback", fallback]);
    }
    const fallback = tmux(["show-options", "-gqv", "@pi_console_enter_fallback"]) || "send-keys Enter";
    const helper = `${shellQuote(process.execPath)} ${shellQuote(fileURLToPath(import.meta.url))}`;
    const command = `${helper} --enter #{q:socket_path} #{q:pane_id} #{q:client_name} #{q:client_pid}`;
    tmux(["bind-key", "-T", "root", "Enter", "if-shell", "-F", `#{!=:#{${option}},}`, "run-shell " + shellQuote(command), fallback]);
    tmux(["set-option", "-g", "@pi_console_enter_binding", tmux(["list-keys", "-T", "root", "Enter"])]);
}

function enter() {
    const payload = tmux(["show-options", "-pqv", "-t", pane, option]);
    let registration;
    try {
        registration = JSON.parse(payload);
        if (!Number.isSafeInteger(registration.pid) || registration.pid <= 0
            || typeof registration.server !== "string" || !registration.server
            || typeof registration.program !== "string" || !registration.program) throw new Error("Invalid registration");
        process.kill(registration.pid, 0);
    } catch {
        // A killed editor cannot run VimLeavePre. Remove only its own marker.
        if (payload && tmux(["show-options", "-pqv", "-t", pane, option]) === payload) {
            tmux(["set-option", "-pu", "-t", pane, option]);
        }
        tmux(["send-keys", "-t", pane, "Enter"]);
        return;
    }
    const context = { name, pid: Number(clientPid), pane };
    const argument = JSON.stringify({ context, owner: registration.pid });
    const expression = `luaeval('require("pi-integration.backends.tmux-input").enqueue(vim.json.decode(_A))', ${vimQuote(argument)})`;
    // Serialize trigger/context pairs from different clients sharing the pane.
    const lock = `pi-console-enter-${pane}`;
    tmux(["wait-for", "-L", lock]);
    let result;
    try {
        tmux(["send-keys", "-t", pane, "C-S-F12"]);
        // Only this short-lived RPC client is killed on timeout, never the editor.
        // Keep the deadline longer than the editor's two-second context wait.
        result = spawnSync(registration.program, ["--server", registration.server, "--remote-expr", expression], {
            encoding: "utf8", timeout: 3000, killSignal: "SIGKILL",
        });
    } finally {
        tmux(["wait-for", "-U", lock]);
    }
    if (result.error || result.status !== 0 || result.stdout.trim() !== "1") {
        // Do not guess a client or replay Enter if RPC delivery failed. Report
        // through the status line: a nonzero run-shell exit opens a tmux output
        // view that captures subsequent keys, even after the RPC has timed out.
        const message = result.error?.code === "ETIMEDOUT"
            ? "pi-console: Enter timed out; the editor did not respond"
            : "pi-console: could not deliver Enter to the overview";
        tmux(["display-message", "-c", name, message]);
    }
}

try {
    if (!socket || (action !== "--install" && action !== "--enter")) throw new Error("Usage: client-enter.mjs --install SOCKET | --enter SOCKET PANE CLIENT PID");
    if (action === "--install") {
        // Several overview/sidebar processes can register at once. Serialize
        // preservation of the old binding so our wrapper never saves itself.
        tmux(["wait-for", "-L", "pi-console-enter-install"]);
        try { install(); }
        finally { tmux(["wait-for", "-U", "pi-console-enter-install"]); }
    } else enter();
} catch (error) {
    console.error(error.message);
    process.exitCode = 1;
}
