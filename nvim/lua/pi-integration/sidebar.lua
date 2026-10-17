local runtime = require("pi-integration.runtime")
local help = require("pi-integration.help")
local build_info = require("pi-integration.build-info")
local session_list = require("pi-integration.session-list")
local list_cursor = require("pi-integration.list-cursor")
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
	vim.wo[win].cursorlineopt = "line"
	list_cursor.attach(buf)
	vim.o.laststatus = 2
	vim.wo[win].fillchars = "stl: ,stlnc: "
	vim.wo[win].statusline = "%!v:lua.require('pi-integration.sidebar').render_statusline()"
	vim.o.showtabline = 0
	vim.o.cmdheight = 0
	vim.o.showmode = false
	vim.o.ruler = false
	local ns = vim.api.nvim_create_namespace("pi-sidebar")
	local list = session_list.new()
	local rows, starts = {}, {}
	local navigation = session_navigation.new(win)
	local updating = false
	local last_focused_at = 0
	local timer = vim.uv.new_timer()
	local closed = false
	local refreshing = false
	local function selected()
		return vim.api.nvim_win_is_valid(win) and rows[vim.api.nvim_win_get_cursor(win)[1]] or nil
	end
	local function notify(err)
		vim.notify(err or "Session operation failed", vim.log.levels.WARN, { title = "Pi sidebar" })
	end
	local function render(instances, err)
		if closed or not vim.api.nvim_win_is_valid(win) or not vim.api.nvim_buf_is_valid(buf) then
			return
		end
		local previous = selected()
		local view = vim.api.nvim_win_call(win, vim.fn.winsaveview)
		-- Follow a new focus event, not every refresh, so manual browsing sticks.
		local latest = instances and runtime.last_focused(instances) or nil
		local reveal = latest and latest.last_focused_at > last_focused_at and latest or nil
		local nodes, entries
		if instances then nodes, entries = list.build(instances, "", reveal) end
		if not nodes then
			vim.api.nvim_buf_set_extmark(buf, ns, 0, 0, {
				id = 1, virt_lines = { { { "  " .. truncate(entries or err, vim.api.nvim_win_get_width(win) - 4), "DiagnosticError" } } },
			})
			return
		end
		if reveal then last_focused_at = latest.last_focused_at end
		local waiting = 0
		for _, entry in ipairs(entries) do waiting = waiting + (entry.status == "Waiting" and 1 or 0) end
		local width = math.max(1, vim.api.nvim_win_get_width(win) - 2)
		local lines = { " 󰕮 · " .. #instances .. " open", "" }
		local highlights = { { row = 0, start = 0, finish = #lines[1], group = "Title" } }
		local function highlight(row, first, last, group)
			table.insert(highlights, { row = row - 1, start = first, finish = last, group = group })
		end
		if waiting > 0 then
			local prefix = lines[1] .. " · "
			lines[1] = prefix .. icons.get("Waiting").icon .. " " .. waiting
			highlight(1, #prefix, #lines[1], icons.highlight("Waiting"))
		end
		rows, starts = {}, {}
		local cursor, focused_row
		for _, node in ipairs(nodes) do
			if node.kind == "group" and #starts > 0 then table.insert(lines, "") end
			local row = #lines + 1
			if node.kind == "group" then
				table.insert(lines, truncate(session_list.group_label(node, true), width))
				highlight(row, 0, #lines[row], "Title")
				if node.collapsed and #node.entries > 0 then
					local summary = "   "
					for _, part in ipairs(session_list.group_summary(node)) do
						local separator = summary == "   " and "" or " · "
						if vim.fn.strdisplaywidth(summary .. separator .. part) > width then
							table.insert(lines, summary)
							highlight(#lines, 0, #summary, "Comment")
							summary, separator = "   ", ""
						end
						summary = summary .. separator .. part
					end
					table.insert(lines, summary)
					highlight(#lines, 0, #summary, "Comment")
				end
			elseif node.kind == "subagent" then
				table.insert(lines, truncate(session_list.subagent_label(node), width))
				highlight(row, 0, #lines[row], "Comment")
			else
				local entry = node.entry
				local icon = icons.get(entry.status).icon
				local prefix = " " .. session_list.session_prefix(node) .. icon .. " "
				highlight(row, 1 + #session_list.session_prefix(node), #prefix - 1, icons.highlight(entry.status))
				if build_info.is_dev(entry) then
					highlight(row, #prefix, #prefix + 3, "PiBuildDev")
					prefix = prefix .. "DEV "
				end
				table.insert(lines, prefix .. truncate(entry.title, width - vim.fn.strdisplaywidth(prefix)))
				local project = text(entry.project)
				if project == "" then project = text(entry.directory) ~= "" and entry.directory or entry.cwd end
				local detail = vim.fn.fnamemodify(text(project), ":t")
				if text(entry.activity) ~= "" then detail = detail .. " · " .. text(entry.activity) end
				local suffix = session_list.session_suffix(node)
				-- Reserve space for the running count even when activity is long.
				table.insert(lines, "     " .. truncate(detail, width - 5 - vim.fn.strdisplaywidth(suffix)) .. suffix)
				highlight(row + 1, 0, #lines[row + 1], "Comment")
				if reveal and entry.id == reveal.id then focused_row = row end
			end
			if node.kind ~= "subagent" then
				rows[row] = node
				table.insert(starts, row)
				if session_list.same(previous, node) then cursor = row end
			end
		end
		cursor = focused_row or cursor
		if #starts == 0 then table.insert(lines, " No open or pinned sessions.") end
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
		view.lnum, view.col = cursor, 0
		vim.api.nvim_win_call(win, function()
			vim.fn.winrestview(view)
		end)
		navigation.set_rows(starts)
		updating = false
	end
	local function refresh()
		if closed or refreshing or not vim.api.nvim_buf_is_valid(buf) or not vim.api.nvim_win_is_valid(win) then return end
		refreshing = true
		runtime.list_async(function(instances, err)
			refreshing = false
			render(instances, err)
		end)
	end
	local mapping_specs, help_state = {}, {}
	local function map(key, action, description)
		table.insert(mapping_specs, { key, buffer = buf, desc = description })
		vim.keymap.set("n", key, action, { buffer = buf, silent = true, desc = description, nowait = key == "g" })
	end
	local function tmux_action(action)
		vim.system({ "bash", config.launcher, "tmux", action, vim.env.TMUX_PANE }, { text = true }, vim.schedule_wrap(function(result)
			if result.code ~= 0 then
				notify(vim.trim(result.stderr or "tmux operation failed"))
			end
		end))
	end
	list.bind(map, selected, navigation, config, function(result, err)
		if not result then notify(err) end
		refresh()
	end, refresh)
	map("o", function() tmux_action("overview") end, "Open full overview")
	map("q", function() tmux_action("sidebar") end, "Close sidebar")
	map("r", refresh, "Refresh summary")
	map("<leader>?", function()
		local lines = { "# 󰕮 Sidebar", "", "## Keys", "" }
		for _, spec in ipairs(mapping_specs) do
			table.insert(lines, "- `" .. spec[1] .. "` " .. spec.desc .. ".")
		end
		help.toggle_window(help_state, { name = "pi://sidebar-help", title = "󰕮 Help", lines = lines })
	end, "Pi sidebar help")
	require("which-key").add(mapping_specs)
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
