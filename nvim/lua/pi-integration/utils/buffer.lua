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
		if value and vim.bo[buf].readonly then
			vim.b[buf].pi_restore_readonly = true
			vim.bo[buf].readonly = false
		end
		vim.api.nvim_set_option_value("modifiable", value, { buf = buf })
		if not value and vim.b[buf].pi_restore_readonly then
			vim.bo[buf].readonly = true
			vim.b[buf].pi_restore_readonly = nil
		end
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

local function continuation_byte(byte)
	return byte and byte >= 0x80 and byte < 0xC0
end

local function common_prefix(left, right)
	local length = 0
	while length < math.min(#left, #right) and left:byte(length + 1) == right:byte(length + 1) do
		length = length + 1
	end
	-- Bytewise matches can end inside a UTF-8 character.
	while length > 0 and continuation_byte(left:byte(length + 1)) do
		length = length - 1
	end
	return length
end

local function common_suffix(left, right, limit)
	local length = 0
	while length < limit and left:byte(#left - length) == right:byte(#right - length) do
		length = length + 1
	end
	while length > 0 and continuation_byte(left:byte(#left - length + 1)) do
		length = length - 1
	end
	return length
end

local function replace_text(buf, current, start, count, replacement)
	local first, last = current[start], current[start + count - 1]
	local prefix = common_prefix(first, replacement[1])
	local suffix_limit = math.min(
		#last - (count == 1 and prefix or 0),
		#replacement[#replacement] - (#replacement == 1 and prefix or 0)
	)
	local suffix = common_suffix(last, replacement[#replacement], suffix_limit)
	replacement[#replacement] = replacement[#replacement]:sub(1, #replacement[#replacement] - suffix)
	replacement[1] = replacement[1]:sub(prefix + 1)
	vim.api.nvim_buf_set_text(buf, start - 1, prefix, start + count - 2, #last - suffix, replacement)
end

-- Snapshot renders must leave unchanged lines and their decorations intact.
function M.update_lines(buf, lines)
	if not M.valid(buf) then
		return
	end
	if #lines == 0 then
		lines = { "" }
	end
	local current = vim.api.nvim_buf_get_lines(buf, 0, -1, false)
	local hunks = vim.diff(table.concat(current, "\n") .. "\n", table.concat(lines, "\n") .. "\n", {
		result_type = "indices",
	})
	if #hunks == 0 then
		return
	end

	local modifiable = vim.bo[buf].modifiable
	M.set_modifiable(buf, true)
	-- Apply from the bottom so all hunk coordinates still refer to current.
	for index = #hunks, 1, -1 do
		local old_start, old_count, new_start, new_count = unpack(hunks[index])
		local replacement = new_count > 0 and vim.list_slice(lines, new_start, new_start + new_count - 1) or {}
		if old_count == 0 or new_count == 0 then
			local row = old_count == 0 and old_start or old_start - 1
			vim.api.nvim_buf_set_lines(buf, row, row + old_count, false, replacement)
		elseif old_count == new_count then
			-- Adjacent changed rows can still keep their own prefixes/suffixes.
			for offset = old_count - 1, 0, -1 do
				replace_text(buf, current, old_start + offset, 1, { replacement[offset + 1] })
			end
		else
			replace_text(buf, current, old_start, old_count, replacement)
		end
	end
	M.set_modifiable(buf, modifiable)
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
