local floats = require("pi-integration.floats")

local M = {}

-- A question can open above a queued-message edit; only the newest editor owns focus.
local editor_windows = {}

-- A write records the saved text; closing completes the edit with that text,
-- or nil if nothing was written. Editing keys and write/quit commands remain native.
function M.open(opts, on_close)
	local buf = vim.api.nvim_create_buf(false, true)
	vim.api.nvim_buf_set_name(buf, opts.name or ("pi://markdown-editor/" .. buf))
	vim.bo[buf].buftype = "acwrite"
	vim.bo[buf].bufhidden = "wipe"
	vim.bo[buf].swapfile = false
	vim.bo[buf].filetype = "markdown"
	vim.api.nvim_buf_set_lines(buf, 0, -1, false, vim.split(opts.text or "", "\n", { plain = true }))
	vim.bo[buf].modified = false

	local width = math.max(1, math.min(opts.width or 80, vim.o.columns - 4))
	local height = math.max(1, math.min(opts.height or 8, vim.o.lines - 4))
	local win = vim.api.nvim_open_win(buf, true, {
		relative = "editor",
		width = width,
		height = height,
		row = math.max(0, math.floor((vim.o.lines - height) / 2)),
		col = math.max(0, math.floor((vim.o.columns - width) / 2)),
		style = "minimal",
		border = "rounded",
		title = opts.title,
		title_pos = opts.title_pos or "center",
		footer = opts.footer,
	})
	vim.wo[win].wrap = true
	table.insert(editor_windows, win)

	local saved_text
	vim.api.nvim_create_autocmd("BufWriteCmd", {
		buffer = buf,
		callback = function()
			local text = table.concat(vim.api.nvim_buf_get_lines(buf, 0, -1, false), "\n")
			if opts.prepare_text then
				text = opts.prepare_text(text)
			end
			if text ~= nil then
				saved_text = text
				vim.bo[buf].modified = false
			end
		end,
	})

	local closed = false
	local function finish()
		if closed then
			return
		end
		closed = true
		for index, editor_win in ipairs(editor_windows) do
			if editor_win == win then
				table.remove(editor_windows, index)
				break
			end
		end
		local text = saved_text
		vim.schedule(function()
			floats.close_window(win)
			if vim.api.nvim_buf_is_valid(buf) then
				vim.api.nvim_buf_delete(buf, { force = true })
			end
			local active_win = editor_windows[#editor_windows]
			if active_win and vim.api.nvim_win_is_valid(active_win) then
				vim.api.nvim_set_current_win(active_win)
			end
			on_close(text)
		end)
	end
	vim.api.nvim_create_autocmd("WinClosed", { pattern = tostring(win), once = true, callback = finish })
	vim.api.nvim_create_autocmd({ "BufHidden", "BufWipeout" }, { buffer = buf, once = true, callback = finish })
	vim.api.nvim_create_autocmd("WinLeave", {
		buffer = buf,
		desc = "Keep focus in the floating editor until it closes",
		callback = function()
			-- Wait for navigation or an intentional close to finish first.
			vim.schedule(function()
				if not closed and editor_windows[#editor_windows] == win
					and vim.api.nvim_win_is_valid(win) and vim.api.nvim_win_get_buf(win) == buf then
					vim.api.nvim_set_current_win(win)
				end
			end)
		end,
	})
	return buf, win
end

return M
