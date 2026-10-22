local buffer = require("pi-integration.utils.buffer")
local diff_stats = require("pi-integration.diff-stats")
local build_info = require("pi-integration.build-info")

local M = {}

local status_ns = vim.api.nvim_create_namespace("pi-console-status-bars")
-- Each bar has one buffer row and one native statusline row.
local footer = { buf = "status_buf", win = "status_win", name = "pi://status", split = "below" }
local header = { buf = "header_buf", win = "header_win", name = "pi://header", split = "above" }
local footer_bars = { footer }
local service_bars = { header, footer }

local icons = require("pi-integration.status-icons")
local activity_spinner_frames = icons.working_frames

local function non_null(value)
	return value ~= nil and value ~= vim.NIL
end

local function format_count(value)
	value = tonumber(value) or 0
	if value >= 1000000 then
		return string.format("%.1fM", value / 1000000)
	elseif value >= 1000 then
		return string.format("%.1fk", value / 1000)
	end
	return tostring(value)
end

local function statusline_escape(text)
	return tostring(text or ""):gsub("%%", "%%%%")
end

local function statusline_text(text, highlight)
	local style = "%#" .. highlight .. "#"
	return style .. statusline_escape(text):gsub("·", function()
		return "%#PiStatusSeparator#·" .. style
	end)
end

local function format_stat_parts(parts)
	local plain_parts = {}
	local statusline_parts = {}
	for _, part in ipairs(parts) do
		table.insert(plain_parts, part.text)
		table.insert(statusline_parts, statusline_text(part.text, part.highlight))
	end
	return table.concat(plain_parts, "·"), table.concat(statusline_parts, "%#PiStatusSeparator#·")
end

local function format_session_stats(state)
	local stats = state.session_stats
	if not stats and not state.workspace_diff then
		return "tokens: --", statusline_escape("tokens: --"), "", ""
	end

	stats = stats or {}
	local tokens = stats.tokens or {}
	local primary_parts = {
		{ text = "↑" .. format_count(tokens.input), highlight = "PiUsageInput" },
		{ text = "↓" .. format_count(tokens.output), highlight = "PiUsageOutput" },
	}
	local secondary_parts = {}

	local context = stats.contextUsage
	if context then
		local context_tokens = non_null(context.tokens) and format_count(context.tokens) or "?"
		local context_window = non_null(context.contextWindow) and format_count(context.contextWindow) or "?"
		table.insert(primary_parts, { text = "ctx " .. context_tokens .. "/" .. context_window, highlight = "PiUsageContext" })
	end

	local diff = state.workspace_diff
	if diff then
		table.insert(secondary_parts, { text = string.format("+%d", diff.added), highlight = "PiDiffAdded" })
		table.insert(secondary_parts, { text = string.format("-%d", diff.removed), highlight = "PiDiffRemoved" })
		table.insert(secondary_parts, {
			text = string.format("%d %s", diff.files, diff.files == 1 and "file" or "files"),
			highlight = "PiDiffStats",
		})
	end

	-- Pi core currently reports cacheRead/cacheWrite as cumulative per-request
	-- token events. For statusline purposes, show the session cache footprint
	-- instead: the largest cache read/write reported by any single model turn.
	local cache_read = tonumber(tokens.sessionCacheRead or tokens.cacheRead) or 0
	local cache_write = tonumber(tokens.sessionCacheWrite or tokens.cacheWrite) or 0
	if cache_read > 0 or cache_write > 0 then
		table.insert(secondary_parts, { text = "R" .. format_count(cache_read), highlight = "PiUsageStats" })
		table.insert(secondary_parts, { text = "W" .. format_count(cache_write), highlight = "PiUsageStats" })
	end

	if non_null(stats.cost) then
		table.insert(secondary_parts, { text = string.format("$%.2f", stats.cost), highlight = "PiUsageCost" })
	end

	local primary_text, primary_statusline = format_stat_parts(primary_parts)
	if not state.session_stats then
		primary_text, primary_statusline = "tokens: --", statusline_escape("tokens: --")
	end
	local secondary_text, secondary_statusline = format_stat_parts(secondary_parts)
	return primary_text, primary_statusline, secondary_text, secondary_statusline, secondary_parts
end

local function truncate_plain_to_width(text, width)
	if vim.fn.strdisplaywidth(text) <= width then
		return text
	end

	local result = ""
	for _, char in ipairs(vim.fn.split(text, "\\zs")) do
		local next_result = result .. char
		if vim.fn.strdisplaywidth(next_result) > width then
			break
		end
		result = next_result
	end
	return result
end

local function mode_highlight_group(mode)
	if mode == "full" then
		return "PiModeFull"
	elseif mode == "edit" then
		return "PiModeEdit"
	elseif mode == "ask" then
		return "PiModeAsk"
	elseif mode == "readonly" then
		return "PiModeReadonly"
	end
	return "PiModeUnknown"
end

local function mode_statusline_highlight(mode)
	return "%#" .. mode_highlight_group(mode) .. "#"
end

local function mode_statusline_label(mode)
	if mode == "full" then
		return "󱓞 "
	elseif mode == "edit" then
		return "󱇧 "
	elseif mode == "ask" then
		return "󰋗 "
	elseif mode == "readonly" then
		return " "
	end
	return tostring(mode or "--")
end

local function workspace_statusline_label(state)
	local workspace = state.workspace or {}
	if workspace.localCheckout == true then
		return "local"
	end

	local id = type(workspace.id) == "string" and workspace.id ~= "" and workspace.id or nil
	local hash = id and id:match("([%x]+)$") or nil
	if hash then
		return hash
	end

	local name = type(workspace.name) == "string" and workspace.name ~= "" and workspace.name or "workspace"
	local branch = type(workspace.branch) == "string" and workspace.branch ~= "" and workspace.branch or nil
	return branch and (name .. "@" .. branch) or name
end

local function workspace_statusline_highlight(state)
	local workspace = state.workspace or {}
	if workspace.localCheckout == true then
		return "%#PiWorkspaceLocal#"
	end
	return "%#PiWorkspaceActive#"
end

local function current_model_statusline_label(ctx)
	local model = ctx.state.model_id or ctx.config.model
	local provider = ctx.state.provider or ctx.config.provider
	if type(model) ~= "string" or model == "" then
		return "--"
	end
	if model:find("openai-codex/", 1, true) == 1 then
		return "codex/" .. model:sub(#"openai-codex/" + 1)
	end
	if provider == "openai-codex" then
		provider = "codex"
	end
	if type(provider) == "string" and provider ~= "" and not model:find("/", 1, true) then
		return provider .. "/" .. model
	end
	return model
end

local function codex_limits_statusline_label(state)
	if state.provider ~= "openai-codex" or type(state.codex_usage) ~= "table" then
		return ""
	end
	local windows = state.codex_usage.windows
	if type(windows) ~= "table" then
		return ""
	end

	local parts = {}
	for _, item in ipairs({ { "5h", windows.fiveHour }, { "wk", windows.weekly } }) do
		local used = type(item[2]) == "table" and tonumber(item[2].usedPercent) or nil
		if used then
			local remaining = math.max(0, math.min(100, 100 - used))
			table.insert(parts, string.format("%s %.0f%%", item[1], remaining))
		end
	end
	return table.concat(parts, "·")
end

local function current_thinking_level_label(state)
	local level = state.thinking_level
	if type(level) ~= "string" or level == "" then
		return nil
	end
	return level
end

local function activity_statusline_label(state)
	local queued, next_pending = 0, nil
	for _, pending in ipairs(state.pending_user_messages or {}) do
		if pending.status == "queued" or pending.status == "sending" then
			queued = queued + 1
			next_pending = next_pending or pending
		end
	end
	local suffix = queued > 0 and ("·" .. tostring(queued) .. " queued") or ""
	local request = state.active_ui_request_id and (state.pending_ui_requests or {})[state.active_ui_request_id]
	if request and not request.navigation and (not request.expires or request.expires > vim.uv.now()) then
		return " waiting·" .. request.label .. suffix .. (request.hidden and "·<leader>pa" or "")
	end
	if not state.is_loading and not state.is_agent_running and not state.is_streaming
		and not state.is_retrying and not state.awaiting_agent_output then
		if next_pending and next_pending.edit_buf then
			return " waiting·editing queued message" .. suffix
		end
		return suffix
	end
	local label
	if state.is_loading then
		label = "loading"
	elseif state.is_retrying then
		label = "retry"
	else
		label = state.activity_label or "work"
	end
	label = label .. suffix
	local tick = tonumber(state.activity_spinner_tick) or 1
	local frame = activity_spinner_frames[((tick - 1) % #activity_spinner_frames) + 1]
	return " " .. frame .. " " .. label
end

local function spawn_statusline_label(state)
	local count = tonumber(state.spawn_running_count) or 0
	if count <= 0 then
		return ""
	end
	return " " .. icons.subagent_icon .. " " .. tostring(count)
end

local function thinking_statusline_highlight(level)
	if level == "off" then
		return "%#PiThinkingOff#"
	elseif level == "minimal" then
		return "%#PiThinkingMinimal#"
	elseif level == "low" then
		return "%#PiThinkingLow#"
	elseif level == "medium" then
		return "%#PiThinkingMedium#"
	elseif level == "high" then
		return "%#PiThinkingHigh#"
	elseif level == "xhigh" then
		return "%#PiThinkingXhigh#"
	end
	return "%#PiUsageStats#"
end

local function integration_statusline_label(mode)
	if mode == "allowed" then
		return "✓"
	end
	return "?"
end

local function integration_highlight_group(mode)
	if mode == "ask" then
		return "PiIntegrationAsk"
	elseif mode == "allowed" then
		return "PiIntegrationAllowed"
	end
	return "PiModeUnknown"
end

local function integration_statusline_highlight(mode)
	return "%#" .. integration_highlight_group(mode) .. "#"
end

local function notification_statusline_label(status)
	if status == "notify on" then
		return "󰂞 "
	elseif status == "notify off" then
		return "󰂛 "
	end
	return tostring(status or "")
end

local function notification_highlight_group(status)
	if status == "notify on" then
		return "PiNotifyOn"
	elseif status == "notify off" then
		return "PiNotifyOff"
	end
	return "PiUsageStats"
end

local function notification_statusline_highlight(status)
	return "%#" .. notification_highlight_group(status) .. "#"
end

local function icon_only(label)
	return (label:gsub("%s+$", ""))
end

function M.status_indicators(state)
	local mode = state.access_mode
	local integration_mode = state.integration_mode
	local notification_status = state.notification_status
	return {
		{
			text = mode and icon_only(mode_statusline_label(mode)) or "",
			highlight = mode_highlight_group(mode),
		},
		{
			text = integration_mode and icon_only(integration_statusline_label(integration_mode)) or "",
			highlight = integration_highlight_group(integration_mode),
		},
		{
			text = notification_status and icon_only(notification_statusline_label(notification_status)) or "",
			highlight = notification_highlight_group(notification_status),
		},
	}
end

function M.render(ctx)
	local state = ctx.state
	local mode = state.access_mode or "--"
	local mode_text = mode_statusline_label(mode)
	local mode_prefix = " "
	local mode_suffix = ""
	local mode_label = mode_prefix .. mode_text .. mode_suffix
	local status_delimiter = "·"
	local integration_mode = state.integration_mode or "ask"
	local integration_label = integration_statusline_label(integration_mode)
	local integration_segment_label = status_delimiter .. integration_label
	local notification_label = state.notification_status and notification_statusline_label(state.notification_status) or ""
	local notification_segment_label = notification_label ~= "" and (status_delimiter .. notification_label) or ""
	local workspace_text = workspace_statusline_label(state)
	local workspace_label = status_delimiter .. workspace_text
	local model_label = status_delimiter .. current_model_statusline_label(ctx)
	local thinking_level = current_thinking_level_label(state)
	local thinking_label = thinking_level and (" [" .. thinking_level .. "]") or ""
	local limits_text = codex_limits_statusline_label(state)
	local stats_text, stats_statusline = format_session_stats(state)
	local width = vim.api.nvim_win_get_width(state.status_win)
	local mode_width = vim.fn.strdisplaywidth(mode_label)
	local integration_width = vim.fn.strdisplaywidth(integration_segment_label)
	local notification_width = vim.fn.strdisplaywidth(notification_segment_label)
	local workspace_width = vim.fn.strdisplaywidth(workspace_label)
	local model_width = vim.fn.strdisplaywidth(model_label)
	local thinking_width = vim.fn.strdisplaywidth(thinking_label)
	local left_width = mode_width + integration_width + notification_width + workspace_width + model_width + thinking_width
	local available_right_width = width - left_width - 3
	local stats_plain = " " .. stats_text .. " "
	local limits_plain = limits_text ~= "" and (" " .. limits_text .. " ") or ""
	local both_plain = limits_text ~= "" and (" " .. limits_text .. "·" .. stats_text .. " ") or ""
	local right_label = ""
	if both_plain ~= "" and vim.fn.strdisplaywidth(both_plain) <= available_right_width then
		right_label = "%#PiUsageStats# "
			.. statusline_text(limits_text, "PiUsageStats")
			.. "%#PiStatusSeparator#·"
			.. stats_statusline
			.. "%#PiUsageStats# "
	elseif limits_plain ~= "" and vim.fn.strdisplaywidth(limits_plain) <= available_right_width then
		right_label = "%#PiUsageStats# " .. statusline_text(limits_text, "PiUsageStats") .. " "
	elseif vim.fn.strdisplaywidth(stats_plain) <= available_right_width then
		right_label = "%#PiUsageStats# " .. stats_statusline .. "%#PiUsageStats# "
	end
	local mode_highlight = mode_statusline_highlight(mode)

	if width <= mode_width then
		local prefix_width = vim.fn.strdisplaywidth(mode_prefix)
		if width <= prefix_width then
			return "%#PiUsageStats#" .. statusline_escape(truncate_plain_to_width(mode_prefix, width)) .. "%*"
		end
		return "%#PiUsageStats#"
			.. statusline_escape(mode_prefix)
			.. mode_highlight
			.. statusline_escape(truncate_plain_to_width(mode_text .. mode_suffix, width - prefix_width))
			.. "%*"
	end

	local left_label = "%#PiUsageStats#"
		.. statusline_escape(mode_prefix)
		.. mode_highlight
		.. statusline_escape(mode_text)
		.. "%#PiUsageStats#"
		.. statusline_escape(mode_suffix)

	if width <= left_width then
		return left_label
			.. statusline_text(truncate_plain_to_width(integration_segment_label .. notification_segment_label .. workspace_label .. model_label .. thinking_label, width - mode_width), "PiUsageStats")
			.. "%*"
	end

	left_label = left_label
		.. "%#PiStatusSeparator#" .. status_delimiter
		.. integration_statusline_highlight(integration_mode)
		.. statusline_escape(integration_label)
		.. "%#PiUsageStats#"
	if notification_label ~= "" then
		left_label = left_label
			.. "%#PiStatusSeparator#" .. status_delimiter
			.. notification_statusline_highlight(state.notification_status)
			.. statusline_escape(notification_label)
			.. "%#PiUsageStats#"
	end
	left_label = left_label
		.. "%#PiStatusSeparator#" .. status_delimiter
		.. workspace_statusline_highlight(state)
		.. statusline_escape(workspace_text)
		.. statusline_text(model_label, "PiUsageStats")
	if thinking_label ~= "" then
		left_label = left_label
			.. thinking_statusline_highlight(thinking_level)
			.. statusline_escape(thinking_label)
			.. "%#PiUsageStats#"
	end
	return left_label .. "%#PiUsageStats#%=" .. right_label .. "%*"
end

function M.render_secondary(ctx)
	local state = ctx.state
	local activity_label = activity_statusline_label(state)
	local spawn_label = spawn_statusline_label(state)
	local left_text = activity_label .. spawn_label
	local width = vim.api.nvim_win_get_width(state.status_win)
	local build_label = build_info.statusline_label(math.max(0, width - 1)) .. " "
	local build_width = vim.fn.strdisplaywidth(build_label)
	local _, _, _, _, parts = format_session_stats(state)
	parts = parts or {}
	local stats_text, stats_statusline = format_stat_parts(parts)
	-- Drop less-important stats from the left, keeping cost nearest the build.
	while #parts > 0 and vim.fn.strdisplaywidth(stats_text) + 1 + build_width > width do
		table.remove(parts, 1)
		stats_text, stats_statusline = format_stat_parts(parts)
	end
	local right_width = build_width + (stats_text ~= "" and (vim.fn.strdisplaywidth(stats_text) + 1) or 0)
	local right_label = (stats_text ~= "" and (stats_statusline .. "%#PiStatusSeparator#·") or "")
		.. statusline_text(build_label, build_info.highlight())

	local gap_width = left_text ~= "" and 3 or 0
	local available_left_width = math.max(0, width - right_width - gap_width)
	local visible_activity = truncate_plain_to_width(activity_label, available_left_width)
	local visible_spawn = visible_activity == activity_label
		and truncate_plain_to_width(spawn_label, math.max(0, available_left_width - vim.fn.strdisplaywidth(visible_activity)))
		or ""
	local left_label = statusline_text(visible_activity, "PiActivity") .. statusline_text(visible_spawn, "PiSubagent")
	return left_label .. "%#PiUsageStats#%=" .. right_label .. "%*"
end

local function resolve_bar(state, bar)
	state[bar.win] = buffer.find_window(state[bar.buf], state[bar.win])
	return state[bar.win]
end

local function close_bar(state, bar)
	local win = resolve_bar(state, bar)
	if win then
		pcall(vim.api.nvim_win_close, win, true)
	end
	state[bar.win] = nil
end

local function ensure_bar_buffer(state, bar)
	if buffer.valid(state[bar.buf]) then
		return state[bar.buf]
	end
	local buf = vim.api.nvim_create_buf(false, true)
	vim.api.nvim_buf_set_name(buf, bar.name)
	vim.api.nvim_set_option_value("buftype", "nofile", { buf = buf })
	vim.api.nvim_set_option_value("bufhidden", "hide", { buf = buf })
	vim.api.nvim_set_option_value("swapfile", false, { buf = buf })
	vim.api.nvim_set_option_value("modifiable", false, { buf = buf })
	state[bar.buf] = buf
	return buf
end

local function bar_is_at_edge(state, bar)
	local tab = vim.api.nvim_win_get_tabpage(state[bar.win])
	local tab_number = vim.api.nvim_tabpage_get_number(tab)
	local layout = vim.fn.winlayout(tab_number)
	if layout[1] ~= "col" then
		return false
	end
	local children = layout[2]
	local edge = children[bar.split == "above" and 1 or #children]
	return edge and edge[1] == "leaf" and edge[2] == state[bar.win]
end

local function normalize_bar_window(state, bar)
	if not buffer.window_matches(state.transcript_win, state.transcript_buf)
		or not buffer.window_matches(state[bar.win], state[bar.buf]) then
		return
	end
	local transcript_tab = vim.api.nvim_win_get_tabpage(state.transcript_win)
	if vim.api.nvim_get_current_tabpage() == transcript_tab then
		local bar_tab = vim.api.nvim_win_get_tabpage(state[bar.win])
		if bar_tab ~= transcript_tab or not bar_is_at_edge(state, bar) then
			pcall(vim.api.nvim_win_set_config, state[bar.win], { split = bar.split, win = -1 })
		end
	end
	if vim.api.nvim_win_get_height(state[bar.win]) ~= 1 then
		pcall(vim.api.nvim_win_set_height, state[bar.win], 1)
	end
end

local function apply_bar_window_options(win)
	vim.api.nvim_set_option_value("wrap", false, { win = win })
	vim.api.nvim_set_option_value("winbar", "", { win = win })
	vim.api.nvim_set_option_value("fillchars", "stl: ,stlnc: ", { win = win })
	vim.api.nvim_set_option_value("statusline", "", { win = win })
	vim.api.nvim_set_option_value("winfixheight", true, { win = win })
	vim.api.nvim_set_option_value("winfixbuf", true, { win = win })
	vim.api.nvim_set_option_value("winhl", "Normal:PiStatusFooterNormal,EndOfBuffer:PiStatusFooterNormal", { win = win })
end

local function ensure_bar_window(state, bar, buf)
	if resolve_bar(state, bar) then
		normalize_bar_window(state, bar)
		return state[bar.win]
	end
	if vim.api.nvim_get_current_tabpage() ~= vim.api.nvim_win_get_tabpage(state.transcript_win) then
		return nil
	end
	local opened, win = pcall(vim.api.nvim_open_win, buf, false, {
		split = bar.split,
		win = -1,
		height = 1,
		focusable = false,
		style = "minimal",
	})
	if not opened then
		return nil
	end
	apply_bar_window_options(win)
	pcall(vim.api.nvim_win_set_height, win, 1)
	state[bar.win] = win
	return win
end

local function evaluate_statusline(format, win, width)
	return vim.api.nvim_eval_statusline(format, {
		winid = win,
		maxwidth = width,
		highlights = true,
		use_winbar = true,
	})
end

local function apply_evaluated_highlights(buf, row, evaluated)
	for index, item in ipairs(evaluated.highlights or {}) do
		local next_item = evaluated.highlights[index + 1]
		local end_col = next_item and next_item.start or #evaluated.str
		if item.start < end_col then
			vim.api.nvim_buf_set_extmark(buf, status_ns, row, item.start, {
				end_col = end_col,
				hl_group = { item.group, "PiStatusFooter" },
				priority = 100,
			})
		end
	end
end

local function single_line(value)
	return tostring(value or ""):gsub("[%c]", " ")
end

local function header_formats(state, width)
	local title = single_line(state.session_name or "Untitled session")
	local connection = state.connection_status or "disconnected"
	local client = state.client_status or "view only"
	local right = connection .. " · " .. client
	local host_width = width - vim.fn.strdisplaywidth(right) - 5
	if host_width > 0 then
		local host = truncate_plain_to_width(single_line(state.host_name), host_width)
		if host ~= "" then right = host .. " · " .. right end
	end
	right = truncate_plain_to_width(right, math.max(0, width - 2))
	local cwd_width = math.max(0, width - vim.fn.strdisplaywidth(right) - 4)
	local cwd = truncate_plain_to_width(single_line(state.session_cwd or "--"), cwd_width)
	local details = statusline_text(" " .. cwd, "PiUsageStats")
		.. "%=" .. statusline_text(right .. " ", "PiUsageStats") .. "%*"
	return statusline_text(" " .. truncate_plain_to_width(title, math.max(0, width - 2)), "PiSessionTitle") .. "%*", details
end

local function render_bar(ctx, bar, buf, width)
	local primary_format, secondary_format
	if bar == header then
		primary_format, secondary_format = header_formats(ctx.state, width)
	else
		primary_format, secondary_format = M.render(ctx), M.render_secondary(ctx)
	end
	local primary = evaluate_statusline(primary_format, ctx.state[bar.win], width)
	vim.api.nvim_set_option_value("modifiable", true, { buf = buf })
	vim.api.nvim_buf_set_lines(buf, 0, -1, false, { primary.str })
	vim.api.nvim_set_option_value("modifiable", false, { buf = buf })
	vim.api.nvim_buf_clear_namespace(buf, status_ns, 0, -1)
	apply_evaluated_highlights(buf, 0, primary)
	vim.api.nvim_set_option_value("statusline", secondary_format, { win = ctx.state[bar.win] })
end

function M.setup(ctx)
	if not ctx.service_mode then
		diff_stats.setup(ctx.state, function() M.update(ctx) end)
	end
	local update_scheduled = false
	local function schedule_update()
		if update_scheduled then
			return
		end
		update_scheduled = true
		vim.schedule(function()
			update_scheduled = false
			M.update(ctx)
		end)
	end

	local bars = ctx.service_mode and service_bars or footer_bars
	local footer_group = vim.api.nvim_create_augroup("PiNvimStatusFooter", { clear = true })
	vim.api.nvim_create_autocmd({ "VimResized", "WinResized", "WinNew", "WinClosed", "TabEnter" }, {
		group = footer_group,
		desc = "Keep the pi-console status bars pinned",
		callback = schedule_update,
	})
	vim.api.nvim_create_autocmd("WinEnter", {
		group = footer_group,
		desc = "Keep focus out of the pi-console status bars",
		callback = function()
			local state = ctx.state
			local function is_bar(win)
				for _, bar in ipairs(bars) do
					if buffer.window_matches(win, state[bar.buf]) then return true end
				end
				return false
			end
			if not is_bar(vim.api.nvim_get_current_win()) then return end
			local previous_win = vim.fn.win_getid(vim.fn.winnr("#"))
			if not is_bar(previous_win) and vim.api.nvim_win_is_valid(previous_win) then
				vim.api.nvim_set_current_win(previous_win)
			elseif ctx.transcript.win_valid() then
				vim.api.nvim_set_current_win(state.transcript_win)
			end
		end,
	})
	vim.api.nvim_create_autocmd("SafeState", {
		group = footer_group,
		desc = "Restore the pi-console status bars after window commands",
		callback = function()
			local state = ctx.state
			if not ctx.transcript.win_valid() then return end
			for _, bar in ipairs(bars) do
				if resolve_bar(state, bar) then normalize_bar_window(state, bar) end
			end
		end,
	})
end

function M.update(ctx)
	local state = ctx.state
	if not ctx.service_mode then
		diff_stats.refresh(state, function() M.update(ctx) end)
	end
	local bars = ctx.service_mode and service_bars or footer_bars
	if not ctx.transcript.win_valid() then
		for _, bar in ipairs(bars) do close_bar(state, bar) end
		return
	end
	for _, bar in ipairs(bars) do
		local buf = ensure_bar_buffer(state, bar)
		local win = ensure_bar_window(state, bar, buf)
		if win then
			local width = vim.api.nvim_win_get_width(win)
			if width < 1 then
				close_bar(state, bar)
			else
				render_bar(ctx, bar, buf, width)
			end
		end
	end
	vim.cmd("redraw")
end

return M
