local editor = require("pi-integration.utils.markdown-editor")
local lifecycle = require("pi-integration.state")

local M = {}

function M.open(ctx, text)
	local state = ctx.state
	if state.steer_win and vim.api.nvim_win_is_valid(state.steer_win) then
		vim.api.nvim_set_current_win(state.steer_win)
		return
	end
	if not lifecycle.is_agent_active(state) then
		ctx.ui.notify("Pi is idle; use the main input for a new prompt.", vim.log.levels.INFO)
		return
	end
	local session_file = state.session_file
	local process = state.rpc_process
	local _, win = editor.open({
		name = "pi://steer",
		title = " Steer (:wq to send, :q! to cancel) ",
		text = text or state.steer_draft or "",
		width = 90,
		height = 12,
		prepare_text = vim.trim,
	}, function(message)
		state.steer_win = nil
		if not message or message == "" then return end
		state.steer_draft = message
		if process ~= state.rpc_process or session_file ~= state.session_file then
			ctx.ui.notify("Session changed; steering message was not sent. Draft retained.", vim.log.levels.WARN)
			return
		end
		if not lifecycle.is_agent_active(state) then
			ctx.ui.notify("Pi finished before steering was sent. Draft retained.", vim.log.levels.WARN)
			return
		end
		ctx.rpc.send({ type = "steer", message = message }, function(event)
			if event.success then
				if state.steer_draft == message then state.steer_draft = nil end
				ctx.ui.notify("Steering message accepted.")
			else
				ctx.ui.notify(event.error or "Could not steer Pi; draft retained.", vim.log.levels.ERROR)
			end
		end)
	end)
	state.steer_win = win
end

return M
