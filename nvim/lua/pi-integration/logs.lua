local floats = require("pi-integration.floats")
local M = {}
local entries, keyed = {}, {}
local log_buf, log_win, line_entries
local pending, scheduled
local max_entries = 1000

local function valid_win(win)
	return win and vim.api.nvim_win_is_valid(win)
end

local function level_name(level)
	if type(level) == "string" then return level end
	return level == vim.log.levels.ERROR and "error" or level == vim.log.levels.WARN and "warn" or "info"
end

local function lines_for(entry)
	local lines = { string.format("%s %-7s%s %s", entry.timestamp, entry.level:upper(),
		entry.session and (" [" .. entry.session .. "]") or "", entry.message) }
	local details = entry.details
	if details ~= nil and details ~= "" then
		if type(details) ~= "string" then details = vim.inspect(details) end
		for _, line in ipairs(vim.split(details, "\n", { plain = true })) do
			table.insert(lines, "  " .. line)
		end
	end
	return lines
end

function M.refresh()
	if not log_buf or not vim.api.nvim_buf_is_valid(log_buf) then return end
	local view, following, cursor_entry, top_entry, cursor_offset, top_offset
	local function anchor(row)
		local entry = line_entries and line_entries[row]
		local first = row
		while first > 1 and line_entries[first - 1] == entry do first = first - 1 end
		return entry, row - first
	end
	if valid_win(log_win) then
		view = vim.api.nvim_win_call(log_win, vim.fn.winsaveview)
		following = view.lnum == vim.api.nvim_buf_line_count(log_buf)
		cursor_entry, cursor_offset = anchor(view.lnum)
		top_entry, top_offset = anchor(view.topline)
	end
	local lines, first_lines = {}, {}
	line_entries = {}
	for _, entry in ipairs(entries) do
		first_lines[entry] = #lines + 1
		for _, line in ipairs(lines_for(entry)) do
			table.insert(lines, line)
			line_entries[#lines] = entry
		end
	end
	if #lines == 0 then lines = { "No Pi logs for this Neovim session." } end
	vim.bo[log_buf].modifiable = true
	vim.api.nvim_buf_set_lines(log_buf, 0, -1, false, lines)
	vim.bo[log_buf].modifiable = false
	if view and valid_win(log_win) then
		if following then
			vim.api.nvim_win_set_cursor(log_win, { #lines, 0 })
		else
			local function row_for(entry, offset, fallback)
				local first = first_lines[entry]
				if not first then return math.min(fallback, #lines) end
				local last = first
				while line_entries[last + 1] == entry do last = last + 1 end
				return math.min(first + offset, last)
			end
			view.lnum = row_for(cursor_entry, cursor_offset, view.lnum)
			view.topline = row_for(top_entry, top_offset, view.topline)
			vim.api.nvim_win_call(log_win, function() vim.fn.winrestview(view) end)
		end
	end
end

-- A key identifies one action or queue item. Receipts update its existing entry.
function M.get(key)
	return keyed[key]
end

function M.add(level, message, details, opts)
	opts = opts or {}
	local text = vim.split(tostring(message or ""), "\n", { plain = true })
	message = table.remove(text, 1)
	if #text > 0 then details = table.concat(text, "\n") .. (details and ("\n" .. tostring(details)) or "") end
	local entry = opts.key and keyed[opts.key]
	local changed = not entry or entry.message ~= message or entry.level ~= level_name(level) or not vim.deep_equal(entry.details, details)
	if not entry then
		entry = { key = opts.key, timestamp = os.date("%Y-%m-%d %H:%M:%S") }
		table.insert(entries, entry)
		if opts.key then keyed[opts.key] = entry end
	end
	entry.level, entry.message, entry.details = level_name(level), message, details
	entry.session, entry.inspect = opts.session or entry.session, opts.inspect or entry.inspect
	while #entries > max_entries do
		local removed = table.remove(entries, 1)
		if removed.key then keyed[removed.key] = nil end
	end
	if changed then M.refresh() end
	return entry, changed
end

function M.truncate(text, width)
	text = tostring(text):gsub("[%c]", " "):gsub("%s+", " ")
	width = math.max(0, width)
	if vim.fn.strdisplaywidth(text) <= width then return text end
	if width <= 3 then return string.rep(".", width) end
	local low, high = 0, vim.fn.strchars(text)
	while low < high do
		local middle = math.ceil((low + high) / 2)
		if vim.fn.strdisplaywidth(vim.fn.strcharpart(text, 0, middle)) <= width - 3 then low = middle else high = middle - 1 end
	end
	return vim.fn.strcharpart(text, 0, low) .. "..."
end

-- Coalesce bursts into the latest preview; every full message is already logged.
function M.display(message, level)
	pending = { message = message, level = level_name(level) }
	if scheduled then return end
	scheduled = true
	vim.schedule(function()
		scheduled = false
		local item = pending
		pending = nil
		local mode = vim.api.nvim_get_mode().mode
		if vim.fn.getcmdtype() ~= "" or mode:match("^[cr!]") or vim.o.cmdheight == 0 then return end
		vim.cmd("redraw")
		local width = math.max(0, math.min(vim.o.columns - 1, vim.v.echospace - 1))
		if width == 0 then return end
		local highlight = item.level == "error" and "ErrorMsg" or item.level == "warn" and "WarningMsg" or "None"
		vim.api.nvim_echo({ { M.truncate(item.message, width), highlight } }, false, {})
	end)
end

function M.notify(message, level, opts)
	local _, changed = M.add(level, message, nil, opts)
	if changed then M.display(message, level) end
end

local function open_float(buf, title, parent, footer)
	local width = math.max(1, math.min(math.floor(vim.o.columns * 0.85), vim.o.columns - 4))
	local height = math.max(1, math.min(math.floor(vim.o.lines * 0.8), vim.o.lines - 4))
	local win = vim.api.nvim_open_win(buf, true, {
		relative = "editor", width = width, height = height,
		row = math.max(0, math.floor((vim.o.lines - height) / 2)),
		col = math.max(0, math.floor((vim.o.columns - width) / 2)),
		style = "minimal", border = "rounded", title = " " .. title .. " ",
		footer = footer or " q close ",
	})
	vim.wo[win].wrap, vim.wo[win].linebreak = true, true
	local function close() floats.close_window(win) end
	floats.close_on_win_leave(buf, close, { win = win, parent = parent })
	for _, key in ipairs({ "q", "<Esc>" }) do
		vim.keymap.set("n", key, close, { buffer = buf, silent = true, desc = "Close Pi log" })
	end
	return win
end

function M.detail(contents, title)
	local parent = vim.api.nvim_get_current_win()
	local buf = vim.api.nvim_create_buf(false, true)
	vim.bo[buf].bufhidden = "wipe"
	vim.bo[buf].filetype = "markdown"
	vim.api.nvim_buf_set_lines(buf, 0, -1, false, vim.split(contents, "\n", { plain = true }))
	vim.bo[buf].modifiable = false
	return open_float(buf, title or "Pi log details", parent)
end

function M.show()
	if valid_win(log_win) then vim.api.nvim_set_current_win(log_win); return end
	if not log_buf or not vim.api.nvim_buf_is_valid(log_buf) then
		log_buf = vim.api.nvim_create_buf(false, true)
		vim.api.nvim_buf_set_name(log_buf, "pi://logs")
		vim.bo[log_buf].bufhidden, vim.bo[log_buf].filetype = "hide", "log"
		vim.bo[log_buf].modifiable = false
		vim.keymap.set("n", "<CR>", function()
			local entry = line_entries[vim.api.nvim_win_get_cursor(0)[1]]
			if not entry then return end
			if entry.inspect then entry.inspect() else M.detail(table.concat(lines_for(entry), "\n")) end
		end, { buffer = log_buf, desc = "Inspect Pi log entry" })
	end
	M.refresh()
	log_win = open_float(log_buf, "Pi logs", vim.api.nvim_get_current_win(), " Enter details | q close ")
	vim.api.nvim_win_set_cursor(log_win, { vim.api.nvim_buf_line_count(log_buf), 0 })
end

return M
