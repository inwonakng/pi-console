-- Shared by the compact overview and managed tmux window titles.
-- Colors match the dedicated frontend's Catppuccin Frappe palette.
local M = {}
local colors = {
	blue = "#8caaee",
	yellow = "#e5c890",
	green = "#a6d189",
	mauve = "#ca9ee6",
	muted = "#737994",
	red = "#e78284",
}
local styles = {
	Done = { icon = "", color = colors.green },
	Working = { icon = "", color = colors.blue },
	Waiting = { icon = "", color = colors.yellow },
	Compacting = { icon = "", color = colors.mauve },
	Loading = { icon = "", color = colors.blue },
	Idle = { icon = "", color = colors.muted },
	Error = { icon = "", color = colors.red },
	["Not Open"] = { icon = "", color = colors.muted },
}
styles.Retrying = styles.Working
styles.Starting = styles.Loading
styles.Stopped = styles.Error
styles.Unresponsive = styles.Error

function M.get(status)
	return styles[status] or styles.Error
end

function M.tab_name(status)
	local icon = M.get(status).icon
	return icon .. string.rep(" ", math.max(0, 2 - vim.fn.strdisplaywidth(icon)))
end

function M.highlight(status)
	local style = M.get(status)
	local name = "PiSessionStatus" .. style.color:sub(2)
	vim.api.nvim_set_hl(0, name, { fg = style.color })
	return name
end

return M
