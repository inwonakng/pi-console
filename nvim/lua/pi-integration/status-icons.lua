-- Shared by the compact overview and managed tmux window titles.
-- Colors match the dedicated frontend's Catppuccin Frappe palette.
local M = { animation_interval_ms = 500 }
-- The conversation footer uses these same frames at its faster local cadence.
M.working_frames = { "⠖", "⠲", "⢒", "⢰", "⣰", "⣠", "⣄", "⣆" }
local loading_frames = { "󰞌", "󰔟", "󰚭" }
local colors = {
	blue = "#8caaee",
	yellow = "#e5c890",
	green = "#a6d189",
	mauve = "#ca9ee6",
	muted = "#737994",
	red = "#e78284",
}
local styles = {
	Done = { icon = "✓", color = colors.green, bold = true },
	Working = { frames = M.working_frames, color = colors.blue },
	Waiting = { icon = "", color = colors.yellow },
	Compacting = { icon = "", color = colors.mauve },
	Loading = { frames = loading_frames, color = colors.blue },
	Idle = { icon = "󰽥", color = colors.muted },
	Error = { icon = "", color = colors.red },
	["Not Open"] = { icon = "", color = colors.muted },
}
styles.Retrying = styles.Working
styles.Starting = styles.Loading
styles.Stopped = styles.Error
styles.Unresponsive = styles.Error

function M.get(status)
	local style = styles[status] or styles.Error
	if style.frames then
		-- Use subsecond monotonic time so the sidebar and tmux publisher can
		-- advance frames at the shared refresh interval without another timer.
		local tick = math.floor(vim.uv.hrtime() / (M.animation_interval_ms * 1000000))
		return { icon = style.frames[(tick % #style.frames) + 1], color = style.color }
	end
	return style
end

function M.tab_name(status)
	local icon = M.get(status).icon
	return icon .. string.rep(" ", math.max(0, 2 - vim.fn.strdisplaywidth(icon)))
end

function M.highlight(status)
	local style = M.get(status)
	local name = "PiSessionStatus" .. style.color:sub(2) .. (style.bold and "Bold" or "")
	vim.api.nvim_set_hl(0, name, { fg = style.color, bold = style.bold == true })
	return name
end

return M
