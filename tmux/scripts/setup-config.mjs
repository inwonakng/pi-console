// Persist only our block, at the end so it overrides older included bindings.
// Startup runs setup.sh --apply: it must not edit this file or recursively set up.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const [script, channel] = process.argv.slice(2);
if (!script || !path.isAbsolute(script) || /[\r\n]/.test(script) || !["dev", "stable"].includes(channel)) {
    throw new Error("Expected an absolute setup script path and dev/stable channel");
}
const homeConfig = path.join(os.homedir(), ".tmux.conf");
const xdgConfig = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "tmux/tmux.conf");
const config = fs.existsSync(homeConfig) ? homeConfig : fs.existsSync(xdgConfig) ? xdgConfig : homeConfig;
// Follow dotfile symlinks rather than replacing them with a regular file.
const target = fs.existsSync(config) ? fs.realpathSync(config) : config;
const exists = fs.existsSync(target);
const original = exists ? fs.readFileSync(target, "utf8") : "";
const start = "# >>> pi-console >>>";
const end = "# <<< pi-console <<<";
const lines = original.split("\n");
const kept = [];
let inBlock = false;
for (const line of lines) {
    if (line.trim() === start) {
        if (inBlock) throw new Error(`Nested pi-console block in ${config}; leaving it unchanged`);
        inBlock = true;
    } else if (line.trim() === end) {
        if (!inBlock) throw new Error(`Unmatched pi-console block in ${config}; leaving it unchanged`);
        inBlock = false;
    } else if (!inBlock) {
        kept.push(line);
    }
}
if (inBlock) throw new Error(`Unclosed pi-console block in ${config}; leaving it unchanged`);

// Remove only the exact old installer-style unmarked entry (including its
// two-line spelling). Leave includes and arbitrary user commands untouched.
const legacy = /^[\t ]*if-shell "command -v (pi-console(?:-dev)?) >\/dev\/null 2>&1"[\t ]*(?:\\\r?\n[\t ]*)?"run-shell '\1 --tmux setup'"[\t ]*(?:\r?\n|$)/gm;
const rest = kept.join("\n").replace(legacy, "").replace(/\n*$/, "");
const shellQuote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
const tmuxQuote = (value) => '"' + value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("$", "\\$") + '"';
const command = `bash ${shellQuote(script)} --apply`;
const block = `${start}\n# Default channel: ${channel}\nrun-shell ${tmuxQuote(command)}\n${end}\n`;
const updated = (rest ? rest + "\n\n" : "") + block;
if (updated === original) {
    console.log(`Tmux default is already ${channel} in ${config}.`);
} else {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const suffix = `${Date.now()}.${process.pid}`;
    if (exists) {
        const backup = `${target}.pi-console.bak.${suffix}`;
        fs.copyFileSync(target, backup, fs.constants.COPYFILE_EXCL);
        console.log(`Backed up tmux configuration to ${backup}.`);
    }
    const temporary = `${target}.pi-console.tmp.${suffix}`;
    try {
        fs.writeFileSync(temporary, updated, { flag: "wx", mode: exists ? fs.statSync(target).mode & 0o777 : 0o644 });
        fs.renameSync(temporary, target);
    } finally {
        if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
    console.log(`Saved ${channel} as the tmux default in ${config}.`);
}
