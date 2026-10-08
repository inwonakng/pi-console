local M = {}

function M.valid(buf)
	return buf and vim.api.nvim_buf_is_valid(buf)
end

function M.window_matches(win, buf)
	return M.valid(buf) and win ~= nil and vim.api.nvim_win_is_valid(win)
		and vim.api.nvim_win_get_buf(win) == buf
end

-- Window IDs are hints: prefer an existing current-tab view when recovering a
-- stale handle. Never change focus or open a window just to find a buffer.
function M.find_window(buf, hint)
	if not M.valid(buf) then
		return nil
	end
	if M.window_matches(hint, buf) then
		return hint
	end
	local current = vim.api.nvim_get_current_win()
	if M.window_matches(current, buf) then
		return current
	end
	for _, win in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
		if M.window_matches(win, buf) then
			return win
		end
	end
	for _, win in ipairs(vim.api.nvim_list_wins()) do
		if M.window_matches(win, buf) then
			return win
		end
	end
	return nil
end

function M.set_modifiable(buf, value)
	if M.valid(buf) then
		vim.api.nvim_set_option_value("modifiable", value, { buf = buf })
	end
end

function M.create_scratch(opts)
	opts = opts or {}
	local buf = vim.api.nvim_create_buf(false, true)
	if opts.name and opts.name ~= "" then
		vim.api.nvim_buf_set_name(buf, opts.name)
	end
	vim.api.nvim_set_option_value("buftype", "nofile", { buf = buf })
	vim.api.nvim_set_option_value("bufhidden", opts.bufhidden or "wipe", { buf = buf })
	vim.api.nvim_set_option_value("swapfile", false, { buf = buf })
	vim.api.nvim_set_option_value("filetype", opts.filetype or "text", { buf = buf })
	if opts.lines then
		vim.api.nvim_buf_set_lines(buf, 0, -1, false, opts.lines)
	end
	vim.api.nvim_set_option_value("modifiable", opts.modifiable == true, { buf = buf })
	if opts.treesitter then
		pcall(vim.treesitter.start, buf, opts.treesitter)
	end
	return buf
end

function M.set_lines(buf, lines, modifiable)
	if not M.valid(buf) then
		return
	end
	M.set_modifiable(buf, true)
	vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines or {})
	M.set_modifiable(buf, modifiable == true)
end

return M
