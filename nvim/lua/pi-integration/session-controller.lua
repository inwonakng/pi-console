local guard = require("pi-integration.utils.guard")
local runtime = require("pi-integration.runtime")
local pending_picker = require("pi-integration.pending-picker")

local M = {}

local function reset_conversation(ctx, keep_transcript, keep_pending_messages, session_file)
	local state = ctx.state
	local pending_user_messages = keep_pending_messages and state.pending_user_messages or {}
	if not keep_pending_messages then
		require("pi-integration.queue").close_editors(ctx)
	end
	pending_picker.clear(ctx, false)
	state.pending_ui_requests = {}
	state.active_ui_request_id = nil
	state.pending_user_messages = pending_user_messages
	state.session_name = nil
	state.message_count = 0
	state.has_sent_message = false
	state.session_stats = nil
	state.todo_status = nil
	state.todo_tool_output_id = nil
	state.tree_leaf_id = nil
	-- Startup status can arrive before get_state. Keep only the snapshot
	-- explicitly owned by the incoming session; never carry the old session.
	if not session_file or state.spawn_runs_session_file ~= session_file then
		state.spawn_runs = {}
		state.spawn_runs_session_file = nil
		state.spawn_running_count = 0
	end
	state.spawn_run_output_by_id = {}
	state.is_agent_running = false
	state.refresh_transcript_after_settled = false
	state.is_retrying = false
	state.pending_retry_error = nil
	state.assistant_block_open = false
	ctx.session.reset_outputs()
	ctx.transcript.clear_items()
	ctx.transcript.touch()
	if not keep_transcript and ctx.buffer.valid(state.transcript_buf) then
		for _, win in ipairs(vim.api.nvim_list_wins()) do
			if vim.api.nvim_win_get_buf(win) == state.transcript_buf then
				vim.api.nvim_win_set_cursor(win, { 1, 0 })
			end
		end
		ctx.buffer.set_lines(state.transcript_buf, {}, false)
	end
end

function M.apply_state(ctx, data, new_session)
	local state = ctx.state
	local session_changed = data.sessionFile ~= state.session_file
	local restore_transcript = not new_session and session_changed
		and type(data.sessionFile) == "string" and vim.fn.filereadable(data.sessionFile) == 1
	local previous_leaf_id = state.tree_leaf_id
	local sent_before_sync = state.has_sent_message
	if new_session or session_changed then
		reset_conversation(ctx, restore_transcript, state.is_loading and not new_session and not state.session_replacement_pending, data.sessionFile)
	end
	state.session_file = data.sessionFile
	state.pending_session_file = nil
	state.session_name = data.sessionName
	state.message_count = data.messageCount or state.message_count
	state.has_sent_message = (not new_session and sent_before_sync) or (tonumber(state.message_count) or 0) > 0
	state.is_streaming = data.isStreaming or false
	-- isStreaming can be false between agent_end and agent_settled. An ordinary
	-- state sync must not release the queue before the settlement event.
	state.is_agent_running = state.is_agent_running or state.is_streaming
	state.is_compacting = data.isCompacting or false
	state.thinking_level = data.thinkingLevel or data.thinking_level or state.thinking_level
	ctx.session.set_model_metadata(data.provider or data.providerId or data.providerName, data.model or data.modelId)
	if restore_transcript then
		ctx.actions.restore_session_transcript(data.sessionFile, previous_leaf_id)
	end
	ctx.transcript.refresh_ui()
	runtime.publish()
end

function M.sync(ctx, options)
	options = options or {}
	local state = ctx.state
	-- Startup performs the initial sync after assigning the job. Hand off the
	-- caller's options instead of creating two competing sync generations.
	if not state.job and not state.rpc_tearing_down then
		require("pi-integration.rpc").start(ctx, options)
		return
	end
	state.session_sync_generation = (state.session_sync_generation or 0) + 1
	local generation = state.session_sync_generation
	local function fail_sync(message)
		state.session_replacement_pending = false
		state.session_sync_complete = false
		ctx.events.set_loading(false)
		state.loading_error = message
		ctx.actions.fail_pending_prompts()
		ctx.ui.notify(message, vim.log.levels.ERROR)
	end
	ctx.rpc.send({ type = "get_state" }, function(event)
		if generation ~= state.session_sync_generation then
			return
		end
		if not event.success or not event.data then
			fail_sync(event.error or "Could not get Pi session state")
			return
		end
		M.apply_state(ctx, event.data, options.new_session)
		ctx.rpc.send({ type = "get_commands" }, function(commands_event)
			if generation ~= state.session_sync_generation then
				return
			end
			if not commands_event.success or not commands_event.data then
				fail_sync(commands_event.error or "Could not discover Pi commands")
				return
			end
			state.command_sources = {}
			for _, command in ipairs(commands_event.data.commands or {}) do
				if type(command.name) == "string" then
					state.command_sources[command.name] = command.source
				end
			end
			if not state.command_sources["pi-trust-setup"] then
				fail_sync("The pi-console project trust extension is missing; enable or update the global pi-console package.")
				return
			end
			state.trust_status = nil
			ctx.rpc.send({ type = "prompt", message = "/pi-trust-setup" }, function(trust_event)
				if generation ~= state.session_sync_generation then return end
				local status = state.trust_status
				if not trust_event.success or not status or status.state == "error" then
					fail_sync((status and status.error) or trust_event.error or "Project trust setup returned no result")
					return
				end
				if status.state == "restart" then
					require("pi-integration.rpc").restart(ctx, { trust_setup = true })
					return
				end
				if status.state ~= "ready" then
					fail_sync("Project trust setup did not finish")
					return
				end
				local function finish(publish_event)
					if generation ~= state.session_sync_generation then return end
					if publish_event and not publish_event.success then
						fail_sync(publish_event.error or "Could not publish workspace state")
						return
					end
					state.session_sync_complete = true
					state.session_replacement_pending = false
					ctx.actions.finish_loading_if_ready()
					ctx.actions.refresh_messages()
					ctx.actions.refresh_session_stats()
					if options.on_success then options.on_success() end
				end
				if options.publish_workspace then
					ctx.rpc.send({ type = "prompt", message = "/pi-workspace-publish" }, finish)
				else
					finish()
				end
			end)
		end)
	end)
end

function M.new_session(ctx)
	if not guard.if_history_change_allowed(ctx, "starting another session") then return end
	require("pi-integration.rpc").restart(ctx, { fresh_session = true })
end

function M.new_session_window(ctx)
	local workspace = ctx.state.workspace
	local cwd = (workspace and (workspace.directory or workspace.cwd)) or vim.fn.getcwd()
	local launched, err = runtime.launch(ctx.config.launcher, cwd)
	if not launched then
		ctx.ui.notify(err or "Could not start a new session in a new window", vim.log.levels.ERROR)
	end
end

function M.switch_session(ctx, path)
	if not guard.if_history_change_allowed(ctx, "switching sessions") then return end
	require("pi-integration.rpc").restart(ctx, { session_file = runtime.canonical_path(path) })
end

return M
