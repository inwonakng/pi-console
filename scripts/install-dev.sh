#!/usr/bin/env bash
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
project_root=$(CDPATH= cd -- "$script_dir/.." && pwd -P)
. "$script_dir/install-common.sh"
bin_dir=${PI_CONSOLE_BIN_DIR:-"$HOME/.local/bin"}
bin_dir=${bin_dir%/}
validate_directory "$bin_dir"
mode=
case "$#:${1-}" in
    0:) ;;
    1:--full) mode=full ;;
    1:--server-only) mode=server-only ;;
    *) fail 'Usage: install-dev.sh [--full | --server-only]' ;;
esac
dev_install_root
mkdir -p "$(dirname -- "$install_root")"
install_lock="$install_root.install-lock"
mkdir -- "$install_lock" 2>/dev/null || fail "Installer already running or stale lock: $install_lock"
trap 'rmdir -- "$install_lock"' EXIT
# Recheck ownership after acquiring the installation lock.
dev_install_root
if [ -z "$mode" ] && [ -L "$install_root/current" ]; then
    selected_marker="$install_root/current/.pi-console-install"
    [ ! -L "$selected_marker" ] && [ -f "$selected_marker" ] \
        && [ "$(value "$selected_marker" channel)" = dev ] \
        && [ "$(value "$selected_marker" checkout)" = "$project_root" ] || fail 'Invalid selected dev runtime marker.'
    mode=$(value "$selected_marker" mode)
fi
mode=${mode:-full}
case "$mode" in full|server-only) ;; *) fail "Unknown installation mode: $mode" ;; esac
missing=
required_commands='pi node npm git realpath rg tar'
if [ "$mode" = full ]; then required_commands="$required_commands nvim tmux fzf cargo cc tree-sitter curl tar"; fi
if [ "$(uname -s)" = Linux ]; then required_commands="$required_commands bwrap socat"; fi
for command in $required_commands; do
    if ! command -v "$command" >/dev/null 2>&1; then missing="$missing $command"; fi
done
[ -z "$missing" ] || fail "Missing required commands:$missing. Install them and retry; full mode requires tree-sitter CLI >=0.26.1 (not the npm package). Use --server-only only for a headless installation."
node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 19) ? 0 : 1)' \
    || fail 'Node.js 22.19.0 or newer is required. Update Node.js and retry.'
# Keep this preflight identical in both installers; stable is pipe-to-Bash self-contained.
node - "$mode" <<'NODE'
const { execFileSync } = require("node:child_process");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const scratch = mkdtempSync(join(tmpdir(), "pi-console-prerequisites-"));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
const run = (bin, args, input) => execFileSync(bin, args, { env, input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
function version(bin, minimum, pattern) {
  const output = run(bin, ["--version"]);
  const match = output.match(pattern);
  const actual = match?.slice(1, 4).map(Number);
  if (!actual || actual.reduce((result, part, i) => result || Math.sign(part - minimum[i]), 0) < 0)
    throw new Error(bin + " >=" + minimum.join(".") + " is required; found " + output.split("\n")[0] + ". Upgrade it and retry.");
}
try {
  version("git", [2, 45, 0], /^git version (\d+)\.(\d+)\.(\d+)/);
  try {
    run("git", ["init", "--bare", "--quiet", scratch]);
    const tree = run("git", ["-C", scratch, "mktree"], "");
    run("git", ["-C", scratch, "merge-tree", "--write-tree", "--merge-base=" + tree, tree, tree]);
  } catch (error) {
    throw new Error("Git must support merge-tree --write-tree --merge-base with raw tree operands (Git >=2.45.0). Select a supported Git executable and retry. " + (error.stderr || error.message));
  }
  if (process.argv[2] === "full") {
    version("nvim", [0, 12, 0], /^NVIM v(\d+)\.(\d+)\.(\d+)/);
    version("tree-sitter", [0, 26, 1], /^tree-sitter (\d+)\.(\d+)\.(\d+)/);
    run("tree-sitter", ["generate", "--help"]);
    run("tree-sitter", ["build", "--help"]);
    env.NVIM_LOG_FILE = join(scratch, "nvim.log");
    try {
      run("nvim", ["--headless", "-u", "NONE", "-i", "NONE", "--noplugin", "-n", "-c",
        'lua vim.defer_fn(function() vim.cmd("cquit 1") end, 10000); local ok, err = pcall(function() assert(vim.fn.has("nvim-0.12") == 1, "Neovim >=0.12.0 required"); assert(type(vim.pack) == "table" and type(vim.pack.add) == "function", "vim.pack.add required"); assert(vim.treesitter.language_version >= 13, "Tree-sitter runtime ABI >=13 required") end); if not ok then vim.api.nvim_err_writeln(tostring(err)); vim.cmd("cquit 1") else vim.cmd("qa!") end']);
    } catch (error) {
      throw new Error("Full installation requires Neovim >=0.12.0 with vim.pack.add and Tree-sitter runtime ABI >=13. Upgrade Neovim and retry. " + (error.stderr || error.message));
    }
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally { rmSync(scratch, { recursive: true, force: true }); }
NODE
[ "$(pi --version)" = 1.3.0 ] || fail 'Pi 1.3.0 is required by this build. Select that Pi version and retry; the installer does not modify Pi.'

staging=$(mktemp -d "$(dirname -- "$install_root")/.pi-console-dev.XXXXXX")
trap 'rm -rf -- "$staging"; rmdir -- "$install_lock"' EXIT
for name in pi-console-dev pi-dev; do
    case "$name" in pi-console-dev) target=pi-console ;; pi-dev) target=pi-shell ;; esac
    dev_wrapper "$install_root/current/bin/$target" >"$staging/$name"
    chmod 755 "$staging/$name"
    # Accept the exact wrapper from this checkout's previous installer too.
    dev_wrapper "$project_root/bin/$target" >"$staging/old-$name"
    if [ ! -L "$bin_dir/$name" ] && [ -f "$bin_dir/$name" ] && cmp -s "$bin_dir/$name" "$staging/old-$name"; then
        continue
    fi
    check_wrapper "$bin_dir/$name" "$staging/$name"
done
commit=$(git -C "$project_root" rev-parse HEAD)
[[ "$commit" =~ ^[0-9a-f]{40}$ ]] || fail 'Invalid checkout commit.'
dirty=0
[ -z "$(git --no-optional-locks -C "$project_root" status --porcelain)" ] || dirty=1
mkdir "$staging/source"
# Copy current sources (including uncommitted edits), never live dependencies/builds.
# Extract only after tar succeeds; a failed source copy must not be activated.
tar -C "$project_root" --exclude=node_modules --exclude=dist --exclude=.DS_Store \
    -cf "$staging/source.tar" bin nvim pi server tmux scripts
tar -C "$staging/source" -xf "$staging/source.tar"
bash "$staging/source/scripts/build-runtime.sh"
printf 'channel=dev\nref=checkout\ncommit=%s\ndirty=%s\nmode=%s\ncheckout=%s\n' \
    "$commit" "$dirty" "$mode" "$project_root" >"$staging/source/.pi-console-install"
release="$commit-$mode-${staging##*.}"
# Retire only the exact old registration after a successful build, before activation.
remove_old_registration "$project_root/pi"
mkdir -p "$install_root/versions" "$bin_dir"
[ ! -e "$install_root/versions/$release" ] && [ ! -L "$install_root/versions/$release" ] || fail 'Runtime already exists.'
mv -- "$staging/source" "$install_root/versions/$release"
printf 'checkout=%s\n' "$project_root" >"$staging/marker"
mv -f -- "$staging/marker" "$marker"
ln -s "versions/$release" "$staging/current"
case "$(uname -s)" in
    Darwin) mv -fh -- "$staging/current" "$install_root/current" ;;
    *) mv -fT -- "$staging/current" "$install_root/current" ;;
esac
for name in pi-console-dev pi-dev; do mv -f -- "$staging/$name" "$bin_dir/$name"; done
remove_checkout_link "$bin_dir/pi-console" "$project_root/bin/pi-console"
printf '\nDevelopment commands: %s/pi-console-dev and %s/pi-dev\n' "$bin_dir" "$bin_dir"
printf 'Mode: %s. Snapshot: %s/versions/%s\n' "$mode" "$install_root" "$release"
printf 'Rerun this installer after checkout edits. Old snapshots are retained; running services keep new conversations on their pinned build until an explicit guarded restart.\n'
printf 'Stable commands, tmux selection and service startup were left unchanged.\n'
