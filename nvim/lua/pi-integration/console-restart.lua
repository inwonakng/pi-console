local M = {}

function M.request(ctx)
	local state = ctx.state
	local path = ctx.config.restart_file
	if not path or path == "" then
		ctx.ui.notify("Full-console restart requires launching through pi-console.", vim.log.levels.WARN)
		return
	end
	if
		state.is_streaming or state.is_retrying or state.awaiting_agent_output or state.is_compacting
		or state.is_loading or state.restart_requested or (state.spawn_running_count or 0) > 0
		or (state.workspace and state.workspace.transitionPending)
	then
		ctx.ui.notify("Wait for the current Pi work to finish before restarting pi-console.", vim.log.levels.WARN)
		return
	end
	for _, pending in ipairs(state.pending_user_messages or {}) do
		if pending.status == "queued" or pending.status == "sending" then
			ctx.ui.notify("Wait for pending prompts to finish before restarting pi-console.", vim.log.levels.WARN)
			return
		end
	end
	if state.active_ui_request_id then
		ctx.ui.notify("Resolve the pending Pi request before restarting pi-console.", vim.log.levels.WARN)
		return
	end
	for _, buf in ipairs(vim.api.nvim_list_bufs()) do
		if vim.bo[buf].modified and vim.bo[buf].buftype ~= "nofile" then
			ctx.ui.notify("Save or discard modified file buffers before restarting pi-console.", vim.log.levels.WARN)
			return
		end
	end

	local input_lines = ctx.buffer.valid(state.input_buf)
		and vim.api.nvim_buf_get_lines(state.input_buf, 0, -1, false) or { "" }
	local snapshot = {
		cwd = vim.fn.getcwd(),
		session_file = state.session_file or state.pending_session_file,
		input_lines = input_lines,
		access_mode = state.access_mode,
		integration_mode = state.integration_mode,
	}
	local ok, err = pcall(function()
		assert(vim.fn.writefile({ vim.json.encode(snapshot) }, path) == 0, "Could not write restart state")
		-- Do not force quit: VimLeavePre performs the existing Pi shutdown.
		vim.cmd("qall")
	end)
	if not ok then
		vim.fn.delete(path)
		ctx.ui.notify("Could not restart pi-console: " .. tostring(err), vim.log.levels.ERROR)
	end
end

return M
