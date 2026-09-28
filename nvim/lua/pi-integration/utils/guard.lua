local M = {}

function M.active_run_message(ctx, action)
	local prefix = ctx.state.is_retrying and "Pi is retrying" or "Pi is still running"
	return prefix .. "; wait or abort before " .. action .. "."
end

function M.is_agent_active(ctx)
	return ctx.session.is_agent_active and ctx.session.is_agent_active()
end

function M.if_not_active(ctx, action)
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
	vim.ui.select({ "Continue", "Cancel" }, { prompt = prompt }, function(choice)
		if choice == "Continue" then
			proceed()
		end
	end)
end

return M
