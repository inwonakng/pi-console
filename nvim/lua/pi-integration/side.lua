-- Paired side-conversation floats. Ownership and submissions stay in the frontend.
local floats = require("pi-integration.floats")
local buffer = require("pi-integration.utils.buffer")
local markdown = require("pi-integration.markdown-render")
local M = {}
local transcript_win, input_win, return_win, focus
local input_cursor, transcript_view, hiding, displayed_buf
local window_group = vim.api.nvim_create_augroup("PiSideWindows", { clear = true })

local function valid(win) return win and vim.api.nvim_win_is_valid(win) end

function M.visible() return valid(transcript_win) or valid(input_win) end

local function geometry()
	local width = math.max(1, math.min(110, math.floor(vim.o.columns * 0.86), vim.o.columns - 4))
	local top = (vim.o.showtabline == 2 or (vim.o.showtabline == 1 and #vim.api.nvim_list_tabpages() > 1)) and 1 or 0
	local bottom = vim.o.cmdheight + (vim.o.laststatus > 0 and 1 or 0) + 1
	local usable = math.max(6, vim.o.lines - top - bottom)
	local total = math.max(6, math.floor(usable * 0.75))
	local input_height = math.max(1, math.min(8, math.floor(total * 0.25)))
	return width, math.max(1, total - input_height - 4), input_height,
		top + math.floor((usable - total) / 2), math.max(0, math.floor((vim.o.columns - width) / 2))
end

function M.hide()
	if hiding then return end
	hiding = true
	if focus then focus:release(); focus = nil end
	if valid(input_win) then input_cursor = vim.api.nvim_win_get_cursor(input_win) end
	if valid(transcript_win) then transcript_view = vim.api.nvim_win_call(transcript_win, vim.fn.winsaveview) end
	for _, win in pairs({ input_win, transcript_win }) do
		floats.close_descendants(win)
		floats.close_window(win)
	end
	input_win, transcript_win = nil, nil
	if valid(return_win) then vim.api.nvim_set_current_win(return_win) end
	hiding = false
end

function M.open(transcript_buf, input_buf)
	if M.visible() then
		if valid(input_win) then vim.api.nvim_set_current_win(input_win) end
		return
	end
	return_win = vim.api.nvim_get_current_win()
	if displayed_buf ~= transcript_buf then input_cursor, transcript_view = nil, nil end
	displayed_buf = transcript_buf
	local width, th, ih, row, col = geometry()
	transcript_win = vim.api.nvim_open_win(transcript_buf, false, {
		relative = "editor", width = width, height = th, row = row, col = col,
		style = "minimal", border = "rounded", title = " Side conversation | ask ",
	})
	input_win = vim.api.nvim_open_win(input_buf, true, {
		relative = "editor", width = width, height = ih, row = row + th + 2, col = col,
		style = "minimal", border = "rounded", title = " Side input ",
		footer = " Ctrl+Enter send · <leader>pb / :q hide · <leader>n new chat ",
	})
	vim.api.nvim_clear_autocmds({ group = window_group, event = "WinClosed" })
	for _, win in ipairs({ transcript_win, input_win }) do
		vim.wo[win].wrap, vim.wo[win].linebreak, vim.wo[win].conceallevel = true, true, 2
		vim.api.nvim_create_autocmd("WinClosed", {
			group = window_group, pattern = tostring(win), once = true,
			callback = function() if not hiding then M.hide() end end,
		})
	end
	for _, buf in ipairs({ transcript_buf, input_buf }) do
		vim.keymap.set("n", "<leader>pb", M.hide, { buffer = buf, desc = "Hide side conversation" })
		for _, lhs in ipairs({ "<C-k>", "<C-w>k", "<C-w><C-k>" }) do
			vim.keymap.set("n", lhs, function() if valid(transcript_win) then vim.api.nvim_set_current_win(transcript_win) end end, { buffer = buf })
		end
		for _, lhs in ipairs({ "<C-j>", "<C-w>j", "<C-w><C-j>" }) do
			vim.keymap.set("n", lhs, function() if valid(input_win) then vim.api.nvim_set_current_win(input_win) end end, { buffer = buf })
		end
	end
	focus = floats.focus_group({ transcript_win, input_win })
	if input_cursor then pcall(vim.api.nvim_win_set_cursor, input_win, input_cursor) end
	if transcript_view then
		vim.api.nvim_win_call(transcript_win, function() vim.fn.winrestview(transcript_view) end)
	end
	markdown.render(transcript_buf, transcript_win, { latex = true })
	markdown.render(input_buf, input_win)
end

function M.render(buf, lines)
	local preserve = vim.api.nvim_get_current_win() == transcript_win
		or vim.deep_equal(vim.api.nvim_buf_get_lines(buf, 0, -1, false), lines)
	local view = valid(transcript_win) and vim.api.nvim_win_call(transcript_win, vim.fn.winsaveview)
	buffer.update_lines(buf, lines)
	if valid(transcript_win) then
		vim.api.nvim_win_call(transcript_win, function()
			if preserve and view then vim.fn.winrestview(view)
			else
				vim.api.nvim_win_set_cursor(transcript_win, { math.max(1, #lines), 0 })
				vim.cmd("normal! zb")
			end
		end)
		markdown.render(buf, transcript_win, { latex = true })
	end
end

vim.api.nvim_create_autocmd("VimResized", { group = window_group, callback = function()
	if not valid(transcript_win) or not valid(input_win) then return end
	local width, th, ih, row, col = geometry()
	vim.api.nvim_win_set_config(transcript_win, { relative = "editor", width = width, height = th, row = row, col = col })
	vim.api.nvim_win_set_config(input_win, { relative = "editor", width = width, height = ih, row = row + th + 2, col = col })
end })
return M
