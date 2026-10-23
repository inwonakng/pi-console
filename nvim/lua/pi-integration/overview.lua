local help = require("pi-integration.help")
local runtime = require("pi-integration.runtime")
local session_list = require("pi-integration.session-list")
local list_cursor = require("pi-integration.list-cursor")
local icons = require("pi-integration.status-icons")
local statusline = require("pi-integration.statusline")
local build_info = require("pi-integration.build-info")
local session_navigation = require("pi-integration.session-navigation")
local M = {}
local ns = vim.api.nvim_create_namespace("pi-overview")

local function text(value)
	return type(value) == "string" and value:gsub("[%c]", " ") or ""
end

local function column(value, width)
	value = text(value)
	if vim.fn.strdisplaywidth(value) > width then
		while vim.fn.strdisplaywidth(value) > width - 1 do
			value = vim.fn.strcharpart(value, 0, vim.fn.strchars(value) - 1)
		end
		value = value .. "…"
	end
	return value .. string.rep(" ", math.max(0, width - vim.fn.strdisplaywidth(value)))
end

local function project(entry)
	if type(entry.project) == "string" and entry.project ~= "" then
		return entry.project
	end
	return type(entry.directory) == "string" and entry.directory ~= "" and entry.directory or entry.cwd
end

local function workspace_hash(entry)
	local id = type(entry.workspace_id) == "string" and entry.workspace_id or ""
	return id:match("([%x]+)$") or "—"
end

local indicator_widths = { 1, 2, 1 }

local function indicator_columns(entry)
	local cells = {}
	local spans = {}
	local byte_offset = 0
	for index, indicator in ipairs(statusline.status_indicators(entry)) do
		if index > 1 then
			table.insert(cells, " ")
			byte_offset = byte_offset + 1
		end
		local icon = text(indicator.text)
		local cell = column(icon, indicator_widths[index])
		table.insert(cells, cell)
		if icon ~= "" then
			table.insert(spans, {
				start_col = byte_offset,
				end_col = byte_offset + #icon,
				highlight = indicator.highlight,
			})
		end
		byte_offset = byte_offset + #cell
	end
	return table.concat(cells), spans
end

local blank_indicators = column("", indicator_widths[1])
	.. " " .. column("", indicator_widths[2])
	.. " " .. column("", indicator_widths[3])

local function set_lines(buf, lines)
	if not vim.deep_equal(vim.api.nvim_buf_get_lines(buf, 0, -1, false), lines) then
		vim.bo[buf].modifiable = true
		vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
		vim.bo[buf].modifiable = false
	end
end

local function scratch(name)
	local buf = vim.api.nvim_create_buf(false, true)
	vim.api.nvim_buf_set_name(buf, name)
	vim.bo[buf].bufhidden = "hide"
	vim.bo[buf].filetype = "pi-overview"
	vim.bo[buf].modifiable = false
	return buf
end

function M.render_statusline()
	local win = vim.g.statusline_winid or vim.api.nvim_get_current_win()
	return build_info.statusline(vim.api.nvim_win_get_width(win), {
		" 󰕮", "Enter open", "Tab expand", "J/K move", "g group", "p pin", "dd kill/delete", "/ filter", "<leader>? keys",
	})
end

local function window_options(win, statusline)
	for name, value in pairs({ number = false, relativenumber = false, signcolumn = "no", wrap = false, spell = false, fillchars = "stl:─,stlnc:─", statusline = statusline }) do
		vim.api.nvim_set_option_value(name, value, { win = win })
	end
end

function M.open(config)
	local registered, registration_error = runtime.start_overview()
	if not registered then
		vim.notify(registration_error, vim.log.levels.WARN, { title = "Pi overview" })
	end
	local list_buf = scratch("pi://overview")
	local list_win = vim.api.nvim_get_current_win()
	vim.api.nvim_win_set_buf(list_win, list_buf)
	window_options(list_win, "%!v:lua.require('pi-integration.overview').render_statusline()")
	vim.wo[list_win].cursorline = true
	vim.wo[list_win].cursorlineopt = "line"
	vim.cmd("botright 9split")
	local detail_win = vim.api.nvim_get_current_win()
	local detail_buf = scratch("pi://overview-details")
	vim.api.nvim_win_set_buf(detail_win, detail_buf)
	window_options(detail_win, "%#PiOverviewStatusLine# Selected conversation %#PiPaneBorder#%=")
	vim.wo[detail_win].cursorline = false
	vim.wo[detail_win].wrap = true
	vim.wo[detail_win].winfixheight = true
	vim.api.nvim_set_current_win(list_win)
	list_cursor.attach(list_buf)
	list_cursor.attach(detail_buf)

	local list = session_list.new()
	local rows = {}
	local navigation = session_navigation.new(list_win)
	local query = ""
	local updating = false
	local closed = false
	local refreshing = false
	local select_last_focused = true
	local focus_autocmd
	local timer = vim.uv.new_timer()
	local function selected()
		if vim.api.nvim_win_is_valid(list_win) then
			return rows[vim.api.nvim_win_get_cursor(list_win)[1]]
		end
	end
	local function details()
		if not vim.api.nvim_buf_is_valid(detail_buf) then
			return
		end
		local node = selected()
		local entry = node and node.kind == "session" and node.entry or nil
		local lines = { "", " Select a conversation to see its details." }
		if node and node.kind == "group" then
			lines = { " " .. node.name, "", " Sessions:  " .. #node.entries .. " visible · " .. node.count .. " remembered", " Tab: expand/collapse · J/K: move group · g: create group", " dd: delete group, keeping its sessions in Ungrouped" }
		end
		if entry then
			local waiting = type(entry.waiting) == "table" and entry.waiting or nil
			local activity = not waiting and entry.activity and entry.activity ~= "" and (" · " .. text(entry.activity)) or ""
			lines = {
				" " .. (entry.pinned and " " or "") .. text(entry.title),
				"",
				" Status:    " .. text(entry.status) .. activity,
			}
			if type(entry.build) == "table" and (entry.build.channel == "dev" or entry.build.channel == "stable") then
				table.insert(lines, " Build:     " .. build_info.detail_text(entry.build))
			elseif entry.channel == "dev" or entry.channel == "stable" then
				table.insert(lines, " Build:     " .. (entry.channel == "dev" and "DEV" or "stable"))
			end
			if waiting then
				table.insert(lines, " Request:   " .. (text(waiting.label) ~= "" and text(waiting.label) or "Input requested"))
				table.insert(lines, " Question:  " .. (text(waiting.question) ~= "" and text(waiting.question) or "Pi needs input."))
				if text(waiting.context) ~= "" then
					table.insert(lines, " Context:   " .. text(waiting.context))
				end
			end
			table.insert(lines, " Project:   " .. text(project(entry)))
			table.insert(lines, " Workspace: " .. workspace_hash(entry))
			if workspace_hash(entry) ~= "—" then
				table.insert(lines, " Working:   " .. text(entry.cwd))
			end
			if entry.host_id then
				table.insert(lines, " Host:      " .. text(entry.host_name) .. " [" .. entry.host_id .. "]")
				table.insert(lines, " Control:   " .. (type(entry.controller) == "table" and text(entry.controller.label) or "Unclaimed"))
			end
			table.insert(lines, " Location:  " .. text(entry.location))
			table.insert(lines, " Model:     " .. (text(entry.model) ~= "" and text(entry.model) or "—"))
			table.insert(lines, " Subagents: " .. tostring(tonumber(entry.subagents) or 0))
			table.insert(lines, " Session:   " .. (text(entry.path) ~= "" and text(entry.path) or "Not saved yet"))
		end
		set_lines(detail_buf, lines)
		vim.api.nvim_buf_clear_namespace(detail_buf, ns, 0, -1)
		if entry then
			local title_group = entry.is_new_session and "PiOverviewNewSession" or "PiOverviewDetailTitle"
			vim.api.nvim_buf_set_extmark(detail_buf, ns, 0, 1, { end_col = #lines[1], hl_group = title_group })
			for row = 3, #lines do
				local _, value_start = lines[row]:find(":%s*")
				if value_start then
					vim.api.nvim_buf_set_extmark(detail_buf, ns, row - 1, value_start, { end_col = #lines[row], hl_group = "PiOverviewValue" })
				end
			end
		end
	end
	local function render(instances, err)
		if closed or not vim.api.nvim_buf_is_valid(list_buf) or not vim.api.nvim_win_is_valid(list_win) then
			return
		end
		local previous = selected()
		local view = vim.api.nvim_win_call(list_win, vim.fn.winsaveview)
		local focus_target = select_last_focused and runtime.last_focused(instances or {}) or nil
		local nodes, entries
		if instances then nodes, entries = list.build(instances, query, focus_target) end
		-- Keep the last successful list on backend or persistence failures.
		if not nodes then
			set_lines(detail_buf, { " Could not refresh sessions:", " " .. text(entries or err) })
			return
		end
		select_last_focused = false
		rows = {}
		local starts, highlights = {}, {}
		local pinned_count = 0
		for _, entry in ipairs(entries) do
			if entry.pinned then pinned_count = pinned_count + 1 end
		end
		local lines = {
			" Pi sessions · " .. #instances .. " open · " .. pinned_count .. " pinned",
			query == "" and "" or (" Filter: " .. query),
			"",
			"     " .. column("Status", 13) .. "  " .. blank_indicators .. "  " .. column("Project", 20) .. "  " .. column("Workspace", 10) .. ("  " .. column("Host", 18)) .. "  Title",
		}
		local function highlight(row, first, last, group)
			table.insert(highlights, { row = row - 1, first = first, last = last, group = group })
		end
		highlight(1, 0, #lines[1], "Title")
		local cursor, nearest_row, focused_row
		for _, node in ipairs(nodes) do
			if node.kind == "group" and #starts > 0 then table.insert(lines, "") end
			local row = #lines + 1
			if node.kind == "group" then
				table.insert(lines, session_list.group_label(node))
				highlight(row, 0, #lines[row], "Title")
			elseif node.kind == "subagent" then
				table.insert(lines, session_list.subagent_label(node))
				highlight(row, 0, #lines[row], "PiSubagent")
			else
				local entry = node.entry
				local name = vim.fn.fnamemodify(project(entry), ":t")
				local indicators, spans = indicator_columns(entry)
				local prefix = " " .. session_list.session_prefix(node)
				local indicator_start = #prefix + #column(entry.status, 13) + 2
				local row_prefix = prefix .. column(entry.status, 13) .. "  " .. indicators .. "  " .. column(name, 20) .. "  " .. column(workspace_hash(entry), 10) .. (entry.host_id and "  " .. column(entry.host_name .. " [" .. entry.host_id:sub(1, 8) .. "]", 18) or "") .. "  "
				local badge = build_info.is_dev(entry) and "DEV " or ""
				local suffix = session_list.session_suffix(node)
				local title = badge .. text(entry.title) .. suffix
				table.insert(lines, row_prefix .. title)
				highlight(row, #prefix, #prefix + #text(entry.status), icons.highlight(entry.status))
				for _, span in ipairs(spans) do
					highlight(row, indicator_start + span.start_col, indicator_start + span.end_col, span.highlight)
				end
				if badge ~= "" then highlight(row, #row_prefix, #row_prefix + 3, "PiBuildDev") end
				highlight(row, #row_prefix + #badge, #lines[row] - #suffix, entry.is_new_session and "PiOverviewNewSession" or "PiOverviewTitle")
				if suffix ~= "" then highlight(row, #lines[row] - #suffix, #lines[row], "PiSubagent") end
				if focus_target and entry.id == focus_target.id then focused_row = row end
			end
			if node.kind ~= "subagent" then
				rows[row] = node
				table.insert(starts, row)
				if not nearest_row or math.abs(row - view.lnum) < math.abs(nearest_row - view.lnum) then nearest_row = row end
				if session_list.same(previous, node) then cursor = row end
			end
		end
		cursor = focused_row or cursor
		if #starts == 0 then
			table.insert(lines, runtime.available() and " No matching conversations. Press <leader>pn to start one." or " No supported session backend available.")
		end
		cursor = cursor or nearest_row or math.max(1, math.min(view.lnum, #lines))
		updating = true
		set_lines(list_buf, lines)
		vim.api.nvim_buf_clear_namespace(list_buf, ns, 0, -1)
		for _, hl in ipairs(highlights) do
			vim.api.nvim_buf_set_extmark(list_buf, ns, hl.row, hl.first, { end_col = hl.last, hl_group = hl.group })
		end
		-- Preserve ordinary scrolling; only reveal selection if its row moved.
		local height = vim.api.nvim_win_get_height(list_win)
		if cursor < view.topline then
			view.topline = cursor
		elseif cursor >= view.topline + height then
			view.topline = cursor - height + 1
		end
		view.lnum, view.col = cursor, 0
		vim.api.nvim_win_call(list_win, function() vim.fn.winrestview(view) end)
		navigation.set_rows(starts)
		updating = false
		details()
	end
	local function refresh()
		if closed or refreshing or not vim.api.nvim_buf_is_valid(list_buf) or not vim.api.nvim_win_is_valid(list_win) then return end
		refreshing = true
		runtime.list_async(function(instances, err)
			refreshing = false
			-- Selection and viewport are read by render after the query returns,
			-- preserving navigation performed while the subprocess was running.
			render(instances, err)
		end)
	end
	local function report(result, err)
		if not result then
			vim.notify(err or "Session operation failed", vim.log.levels.WARN, { title = "Pi overview" })
		end
		refresh()
	end
	local mapping_specs = {}
	local help_state = {}
	local function map(key, callback, description)
		table.insert(mapping_specs, { lhs = key, desc = description })
		vim.keymap.set("n", key, callback, { buffer = list_buf, desc = description, silent = true, nowait = key == "g" })
		if key == "<CR>" then
			require("pi-integration.backends.tmux-input").register(list_buf, callback)
		end
	end
	local function require_selected()
		local entry = selected()
		if not entry or entry.kind ~= "session" then
			vim.notify("Select a conversation first", vim.log.levels.WARN, { title = "Pi overview" })
			return nil
		end
		return entry.entry
	end
	local function control_selected(action, argument)
		local entry = require_selected()
		if entry then
			report(runtime.control(entry, action, argument))
		end
	end
	local function pick_mode(values, prompt, action)
		local entry = require_selected()
		if not entry then
			return
		end
		vim.ui.select(values, { prompt = prompt, pi_select_layout = "compact" }, function(choice)
			if choice then
				report(runtime.control(entry, action, choice))
			end
		end)
	end

	list.bind(map, selected, navigation, config, report, refresh)
	map("/", function()
		vim.ui.input({ prompt = "Filter sessions: ", default = query }, function(value)
			if value then
				query = text(value)
				refresh()
			end
		end)
	end, "Filter conversations")
	map("c", function()
		query = ""
		refresh()
	end, "Clear filter")
	map("r", refresh, "Refresh overview")
	map("<leader>a", function()
		control_selected("cycle_access_mode")
	end, "Cycle selected conversation access mode")
	map("<leader>A", function()
		pick_mode(config.access_modes or {}, "Pi access mode", "set_access_mode")
	end, "Pick selected conversation access mode")
	map("<leader>i", function()
		control_selected("cycle_integration_mode")
	end, "Cycle selected conversation integration mode")
	map("<leader>I", function()
		pick_mode(config.integration_modes or {}, "Pi integration mode", "set_integration_mode")
	end, "Pick selected conversation integration mode")
	map("<leader>n", function()
		control_selected("toggle_notifications")
	end, "Toggle selected conversation notifications")
	map("<leader>s", function() require("pi-integration.service-hosts").history_picker() end, "Pick session")
	map("<leader>pn", function() require("pi-integration.service-hosts").new_conversation() end, "New conversation with chosen owner/project")
	map("<leader>pN", function()
		local entry = require_selected()
		if entry then report(require("pi-integration.service-hosts").new_in_project(entry)) end
	end, "New conversation in selected workspace")
	map("<leader>?", function()
		local lines = { "# 󰕮 Help", "", "## Keys", "" }
		for _, spec in ipairs(mapping_specs) do
			table.insert(lines, "- `" .. spec.lhs .. "` " .. spec.desc .. ".")
		end
		vim.list_extend(lines, { "- `q` or `<Esc>` close this help." })
		help.toggle_window(help_state, {
			name = "pi://overview-help",
			title = "󰕮 Help",
			lines = lines,
		})
	end, "Pi overview help")

	local which_key_specs = {}
	for _, spec in ipairs(mapping_specs) do
		table.insert(which_key_specs, { spec.lhs, buffer = list_buf, desc = spec.desc })
	end
	require("which-key").add(which_key_specs)
	vim.api.nvim_create_autocmd("CursorMoved", {
		buffer = list_buf,
		callback = function()
			if not updating then
				navigation.snap()
				details()
			end
		end,
	})
	local function stop()
		if not closed then
			closed = true
			vim.api.nvim_del_autocmd(focus_autocmd)
			timer:stop()
			timer:close()
		end
	end
	focus_autocmd = vim.api.nvim_create_autocmd("FocusGained", {
		callback = function()
			select_last_focused = true
			refresh()
		end,
	})
	vim.api.nvim_create_autocmd("BufWipeout", { buffer = list_buf, once = true, callback = stop })
	vim.api.nvim_create_autocmd("VimLeavePre", { once = true, callback = stop })
	refresh()
	timer:start(1000, 1000, vim.schedule_wrap(refresh))
end

return M
