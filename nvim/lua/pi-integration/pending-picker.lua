local M = {}

-- One live RPC dialog owns the input pane until answered or revoked.
local active
local input_sequence = 0

function M.owns_buffer(buf)
	return active ~= nil and (active.buf == buf or active.input_buf == buf)
end

function M.owns_window(win)
	return active ~= nil and active.win == win
end

function M.focus(ctx)
	if active and active.ctx.state == ctx.state and vim.api.nvim_win_is_valid(active.win) then
		vim.api.nvim_set_current_win(active.win)
		return true
	end
	return false
end

local function refresh(picker)
	picker.ctx.transcript.refresh_ui()
end

local function restore_input(picker)
	if picker.restored then return end
	picker.restored = true
	if not vim.api.nvim_win_is_valid(picker.win) or not vim.api.nvim_buf_is_valid(picker.input_buf) then return end
	vim.api.nvim_win_set_buf(picker.win, picker.input_buf)
	vim.wo[picker.win].winbar = picker.winbar
	vim.wo[picker.win].statuscolumn = picker.statuscolumn
	vim.wo[picker.win].statusline = picker.statusline
	if picker.side then
		picker.side.resize_input(nil)
		picker.side.bind_input()
	else
		vim.api.nvim_win_set_height(picker.win, picker.height)
		picker.ctx.state.input_win = picker.win
	end
	vim.api.nvim_win_call(picker.win, function() vim.fn.winrestview(picker.view) end)
end

local function close(picker)
	local focused = vim.api.nvim_get_current_win()
	if not picker.input then
		local win = require("fzf-lua").win.__SELF()
		if win and win.fzf_bufnr == picker.buf then
			-- The terminating fzf job must not close/refocus this pane a second time.
			win:set_autoclose(false)
			win:close()
		end
	end
	restore_input(picker)
	if picker.input and picker.buf and vim.api.nvim_buf_is_valid(picker.buf) then
		vim.api.nvim_buf_delete(picker.buf, { force = true })
	end
	if vim.api.nvim_win_is_valid(focused) then vim.api.nvim_set_current_win(focused) end
end

local function finish(picker, choice, respond, explicit_cancel)
	if active ~= picker then return end
	active = nil
	if picker.request.expires and picker.request.expires <= vim.uv.now() then respond = false end
	-- Release ownership before closing: delayed callbacks must not answer a
	-- revoked request or close the next dialog.
	close(picker)
	local state = picker.ctx.state
	state.pending_ui_requests[picker.id] = nil
	if state.active_ui_request_id == picker.id then state.active_ui_request_id = nil end
	if respond then
		if explicit_cancel and picker.request.on_cancel then
			picker.request.on_cancel()
		elseif choice ~= nil then
			picker.on_choice(choice)
		end
	end
	refresh(picker)
end

function M.can_open(request_id)
	if active and active.request.expires and active.request.expires <= vim.uv.now() then
		finish(active, nil, false)
	end
	if not active or request_id == active.id then return true end
	active.ctx.ui.notify("Resolve the pending action in the input pane first.", vim.log.levels.WARN)
	return false
end

-- Dispose only the frontend; the owner retains the pending interaction.
function M.clear(ctx)
	if active and active.ctx.state == ctx.state then finish(active, nil, false) end
end

local function open_pane(ctx, id, on_choice)
	local layout = require("pi-integration.layout")
	local state = ctx.state
	local request = state.pending_ui_requests[id]
	local side = request.side and require("pi-integration.side") or nil
	local win = side and side.input_window() or state.input_win
	if not side and (not win or not vim.api.nvim_win_is_valid(win) or vim.api.nvim_win_get_buf(win) ~= state.input_buf) then
		layout.open(ctx)
		win = state.input_win
	end
	local picker = {
		ctx = ctx, id = id, request = request, on_choice = on_choice, side = side,
		win = win, input_buf = vim.api.nvim_win_get_buf(win), height = vim.api.nvim_win_get_height(win),
		winbar = vim.wo[win].winbar, statuscolumn = vim.wo[win].statuscolumn, statusline = vim.wo[win].statusline,
		view = vim.api.nvim_win_call(win, vim.fn.winsaveview),
	}
	active = picker
	vim.api.nvim_set_current_win(win)
	if picker.request.expires then
		vim.defer_fn(function()
			finish(picker, nil, false)
		end, math.max(0, picker.request.expires - vim.uv.now()))
	end
	return picker
end

function M.select(ctx, id, items, opts, on_choice)
	if not M.can_open(id) then on_choice(nil); return end
	local picker = open_pane(ctx, id, on_choice)
	opts.pi_request_id = id
	opts.pi_on_failure = function() finish(picker, nil, true, true) end
	opts.pi_input_win = picker.win
	opts.pi_transcript_win = picker.side and picker.side.transcript_window() or ctx.state.transcript_win
	opts.pi_resize_input = picker.side and picker.side.resize_input or nil
	opts.on_create = function(event)
		picker.buf = event.bufnr
		-- Keep the pane separator instead of fzf-lua's split-provider label.
		require("fzf-lua").win.__SELF().update_statusline = function()
			vim.wo[picker.win].statusline = picker.statusline
		end
		vim.wo[picker.win].statuscolumn = ""
		if picker.side then
			picker.side.bind_input()
			picker.side.setup_navigation(picker.buf, { "n", "t" })
		end
		-- Esc leaves terminal-input mode; it neither hides nor answers.
		vim.keymap.set("t", "<Esc>", "<C-\\><C-n>", { buffer = picker.buf, nowait = true })
		if not picker.side then
			for _, direction in ipairs({ "h", "j", "k", "l" }) do
				vim.keymap.set("t", "<C-" .. direction .. ">", "<C-\\><C-n><C-w>" .. direction,
					{ buffer = picker.buf, desc = "Navigate windows" })
			end
		end
		vim.keymap.set({ "t", "n" }, "<C-q>", function()
			finish(picker, nil, true, true)
		end, { buffer = picker.buf, desc = "Cancel pending Pi action" })
		vim.api.nvim_create_autocmd("BufEnter", { buffer = picker.buf, callback = function()
			vim.cmd("startinsert")
		end })
	end
	opts.on_close = function() restore_input(picker) end
	local ok, err = pcall(vim.ui.select, items, opts, function(choice)
		finish(picker, choice, true, choice == nil)
	end)
	if not ok or (active == picker and not picker.buf) then
		ctx.logs.add("error", "Pi picker failed", ok and "fzf-lua did not open a picker" or tostring(err))
		finish(picker, nil, true, true)
	end
	refresh(picker)
end

function M.input(ctx, event, on_input)
	if not M.can_open(event.id) then on_input(nil); return end
	local picker = open_pane(ctx, event.id, on_input)
	picker.input = true
	local ok, err = pcall(function()
		input_sequence = input_sequence + 1
		picker.buf = require("pi-integration.layout").create_buffer(ctx, "pi://answer/" .. input_sequence, "markdown", true)
		vim.api.nvim_buf_set_lines(picker.buf, 0, -1, false, vim.split(event.prefill or "", "\n", { plain = true }))
		vim.bo[picker.buf].modified = false
		vim.api.nvim_win_set_buf(picker.win, picker.buf)
		if picker.side then
			picker.side.bind_input()
			picker.side.setup_navigation(picker.buf)
		end
		local title = event.title or "Pi input"
		if event.placeholder and event.placeholder ~= "" then title = title .. " | " .. event.placeholder end
		vim.wo[picker.win].winbar = " " .. title:gsub("[\r\n%%]+", " ") .. " (Ctrl+Enter submits; Ctrl+Q cancels)"
		for _, key in ipairs({ "<C-CR>", "<C-s>" }) do
			vim.keymap.set({ "n", "i" }, key, function()
				local text = table.concat(vim.api.nvim_buf_get_lines(picker.buf, 0, -1, false), "\n")
				vim.cmd("stopinsert")
				finish(picker, text, true)
			end, { buffer = picker.buf, desc = "Submit Pi answer" })
		end
		vim.keymap.set({ "n", "i" }, "<C-q>", function()
			vim.cmd("stopinsert")
			finish(picker, nil, true, true)
		end, { buffer = picker.buf, desc = "Cancel pending Pi input" })
		vim.api.nvim_create_autocmd({ "BufHidden", "BufWipeout" }, { buffer = picker.buf, once = true,
			callback = function() vim.schedule(function() finish(picker, nil, true, true) end) end })
		vim.cmd("startinsert")
	end)
	if not ok then
		ctx.logs.add("error", "Pi input failed", tostring(err))
		finish(picker, nil, true, true)
	end
	refresh(picker)
	return picker.buf
end

return M
