local json = require("pi-integration.utils.json")
local pending_picker = require("pi-integration.pending-picker")
local lifecycle = require("pi-integration.state")
local tool_output = require("pi-integration.tool-output")

local M = {}

local function decode_json(ctx, line)
	local decoded = json.decode(line)
	if decoded ~= nil then
		return decoded
	end
	ctx.logs.add("error", "Bad JSON from pi", line)
	ctx.transcript.render_error_message("Pi Error", "Bad JSON from pi: " .. line)
	return nil
end

local function owns_process(state, process)
	return state.rpc_process == process and process.active
end

local function next_request_id(state)
	state.next_id = state.next_id + 1
	return "pi-console-" .. tostring(state.next_id)
end

local function complete_callback(ctx, callback, event)
	local ok, err = pcall(callback, event)
	if not ok then
		ctx.logs.add("error", "Pi RPC callback failed", tostring(err))
	end
end

local function failed_response(id, message)
	return { type = "response", id = id, success = false, error = message }
end

function M.handle_response(ctx, event)
	local state = ctx.state
	local callback = event.id and state.callbacks[event.id]
	if callback then
		state.callbacks[event.id] = nil
		complete_callback(ctx, callback, event)
		return
	end

	if event.success == false then
		local message = ctx.rpc.event_error_text(event) or vim.inspect(event)
		ctx.logs.add("error", "Pi RPC response failed", message)
		ctx.transcript.render_error_message("Pi Error", message)
	end
end

function M.handle_jsonl_data(ctx, data, pending_key)
	local state = ctx.state
	if not data then
		return
	end

	local process = state.rpc_process
	for i, chunk in ipairs(data) do
		if process and not owns_process(state, process) then
			return
		end
		if i == 1 then
			chunk = state[pending_key] .. chunk
		end

		if i < #data then
			chunk = chunk:gsub("\r$", "")
			if chunk ~= "" then
				local event = decode_json(ctx, chunk)
				if event then
					ctx.rpc.handle_event(event)
				end
			end
			if process and not owns_process(state, process) then
				return
			end
			state[pending_key] = ""
		else
			state[pending_key] = chunk
		end
	end
end

function M.argv(ctx)
	local state = ctx.state
	local config = ctx.config
	local args = { config.binary, "--mode", "rpc" }
	if state.pending_session_file and state.pending_session_file ~= "" then
		vim.list_extend(args, { "--session", vim.fn.expand(state.pending_session_file) })
	end
	if config.provider and config.provider ~= "" then
		vim.list_extend(args, { "--provider", config.provider })
	end
	if config.model and config.model ~= "" then
		vim.list_extend(args, { "--model", config.model })
	end
	if config.session_dir and config.session_dir ~= "" then
		vim.list_extend(args, { "--session-dir", vim.fn.expand(config.session_dir) })
	end
	return args
end

function M.job_env(ctx)
	if ctx.config.agent_dir and ctx.config.agent_dir ~= "" then
		return { PI_CODING_AGENT_DIR = vim.fn.expand(ctx.config.agent_dir) }
	end
	return nil
end

local function reset_runtime_state(ctx)
	local state = ctx.state
	for _, output_id in ipairs(tool_output.interrupt_executions(state)) do
		ctx.transcript.write_tool_output(output_id)
	end
	state.job = nil
	state.is_agent_running = false
	state.refresh_transcript_after_settled = false
	state.session_replacement_pending = false
	state.is_streaming = false
	state.is_retrying = false
	state.is_compacting = false
	state.is_loading = false
	state.workspace_status_received = false
	state.session_sync_complete = false
	pending_picker.clear(ctx, false)
	state.pending_ui_requests = {}
	state.active_ui_request_id = nil
	state.awaiting_agent_output = false
	state.pending_retry_error = nil
	if state.activity_timer then
		state.activity_timer:stop()
		state.activity_timer:close()
		state.activity_timer = nil
	end
	state.activity_label = nil
	state.activity_tool_call_id = nil
	state.activity_spinner_tick = 1
	state.abort_requested = false
	ctx.transcript.refresh_ui()
end

-- Detach requests and make the process unavailable before invoking application
-- callbacks. Failure handlers may send, but must not start a replacement here.
local function begin_teardown(ctx, message)
	local state = ctx.state
	if state.rpc_tearing_down then
		return
	end
	state.rpc_tearing_down = true
	local process = state.rpc_process
	if process then
		process.active = false
		process.draining = true
	end
	state.job = nil
	local callbacks = state.callbacks
	state.callbacks = {}
	ctx.actions.fail_pending_prompts()
	reset_runtime_state(ctx)
	for id, callback in pairs(callbacks) do
		complete_callback(ctx, callback, failed_response(id, message))
	end
	state.session_sync_generation = state.session_sync_generation + 1
	if process then
		process.draining = false
	end
end

local function finish_exit(ctx, process, code)
	local state = ctx.state
	if state.rpc_process ~= process or process.draining then
		return
	end
	local restarting = state.restart_requested
	if state.session_file and state.session_file ~= "" then
		state.pending_session_file = state.session_file
	end
	local awaiting_output = state.awaiting_agent_output
	ctx.logs.add(
		restarting and "info" or (code == 0 and "info" or "error"),
		(restarting and "pi exited for restart with code " or "pi exited with code ") .. tostring(code),
		ctx.rpc.recent_stderr_text()
	)
	if not restarting then
		if (ctx.transcript.assistant_placeholder_active() or awaiting_output) and not state.error_rendered_for_active_run then
			ctx.transcript.render_error_message(
				"Pi Error",
				ctx.rpc.recent_stderr_text() or ("pi exited with code " .. tostring(code) .. " before returning a message")
			)
		else
			ctx.transcript.append_status("pi exited with code " .. tostring(code))
		end
	end
	begin_teardown(ctx, "Pi exited with code " .. tostring(code))
	state.rpc_process = nil
	state.rpc_tearing_down = false
	local restart_requested = state.restart_requested
	state.restart_requested = false
	if restart_requested and M.start(ctx) then
		ctx.ui.notify("Pi restarted")
	end
end

local function stop_process(ctx, message)
	if ctx.state.rpc_tearing_down then
		return
	end
	local process = ctx.state.rpc_process
	begin_teardown(ctx, message)
	if process then
		if process.exit_code ~= nil then
			finish_exit(ctx, process, process.exit_code)
			return
		end
		local ok, stopped = pcall(vim.fn.jobstop, process.job)
		if not ok or stopped == 0 then
			ctx.logs.add("error", "Could not stop Pi; waiting for process exit", not ok and tostring(stopped) or nil)
		end
	else
		ctx.state.rpc_tearing_down = false
	end
end

function M.start(ctx, sync_options)
	local state = ctx.state
	if state.rpc_tearing_down then
		return false
	end
	if state.job and state.job > 0 then
		return true
	end
	local process = { active = true }
	state.rpc_process = process
	state.stdout_pending = ""
	state.stderr_pending = ""
	state.last_stderr_lines = {}
	state.error_rendered_for_active_run = false
	state.is_retrying = false
	state.pending_retry_error = nil
	state.workspace_status_received = false
	state.session_sync_complete = false
	ctx.events.set_loading(true)

	local started, job = pcall(vim.fn.jobstart, M.argv(ctx), {
		stdin = "pipe",
		env = M.job_env(ctx),
		stdout_buffered = false,
		stderr_buffered = false,
		on_stdout = function(_, data, _)
			vim.schedule(function()
				if owns_process(state, process) then
					M.handle_jsonl_data(ctx, data, "stdout_pending")
				end
			end)
		end,
		on_stderr = function(_, data, _)
			vim.schedule(function()
				if not owns_process(state, process) then
					return
				end
				for _, line in ipairs(data or {}) do
					if line ~= "" then
						table.insert(state.last_stderr_lines, line)
						if #state.last_stderr_lines > 20 then
							table.remove(state.last_stderr_lines, 1)
						end
						ctx.logs.add("stderr", line)
					end
					if ctx.config.show_stderr and line ~= "" then
						ctx.transcript.append_status("pi stderr: " .. line)
					end
				end
			end)
		end,
		on_exit = function(_, code, _)
			process.exit_code = code
			vim.schedule(function()
				finish_exit(ctx, process, code)
			end)
		end,
	})

	if not started or job <= 0 then
		local message = "Failed to start pi. Is `pi` on PATH?"
		if not started then
			message = message .. " " .. tostring(job)
		end
		ctx.logs.add("error", message)
		ctx.ui.notify(message, vim.log.levels.ERROR)
		begin_teardown(ctx, message)
		state.rpc_process = nil
		state.rpc_tearing_down = false
		state.loading_error = message
		return false
	end
	process.job = job
	state.job = job

	local options = vim.tbl_extend("force", { publish_workspace = true }, sync_options or {})
	local on_success = options.on_success
	options.on_success = function()
		require("pi-integration.directory-history").record(vim.fn.getcwd())
		ctx.actions.maybe_prompt_session_archive()
		if on_success then
			on_success()
		end
	end
	ctx.session.sync(options)
	if state.pending_access_mode then
		local mode = state.pending_access_mode
		M.send(ctx, { type = "prompt", message = "/pi-mode " .. mode }, function(event)
			if event.success then
				state.pending_access_mode = nil
			else
				ctx.ui.notify(event.error or "Could not set access mode", vim.log.levels.ERROR)
			end
		end)
	end
	if state.pending_integration_mode then
		local mode = state.pending_integration_mode
		M.send(ctx, { type = "prompt", message = "/pi-integration-mode " .. mode }, function(event)
			if event.success then
				state.pending_integration_mode = nil
			else
				ctx.ui.notify(event.error or "Could not set integration mode", vim.log.levels.ERROR)
			end
		end)
	end
	return state.job ~= nil and state.job > 0
end

function M.send(ctx, cmd, callback)
	local state = ctx.state
	if state.rpc_tearing_down then
		if callback then
			complete_callback(ctx, callback, failed_response(cmd.id, "Pi is stopping; request was not sent."))
		end
		return
	end
	if not M.start(ctx) then
		local tearing_down = state.rpc_tearing_down
		state.rpc_tearing_down = true
		local message = state.loading_error or "Could not start pi. Is `pi` on PATH?"
		ctx.logs.add("error", message)
		ctx.transcript.render_error_message("Pi Error", message)
		if callback then
			complete_callback(ctx, callback, failed_response(cmd.id, message))
		end
		state.rpc_tearing_down = tearing_down
		return
	end

	if callback then
		cmd.id = cmd.id or next_request_id(state)
		if state.callbacks[cmd.id] then
			complete_callback(ctx, callback, failed_response(cmd.id, "Pi request ID is already pending."))
			return
		end
		state.callbacks[cmd.id] = callback
	end

	local encoded, line = pcall(json.encode, cmd)
	if not encoded or not line then
		local message = "Could not encode Pi request: " .. tostring(line)
		ctx.logs.add("error", message)
		if callback then
			state.callbacks[cmd.id] = nil
			complete_callback(ctx, callback, failed_response(cmd.id, message))
		end
		return
	end
	local sent, bytes = pcall(vim.fn.chansend, state.job, line .. "\n")
	if not sent or bytes == 0 then
		local message = "Could not send request to pi; the RPC channel is closed."
		ctx.logs.add("error", message, not sent and tostring(bytes) or nil)
		ctx.transcript.render_error_message("Pi Error", message)
		stop_process(ctx, message)
	end
end

function M.can_restart(ctx)
	local reason = lifecycle.restart_block_reason(ctx.state)
	if reason then
		ctx.ui.notify(reason, vim.log.levels.WARN)
		return false
	end
	return true
end

function M.restart(ctx, options)
	local state = ctx.state
	options = options or {}
	if not M.can_restart(ctx) then
		return
	end

	pending_picker.clear(ctx, true)
	if options.fresh_session then
		state.session_file = nil
		state.pending_session_file = nil
		state.session_name = nil
		state.message_count = 0
		state.has_sent_message = false
	else
		local session_file = state.session_file or state.pending_session_file
		if session_file and session_file ~= "" then
			state.pending_session_file = session_file
		end
	end
	if state.access_mode and state.access_mode ~= "" then
		state.pending_access_mode = state.access_mode
	end
	if state.integration_mode and state.integration_mode ~= "" then
		state.pending_integration_mode = state.integration_mode
	end
	if state.rpc_process then
		state.restart_requested = true
		ctx.ui.notify("Restarting Pi...")
		stop_process(ctx, "Pi restarted; request was not completed.")
		return
	end

	if M.start(ctx) then
		ctx.ui.notify("Pi restarted")
	end
end

function M.stop(ctx)
	ctx.state.restart_requested = false
	stop_process(ctx, "Pi stopped; request was not completed.")
end

return M
