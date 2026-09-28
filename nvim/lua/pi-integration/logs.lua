local M = {}

local DEFAULT_MAX_ENTRIES = 1000

local function valid_win(win)
	return win and vim.api.nvim_win_is_valid(win)
end

local function timestamp()
	return os.date("%Y-%m-%d %H:%M:%S")
end

local function session_label(state)
	if not state.session_file or state.session_file == "" then
		return nil
	end
	return vim.fn.fnamemodify(state.session_file, ":t")
end

local function format_entry(entry)
	local level = tostring(entry.level or "info"):upper()
	local session = entry.session and (" [" .. entry.session .. "]") or ""
	local lines = { string.format("%s %-7s%s %s", entry.timestamp or "", level, session, tostring(entry.message or "")) }
	if type(entry.details) == "string" and entry.details ~= "" then
		for _, line in ipairs(vim.split(entry.details, "\n", { plain = true })) do
			table.insert(lines, "  " .. line)
		end
	elseif entry.details ~= nil then
		for _, line in ipairs(vim.split(vim.inspect(entry.details), "\n", { plain = true })) do
			table.insert(lines, "  " .. line)
		end
	end
	return lines
end

local function log_lines(state)
	if #state.logs == 0 then
		return { "No Pi logs for this Neovim session." }
	end
	local lines = {}
	for _, entry in ipairs(state.logs) do
		vim.list_extend(lines, format_entry(entry))
	end
	return lines
end

local function ensure_buffer(ctx)
	local state = ctx.state
	if ctx.buffer.valid(state.logs_buf) then
		return state.logs_buf
	end
	local buf = vim.api.nvim_create_buf(false, true)
	state.logs_buf = buf
	vim.api.nvim_buf_set_name(buf, "pi://logs")
	vim.api.nvim_set_option_value("buftype", "nofile", { buf = buf })
	vim.api.nvim_set_option_value("bufhidden", "hide", { buf = buf })
	vim.api.nvim_set_option_value("swapfile", false, { buf = buf })
	vim.api.nvim_set_option_value("filetype", "log", { buf = buf })
	vim.api.nvim_set_option_value("modifiable", false, { buf = buf })
	return buf
end

function M.refresh(ctx)
	local state = ctx.state
	if not ctx.buffer.valid(state.logs_buf) then
		return
	end
	ctx.buffer.set_modifiable(state.logs_buf, true)
	vim.api.nvim_buf_set_lines(state.logs_buf, 0, -1, false, log_lines(state))
	ctx.buffer.set_modifiable(state.logs_buf, false)
	if valid_win(state.logs_win) then
		pcall(vim.api.nvim_win_set_cursor, state.logs_win, { vim.api.nvim_buf_line_count(state.logs_buf), 0 })
	end
end

function M.add(ctx, level, message, details)
	local state = ctx.state
	local max_entries = tonumber(ctx.config.log_max_entries) or DEFAULT_MAX_ENTRIES
	local text = tostring(message or "")
	if text == "" and details == nil then
		return
	end
	table.insert(state.logs, {
		timestamp = timestamp(),
		level = level or "info",
		message = text,
		details = details,
		session = session_label(state),
	})
	while #state.logs > max_entries do
		table.remove(state.logs, 1)
	end
	M.refresh(ctx)
end

function M.show(ctx)
	local state = ctx.state
	local buf = ensure_buffer(ctx)
	M.refresh(ctx)
	if valid_win(state.logs_win) then
		vim.api.nvim_set_current_win(state.logs_win)
	else
		vim.cmd("botright 12split")
		state.logs_win = vim.api.nvim_get_current_win()
		vim.api.nvim_win_set_buf(state.logs_win, buf)
	end
	vim.api.nvim_win_set_buf(state.logs_win, buf)
	vim.api.nvim_set_option_value("statusline", "%#PiInputTitle# Pi logs %#PiPaneBorder#%=", { win = state.logs_win })
	vim.api.nvim_set_option_value("signcolumn", "yes:1", { win = state.logs_win })
	pcall(vim.api.nvim_win_set_cursor, state.logs_win, { vim.api.nvim_buf_line_count(buf), 0 })
end

return M
