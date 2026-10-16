local runtime = require("pi-integration.runtime")
local build_info = require("pi-integration.build-info")
local pins = require("pi-integration.session-pins")
local icons = require("pi-integration.status-icons")
local session_navigation = require("pi-integration.session-navigation")
local M = {}

local function text(value)
	return type(value) == "string" and value:gsub("[%c]", " ") or ""
end

local function truncate(value, width)
	value = text(value)
	if vim.fn.strdisplaywidth(value) <= width then
		return value
	end
	while vim.fn.strdisplaywidth(value) > math.max(0, width - 1) do
		value = vim.fn.strcharpart(value, 0, vim.fn.strchars(value) - 1)
	end
	return width > 0 and (value .. "…") or ""
end

function M.render_statusline()
	local win = vim.g.statusline_winid or vim.api.nvim_get_current_win()
	return build_info.statusline(vim.api.nvim_win_get_width(win))
end

function M.open(config)
	-- This is only a viewer: do not publish a conversation or register it as
	-- the persistent overview used by the session launcher.
	local buf = vim.api.nvim_create_buf(false, true)
	local win = vim.api.nvim_get_current_win()
	vim.api.nvim_buf_set_name(buf, "pi://sidebar")
	vim.bo[buf].filetype = "pi-sidebar"
	vim.bo[buf].bufhidden = "wipe"
	vim.api.nvim_win_set_buf(win, buf)
	for option, value in pairs({ number = false, relativenumber = false, signcolumn = "no", wrap = false, spell = false, cursorline = true }) do
		vim.api.nvim_set_option_value(option, value, { win = win })
	end
	vim.o.laststatus = 2
	vim.wo[win].fillchars = "stl: ,stlnc: "
	vim.wo[win].statusline = "%!v:lua.require('pi-integration.sidebar').render_statusline()"
	vim.o.showtabline = 0
	vim.o.cmdheight = 0
	vim.o.showmode = false
	vim.o.ruler = false
	local ns = vim.api.nvim_create_namespace("pi-sidebar")
	local rows, starts = {}, {}
	local navigation = session_navigation.new(win)
	local updating = false
	local last_focused_at = 0
	local timer = vim.uv.new_timer()
	local closed = false
	local function selected()
		return vim.api.nvim_win_is_valid(win) and rows[vim.api.nvim_win_get_cursor(win)[1]] or nil
	end
	local function notify(err)
		vim.notify(err or "Session operation failed", vim.log.levels.WARN, { title = "Pi sidebar" })
	end
	local function refresh()
		if closed or not vim.api.nvim_win_is_valid(win) or not vim.api.nvim_buf_is_valid(buf) then
			return
		end
		local previous = selected()
		local view = vim.api.nvim_win_call(win, vim.fn.winsaveview)
		local instances, err = runtime.list()
		local entries
		if instances then
			entries, err = pins.merge(instances)
		end
		if not entries then
			-- Keep the last successful list while showing the refresh failure.
			vim.api.nvim_buf_set_extmark(buf, ns, 0, 0, {
				id = 1, virt_lines = { { { "  " .. truncate(err, vim.api.nvim_win_get_width(win) - 4), "DiagnosticError" } } },
			})
			return
		end
		-- Follow a new focus event, not every refresh, so manual browsing sticks.
		local latest = runtime.last_focused(instances)
		if latest and latest.last_focused_at > last_focused_at then
			previous = latest
			-- Keep the newest observed time even if that conversation closes.
			last_focused_at = latest.last_focused_at
		end
		local pinned, regular, waiting = {}, {}, 0
		for _, entry in ipairs(entries) do
			table.insert(entry.pinned and pinned or regular, entry)
			waiting = waiting + (entry.status == "Waiting" and 1 or 0)
		end
		local width = math.max(1, vim.api.nvim_win_get_width(win) - 2)
		local lines = { " 󰕮 · " .. #instances .. " open", "" }
		local highlights = { { row = 0, start = 0, finish = #lines[1], group = "Title" } }
		if waiting > 0 then
			local prefix = lines[1] .. " · "
			lines[1] = prefix .. icons.get("Waiting").icon .. " " .. waiting
			table.insert(highlights, { row = 0, start = #prefix, finish = #lines[1], group = icons.highlight("Waiting") })
		end
		rows, starts = {}, {}
		local cursor
		for _, section in ipairs({ { label = " Pinned", entries = pinned }, { label = "Sessions", entries = regular } }) do
			if #section.entries > 0 then
				table.insert(lines, " " .. section.label)
				table.insert(highlights, { row = #lines - 1, start = 0, finish = #lines[#lines], group = "Title" })
				for _, entry in ipairs(section.entries) do
					local row = #lines + 1
					local icon = icons.get(entry.status).icon
					local prefix = " " .. icon .. " "
					if build_info.is_dev(entry) then
						table.insert(highlights, { row = row - 1, start = #prefix, finish = #prefix + 3, group = "PiBuildDev" })
						prefix = prefix .. "DEV "
					end
					local title = truncate(entry.title, width - vim.fn.strdisplaywidth(prefix))
					table.insert(lines, prefix .. title)
					table.insert(highlights, { row = row - 1, start = 1, finish = 1 + #icon, group = icons.highlight(entry.status) })
					local project = text(entry.project)
					if project == "" then
						project = text(entry.directory) ~= "" and entry.directory or entry.cwd
					end
					local detail = vim.fn.fnamemodify(text(project), ":t")
					if text(entry.activity) ~= "" then
						detail = detail .. " · " .. text(entry.activity)
					end
					if (tonumber(entry.subagents) or 0) > 0 then
						detail = detail .. " ·  " .. entry.subagents
					end
					table.insert(lines, "   " .. truncate(detail, width - 3))
					table.insert(highlights, { row = row, start = 0, finish = #lines[#lines], group = "Comment" })
					rows[row], rows[row + 1] = entry, entry
					table.insert(starts, row)
					if previous and (previous.id == entry.id or previous.path and previous.path == entry.path) then
						cursor = row
					end
				end
				table.insert(lines, "")
			end
		end
		if #starts == 0 then
			table.insert(lines, " No open or pinned sessions.")
		end
		if not cursor then
			cursor = starts[1] or 1
			for _, row in ipairs(starts) do
				if math.abs(row - view.lnum) < math.abs(cursor - view.lnum) then
					cursor = row
				end
			end
		end
		updating = true
		vim.bo[buf].modifiable = true
		if not vim.deep_equal(vim.api.nvim_buf_get_lines(buf, 0, -1, false), lines) then
			vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
		end
		vim.bo[buf].modifiable = false
		vim.api.nvim_buf_clear_namespace(buf, ns, 0, -1)
		for _, hl in ipairs(highlights) do
			vim.api.nvim_buf_set_extmark(buf, ns, hl.row, hl.start, { end_col = hl.finish, hl_group = hl.group })
		end
		-- Keep the viewport stable unless the selected session moves out of view.
		local height = vim.api.nvim_win_get_height(win)
		if cursor < view.topline then
			view.topline = cursor
		elseif cursor >= view.topline + height then
			view.topline = cursor - height + 1
		end
		view.lnum = cursor
		vim.api.nvim_win_call(win, function()
			vim.fn.winrestview(view)
		end)
		navigation.set_rows(starts)
		updating = false
	end
	local function map(key, action, description)
		vim.keymap.set("n", key, action, { buffer = buf, silent = true, desc = description })
	end
	local function tmux_action(action)
		vim.system({ "bash", config.launcher, "tmux", action, vim.env.TMUX_PANE }, { text = true }, vim.schedule_wrap(function(result)
			if result.code ~= 0 then
				notify(vim.trim(result.stderr or "tmux operation failed"))
			end
		end))
	end
	map("j", function() navigation.move(vim.v.count1) end, "Next session")
	map("k", function() navigation.move(-vim.v.count1) end, "Previous session")
	map("<Down>", function() navigation.move(vim.v.count1) end, "Next session")
	map("<Up>", function() navigation.move(-vim.v.count1) end, "Previous session")
	map("<CR>", function()
		local entry = selected()
		if not entry then return end
		local ok, err
		if entry.status == "Not Open" then
			ok, err = runtime.launch(config.launcher, entry.cwd, entry.path)
		else
			ok, err = runtime.focus(entry.id)
		end
		if not ok then notify(err) end
	end, "Focus or reopen session")
	map("o", function() tmux_action("overview") end, "Open full overview")
	map("q", function() tmux_action("sidebar") end, "Close sidebar")
	map("r", refresh, "Refresh summary")
	local function stop()
		if not closed then
			closed = true
			timer:stop()
			timer:close()
		end
	end
	vim.api.nvim_create_autocmd("CursorMoved", {
		buffer = buf,
		callback = function()
			if not updating then
				navigation.snap()
			end
		end,
	})
	vim.api.nvim_create_autocmd("BufWipeout", { buffer = buf, once = true, callback = stop })
	vim.api.nvim_create_autocmd("VimLeavePre", { once = true, callback = stop })
	vim.api.nvim_create_autocmd({ "VimResized", "ColorScheme" }, { callback = refresh })
	refresh()
	timer:start(icons.animation_interval_ms, icons.animation_interval_ms, vim.schedule_wrap(refresh))
end

return M
