local M = {}

local footer_ns = vim.api.nvim_create_namespace("pi-console-status-footer")
local footer_height = 1

local activity_spinner_frames = {
	"⠖",
	"⠲",
	"⢒",
	"⢰",
	"⣰",
	"⣠",
	"⣄",
	"⣆",
}

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

local function format_stat_parts(parts)
	local plain_parts = {}
	local statusline_parts = {}
	for _, part in ipairs(parts) do
		table.insert(plain_parts, part.text)
		table.insert(statusline_parts, "%#" .. part.highlight .. "#" .. statusline_escape(part.text))
	end
	return table.concat(plain_parts, "·"), table.concat(statusline_parts, "%#PiUsageStats#·")
end

local function format_session_stats(state)
	local stats = state.session_stats
	if not stats then
		return "tokens: --", statusline_escape("tokens: --"), "", ""
	end

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
	local secondary_text, secondary_statusline = format_stat_parts(secondary_parts)
	return primary_text, primary_statusline, secondary_text, secondary_statusline
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
	if not state.is_streaming and not state.is_retrying then
		return ""
	end
	local label = state.is_retrying and "retry" or state.activity_label or "work"
	local tick = tonumber(state.activity_spinner_tick) or 1
	local frame = activity_spinner_frames[((tick - 1) % #activity_spinner_frames) + 1]
	return " " .. frame .. " " .. label
end

local function spawn_statusline_label(state)
	local count = tonumber(state.spawn_running_count) or 0
	if count <= 0 then
		return ""
	end
	return " 󰇥" .. tostring(count)
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
	local both_plain = limits_text ~= "" and (" " .. limits_text .. " · " .. stats_text .. " ") or ""
	local right_label = ""
	if both_plain ~= "" and vim.fn.strdisplaywidth(both_plain) <= available_right_width then
		right_label = "%#PiUsageStats# "
			.. statusline_escape(limits_text)
			.. " · "
			.. stats_statusline
			.. "%#PiUsageStats# "
	elseif limits_plain ~= "" and vim.fn.strdisplaywidth(limits_plain) <= available_right_width then
		right_label = "%#PiUsageStats# " .. statusline_escape(limits_text) .. " "
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
			.. "%#PiUsageStats#"
			.. statusline_escape(truncate_plain_to_width(integration_segment_label .. notification_segment_label .. workspace_label .. model_label .. thinking_label, width - mode_width))
			.. "%*"
	end

	left_label = left_label
		.. statusline_escape(status_delimiter)
		.. integration_statusline_highlight(integration_mode)
		.. statusline_escape(integration_label)
		.. "%#PiUsageStats#"
	if notification_label ~= "" then
		left_label = left_label
			.. statusline_escape(status_delimiter)
			.. notification_statusline_highlight(state.notification_status)
			.. statusline_escape(notification_label)
			.. "%#PiUsageStats#"
	end
	left_label = left_label
		.. statusline_escape(status_delimiter)
		.. workspace_statusline_highlight(state)
		.. statusline_escape(workspace_text)
		.. "%#PiUsageStats#"
		.. statusline_escape(model_label)
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
	local _, _, stats_text, stats_statusline = format_session_stats(state)
	local right_plain = stats_text ~= "" and (" " .. stats_text .. " ") or ""
	local right_width = vim.fn.strdisplaywidth(right_plain)
	local width = vim.api.nvim_win_get_width(state.status_win)

	if right_width >= width then
		return "%#PiUsageStats#" .. statusline_escape(truncate_plain_to_width(right_plain, width)) .. "%*"
	end

	local gap_width = left_text ~= "" and right_plain ~= "" and 3 or 0
	local available_left_width = math.max(0, width - right_width - gap_width)
	local visible_left = truncate_plain_to_width(left_text, available_left_width)
	local left_label = "%#PiUsageStats#" .. statusline_escape(visible_left)
	if visible_left == left_text and activity_label ~= "" then
		left_label = "%#PiActivity#" .. statusline_escape(activity_label) .. "%#PiUsageStats#" .. statusline_escape(spawn_label)
	end
	local right_label = stats_text ~= "" and ("%#PiUsageStats# " .. stats_statusline .. "%#PiUsageStats# ") or ""
	return left_label .. "%#PiUsageStats#%=" .. right_label .. "%*"
end

local function close_footer(state)
	if state.status_win and vim.api.nvim_win_is_valid(state.status_win) then
		pcall(vim.api.nvim_win_close, state.status_win, true)
	end
	state.status_win = nil
end

local function ensure_footer_buffer(state)
	if state.status_buf and vim.api.nvim_buf_is_valid(state.status_buf) then
		return state.status_buf
	end
	local buf = vim.api.nvim_create_buf(false, true)
	vim.api.nvim_buf_set_name(buf, "pi://status")
	vim.api.nvim_set_option_value("buftype", "nofile", { buf = buf })
	vim.api.nvim_set_option_value("bufhidden", "hide", { buf = buf })
	vim.api.nvim_set_option_value("swapfile", false, { buf = buf })
	vim.api.nvim_set_option_value("modifiable", false, { buf = buf })
	state.status_buf = buf
	return buf
end

local function footer_is_bottom(state)
	local tab = vim.api.nvim_win_get_tabpage(state.status_win)
	local tab_number = vim.api.nvim_tabpage_get_number(tab)
	local layout = vim.fn.winlayout(tab_number)
	if layout[1] ~= "col" then
		return false
	end
	local children = layout[2]
	local bottom = children[#children]
	return bottom and bottom[1] == "leaf" and bottom[2] == state.status_win
end

local function normalize_footer_window(state)
	local transcript_tab = vim.api.nvim_win_get_tabpage(state.transcript_win)
	if vim.api.nvim_get_current_tabpage() == transcript_tab then
		local footer_tab = vim.api.nvim_win_get_tabpage(state.status_win)
		if footer_tab ~= transcript_tab or not footer_is_bottom(state) then
			pcall(vim.api.nvim_win_set_config, state.status_win, { split = "below", win = -1 })
		end
	end
	if vim.api.nvim_win_get_height(state.status_win) ~= footer_height then
		pcall(vim.api.nvim_win_set_height, state.status_win, footer_height)
	end
end

local function apply_footer_window_options(win)
	vim.api.nvim_set_option_value("wrap", false, { win = win })
	vim.api.nvim_set_option_value("winbar", "", { win = win })
	vim.api.nvim_set_option_value("fillchars", "stl: ,stlnc: ", { win = win })
	vim.api.nvim_set_option_value("statusline", "", { win = win })
	vim.api.nvim_set_option_value("winfixheight", true, { win = win })
	vim.api.nvim_set_option_value("winfixbuf", true, { win = win })
	vim.api.nvim_set_option_value("winhl", "Normal:PiStatusFooterNormal,EndOfBuffer:PiStatusFooterNormal", { win = win })
end

local function ensure_footer_window(state, buf)
	if state.status_win and vim.api.nvim_win_is_valid(state.status_win) then
		normalize_footer_window(state)
		return state.status_win
	end
	if vim.api.nvim_get_current_tabpage() ~= vim.api.nvim_win_get_tabpage(state.transcript_win) then
		return nil
	end
	local opened, win = pcall(vim.api.nvim_open_win, buf, false, {
		split = "below",
		win = -1,
		height = footer_height,
		focusable = false,
		style = "minimal",
	})
	if not opened then
		return nil
	end
	apply_footer_window_options(win)
	pcall(vim.api.nvim_win_set_height, win, footer_height)
	state.status_win = win
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
			vim.api.nvim_buf_set_extmark(buf, footer_ns, row, item.start, {
				end_col = end_col,
				hl_group = { item.group, "PiStatusFooter" },
				priority = 100,
			})
		end
	end
end

local function render_footer(ctx, buf, width)
	local primary = evaluate_statusline(M.render(ctx), ctx.state.status_win, width)
	vim.api.nvim_set_option_value("modifiable", true, { buf = buf })
	vim.api.nvim_buf_set_lines(buf, 0, -1, false, { primary.str })
	vim.api.nvim_set_option_value("modifiable", false, { buf = buf })
	vim.api.nvim_buf_clear_namespace(buf, footer_ns, 0, -1)
	apply_evaluated_highlights(buf, 0, primary)
	vim.api.nvim_set_option_value("statusline", M.render_secondary(ctx), { win = ctx.state.status_win })
end

function M.setup(ctx)
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

	local footer_group = vim.api.nvim_create_augroup("PiNvimStatusFooter", { clear = true })
	vim.api.nvim_create_autocmd({ "VimResized", "WinResized", "WinNew", "WinClosed", "TabEnter" }, {
		group = footer_group,
		desc = "Keep the pi-console status footer at the bottom",
		callback = schedule_update,
	})
	vim.api.nvim_create_autocmd("WinEnter", {
		group = footer_group,
		desc = "Keep focus out of the pi-console status footer",
		callback = function()
			local state = ctx.state
			if not state.status_win or vim.api.nvim_get_current_win() ~= state.status_win then
				return
			end
			local previous_win = vim.fn.win_getid(vim.fn.winnr("#"))
			if previous_win ~= state.status_win and vim.api.nvim_win_is_valid(previous_win) then
				vim.api.nvim_set_current_win(previous_win)
			elseif ctx.transcript.win_valid() then
				vim.api.nvim_set_current_win(state.transcript_win)
			end
		end,
	})
	vim.api.nvim_create_autocmd("SafeState", {
		group = footer_group,
		desc = "Restore the pi-console status footer after window commands",
		callback = function()
			local state = ctx.state
			if ctx.transcript.win_valid() and state.status_win and vim.api.nvim_win_is_valid(state.status_win) then
				normalize_footer_window(state)
			end
		end,
	})
end

function M.update(ctx)
	local state = ctx.state
	if not ctx.transcript.win_valid() then
		close_footer(state)
		return
	end
	local buf = ensure_footer_buffer(state)
	local win = ensure_footer_window(state, buf)
	if not win then
		return
	end
	local width = vim.api.nvim_win_get_width(win)
	if width < 1 then
		close_footer(state)
		return
	end
	render_footer(ctx, buf, width)
	vim.cmd("redraw")
end

return M
