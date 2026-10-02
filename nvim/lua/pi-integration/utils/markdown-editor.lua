local floats = require("pi-integration.floats")

local M = {}

-- A write records the saved text; closing completes the edit with that text,
-- or nil if nothing was written. Native Vim keys and commands are unchanged.
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
	})
	vim.wo[win].wrap = true

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
		local text = saved_text
		vim.schedule(function()
			floats.close_window(win)
			if vim.api.nvim_buf_is_valid(buf) then
				vim.api.nvim_buf_delete(buf, { force = true })
			end
			on_close(text)
		end)
	end
	vim.api.nvim_create_autocmd("WinClosed", { pattern = tostring(win), once = true, callback = finish })
	vim.api.nvim_create_autocmd({ "BufHidden", "BufWipeout" }, { buffer = buf, once = true, callback = finish })
	-- Keep the editor open when focus moves to the transcript or an approval.
	return buf, win
end

return M
