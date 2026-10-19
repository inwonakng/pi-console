local floats = require("pi-integration.floats")
local keymaps = require("pi-integration.keymaps")

local M = {}

local function buffer_valid(buf)
	return buf and vim.api.nvim_buf_is_valid(buf)
end

local function create_buffer(name)
	local buf = vim.api.nvim_create_buf(false, true)
	vim.api.nvim_buf_set_name(buf, name)
	vim.bo[buf].bufhidden = "hide"
	vim.bo[buf].filetype = "markdown"
	vim.bo[buf].modifiable = false
	return buf
end

local function set_lines(buf, lines)
	vim.bo[buf].modifiable = true
	vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
	vim.bo[buf].modifiable = false
end

function M.toggle_window(state, options)
	if state.help_win and vim.api.nvim_win_is_valid(state.help_win) then
		floats.close_window(state.help_win)
		state.help_win = nil
		return
	end

	if not buffer_valid(state.help_buf) then
		state.help_buf = create_buffer(options.name)
	end
	set_lines(state.help_buf, options.lines)

	local width = math.min(72, math.max(48, math.floor(vim.o.columns * 0.55)))
	local height = math.min(#options.lines + 2, math.max(14, math.floor(vim.o.lines * 0.65)))
	local row = math.max(1, math.floor((vim.o.lines - height) / 2))
	local col = math.max(0, math.floor((vim.o.columns - width) / 2))

	state.help_win = vim.api.nvim_open_win(state.help_buf, true, {
		relative = "editor",
		width = width,
		height = height,
		row = row,
		col = col,
		style = "minimal",
		border = "rounded",
		title = " " .. options.title .. " ",
		title_pos = "center",
	})

	local close_help_win = function()
		floats.close_window(state.help_win)
		state.help_win = nil
	end
	floats.close_on_win_leave(state.help_buf, close_help_win, { win = state.help_win, parent = options.parent })
	vim.keymap.set("n", "q", close_help_win, { buffer = state.help_buf, desc = "Close help" })
	vim.keymap.set("n", "<Esc>", close_help_win, { buffer = state.help_buf, desc = "Close help" })
end

function M.toggle(ctx)
	local lines = {
		"# Pi Help",
		"",
		"## Keys",
		"",
	}
	vim.list_extend(lines, keymaps.help_key_lines())
	vim.list_extend(lines, {
		"",
		"## Commands",
		"",
		"- `:PiCd [directory]` change CWD before sending the first message.",
		"- `<C-f>` in a directory prompt opens up to 10 unique recently used Pi directories, newest last.",
		"",
		"## Access Modes",
		"",
		"- `full`: run with unrestricted host filesystem and network access.",
		"- `edit`: configured access plus workspace writes; ask for additional access and shell network access.",
		"- `ask`: configured access; ask for additional access and shell network access.",
		"- `readonly`: configured reads and scratch writes only; deny additional access without prompting.",
		"- YAML `access-mode.read-paths` defaults to [\"/\"]: all reads, including credentials, without approval.",
		"- YAML `access-mode.write-paths` defaults to [\"/tmp\"]; non-scratch writes are still denied in readonly.",
		"- Lists add to workspace/system reads and mode permissions; [] removes the corresponding default.",
		"- `temp-dir-prefix` optionally sets the scratch path prefix on the next Pi session; omitted uses OS temp.",
		"- The unique scratch directory is writable by both file tools and Bash, becomes $TMPDIR, and is removed on shutdown.",
		"- Scoped grants offer Allow once, Allow for session, or Deny; file tools and Bash share remembered grants.",
		"- Bash declares additional `writePaths`; use narrow `readPaths` only with restricted read configuration.",
		"- `workspaceWriteAccess` requests workspace writes; `broadReadAccess` is unnecessary with default reads.",
		"- Approval previews show Access scope separately from Command CWD.",
		"- `networkAccess` asks upfront for outbound access to any host: Allow once, Allow network for this session, or Deny.",
		"- A session network grant survives resume and covers later commands; filesystem restrictions and network safeguards remain.",
		"- Network approval can expose readable data, including environment values; readonly still blocks shell network access.",
		"- Network grants are not inherited by new conversations, forks, or subagents; existing saved host grants still apply.",
		"- Without a grant, the proxy denies undeclared access instead of prompting during execution.",
		"- Explicit user-entered `!`/`!!` commands run with host-user access, without our sandbox or approvals.",
		"- Bash has no default timeout. Use its timeout field for short diagnostic probes or user-requested deadlines; omit it otherwise.",
		"- Execution deadlines start after approvals. Embedded shell timeouts remain reserved for user requests or timeout testing.",
		"- Diagnostic scripts must exit on success or failure; headless Neovim probes use cquit on error and install any watchdog before plugin loading.",
		"- On macOS, `unixSocketPaths` requests binding/connections at literal socket paths; directory grants cover descendants.",
		"- Inspect $TMPDIR for Neovim's socket directory. Socket grants do not permit filesystem writes, outbound access, or TCP binding.",
		"- Unix sockets may expose local services; approve narrow paths. Linux path-scoped requests are rejected, never widened.",
		"- `unsandboxed` asks for unrestricted host access: allow once, choose a session scope, or deny.",
		"- Session scopes: exact command/CWD, any command from this CWD, or any command from any CWD.",
		"- All include future script changes and child processes. Exact-command grants require matching text/arguments/CWD.",
		"- CWD scope matches only that canonical directory, not descendants; it does not limit what the command can access.",
		"- Modify scripts separately from the stable run command. A grant never moves a normally sandboxed run outside the sandbox.",
		"- Command and socket grants are memory-only, expire on session/branch replacement or process exit, and are not inherited.",
		"- Detected sandbox blocks report partial execution; inspect state and request an appropriate continuation, never blindly rerun.",
		"",
		"## Pending Actions",
		"",
		"- `<Esc>` hides pending Pi choice/confirmation dialogs without answering them; `<C-q>` cancels the request.",
		"- Question/freehand editors keep focus until closed; `:wq` submits and `:q!` cancels.",
		"- Navigation/settings pickers cancel on `<Esc>` and cannot be restored.",
		"- `<leader>pa` restores the pending picker with its query and selection.",
		"- Select Deny/No to reject a request; hiding never grants permission.",
		"- Resolve the pending action before opening another picker.",
		"- Session replacement, abort, restart, and process exit dispose it.",
		"",
		"## Conversation history tree",
		"",
		"- `<leader>h`: history tree, grouped by turn, opening on the active turn with highlight-only selection.",
		"- `?` in the tree shows all bindings; the compact header shows common actions.",
		"- `b`: full tree/current branch; `o`: entry filter; `/`: fuzzy search full turn text in tree order.",
		"- Search Enter only locates; `n` / `N` select matches. Clear `/` query to reveal the located turn in the full view.",
		"- Tree Enter jumps; `S` jumps with summary. Neither deletes history.",
		"- `c`: clone through the selected turn into a new window; blocked inside managed workspaces.",
		"- Clone copies history, not files, rollback snapshots, permission grants, or workspace ownership.",
		"- `d`: delete selected turn and all descendants; choose History only or History + undo work.",
		"- Undo work is active-path only and restores recorded changes, not arbitrary external effects.",
		"- `<C-f>` / `<C-b>` scroll preview; `r` refreshes; `q` closes.",
		"",
		"## Integration Modes",
		"",
		"- `ask`: request confirmation before integrating a task workspace or discarding any workspace.",
		"- `allowed`: integrate a task workspace or discard any workspace without confirmation.",
		"- Discard approval also applies to retained child workspaces from subagents.",
		"",
		"## Streaming",
		"",
		"Submitting while Pi is working queues the message until the active run fully finishes, including retries.",
		"The statusline shows the number of queued messages next to the activity indicator.",
		"",
		"## Steering and side conversations",
		"",
		"- `<leader>pS` / `:PiSteer` opens a native Vim editor; `:wq` steers and `:q!` cancels.",
		"- `:PiSteer` accepts selected transcript lines. An instruction not sent before Pi finishes stays in the steer draft.",
		"- `<leader>pb` / `:PiSide` toggles the paired side transcript and input floats.",
		"- Side input: `<C-CR>` sends; normal-mode `<C-k>` / `<C-j>` focus transcript / input.",
		"- The toggle or `:q` hides both floats, preserving the draft and conversation. Escape and q keep their native editing behavior.",
		"- `:PiSideAbort` stops only side work. `:PiSideReset` clears side history and captures fresh finalized main context.",
		"- Side access is always ask. Permissions use the normal approval dialogs; simultaneous requests are queued.",
		"- Side history is bundled with the saved parent session and never added to the main model context.",
		"- Send a main prompt first to save the parent. Stop side work before restarting.",
		"",
		"## Message Queue",
		"",
		"- `<leader>pq` opens queued messages in submission order, with full-text previews.",
		"- `<CR>` edits a message in a floating buffer; `:wq` saves and closes it.",
		"- The editor keeps focus until closed; `:q!` closes it without saving.",
		"- `<C-x>` in the queue picker deletes the selected message.",
		"- If the next message is being edited, dispatch waits; later messages cannot overtake it.",
		"- Failed messages remain in the picker; saving an edit queues them again.",
	})
	M.toggle_window(ctx.state, {
		name = "pi://help",
		title = "Pi Help",
		lines = lines,
	})
end

return M
