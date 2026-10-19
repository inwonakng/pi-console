-- guicursor is global: hide it only while a list owns normal-mode focus.
local M = {}
local buffers = {}
local saved
local group

local function update()
	local win = vim.api.nvim_get_current_win()
	local mode = vim.api.nvim_get_mode().mode
	local hide = buffers[vim.api.nvim_get_current_buf()] and (mode == "n" or mode == "no")
	if hide then
		if not saved then saved = vim.o.guicursor end
		local normal = vim.api.nvim_get_hl(0, { name = "Normal", link = false })
		local line = vim.wo[win].cursorline and vim.api.nvim_get_hl(0, { name = "CursorLine", link = false }) or {}
		local bg = line.bg or normal.bg or "#080808"
		vim.api.nvim_set_hl(0, "PiListCursor", { fg = bg, bg = bg, blend = 100, reverse = false })
		vim.o.guicursor = "n-o:block-blinkon0-PiListCursor"
	elseif saved then
		vim.o.guicursor = saved
		saved = nil
	end
end

function M.attach(buf)
	if buffers[buf] then update(); return end
	buffers[buf] = true
	if not group then
		group = vim.api.nvim_create_augroup("PiListCursor", { clear = true })
		vim.api.nvim_create_autocmd({ "BufEnter", "WinEnter", "ModeChanged", "ColorScheme" }, { group = group, callback = update })
		vim.api.nvim_create_autocmd("CmdlineEnter", {
			group = group,
			callback = function()
				if saved then vim.o.guicursor = saved; saved = nil end
			end,
		})
		vim.api.nvim_create_autocmd("CmdlineLeave", { group = group, callback = function() vim.schedule(update) end })
	end
	vim.api.nvim_create_autocmd("BufWipeout", {
		group = group, buffer = buf, once = true,
		callback = function() buffers[buf] = nil; update() end,
	})
	update()
end

return M
