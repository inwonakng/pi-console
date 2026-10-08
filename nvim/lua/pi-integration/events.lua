local M = {}

local json = require("pi-integration.utils.json")
local message_utils = require("pi-integration.utils.message")
local pi_tool_output = require("pi-integration.tool-output")
local pi_skills = require("pi-integration.skills")
local pi_thinking_output = require("pi-integration.thinking-output")
local pi_usage = require("pi-integration.usage")
local pending_picker = require("pi-integration.pending-picker")

local function run_id(run)
	if type(run) ~= "table" then
		return nil
	end
	return run.runId or run.id
end

local function normalize_leaf_id(value)
	if value == vim.NIL or value == "" then
		return false
	end
	if type(value) == "string" then
		return value
	end
	return nil
end

local function schedule_transcript_refresh(ctx)
	local state = ctx.state
	local job, session, generation = state.job, state.session_file, state.session_sync_generation
	if not job or job <= 0 then
		return
	end
	vim.defer_fn(function()
		-- Do not turn a live transcript into an offline cached-branch replay after exit.
		if state.job ~= job or state.session_file ~= session or state.session_sync_generation ~= generation then
			return
		end
		if not state.is_agent_running and not state.is_streaming and not state.is_retrying
			and not state.awaiting_agent_output and not state.is_loading and not state.is_compacting then
			ctx.actions.refresh_messages()
		end
	end, 50)
end

local stop_activity

local function start_activity(ctx, label, tool_call_id)
	local state = ctx.state
	state.activity_label = label or state.activity_label or "work"
	state.activity_tool_call_id = tool_call_id or state.activity_tool_call_id
	if state.activity_timer then
		ctx.transcript.update_statusline()
		return
	end
	state.activity_spinner_tick = 1
	local timer = vim.uv.new_timer()
	state.activity_timer = timer
	timer:start(0, 250, vim.schedule_wrap(function()
		if state.activity_timer ~= timer then
			return
		end
		if not state.is_agent_running and not state.is_streaming and not state.is_retrying and not state.is_loading and not state.awaiting_agent_output then
			stop_activity(ctx)
			return
		end
		state.activity_spinner_tick = (state.activity_spinner_tick % 8) + 1
		ctx.transcript.update_statusline()
	end))
end

stop_activity = function(ctx)
	local state = ctx.state
	if state.activity_timer then
		state.activity_timer:stop()
		state.activity_timer:close()
		state.activity_timer = nil
	end
	state.activity_label = nil
	state.activity_tool_call_id = nil
	state.activity_spinner_tick = 1
	ctx.transcript.update_statusline()
end

function M.set_loading(ctx, loading)
	ctx.state.is_loading = loading == true
	if ctx.state.is_loading then
		ctx.state.loading_error = nil
		start_activity(ctx, "loading")
	elseif not ctx.state.is_agent_running and not ctx.state.is_streaming and not ctx.state.is_retrying and not ctx.state.awaiting_agent_output then
		stop_activity(ctx)
	else
		ctx.transcript.update_statusline()
	end
end

function M.start_activity(ctx, label)
	start_activity(ctx, label)
end

local function update_spawn_run_output(ctx, run, text)
	local id = run_id(run)
	if type(id) ~= "string" or id == "" then
		return false
	end
	local owner = ctx.state.spawn_run_output_by_id[id]
	if not owner or not ctx.state.tool_items_by_output[owner] then return false end
	ctx.transcript.touch()
	local output_id = pi_tool_output.store_or_update_spawn_run(ctx.state, run, text)
	if not output_id then
		return false
	end
	ctx.transcript.write_tool_output(output_id)
	return true
end

local function render_spawn_runs(ctx, runs)
	if type(runs) ~= "table" then
		return false
	end
	local rendered = false
	for _, run in ipairs(runs) do
		rendered = update_spawn_run_output(ctx, run) or rendered
	end
	return rendered
end

local function update_spawn_details(ctx, name, details, text)
	if name ~= "spawn" and name ~= "spawn_control" then return false, details end
	local updated, remaining, represented = pi_tool_output.update_spawn_outputs(ctx.state, details, text)
	if #updated > 0 then ctx.transcript.touch() end
	for _, output_id in ipairs(updated) do ctx.transcript.write_tool_output(output_id) end
	return represented, remaining
end

local function render_tool_output(ctx, event, text, details, display)
	local is_error = event.isError
	if type(event.result) == "table" then
		is_error = is_error == true or event.result.isError == true
	end
	if event.toolName == "spawn_control" then
		-- Control calls update the original spawn outputs, not their own trace rows.
		local call = ctx.state.tool_calls[event.toolCallId]
		if not is_error and details == nil and call and call.execution_status == "running" then return nil end
		local represented, remaining = update_spawn_details(ctx, event.toolName, details, not is_error and text or nil)
		if not is_error and represented then return nil end
		if not is_error then details = remaining end
	end
	local output_id = pi_tool_output.store_or_update_live(
		ctx.state, event.toolName or "tool",
		event.toolCallId,
		text or "",
		nil,
		details,
		display,
		is_error
	)
	ctx.transcript.write_tool_output(output_id)
	return output_id
end

local function render_spawn_custom_tool(ctx, message)
	local name = message_utils.spawn_custom_tool_name(message)
	if not name then
		return false
	end
	local text = ctx.messages.extract_text(message) or ""
	local represented, remaining = update_spawn_details(ctx, name, message.details, name ~= "spawn" and text or nil)
	if not represented then
		local output_id = pi_tool_output.store(ctx.state, "spawn_control", text, nil, remaining)
		ctx.transcript.write_tool_output(output_id)
	end
	return true
end

local function refresh_todo_output(ctx)
	local state = ctx.state
	local output_id = state.todo_tool_output_id
	if output_id and state.tool_outputs and state.tool_outputs[output_id] then
		ctx.transcript.touch()
		ctx.transcript.write_tool_output(output_id)
	end
end

local function render_skill_loads(ctx, message)
	local loads = pi_skills.collect_loads(ctx.state, message)
	if #loads == 0 then
		return false
	end
	ctx.transcript.ensure_assistant_turn_started("Assistant")
	ctx.transcript.begin_trace_item()
	for _, load in ipairs(loads) do
		local output_id = pi_skills.store_load(ctx.state, load)
		ctx.transcript.append_lines(pi_skills.summary_lines(ctx.state, output_id))
		local line = ctx.transcript.line_count()
		ctx.transcript.register_item({
			kind = "skill",
			start_line = line,
			end_line = line,
			output_id = output_id,
		})
	end
	ctx.transcript.end_trace_item()
	return true
end

function M.render_message(ctx, message)
	local role = message.role or message.type or "message"
	if render_spawn_custom_tool(ctx, message) then
		return
	end
	if role == "custom" and message.display == false then
		return
	end
	local text = ctx.messages.extract_text(message) or ""
	if role ~= "toolResult" and text == "" then
		return
	end
	ctx.state.awaiting_agent_output = false
	ctx.transcript.touch()
	if role == "toolResult" then
		local name = message.toolName or "tool"
		local tool_call_id = message_utils.tool_call_id(message)
		pi_tool_output.record_execution_call(ctx.state, name, tool_call_id, nil, "completed")
		if name == "spawn" and not message.isError and not pi_tool_output.live_output_id(ctx.state, tool_call_id)
			and update_spawn_details(ctx, name, message.details, text) then
			return
		end
		local output_id = render_tool_output(ctx, {
			toolName = name,
			toolCallId = tool_call_id,
			isError = message.isError,
		}, text, message.details, pi_tool_output.display_for_result(ctx.state, message))
		return
	end
	ctx.transcript.append_message_header(role:gsub("^%l", string.upper))
	ctx.transcript.append_text(text)
end

local function send_extension_ui_response(ctx, id, response)
	if not ctx.state.pending_ui_requests[id] then
		return
	end
	ctx.state.pending_ui_requests[id] = nil
	if ctx.state.active_ui_request_id == id then
		ctx.state.active_ui_request_id = nil
	end
	response.type = "extension_ui_response"
	response.id = id
	ctx.rpc.send(response)
end

local function decode_approval_payload(message)
	if type(message) ~= "string" or message == "" then
		return nil
	end
	local decoded = json.decode_object(message)
	if not decoded or decoded.kind ~= "pi_approval_preview" then
		return nil
	end
	return decoded
end

local function decode_question_payload(title, expected_kind)
	if type(title) ~= "string" or title == "" then
		return nil
	end
	local payload = json.decode_object(title)
	if not payload or payload.kind ~= expected_kind or type(payload.question) ~= "string" then
		return nil
	end
	return payload
end

local function decode_compact_select_payload(title)
	local payload = type(title) == "string" and json.decode_object(title)
	if not payload or payload.kind ~= "pi_compact_select" or type(payload.prompt) ~= "string" then
		return nil
	end
	return payload
end

local function compact_request_text(value, max_chars)
	if type(value) ~= "string" then
		return nil
	end
	value = vim.trim(value:gsub("%s+", " "))
	if value == "" then
		return nil
	end
	if vim.fn.strchars(value) > max_chars then
		return vim.fn.strcharpart(value, 0, max_chars - 1) .. "…"
	end
	return value
end

local function request_has_option(event, expected)
	for _, option in ipairs(type(event.options) == "table" and event.options or {}) do
		if option == expected then
			return true
		end
	end
	return false
end

local function summarize_ui_request(event)
	local approval = decode_approval_payload(event.message) or decode_approval_payload(event.title)
	if approval then
		local tool = compact_request_text(approval.tool, 40) or "tool"
		return {
			label = "Tool permission",
			question = "Allow " .. tool .. "?",
			context = compact_request_text(approval.summary, 240),
		}
	end

	local question_select = decode_question_payload(event.title, "pi_question_select")
	if question_select then
		return {
			label = "Choice requested",
			question = compact_request_text(question_select.question, 360) or "Pi needs input.",
		}
	end

	local question_response = decode_question_payload(event.title, "pi_question_response")
	if question_response then
		return {
			label = "Question response",
			question = compact_request_text(question_response.question, 360) or "Write a response to Pi's question.",
		}
	end

	local compact_select = decode_compact_select_payload(event.title)
	local title = compact_request_text(compact_select and compact_select.prompt or event.title, 360)
	local message = compact_request_text(event.message, 360)
	if request_has_option(event, "Integrate and return") then
		return {
			label = "Workspace integration",
			question = title or "Apply the workspace changes?",
			context = "Choose whether to integrate, review, or return to the conversation.",
		}
	end

	local labels = {
		select = "Choice requested",
		confirm = "Confirmation requested",
		input = "Input requested",
	}
	local options
	if event.method == "select" and type(event.options) == "table" then
		local visible = {}
		for _, option in ipairs(event.options) do
			local value = compact_request_text(option, 80)
			if value then
				table.insert(visible, value)
			end
		end
		options = #visible > 0 and table.concat(visible, " · ") or nil
	end
	return {
		label = labels[event.method] or "Input requested",
		question = title or "Pi needs input.",
		context = message or options,
	}
end

local function approval_select_opts(payload, prompt)
	local header = {}
	local function field(key, value)
		if type(value) == "string" and value ~= "" then
			table.insert(header, { key, (value:gsub("[\r\n]+", " ")) })
		end
	end
	field("Tool", payload.tool or "tool")
	field("Request", payload.request or prompt)
	field("Access scope", payload.path)
	field("Command CWD", payload.directory)
	field("Mode", payload.mode)
	if not payload.request and payload.summary ~= prompt then
		field("Details", payload.summary)
	end
	return {
		prompt = prompt,
		prompt_label = "Permission",
		pi_select_layout = "compact",
		preview_header = header,
		preview_text = type(payload.preview) == "string" and payload.preview or "",
		preview_filetype = payload.preview_filetype,
	}
end

local function confirm_with_preview(ctx, event)
	local payload = decode_approval_payload(event.message)
	if not payload then
		return false
	end

	local prompt = type(event.title) == "string" and event.title ~= "" and event.title
		or (payload.tool and ("Allow " .. payload.tool .. "?") or "Pi confirm")
	pending_picker.select(ctx, event.id, { "Allow", "Deny" }, approval_select_opts(payload, prompt), function(choice)
		send_extension_ui_response(ctx, event.id, { confirmed = choice == "Allow" })
	end)
	return true
end

local function select_capability_approval(ctx, event)
	local payload = decode_approval_payload(event.title)
	if not payload then
		return false
	end

	local tool = type(payload.tool) == "string" and payload.tool ~= "" and payload.tool or "tool"
	local prompt = "Allow " .. tool .. "?"
	pending_picker.select(ctx, event.id, event.options or {}, approval_select_opts(payload, prompt), function(choice)
		send_extension_ui_response(ctx, event.id, choice and { value = choice } or { cancelled = true })
	end)
	return true
end

local function markdown_input_float(ctx, event)
	local payload = type(event.title) == "string" and json.decode_object(event.title)
	if not payload or payload.kind ~= "pi_question_response" then
		return false
	end

	require("pi-integration.utils.markdown-editor").open({
		name = "pi://question-response/" .. tostring(event.id),
		title = " Answer question (:wq to submit, :q! to return) ",
	}, function(text)
		if text then
			send_extension_ui_response(ctx, event.id, { value = text })
		else
			send_extension_ui_response(ctx, event.id, { cancelled = true })
		end
	end)
	vim.cmd.startinsert()
	return true
end

local function update_access_mode_from_status(ctx, text)
	if type(text) ~= "string" then
		return
	end
	local mode = text:match("Mode:%s*(%w+)")
	if mode and ctx.access.is_mode(mode) then
		ctx.state.access_mode = mode
		ctx.transcript.refresh_ui()
	end
end

local function update_integration_mode_from_status(ctx, text)
	if type(text) ~= "string" then
		return
	end
	local mode = text:match("Integration:%s*(%w+)")
	if mode and ctx.integration.is_mode(mode) then
		ctx.state.integration_mode = mode
		ctx.transcript.refresh_ui()
	end
end

local function update_spawn_runs_from_status(ctx, text)
	local payload = type(text) == "string" and json.decode_object(text) or nil
	if type(payload) ~= "table" then
		return
	end
	local state = ctx.state
	state.spawn_running_count = tonumber(payload.running) or 0
	state.spawn_runs = type(payload.runs) == "table" and payload.runs or {}
	state.spawn_runs_session_file = type(payload.sessionFile) == "string" and payload.sessionFile
		or (state.spawn_runs[1] and state.spawn_runs[1].parentSessionFile)
	if state.spawn_runs_session_file == state.session_file then render_spawn_runs(ctx, state.spawn_runs) end
	ctx.transcript.refresh_ui()
end

local function update_codex_usage_from_status(ctx, text)
	ctx.state.codex_usage = type(text) == "string" and text ~= "" and json.decode_object(text) or nil
	pi_usage.refresh(ctx)
	ctx.transcript.refresh_ui()
end

local function modified_buffers_under(path)
	if type(path) ~= "string" or path == "" then
		return 0
	end
	local prefix = vim.fs.normalize(path) .. "/"
	local count = 0
	for _, buf in ipairs(vim.api.nvim_list_bufs()) do
		local name = vim.api.nvim_buf_get_name(buf)
		if name ~= "" and vim.bo[buf].modified and (vim.fs.normalize(name) .. "/"):sub(1, #prefix) == prefix then
			count = count + 1
		end
	end
	return count
end

local function fail_workspace_loading(ctx, message, detail)
	ctx.logs.add("error", message, detail)
	M.set_loading(ctx, false)
	ctx.state.loading_error = message
	ctx.actions.fail_pending_prompts()
	ctx.ui.notify(message, vim.log.levels.ERROR)
end

local function update_workspace_from_status(ctx, text)
	local payload = type(text) == "string" and json.decode_object(text) or nil
	if type(payload) ~= "table" or type(payload.cwd) ~= "string" or payload.cwd == "" then
		fail_workspace_loading(ctx, "Pi returned an invalid workspace status.", text)
		return
	end
	local state = ctx.state
	local previous = state.workspace or {}
	local cwd_changed = previous.cwd ~= payload.cwd
	local session_changed = type(payload.sessionFile) == "string" and payload.sessionFile ~= state.session_file
	local transition_pending = payload.transitionPending == true
	local transition_finished = previous.transitionPending == true and not transition_pending
	if cwd_changed then
		local modified = modified_buffers_under(previous.path)
		local ok, error_message = pcall(vim.api.nvim_set_current_dir, payload.cwd)
		if not ok then
			fail_workspace_loading(
				ctx,
				"Could not enter Pi workspace cwd: " .. tostring(error_message),
				error_message
			)
			return
		end
		if modified > 0 then
			ctx.ui.notify(
				string.format("Pi changed workspace; %d modified buffer(s) remain attached to their original checkout paths.", modified),
				vim.log.levels.WARN
			)
		end
	end
	if cwd_changed or not state.workspace_status_received then
		require("pi-integration.directory-history").record(payload.cwd)
	end
	state.workspace = payload
	state.workspace_status_received = true
	if transition_pending then
		state.session_sync_complete = false
		state.session_sync_generation = (state.session_sync_generation or 0) + 1
		M.set_loading(ctx, true)
	elseif session_changed or cwd_changed or transition_finished then
		state.session_sync_complete = false
		state.session_sync_generation = (state.session_sync_generation or 0) + 1
		M.set_loading(ctx, true)
		local process = state.rpc_process
		local generation = state.session_sync_generation
		vim.defer_fn(function()
			if state.rpc_process == process and process and process.active
				and generation == state.session_sync_generation then
				ctx.session.sync()
			end
		end, 20)
	else
		ctx.actions.finish_loading_if_ready()
	end
	ctx.transcript.refresh_ui()
end

function M.handle_extension_ui_request(ctx, event)
	local state = ctx.state
	if event.id and (event.method == "select" or event.method == "confirm" or event.method == "input" or event.method == "editor") then
		if not pending_picker.can_open(event.id) then
			ctx.rpc.send({ type = "extension_ui_response", id = event.id, cancelled = true })
			return
		end
		local request = summarize_ui_request(event)
		request.expires = type(event.timeout) == "number" and (vim.uv.now() + event.timeout) or nil
		state.pending_ui_requests[event.id] = request
		state.active_ui_request_id = event.id
	end
	if event.method == "set_editor_text" and type(event.text) == "string" and ctx.buffer.valid(state.input_buf) then
		vim.api.nvim_buf_set_lines(state.input_buf, 0, -1, false, vim.split(event.text, "\n", { plain = true }))
	elseif event.method == "notify" then
		local message = event.message or vim.inspect(event)
		local log_level = event.notifyType == "warning" and "warn" or event.notifyType == "error" and "error" or "info"
		local vim_level = event.notifyType == "warning" and vim.log.levels.WARN
			or event.notifyType == "error" and vim.log.levels.ERROR
			or vim.log.levels.INFO
		ctx.logs.add(log_level, message)
		ctx.ui.notify(message, vim_level)
	elseif event.method == "setStatus" then
		if event.statusKey == "pi-access-mode" then
			update_access_mode_from_status(ctx, event.statusText)
		elseif event.statusKey == "pi-integration-mode" then
			update_integration_mode_from_status(ctx, event.statusText)
		elseif event.statusKey == "pi-history-changed" then
			ctx.actions.refresh_messages()
		elseif event.statusKey == "pi-session-title" then
			state.session_name = event.statusText
			ctx.transcript.refresh_ui()
		elseif event.statusKey == "pi-tree-leaf" then
			state.tree_leaf_id = normalize_leaf_id(event.statusText)
		elseif event.statusKey == "pi-todos" then
			state.todo_status = event.statusText
			refresh_todo_output(ctx)
		elseif event.statusKey == "pi-notifications" then
			state.notification_status = event.statusText
			ctx.transcript.refresh_ui()
		elseif event.statusKey == "pi-spawn-runs" then
			update_spawn_runs_from_status(ctx, event.statusText)
		elseif event.statusKey == "pi-codex-usage" then
			update_codex_usage_from_status(ctx, event.statusText)
		elseif event.statusKey == "pi-workspace" then
			update_workspace_from_status(ctx, event.statusText)
		end
	elseif event.method == "setTitle" and type(event.title) == "string" then
		vim.opt.titlestring = event.title
		vim.opt.title = true
	elseif event.method == "select" then
		if select_capability_approval(ctx, event) then
			return
		end
		local question = decode_question_payload(event.title, "pi_question_select")
		local compact_select = decode_compact_select_payload(event.title)
		local select_opts = { prompt = event.title or "Pi select" }
		if compact_select then
			select_opts.prompt = compact_select.prompt
			select_opts.pi_select_layout = "compact"
		end
		if question then
			select_opts.prompt = question.question
			select_opts.prompt_label = "Question"
			select_opts.pi_select_layout = "compact"
			select_opts.preview_text = question.question
		end
		pending_picker.select(ctx, event.id, event.options or {}, select_opts, function(choice)
			send_extension_ui_response(ctx, event.id, choice and { value = choice } or { cancelled = true })
		end)
	elseif event.method == "confirm" then
		if confirm_with_preview(ctx, event) then
			return
		end
		local prompt = event.title or "Pi confirm"
		local preview_text = prompt
		if type(event.message) == "string" and event.message ~= "" then
			preview_text = preview_text .. "\n\n" .. event.message
		end
		pending_picker.select(ctx, event.id, { "Yes", "No" }, {
			prompt = prompt,
			prompt_label = "Confirmation",
			pi_select_layout = "compact",
			preview_text = preview_text,
		}, function(choice)
			send_extension_ui_response(ctx, event.id, { confirmed = choice == "Yes" })
		end)
	elseif event.method == "input" then
		if markdown_input_float(ctx, event) then
			return
		end
		vim.ui.input({ prompt = event.title or "Pi input", default = event.placeholder or "" }, function(value)
			if value then
				send_extension_ui_response(ctx, event.id, { value = value })
			else
				send_extension_ui_response(ctx, event.id, { cancelled = true })
			end
		end)
	elseif event.method == "editor" then
		ctx.ui.notify("Pi requested an editor UI, which pi-console does not support yet", vim.log.levels.WARN)
		send_extension_ui_response(ctx, event.id, { cancelled = true })
	end
end

function M.handle_message_update(ctx, event)
	local state = ctx.state
	local update = event.assistantMessageEvent or {}

	local function render_active_thinking_if_visible(streaming, refresh)
		local output_id = state.active_thinking_output_id
		if not output_id then
			return
		end
		if state.active_thinking_line then
			if refresh then
				local summary = pi_thinking_output.summary_lines(state, output_id, streaming)[1]
				ctx.transcript.set_line(state.active_thinking_line, summary)
			end
			return
		end
		local text = pi_thinking_output.text(state, output_id) or ""
		if vim.trim(text) == "" then
			return
		end
		ctx.transcript.ensure_assistant_turn_started("Assistant")
		state.current_thinking_rendered = true
		ctx.transcript.begin_trace_item()
		ctx.transcript.append_lines(pi_thinking_output.summary_lines(state, output_id, streaming))
		local line = ctx.transcript.line_count()
		state.active_thinking_line = line
		ctx.transcript.register_item({
			kind = "thinking",
			start_line = line,
			end_line = line,
			output_id = output_id,
		})
		ctx.transcript.end_trace_item()
	end

	if update.type == "text_start" then
		state.awaiting_agent_output = false
		ctx.transcript.ensure_assistant_turn_started("Assistant")
	elseif update.type == "text_delta" then
		state.awaiting_agent_output = false
		ctx.transcript.ensure_assistant_turn_started("Assistant")
		ctx.transcript.append_text(update.delta or "")
	elseif update.type == "thinking_start" and ctx.config.show_thinking then
		state.awaiting_agent_output = false
		state.active_thinking_output_id = pi_thinking_output.store(state, "")
		state.active_thinking_line = nil
	elseif update.type == "thinking_delta" and ctx.config.show_thinking then
		if state.active_thinking_output_id then
			local delta = update.delta or ""
			pi_thinking_output.append(state, state.active_thinking_output_id, delta)
			local title_may_have_changed = delta:find("[\r\n*#_]") ~= nil
			render_active_thinking_if_visible(true, title_may_have_changed)
		end
	elseif update.type == "thinking_end" and ctx.config.show_thinking then
		if state.active_thinking_output_id then
			local text = pi_thinking_output.text(state, state.active_thinking_output_id) or ""
			local final_content = update.content or ""
			if vim.trim(text) == "" and vim.trim(final_content) ~= "" then
				pi_thinking_output.append(state, state.active_thinking_output_id, final_content)
			end
			render_active_thinking_if_visible(false, true)
		end
		state.active_thinking_output_id = nil
		state.active_thinking_line = nil
	elseif update.type == "toolcall_start" then
		state.awaiting_agent_output = false
		ctx.transcript.ensure_assistant_turn_started("Assistant")
	elseif update.type == "toolcall_delta" then
		-- Tool-call deltas are usually raw JSON arguments. For multiline edits this
		-- can be thousands of characters streamed token-by-token before the useful
		-- approval preview/diff appears, making the UI feel much slower than Codex.
		-- Ignore the raw argument stream and let tool_execution_* plus approval
		-- previews render the meaningful result.
		return
	elseif update.type == "toolcall_end" then
		return
	elseif update.type == "error" then
		-- Provider/transport errors may be followed by an automatic retry. The
		-- retry decision is only known at agent_end, so keep the error pending
		-- instead of rendering a scary final error immediately.
		state.pending_retry_error = ctx.rpc.event_error_text(update) or "unknown"
		ctx.logs.add("error", "Provider/agent stream error", state.pending_retry_error)
	end
end

function M.handle_event(ctx, event)
	local state = ctx.state
	if (event.type == "agent_end" and not event.willRetry) or event.type == "agent_settled" then
		for _, output_id in ipairs(pi_tool_output.interrupt_executions(state)) do
			ctx.transcript.write_tool_output(output_id)
		end
	end
	if event.type == "response" then
		ctx.rpc.handle_response(event)
	elseif event.type == "agent_start" then
		state.is_agent_running = true
		state.refresh_transcript_after_settled = false
		state.is_loading = false
		state.is_streaming = true
		state.is_retrying = false
		state.pending_retry_error = nil
		state.awaiting_agent_output = true
		start_activity(ctx, "work")
		state.current_message_started = false
		state.current_thinking_rendered = false
		state.active_thinking_output_id = nil
		state.active_thinking_line = nil
		state.error_rendered_for_active_run = false
		ctx.ui.notify("Pi is working")
	elseif event.type == "agent_end" then
		local abort_requested = state.abort_requested
		state.is_streaming = false
		state.current_message_started = false
		state.current_thinking_rendered = false
		state.active_thinking_output_id = nil
		state.active_thinking_line = nil
		local message = ctx.rpc.event_error_text(event)
		if message then
			ctx.logs.add(event.willRetry and "warn" or "error", "Agent ended with error", message)
		end
		if event.willRetry then
			state.is_retrying = true
			start_activity(ctx, "retry")
			-- Retry is a continuation of the same logical assistant turn. Keep
			-- the placeholder/spinner visible until retry output replaces it or
			-- final failure renders an error.
			state.abort_requested = false
			ctx.actions.refresh_session_stats()
			return
		end
		state.is_retrying = false
		state.pending_retry_error = nil
		local awaiting_output = state.awaiting_agent_output
		state.awaiting_agent_output = false
		if state.is_loading then
			start_activity(ctx, "loading")
		end
		if message and not state.error_rendered_for_active_run then
			ctx.transcript.render_error_message("Agent Error", message)
		elseif (ctx.transcript.assistant_placeholder_active() or awaiting_output) and state.abort_requested then
			ctx.transcript.clear_assistant_placeholder()
		elseif (ctx.transcript.assistant_placeholder_active() or awaiting_output) and not state.error_rendered_for_active_run then
			ctx.transcript.render_error_message(
				"Agent Error",
				ctx.rpc.recent_stderr_text() or "Agent stopped before returning a message. No error details were provided."
			)
		else
			ctx.transcript.clear_assistant_placeholder()
		end
		state.refresh_transcript_after_settled = not state.error_rendered_for_active_run and not abort_requested
		state.abort_requested = false
		ctx.transcript.touch()
		ctx.transcript.refresh_ui()
		ctx.actions.refresh_session_stats()
	elseif event.type == "agent_settled" then
		state.is_agent_running = false
		state.is_streaming = false
		state.is_retrying = false
		ctx.transcript.refresh_ui()
		if state.is_loading then
			start_activity(ctx, "loading")
		else
			stop_activity(ctx)
		end
		if state.refresh_transcript_after_settled then
			schedule_transcript_refresh(ctx)
		end
		state.refresh_transcript_after_settled = false
		ctx.actions.flush_queued_prompts()
		local running = state.spawn_running_count or 0
		if running > 0 then
			ctx.ui.notify(string.format("Pi turn finished; %d subagent%s still running", running, running == 1 and "" or "s"))
		else
			ctx.ui.notify("Pi finished")
		end
	elseif event.type == "auto_retry_start" then
		state.is_retrying = true
		state.pending_retry_error = event.errorMessage or state.pending_retry_error
		ctx.logs.add("warn", "Pi retrying after transient error", state.pending_retry_error)
		start_activity(ctx, "retry")
		ctx.ui.notify(
			"Pi retrying after transient error ("
				.. tostring(event.attempt or "?")
				.. "/"
				.. tostring(event.maxAttempts or "?")
				.. ")"
		)
	elseif event.type == "auto_retry_end" then
		state.is_retrying = false
		ctx.logs.add(event.success == false and "error" or "info", event.success == false and "Pi retry failed" or "Pi retry recovered", event.finalError)
		state.pending_retry_error = nil
		if state.is_agent_running or state.is_streaming then
			start_activity(ctx, "work")
		else
			stop_activity(ctx)
		end
		if event.success == false and not state.error_rendered_for_active_run then
			ctx.transcript.render_error_message("Agent Error", event.finalError or "Retry failed")
			ctx.transcript.touch()
			ctx.transcript.refresh_ui()
		end
	elseif event.type == "compaction_start" then
		state.is_compacting = true
	elseif event.type == "compaction_end" then
		state.is_compacting = false
		if not event.aborted and not event.willRetry then
			schedule_transcript_refresh(ctx)
		end
		ctx.actions.flush_queued_prompts()
	elseif event.type == "message_update" then
		M.handle_message_update(ctx, event)
	elseif event.type == "message_end" then
		if event.message and event.message.role == "user" then
			local text = vim.trim(ctx.messages.extract_text(event.message) or "")
			local fallback_index
			for index, pending in ipairs(state.pending_user_messages or {}) do
				if pending.status == "sending" then
					fallback_index = fallback_index or index
					if pending.text == text then
						fallback_index = index
						break
					end
				end
			end
			if fallback_index then
				table.remove(state.pending_user_messages, fallback_index)
				ctx.transcript.update_statusline()
			end
			state.current_message_started = false
			state.current_thinking_rendered = false
			M.render_message(ctx, event.message)
			return
		end
		if event.message and event.message.role == "toolResult" then
			if pi_skills.tool_result_skill_name(state, event.message) then
				pi_skills.apply_tool_result(state, event.message, message_utils.extract_text(event.message))
				return
			end
			M.render_message(ctx, event.message)
		elseif event.message and event.message.role == "assistant" then
			pi_tool_output.record_calls(state, event.message)
			if not state.current_message_started and not state.current_thinking_rendered then
				M.render_message(ctx, event.message)
			end
			render_skill_loads(ctx, event.message)
		elseif event.message and not state.current_message_started and not state.current_thinking_rendered then
			M.render_message(ctx, event.message)
		end
	elseif event.type == "tool_execution_start" then
		state.awaiting_agent_output = false
		pi_tool_output.record_execution_call(state, event.toolName, event.toolCallId, event.args, "running")
		start_activity(ctx, event.toolName or "tool", event.toolCallId)
		if not pi_skills.tool_result_skill_name(state, event) then
			render_tool_output(ctx, event, "")
		end
		return
	elseif event.type == "tool_execution_update" then
		if not pi_skills.tool_result_skill_name(state, event) then
			local partial = type(event.partialResult) == "table" and event.partialResult or {}
			render_tool_output(ctx, event, message_utils.extract_content_text(partial.content), partial.details)
		end
		return
	elseif event.type == "tool_execution_end" then
		pi_tool_output.record_execution_call(state, event.toolName, event.toolCallId, nil, "completed")
		local execution_result = type(event.result) == "table" and event.result or nil
		local is_error = event.isError == true or (execution_result and execution_result.isError == true)
		if is_error then
			ctx.logs.add("error", "Tool execution failed: " .. tostring(event.toolName or "tool"), message_utils.extract_content_text(execution_result and execution_result.content))
		end
		if not pi_skills.tool_result_skill_name(state, event) then
			local result = execution_result or {}
			render_tool_output(ctx, event, message_utils.extract_content_text(result.content), result.details)
		end
		if state.activity_tool_call_id == event.toolCallId then
			state.activity_tool_call_id = nil
			start_activity(ctx, "work")
		end
		return
	elseif event.type == "queue_update" then
		local count = event.pendingMessageCount or event.count
		if count then
			ctx.ui.notify("Pi queue: " .. tostring(count) .. " pending")
		end
	elseif event.type == "session_info_changed" then
		state.session_name = event.name
		ctx.transcript.refresh_ui()
	elseif event.type == "extension_ui_request" then
		M.handle_extension_ui_request(ctx, event)
	end
end

return M
