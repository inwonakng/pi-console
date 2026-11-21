local lifecycle = require("pi-integration.state")

local M = {}

function M.active_run_message(ctx, action)
	local prefix = ctx.state.is_retrying and "Pi is retrying" or "Pi is still running"
	return prefix .. "; wait or abort before " .. action .. "."
end

function M.is_agent_active(ctx)
	return lifecycle.is_agent_active(ctx.state)
end

function M.if_history_change_allowed(ctx, action)
	if M.is_agent_active(ctx) then
		ctx.ui.notify(M.active_run_message(ctx, action), vim.log.levels.WARN)
		return false
	end
	return true
end

return M
