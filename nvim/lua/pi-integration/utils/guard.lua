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

function M.confirm_abort_active_run(ctx, action, proceed)
	if not M.is_agent_active(ctx) then
		proceed()
		return
	end
	local prompt = (ctx.state.is_retrying and "Pi is retrying" or "Pi is still running")
		.. ". "
		.. action
		.. " will abort the current run. Continue?"
	vim.ui.select({ "Continue", "Cancel" }, { prompt = prompt, pi_select_layout = "compact" }, function(choice)
		if choice == "Continue" then
			proceed()
		end
	end)
end

return M
