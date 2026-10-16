local help = require("pi-integration.help")
local runtime = require("pi-integration.runtime")
local sessions = require("pi-integration.sessions")
local pins = require("pi-integration.session-pins")
local statusline = require("pi-integration.statusline")
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

local function window_options(win, statusline)
	for name, value in pairs({ number = false, relativenumber = false, signcolumn = "no", wrap = false, spell = false, fillchars = "stl:─,stlnc:─", statusline = statusline .. "%#PiPaneBorder#%=" }) do
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
	window_options(list_win, "%#PiOverviewTitle# 󰕮%#PiOverviewStatusLine# · Enter: open/focus · p: pin · dd: kill · /: filter · c: clear · r: refresh · <leader>?: keys ")
	vim.wo[list_win].cursorline = true
	vim.cmd("botright 9split")
	local detail_win = vim.api.nvim_get_current_win()
	local detail_buf = scratch("pi://overview-details")
	vim.api.nvim_win_set_buf(detail_win, detail_buf)
	window_options(detail_win, "%#PiOverviewStatusLine# Selected conversation ")
	vim.wo[detail_win].cursorline = false
	vim.wo[detail_win].wrap = true
	vim.wo[detail_win].winfixheight = true
	vim.api.nvim_set_current_win(list_win)

	local rows = {}
	local query = ""
	local updating = false
	local closed = false
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
		local entry = selected()
		local lines = { "", " Select a conversation to see its details." }
		if entry then
			local waiting = type(entry.waiting) == "table" and entry.waiting or nil
			local activity = not waiting and entry.activity and entry.activity ~= "" and (" · " .. text(entry.activity)) or ""
			lines = {
				" " .. (entry.pinned and " " or "") .. text(entry.title),
				"",
				" Status:    " .. text(entry.status) .. activity,
			}
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
	local function refresh()
		if closed or not vim.api.nvim_buf_is_valid(list_buf) or not vim.api.nvim_win_is_valid(list_win) then
			return
		end
		local previous = selected()
		local view = vim.api.nvim_win_call(list_win, vim.fn.winsaveview)
		local instances, err = runtime.list()
		local entries
		if instances then
			entries, err = pins.merge(instances)
		end
		-- Keep the last successful list on a backend or pin-storage failure.
		if not entries then
			set_lines(detail_buf, { " Could not refresh sessions:", " " .. text(err) })
			return
		end
		local focus_target = select_last_focused and runtime.last_focused(instances) or nil
		select_last_focused = false
		local previous_rows = rows
		rows = {}
		local pinned_entries, regular_entries = {}, {}
		local pinned_count = 0
		for _, entry in ipairs(entries) do
			if entry.pinned then
				pinned_count = pinned_count + 1
			end
			local searchable = (text(entry.title) .. " " .. text(project(entry)) .. " " .. text(entry.cwd) .. " " .. workspace_hash(entry) .. " " .. text(entry.status)):lower()
			if query == "" or searchable:find(query:lower(), 1, true) then
				table.insert(entry.pinned and pinned_entries or regular_entries, entry)
			end
		end
		local lines = {
			" Pi sessions · " .. #instances .. " open · " .. pinned_count .. " pinned",
			query == "" and "" or (" Filter: " .. query),
			"",
			" " .. column("Status", 13) .. "  " .. blank_indicators .. "  " .. column("Project", 20) .. "  " .. column("Workspace", 10) .. "  Title",
		}
		local cursor, nearest_row, focused_row
		local indicator_prefix = " " .. column("", 13) .. "  "
		local indicator_spans = {}
		local title_start_cols = {}
		local heading_rows = {}
		for _, section in ipairs({ { title = " Pinned", entries = pinned_entries }, { title = "Sessions", entries = regular_entries } }) do
			if #section.entries > 0 then
				if #heading_rows > 0 then
					table.insert(lines, "")
				end
				table.insert(lines, " " .. section.title)
				table.insert(heading_rows, #lines)
				for _, entry in ipairs(section.entries) do
					local row = #lines + 1
					rows[row] = entry
					if focus_target and entry.id == focus_target.id then
						focused_row = row
					end
					local name = vim.fn.fnamemodify(project(entry), ":t")
					local indicators, spans = indicator_columns(entry)
					local row_prefix = " " .. column(entry.status, 13) .. "  " .. indicators .. "  " .. column(name, 20) .. "  " .. column(workspace_hash(entry), 10) .. "  "
					indicator_spans[row] = spans
					title_start_cols[row] = #row_prefix
					table.insert(lines, row_prefix .. (entry.pinned and " " or "") .. text(entry.title))
					if not nearest_row or math.abs(row - view.lnum) < math.abs(nearest_row - view.lnum) then
						nearest_row = row
					end
					if previous and (previous.id == entry.id
						or (previous.status == "Not Open" or entry.status == "Not Open")
							and runtime.canonical_path(previous.path) == runtime.canonical_path(entry.path)) then
						cursor = row
					end
				end
			end
		end
		cursor = focused_row or cursor
		if not next(rows) then
			table.insert(lines, runtime.available() and " No matching open or pinned conversations. Press <leader>pn to start one." or " No supported session backend available.")
		end
		if not cursor then
			cursor = view.lnum
			if previous or not next(previous_rows) then
				cursor = nearest_row or cursor
			end
			cursor = math.max(1, math.min(cursor, #lines))
		end
		updating = true
		set_lines(list_buf, lines)
		vim.api.nvim_buf_clear_namespace(list_buf, ns, 0, -1)
		vim.api.nvim_buf_set_extmark(list_buf, ns, 0, 0, { end_col = #lines[1], hl_group = "Title" })
		for _, row in ipairs(heading_rows) do
			vim.api.nvim_buf_set_extmark(list_buf, ns, row - 1, 1, { end_col = #lines[row], hl_group = "Title" })
		end
		for row, entry in pairs(rows) do
			local group = entry.status == "Done" and "DiagnosticOk"
				or entry.status == "Waiting" and "DiagnosticWarn"
				or (entry.status == "Error" or entry.status == "Stopped" or entry.status == "Unresponsive") and "DiagnosticError"
				or (entry.status == "Idle" or entry.status == "Not Open") and "Comment"
				or "DiagnosticInfo"
			vim.api.nvim_buf_set_extmark(list_buf, ns, row - 1, 1, { end_col = 14, hl_group = group })
			for _, span in ipairs(indicator_spans[row]) do
				vim.api.nvim_buf_set_extmark(list_buf, ns, row - 1, #indicator_prefix + span.start_col, {
					end_col = #indicator_prefix + span.end_col,
					hl_group = span.highlight,
				})
			end
			vim.api.nvim_buf_set_extmark(list_buf, ns, row - 1, title_start_cols[row], {
				end_col = #lines[row],
				hl_group = entry.is_new_session and "PiOverviewNewSession" or "PiOverviewTitle",
			})
		end
		-- Keep the viewport stable unless the selected session moves out of view.
		local height = vim.api.nvim_win_get_height(list_win)
		if cursor < view.topline then
			view.topline = cursor
		elseif cursor >= view.topline + height then
			view.topline = cursor - height + 1
		end
		view.lnum = cursor
		vim.api.nvim_win_call(list_win, function()
			vim.fn.winrestview(view)
		end)
		updating = false
		details()
	end
	local function report(result, err)
		if not result then
			vim.notify(err or "Session operation failed", vim.log.levels.WARN, { title = "Pi overview" })
		end
		refresh()
	end
	local history_ctx = {
		config = config,
		state = require("pi-integration.state").new(),
		notices = { empty_session = "No messages yet." },
		ui = {
			notify = function(message, level)
				vim.notify(message, level, { title = "Pi sessions" })
			end,
		},
		session = {
			open_candidate = function(candidate)
				report(runtime.launch(config.launcher, candidate.cwd or vim.fn.getcwd(), candidate.path))
			end,
		},
	}
	local mapping_specs = {}
	local help_state = {}
	local function map(key, callback, description)
		table.insert(mapping_specs, { lhs = key, desc = description })
		vim.keymap.set("n", key, callback, { buffer = list_buf, desc = description, silent = true })
	end
	local function require_selected()
		local entry = selected()
		if not entry then
			vim.notify("Select a conversation first", vim.log.levels.WARN, { title = "Pi overview" })
		end
		return entry
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

	map("<CR>", function()
		local entry = selected()
		if entry then
			if entry.status == "Not Open" then
				report(runtime.launch(config.launcher, entry.cwd, entry.path))
			else
				report(runtime.focus(entry.id))
			end
		end
	end, "Focus or reopen conversation")
	map("p", function()
		local entry = require_selected()
		if entry then
			report(pins.toggle(entry))
		end
	end, "Toggle session pin")
	map("dd", function()
		local entry = selected()
		if not entry then
			return
		end
		local entries, err = runtime.list()
		if not entries then
			report(nil, err)
			return
		end
		local current
		for _, candidate in ipairs(entries) do
			if candidate.id == entry.id and candidate.pid == entry.pid then
				current = candidate
				break
			end
		end
		if not current then
			report(nil, "That conversation is no longer open")
			return
		end
		if runtime.kill_needs_confirmation(current) then
			vim.ui.select({ "Yes", "No" }, { prompt = "Kill running conversation " .. text(current.title) .. " and close its window?", pi_select_layout = "compact" }, function(choice)
				if choice == "Yes" then
					report(runtime.kill(current, true))
				end
			end)
		else
			report(runtime.kill(current, false))
		end
	end, "Kill conversation")
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
	map("<leader>s", function()
		sessions.pick(history_ctx)
	end, "Pick session")
	map("<leader>pn", function()
		require("pi-integration.directory-history").input(
			{ prompt = "New conversation project: ", default = vim.fn.getcwd(), completion = "dir" },
			function(cwd)
				if cwd and vim.trim(cwd) ~= "" then
					report(runtime.launch(config.launcher, vim.fn.fnamemodify(vim.fn.expand(cwd), ":p")))
				end
			end
		)
	end, "New conversation with chosen project")
	map("<leader>pN", function()
		local entry = require_selected()
		if entry then
			report(runtime.launch(config.launcher, project(entry)))
		end
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
