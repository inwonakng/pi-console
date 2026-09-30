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
		"",
		"## Access Modes",
		"",
		"- `full`: run with unrestricted host filesystem and network access.",
		"- `edit`: allow workspace writes; ask before sandboxed network access.",
		"- `ask`: start read-only, then offer Allow once, Allow for session, or Deny after a blocked capability.",
		"- `readonly`: allow project reads while denying persistent writes and shell network access.",
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
		"When a run is already streaming, submitting another prompt is sent as PI steering for the active run.",
	})
	M.toggle_window(ctx.state, {
		name = "pi://help",
		title = "Pi Help",
		lines = lines,
	})
end

return M
