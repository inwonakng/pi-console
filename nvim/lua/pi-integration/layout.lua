local markdown_render = require("pi-integration.markdown-render")

local M = {}

function M.create_buffer(_, name, filetype, modifiable)
	local buf = vim.api.nvim_create_buf(false, true)
	vim.api.nvim_buf_set_name(buf, name)
	vim.api.nvim_set_option_value("buftype", "nofile", { buf = buf })
	vim.api.nvim_set_option_value("bufhidden", "hide", { buf = buf })
	vim.api.nvim_set_option_value("swapfile", false, { buf = buf })
	vim.api.nvim_set_option_value("filetype", filetype, { buf = buf })
	vim.api.nvim_set_option_value("modifiable", modifiable, { buf = buf })
	return buf
end

function M.set_buffer_lines(ctx, buf, lines, modifiable)
	ctx.buffer.set_modifiable(buf, true)
	vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
	ctx.buffer.set_modifiable(buf, modifiable)
end

function M.apply_window_padding(_, win)
	vim.api.nvim_set_option_value("winbar", " ", { win = win })
	vim.api.nvim_set_option_value("fillchars", "stl:─,stlnc:─", { win = win })
	vim.api.nvim_set_option_value("statusline", "%#PiPaneBorder#%=", { win = win })
	vim.api.nvim_set_option_value("statuscolumn", "", { win = win })
	vim.api.nvim_set_option_value("winhl", "", { win = win })
	vim.api.nvim_set_option_value("signcolumn", "yes:1", { win = win })
	vim.api.nvim_set_option_value("scrolloff", 1, { win = win })
	vim.api.nvim_set_option_value("sidescrolloff", 2, { win = win })
end

local function input_sidebar_highlight(mode)
	if mode == "edit" then
		return "PiInputSidebarEdit"
	elseif mode == "ask" then
		return "PiInputSidebarAsk"
	elseif mode == "readonly" then
		return "PiInputSidebarReadonly"
	end
	return "PiInputSidebarUnknown"
end

function M.update_input_sidebar(ctx)
	local win = ctx.state.input_win
	if not win or not vim.api.nvim_win_is_valid(win) then
		return
	end
	local highlight = input_sidebar_highlight(ctx.state.access_mode)
	vim.api.nvim_set_option_value("fillchars", "stl:─,stlnc:─,eob:▌", { win = win })
	vim.api.nvim_set_option_value("statuscolumn", "%#" .. highlight .. "#▌%#SignColumn# ", { win = win })
	vim.api.nvim_set_option_value("winhl", "EndOfBuffer:" .. highlight, { win = win })
end

function M.apply_input_window_options(ctx, win)
	M.apply_window_padding(ctx, win)
	vim.api.nvim_set_option_value("winbar", "", { win = win })
	M.update_input_sidebar(ctx)
end

function M.apply_transcript_window_options(ctx, win)
	M.apply_window_padding(ctx, win)
	vim.api.nvim_set_option_value("scrolloff", 4, { win = win })
end

function M.ensure_transcript_buffer(ctx)
	local state = ctx.state
	if ctx.buffer.valid(state.transcript_buf) then
		return false
	end

	state.transcript_buf = M.create_buffer(ctx, "pi://transcript", "markdown", false)
	markdown_render.prepare_buffer(state.transcript_buf, { latex = true })
	return true
end

function M.ensure_input_buffer(ctx)
	local state = ctx.state
	if ctx.buffer.valid(state.input_buf) then
		return false
	end

	state.input_buf = M.create_buffer(ctx, "pi://input", "markdown", true)
	markdown_render.prepare_buffer(state.input_buf)
	return true
end

function M.show_transcript(ctx)
	local state = ctx.state
	local recreated = M.ensure_transcript_buffer(ctx)
	local win = vim.api.nvim_get_current_win()

	vim.api.nvim_win_set_buf(win, state.transcript_buf)
	state.transcript_win = win
	if state.input_win == win then
		state.input_win = nil
	end
	M.apply_transcript_window_options(ctx, win)
	ctx.session.setup_keymaps()
	ctx.transcript.refresh_ui()
	return recreated
end

function M.show_input(ctx)
	local state = ctx.state
	local recreated = M.ensure_input_buffer(ctx)
	local win = vim.api.nvim_get_current_win()

	vim.api.nvim_win_set_buf(win, state.input_buf)
	state.input_win = win
	if state.transcript_win == win then
		state.transcript_win = nil
	end
	M.apply_input_window_options(ctx, win)
	ctx.session.setup_keymaps()
	return recreated
end

function M.open(ctx)
	local state = ctx.state
	if ctx.buffer.valid(state.transcript_buf) and ctx.buffer.valid(state.input_buf) then
		return false
	end

	M.ensure_transcript_buffer(ctx)
	M.ensure_input_buffer(ctx)

	vim.api.nvim_win_set_buf(0, state.transcript_buf)
	state.transcript_win = vim.api.nvim_get_current_win()
	M.apply_transcript_window_options(ctx, state.transcript_win)
	vim.cmd("botright 12split")
	vim.api.nvim_win_set_buf(0, state.input_buf)
	state.input_win = vim.api.nvim_get_current_win()
	M.apply_input_window_options(ctx, state.input_win)

	ctx.transcript.refresh_ui()
	ctx.session.setup_keymaps()
	return true
end

return M
