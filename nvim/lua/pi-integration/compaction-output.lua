local floats = require("pi-integration.floats")
local buffer_utils = require("pi-integration.utils.buffer")

local M = {}

function M.open_float(ctx, item)
	local summary = type(item) == "table" and item.summary or nil
	if type(summary) ~= "string" or summary == "" then
		ctx.ui.notify("Compaction summary unavailable", vim.log.levels.WARN)
		return true
	end

	local width = math.max(40, math.floor(vim.o.columns * 0.85))
	local height = math.max(10, math.floor(vim.o.lines * 0.8))
	width = math.min(width, math.max(1, vim.o.columns - 4))
	height = math.min(height, math.max(1, vim.o.lines - 4))
	local row = math.floor((vim.o.lines - height) / 2)
	local col = math.floor((vim.o.columns - width) / 2)

	local buf = buffer_utils.create_scratch({
		name = "pi://compaction/" .. tostring(item.start_line or "summary"),
		filetype = "markdown",
		lines = vim.split(summary, "\n", { plain = true }),
	})

	local win = vim.api.nvim_open_win(buf, true, {
		relative = "editor",
		width = width,
		height = height,
		row = row,
		col = col,
		style = "minimal",
		border = "rounded",
		title = " Compaction Summary ",
		title_pos = "left",
	})

	vim.api.nvim_set_option_value("wrap", true, { win = win })
	vim.api.nvim_set_option_value("number", false, { win = win })
	vim.api.nvim_set_option_value("relativenumber", false, { win = win })
	vim.api.nvim_set_option_value("signcolumn", "no", { win = win })

	local close_summary_win = function()
		floats.close_window(win)
	end
	floats.close_on_win_leave(buf, close_summary_win, { win = win, parent = ctx.window.parent })
	vim.keymap.set("n", "q", close_summary_win, { buffer = buf, silent = true, desc = "Close compaction summary" })
	vim.keymap.set("n", "<Esc>", close_summary_win, { buffer = buf, silent = true, desc = "Close compaction summary" })
	vim.keymap.set("n", "y", function()
		vim.fn.setreg("+", summary)
		ctx.ui.notify("Yanked compaction summary")
	end, { buffer = buf, silent = true, desc = "Yank compaction summary" })

	return true
end

return M
