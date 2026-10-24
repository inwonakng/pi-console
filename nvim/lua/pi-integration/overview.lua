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
local selection_ns = vim.api.nvim_create_namespace("pi-overview-selection")

local function text(value)
	return type(value) == "string" and value:gsub("[%c]", " ") or ""
end

local function column(value, width)
	if width <= 0 then return "" end
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

local function workspace_path(entry)
	return text(entry.workspace_cwd) ~= "" and text(entry.workspace_cwd) or text(entry.cwd)
end

local function workspace_label(entry)
	local hash = text(entry.workspace_id):match("([%x]+)$")
	if hash then return hash end
	local name = vim.fn.fnamemodify(workspace_path(entry), ":t")
	hash = name:match("^task%-%d%d%d%d%-.*%-(%x%x%x%x%x%x%x%x)$")
		or name:match("^child%-%d%d%d%d%-.*%-(%x%x%x%x%x%x%x%x)$")
	return hash or name
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
				highlight = indicator.highlight:gsub("^Pi", "PiOverview"),
			})
		end
		byte_offset = byte_offset + #cell
	end
	return table.concat(cells), spans
end

local blank_indicators = column("", indicator_widths[1])
	.. " " .. column("", indicator_widths[2])
	.. " " .. column("", indicator_widths[3])

local metadata_columns = {
	{ key = "status", label = "Status", limit = 13 },
	{ key = "project", label = "Project", limit = 20 },
	{ key = "workspace", label = "Workspace", limit = 14 },
	{ key = "host", label = "Host", limit = 32 },
	{ key = "controller", label = "Controller", limit = 24 },
}

local function metadata(entry)
	local host = text(entry.location) ~= "" and text(entry.location) or text(entry.host_name)
	local controller = type(entry.controller) == "table" and text(entry.controller.label) or ""
	return {
		status = text(entry.status),
		project = vim.fn.fnamemodify(project(entry), ":t"),
		workspace = workspace_label(entry),
		host = host .. (entry.connected == false and " (unreachable)" or ""),
		controller = entry.connected == false and "" or (controller ~= "" and controller or "-"),
	}
end

local function column_widths(win, entries)
	-- Reserve the indentation, indicators, and five two-space gaps.
	local usable = math.max(0, vim.api.nvim_win_get_width(win) - 5 - vim.fn.strdisplaywidth(blank_indicators) - 10)
	local widths, total, minimum_total = {}, 0, 0
	for _, spec in ipairs(metadata_columns) do
		widths[spec.key] = #spec.label
		minimum_total = minimum_total + #spec.label
	end
	for _, entry in ipairs(entries) do
		local values = metadata(entry)
		for _, spec in ipairs(metadata_columns) do
			widths[spec.key] = math.max(widths[spec.key], math.min(spec.limit, vim.fn.strdisplaywidth(values[spec.key])))
		end
	end
	for _, spec in ipairs(metadata_columns) do total = total + widths[spec.key] end
	while total > usable do
		local widest
		for _, spec in ipairs(metadata_columns) do
			local minimum = usable >= minimum_total and #spec.label or 0
			if widths[spec.key] > minimum and (not widest or widths[spec.key] > widths[widest]) then
				widest = spec.key
			end
		end
		if not widest then break end
		widths[widest], total = widths[widest] - 1, total - 1
	end
	return widths
end

local function metadata_line(values, widths)
	local cells = {}
	for _, spec in ipairs(metadata_columns) do
		local value = values[spec.key]
		local suffix = " (unreachable)"
		if spec.key == "host" and value:sub(-#suffix) == suffix and widths.host >= #suffix then
			value = column(value:sub(1, -#suffix - 1), widths.host - #suffix) .. suffix
		end
		table.insert(cells, column(value, widths[spec.key]))
	end
	return "     " .. table.concat(cells, "  ")
end

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
		" 󰕮", "Enter open", "Tab expand", "J/K move", "g group", "p pin", "dd stop/delete group", "<leader>pi interrupt", "/ filter", "<leader>? keys",
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
		require("pi-integration.logs").notify(registration_error, vim.log.levels.WARN, { title = "Pi overview" })
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

	local list = session_list.new()
	local rows = {}
	local navigation = session_navigation.new(list_win)
	local query = ""
	local updating = false
	local closed = false
	local refreshing = false
	local select_last_focused = true
	local focus_autocmd, resize_autocmd
	local timer = vim.uv.new_timer()
	local function selected()
		if vim.api.nvim_win_is_valid(list_win) then
			return rows[vim.api.nvim_win_get_cursor(list_win)[1]]
		end
	end
	local function highlight_selection()
		vim.api.nvim_buf_clear_namespace(list_buf, selection_ns, 0, -1)
		local row = vim.api.nvim_win_get_cursor(list_win)[1]
		local node = rows[row]
		if not node or node.kind ~= "session" then return end
		if rows[row - 1] == node then row = row - 1 end
		for line = row, row + 1 do
			vim.api.nvim_buf_set_extmark(list_buf, selection_ns, line - 1, 0, {
				end_row = line, end_col = 0, hl_group = "CursorLine", hl_eol = true, priority = 200,
			})
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
			table.insert(lines, " Workspace: " .. workspace_path(entry))
			if entry.host_id then
				table.insert(lines, " Host:      " .. text(entry.host_name) .. (entry.connected == false and " (unreachable)" or ""))
				table.insert(lines, " Controller: " .. (entry.connected ~= false and type(entry.controller) == "table" and text(entry.controller.label) or "-"))
			end
			table.insert(lines, " Location:  " .. text(entry.location))
			table.insert(lines, " Model:     " .. (text(entry.model) ~= "" and text(entry.model) or "—"))
			table.insert(lines, " Subagents: " .. tostring(tonumber(entry.subagents) or 0))
			table.insert(lines, " Session:   " .. (text(entry.session_id) ~= "" and text(entry.session_id) or text(entry.path) ~= "" and text(entry.path) or "No session yet"))
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
		local widths = column_widths(list_win, entries)
		local labels = {}
		for _, spec in ipairs(metadata_columns) do labels[spec.key] = spec.label end
		local lines = {
			" Pi sessions · " .. #instances .. " active · " .. pinned_count .. " pinned",
			query == "" and "" or (" Filter: " .. query),
			"",
			metadata_line(labels, widths),
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
				local prefix = " " .. session_list.session_prefix(node)
				local badge = build_info.is_dev(entry) and "DEV " or ""
				local suffix = node.running > 0 and (" · " .. icons.subagent_icon .. " " .. node.running) or ""
				table.insert(lines, prefix .. badge .. text(entry.title) .. suffix)
				if badge ~= "" then highlight(row, #prefix, #prefix + 3, "PiBuildDev") end
				highlight(row, #prefix + #badge, #lines[row] - #suffix, entry.is_new_session and "PiOverviewNewSession" or "PiOverviewTitle")
				if suffix ~= "" then highlight(row, #lines[row] - #suffix, #lines[row], "PiSubagent") end
				local values = metadata(entry)
				local metadata_text = metadata_line(values, widths)
				table.insert(lines, metadata_text)
				highlight(row + 1, 5, 5 + #column(values.status, widths.status), icons.highlight(entry.status))
				if entry.connected ~= false and entry.status ~= "Inactive" then
					local indicators, spans = indicator_columns(entry)
					local indicator_start = #metadata_text + 2
					lines[row + 1] = metadata_text .. "  " .. indicators
					for _, span in ipairs(spans) do
						highlight(row + 1, indicator_start + span.start_col, indicator_start + span.end_col, span.highlight)
					end
				end
				rows[row + 1] = node
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
		highlight_selection()
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
			require("pi-integration.logs").notify(err or "Session operation failed", vim.log.levels.WARN, { title = "Pi overview" })
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
			require("pi-integration.logs").notify("Select a conversation first", vim.log.levels.WARN, { title = "Pi overview" })
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
	end, "New conversation in selected project")
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
				local row = vim.api.nvim_win_get_cursor(list_win)[1]
				if rows[row] and rows[row] == rows[row - 1] then
					vim.api.nvim_win_set_cursor(list_win, { row - 1, 0 })
				end
				navigation.snap()
				highlight_selection()
				details()
			end
		end,
	})
	local function stop()
		if not closed then
			closed = true
			vim.api.nvim_del_autocmd(focus_autocmd)
			vim.api.nvim_del_autocmd(resize_autocmd)
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
	resize_autocmd = vim.api.nvim_create_autocmd("WinResized", { callback = refresh })
	vim.api.nvim_create_autocmd("BufWipeout", { buffer = list_buf, once = true, callback = stop })
	vim.api.nvim_create_autocmd("VimLeavePre", { once = true, callback = stop })
	refresh()
	timer:start(1000, 1000, vim.schedule_wrap(refresh))
end

return M
