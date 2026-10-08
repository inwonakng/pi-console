local lifecycle = require("pi-integration.state")

local M = {}

function M.request(ctx)
	local state = ctx.state
	local path = ctx.config.restart_file
	if not path or path == "" then
		ctx.ui.notify("Full-console restart requires launching through pi-console.", vim.log.levels.WARN)
		return
	end
	local reason = lifecycle.restart_block_reason(state)
	if reason then
		ctx.ui.notify(reason, vim.log.levels.WARN)
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
