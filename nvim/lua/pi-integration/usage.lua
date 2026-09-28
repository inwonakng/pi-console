local floats = require("pi-integration.floats")

local M = {}

local USAGE_BAR_WIDTH = 20

local function valid_win(win)
	return win and vim.api.nvim_win_is_valid(win)
end

local function format_percent(value)
	value = tonumber(value)
	if not value then
		return "--"
	end
	return string.format("%.0f%%", value)
end

local function format_usage_bar(remaining)
	remaining = tonumber(remaining)
	if not remaining then
		return string.rep("░", USAGE_BAR_WIDTH)
	end

	local filled = math.floor((remaining / 100) * USAGE_BAR_WIDTH + 0.5)
	filled = math.max(0, math.min(USAGE_BAR_WIDTH, filled))
	return string.rep("█", filled) .. string.rep("░", USAGE_BAR_WIDTH - filled)
end

local function format_duration(seconds)
	seconds = math.max(0, math.floor(tonumber(seconds) or 0))
	if seconds == 0 then
		return "now"
	end

	local days = math.floor(seconds / 86400)
	local hours = math.floor((seconds % 86400) / 3600)
	local minutes = math.floor((seconds % 3600) / 60)
	local parts = {}
	if days > 0 then
		table.insert(parts, tostring(days) .. "d")
	end
	if hours > 0 then
		table.insert(parts, tostring(hours) .. "h")
	end
	if minutes > 0 or #parts == 0 then
		table.insert(parts, tostring(minutes) .. "m")
	end
	return table.concat(parts, " ")
end

local function append_window(lines, title, window)
	if type(window) ~= "table" then
		return
	end

	local used = tonumber(window.usedPercent)
	local remaining = used and math.max(0, math.min(100, 100 - used)) or nil
	vim.list_extend(lines, {
		"## " .. title,
		"",
		"Remaining: **" .. format_percent(remaining) .. "**",
		"`" .. format_usage_bar(remaining) .. "`",
	})

	local resets_at = tonumber(window.resetsAt)
	if resets_at then
		table.insert(lines, "- Resets: **" .. os.date("%Y-%m-%d %H:%M:%S %Z", resets_at) .. "**")
		table.insert(lines, "- Time remaining: **" .. format_duration(resets_at - os.time()) .. "**")
	end
	table.insert(lines, "")
end

local function usage_lines(state)
	local lines = { "# Codex Usage", "" }
	if state.provider ~= "openai-codex" then
		vim.list_extend(lines, {
			"Codex limits are shown only while the active provider is `openai-codex`.",
		})
		return lines
	end

	local usage = state.codex_usage
	if type(usage) ~= "table" then
		vim.list_extend(lines, {
			"Waiting for Codex usage data…",
		})
		return lines
	end

	if usage.stale == true then
		table.insert(lines, "> Data is stale; the last refresh failed.")
		table.insert(lines, "")
	end
	if tonumber(usage.updatedAt) then
		table.insert(lines, "Updated: " .. os.date("%Y-%m-%d %H:%M:%S %Z", tonumber(usage.updatedAt)))
		table.insert(lines, "")
	end

	local windows = type(usage.windows) == "table" and usage.windows or {}
	append_window(lines, "5-hour limit", windows.fiveHour)
	append_window(lines, "Weekly limit", windows.weekly)

	if not windows.fiveHour and not windows.weekly then
		table.insert(lines, "No 5-hour or weekly limit was returned.")
	end
	if type(usage.error) == "string" and usage.error ~= "" then
		vim.list_extend(lines, {
			"## Refresh error",
			"",
			usage.error,
		})
	end
	return lines
end

local function ensure_buffer(ctx)
	local state = ctx.state
	if ctx.buffer.valid(state.usage_buf) then
		return state.usage_buf
	end
	state.usage_buf = ctx.buffer.create("pi://usage", "markdown", false)
	return state.usage_buf
end

function M.refresh(ctx)
	local state = ctx.state
	if not ctx.buffer.valid(state.usage_buf) then
		return
	end
	ctx.buffer.set_lines(state.usage_buf, usage_lines(state), false)
end

function M.toggle(ctx)
	local state = ctx.state
	if valid_win(state.usage_win) then
		floats.close_window(state.usage_win)
		state.usage_win = nil
		return
	end

	local buf = ensure_buffer(ctx)
	M.refresh(ctx)
	local line_count = vim.api.nvim_buf_line_count(buf)
	local width = math.min(68, math.max(48, math.floor(vim.o.columns * 0.5)))
	local height = math.min(line_count + 2, math.max(8, math.floor(vim.o.lines * 0.5)))
	local row = math.max(1, math.floor((vim.o.lines - height) / 2))
	local col = math.max(0, math.floor((vim.o.columns - width) / 2))

	state.usage_win = vim.api.nvim_open_win(buf, true, {
		relative = "editor",
		width = width,
		height = height,
		row = row,
		col = col,
		style = "minimal",
		border = "rounded",
		title = " Pi Usage ",
		title_pos = "center",
	})

	local close_usage_win = function()
		floats.close_window(state.usage_win)
		state.usage_win = nil
	end
	floats.close_on_win_leave(buf, close_usage_win, { win = state.usage_win })
	vim.keymap.set("n", "q", close_usage_win, { buffer = buf, desc = "Close usage" })
	vim.keymap.set("n", "<Esc>", close_usage_win, { buffer = buf, desc = "Close usage" })

	ctx.rpc.send({ type = "prompt", message = "/pi-codex-usage-refresh" }, function(event)
		if not event.success then
			ctx.ui.notify(event.error or "Could not refresh Codex usage", vim.log.levels.ERROR)
		end
	end)
end

return M
