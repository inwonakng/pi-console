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
	floats.close_on_win_leave(state.help_buf, close_help_win, { win = state.help_win })
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
		"- `networkAccess` asks upfront for outbound access to any host for one command only; filesystem restrictions remain.",
		"- Network approval can expose data the command can read, including environment values; it is never remembered.",
		"- The proxy denies undeclared access instead of opening a permission prompt during execution; saved host grants still apply.",
		"- Explicit user-entered `!`/`!!` commands run with host-user access, without our sandbox or approvals.",
		"- Bash has no default timeout. For a requested execution deadline, use its timeout field rather than embedding shell timeouts.",
		"- `unsandboxed` asks for unrestricted host access for one command when granular restrictions cannot support it; never remembered.",
		"- Detected sandbox blocks report partial execution; inspect state and request an appropriate continuation, never blindly rerun.",
		"",
		"## Pending Actions",
		"",
		"- `<Esc>` hides a Pi choice/approval picker without answering it.",
		"- `<leader>pa` restores the pending picker with its query and selection.",
		"- Select Deny/No to reject a request; hiding never grants permission.",
		"- Resolve the pending action before opening another picker.",
		"- Session replacement, abort, restart, and process exit dispose it.",
		"",
		"## Integration Modes",
		"",
		"- `ask`: request confirmation before integrating a task workspace.",
		"- `allowed`: integrate a task workspace without confirmation.",
		"",
		"## Streaming",
		"",
		"Submitting while Pi is working queues the message until the active run fully finishes, including retries.",
		"The statusline shows the number of queued messages next to the activity indicator.",
		"",
		"## Message Queue",
		"",
		"- `<leader>pq` opens queued messages in submission order, with full-text previews.",
		"- `<CR>` edits a message in a floating buffer; `:wq` saves and closes it.",
		"- `:q!` closes the editor without saving; normal Vim keys are unchanged.",
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
