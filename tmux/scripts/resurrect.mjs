#!/usr/bin/env node
// Resurrect saves process argv, which cannot describe a frontend's current view.
// Replace only registered, live pi-console panes with explicit launcher commands.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";

const [action, socket, argument] = process.argv.slice(2);
const hookOption = "@resurrect-hook-post-save-layout";
const installedOption = "@pi_console_resurrect_save_hook";
const fallbackOption = "@pi_console_resurrect_save_fallback";
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
function tmux(args) {
    const result = spawnSync("tmux", ["-S", socket, ...args], { encoding: "utf8" });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(result.stderr.trim() || "tmux command failed");
    return result.stdout.trimEnd();
}
function option(name) {
    return tmux(["show-options", "-gqv", name]);
}
function install(root) {
    const current = option(hookOption);
    if (current !== option(installedOption)) {
        tmux(["set-option", "-g", fallbackOption, current]);
    }
    const helper = path.join(root, "tmux", "scripts", "resurrect.mjs");
    const command = `${quote(process.execPath)} ${quote(helper)} --save ${quote(socket)}`;
    tmux(["set-option", "-g", hookOption, command]);
    tmux(["set-option", "-g", installedOption, command]);
    const processes = option("@resurrect-processes");
    // Keep an explicit process-restore opt-out. Never enable unrelated programs.
    if (processes !== "false" && processes !== ":all:" && !processes.includes('"~pi-console"')) {
        tmux(["set-option", "-g", "@resurrect-processes", `${processes} "~pi-console"`.trim()]);
    }
}
function launcherFor(launcher) {
    const root = path.dirname(path.dirname(launcher));
    if (path.basename(path.dirname(root)) !== "versions") return launcher;
    let marker;
    try { marker = readFileSync(path.join(root, ".pi-console-install"), "utf8"); }
    catch (error) { if (error.code === "ENOENT") return launcher; throw error; }
    // Installed dev frontends follow updates/rollback, just like tmux bindings.
    // Stable releases retain the exact installation they were viewing.
    return /^channel=dev$/m.test(marker)
        ? path.join(path.dirname(path.dirname(root)), "current", "bin", "pi-console") : launcher;
}
function restoreCommand(state) {
    if (state.version !== 1 || !["overview", "sidebar", "conversation"].includes(state.role)
        || typeof state.launcher !== "string" || !path.isAbsolute(state.launcher)) {
        throw new Error("Invalid pi-console restore registration");
    }
    const args = ["bash", launcherFor(state.launcher)];
    if (state.role !== "conversation") args.push(`--${state.role}`);
    else if (state.session_id) args.push("--attach", state.session_id);
    // No --resume/--reopen: restoring a terminal must not start stopped work.
    for (const [key, flag] of [["service_remote", "--remote"], ["service_root", "--root"],
        ["expected_host", "--expected-host"], ["cwd", "--cwd"]]) {
        if (state[key]) args.push(flag, state[key]);
    }
    if (args.some((value) => typeof value !== "string" || /[\r\n\t\0]/.test(value))) {
        throw new Error("Pi-console restore arguments cannot contain tabs, newlines or NUL");
    }
    return args.map(quote).join(" ");
}
function save(file) {
    const fallback = option(fallbackOption);
    if (fallback) {
        // Match resurrect's hook semantics: append the layout path once, without
        // interpreting it as shell source. Run the user's filter before ours.
        const result = spawnSync("bash", ["-c", `${fallback} "$@"`, "pi-console-resurrect", file], { stdio: "inherit" });
        if (result.error) throw result.error;
        if (result.status !== 0) throw new Error("Existing resurrect save hook failed");
    }
    const panes = new Map();
    const format = "#{session_name}\t#{window_index}\t#{pane_index}\t#{pane_dead}\t#{@pi_console_restore}";
    for (const line of tmux(["list-panes", "-a", "-F", format]).split("\n")) {
        const [session, window, pane, dead, raw] = line.split("\t");
        if (dead !== "0" || !raw) continue;
        const state = JSON.parse(raw);
        if (!Number.isSafeInteger(state.pid) || state.pid <= 0) throw new Error("Invalid pi-console restore PID");
        try { process.kill(state.pid, 0); }
        catch (error) { if (error.code === "ESRCH") continue; throw error; }
        panes.set(JSON.stringify([session, window, pane]), restoreCommand(state));
    }
    const contents = readFileSync(file, "utf8");
    let changed = false;
    const updated = contents.split("\n").map((line) => {
        const fields = line.split("\t");
        if (fields[0] !== "pane") return line;
        const command = panes.get(JSON.stringify([fields[1], fields[2], fields[5]]));
        if (!command) return line;
        fields[9] = "pi-console";
        fields[10] = `:${command}`;
        changed = true;
        return fields.join("\t");
    }).join("\n");
    if (!changed) return;
    const temporary = `${file}.pi-console-${process.pid}`;
    try {
        writeFileSync(temporary, updated, { mode: statSync(file).mode & 0o777 });
        renameSync(temporary, file);
    } finally { rmSync(temporary, { force: true }); }
}
try {
    if (!socket || !argument || !["--install", "--save"].includes(action)) {
        throw new Error("Usage: resurrect.mjs --install SOCKET APP_ROOT | --save SOCKET LAYOUT_FILE");
    }
    if (action === "--install") {
        tmux(["wait-for", "-L", "pi-console-resurrect-install"]);
        try { install(argument); }
        finally { tmux(["wait-for", "-U", "pi-console-resurrect-install"]); }
    } else save(argument);
} catch (error) {
    console.error(`pi-console resurrect: ${error.message}`);
    process.exitCode = 1;
}
