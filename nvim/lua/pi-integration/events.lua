local M = {}

local json = require("pi-integration.utils.json")
local message_utils = require("pi-integration.utils.message")
local pi_skills = require("pi-integration.skills")
local pi_usage = require("pi-integration.usage")
local pending_picker = require("pi-integration.pending-picker")

local function partial_result_text(partial_result)
	if type(partial_result) ~= "table" then
		return ""
	end
	return message_utils.extract_content_text(partial_result.content)
end

local function bind_spawn_run_line(ctx, run, output_id, line)
	if ctx.tools.bind_spawn_run then
		ctx.tools.bind_spawn_run(run, output_id, line)
	end
end

local function render_or_update_live_tool(ctx, event, text, details)
	local state = ctx.state
	local output_id, updated = ctx.tools.store_or_update_live_output(
		event.toolName or "tool",
		event.toolCallId,
		text or "",
		nil,
		details,
		nil
	)
	local output = state.tool_outputs and state.tool_outputs[output_id]
	local run_details = output and output.details or details
	if updated then
		local line = state.live_tool_lines and event.toolCallId and state.live_tool_lines[event.toolCallId]
		if line then
			bind_spawn_run_line(ctx, run_details, output_id, line)
			ctx.transcript.set_line(line, ctx.tools.summary_lines(output_id)[1])
		end
		return output_id
	end

	ctx.transcript.ensure_assistant_turn_started("Assistant")
	ctx.transcript.begin_trace_item()
	ctx.transcript.append_lines(ctx.tools.summary_lines(output_id))
	local line = ctx.transcript.line_count()
	state.live_tool_lines = state.live_tool_lines or {}
	if event.toolCallId then
		state.live_tool_lines[event.toolCallId] = line
	end
	bind_spawn_run_line(ctx, run_details, output_id, line)
	ctx.transcript.register_item({
		kind = "tool",
		start_line = line,
		end_line = line,
		output_id = output_id,
	})
	ctx.transcript.end_trace_item()
	return output_id
end

local function run_id(run)
	if type(run) ~= "table" then
		return nil
	end
	return run.runId or run.id
end

local function shallow_copy(table_value)
	local copy = {}
	for key, value in pairs(table_value or {}) do
		copy[key] = value
	end
	return copy
end

local function upsert_spawn_run(ctx, run)
	local id = run_id(run)
	if type(id) ~= "string" or id == "" then
		return run
	end
	local state = ctx.state
	state.spawn_runs = state.spawn_runs or {}
	for index, existing in ipairs(state.spawn_runs) do
		if run_id(existing) == id then
			local merged = shallow_copy(existing)
			for key, value in pairs(run) do
				merged[key] = value
			end
			state.spawn_runs[index] = merged
			return merged
		end
	end
	table.insert(state.spawn_runs, run)
	return run
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
	vim.defer_fn(function()
		if not state.is_streaming and not state.is_retrying then
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
		if not state.is_streaming and not state.is_retrying and not state.is_loading and not state.awaiting_agent_output then
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
	elseif not ctx.state.is_streaming and not ctx.state.is_retrying and not ctx.state.awaiting_agent_output then
		stop_activity(ctx)
	else
		ctx.transcript.update_statusline()
	end
end

function M.start_activity(ctx, label)
	start_activity(ctx, label)
end

local function update_spawn_run_line(ctx, run, progress)
	local id = run_id(run)
	if type(id) ~= "string" or id == "" then
		return false
	end
	if type(progress) == "string" and progress ~= "" then
		run = shallow_copy(run)
		run.progress = progress
	end
	run = upsert_spawn_run(ctx, run)
	local state = ctx.state
	state.spawn_run_lines = state.spawn_run_lines or {}
	local line = state.spawn_run_lines[id]
	if not line then
		return false
	end
	ctx.transcript.touch()
	local output_id = ctx.tools.store_or_update_spawn_run_output(run, progress)
	if not output_id then
		return false
	end
	bind_spawn_run_line(ctx, run, output_id, line)
	ctx.transcript.set_line(line, ctx.tools.summary_lines(output_id)[1])
	return true
end

local function render_spawn_runs(ctx, runs)
	if type(runs) ~= "table" then
		return false
	end
	local rendered = false
	for _, run in ipairs(runs) do
		rendered = update_spawn_run_line(ctx, run) or rendered
	end
	return rendered
end

local function spawn_custom_tool_name(message)
	if type(message) ~= "table" or message.role ~= "custom" then
		return nil
	end
	if message.customType == "spawn_completion" then
		return "spawn"
	elseif message.customType == "spawn_control_result" then
		return "spawn_control"
	end
	return nil
end

local function update_spawn_details(ctx, name, details, text)
	if name ~= "spawn" and name ~= "spawn_control" then
		return false
	end
	if type(details) ~= "table" then
		return false
	end
	if type(details.runId) == "string" or type(details.id) == "string" then
		return update_spawn_run_line(ctx, details, text)
	elseif type(details.runs) == "table" then
		local updated = false
		for _, run in ipairs(details.runs) do
			updated = update_spawn_run_line(ctx, run) or updated
		end
		return updated
	end
	return false
end

local function render_spawn_custom_tool(ctx, message)
	local name = spawn_custom_tool_name(message)
	if not name then
		return false
	end
	local text = name == "spawn" and "" or (ctx.messages.extract_text(message) or "")
	update_spawn_details(ctx, name, message.details, text)
	return true
end

local function is_todo_tool_name(name)
	return name == "todowrite" or name == "todo_write"
end

local function remember_todo_tool_line(ctx, output_id, line)
	local state = ctx.state
	local output = state.tool_outputs and state.tool_outputs[output_id]
	if output and is_todo_tool_name(output.name) then
		state.todo_tool_output_id = output_id
		state.todo_tool_line = line
	end
end

local function refresh_todo_tool_line(ctx)
	local state = ctx.state
	local output_id = state.todo_tool_output_id
	local line = state.todo_tool_line
	if output_id and line and state.tool_outputs and state.tool_outputs[output_id] then
		ctx.transcript.touch()
		ctx.transcript.set_line(line, ctx.tools.summary_lines(output_id)[1])
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
		local output_id = ctx.skills.store_prompt(load)
		ctx.transcript.append_lines(ctx.skills.summary_lines(output_id))
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
	local text = ctx.messages.extract_text(message)
	if not text or text == "" then
		return
	end
	ctx.state.awaiting_agent_output = false
	ctx.transcript.touch()
	if role == "toolResult" then
		local name = message.toolName or "tool"
		local tool_call_id = message_utils.tool_call_id(message)
		local live_output_id = ctx.tools.live_output_id(tool_call_id)
		if live_output_id then
			ctx.tools.store_or_update_live_output(name, tool_call_id, text, nil, message.details, ctx.tools.store_display and ctx.tools.store_display(message) or nil)
			local line = ctx.state.live_tool_lines and ctx.state.live_tool_lines[tool_call_id]
			if line then
				if name == "spawn" or name == "spawn_control" then
					bind_spawn_run_line(ctx, message.details, live_output_id, line)
				end
				ctx.transcript.set_line(line, ctx.tools.summary_lines(live_output_id)[1])
			end
			return
		end
		if update_spawn_details(ctx, name, message.details, text) then
			return
		end
		ctx.transcript.ensure_assistant_turn_started("Assistant")
		local output_id = ctx.tools.store_output(name, text, nil, message.details, message)
		ctx.transcript.begin_trace_item()
		ctx.transcript.append_lines(ctx.tools.summary_lines(output_id))
		local line = ctx.transcript.line_count()
		if name == "spawn" or name == "spawn_control" then
			bind_spawn_run_line(ctx, message.details, output_id, line)
		end
		ctx.transcript.register_item({
			kind = "tool",
			start_line = line,
			end_line = line,
			output_id = output_id,
		})
		remember_todo_tool_line(ctx, output_id, line)
		ctx.transcript.end_trace_item()
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
	field("File", payload.path)
	field("Directory", payload.directory)
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

	local title = " Answer question (:wq to submit, :q! to return) "
	local buf = vim.api.nvim_create_buf(false, true)
	vim.api.nvim_buf_set_name(buf, "pi://question-response/" .. tostring(event.id))
	vim.bo[buf].buftype = "acwrite"
	vim.bo[buf].bufhidden = "wipe"
	vim.bo[buf].swapfile = false
	vim.bo[buf].filetype = "markdown"
	local width = math.max(1, math.min(80, vim.o.columns - 4))
	local height = math.max(1, math.min(8, vim.o.lines - 4))
	local win = vim.api.nvim_open_win(buf, true, {
		relative = "editor",
		width = width,
		height = height,
		row = math.max(0, math.floor((vim.o.lines - height) / 2)),
		col = math.floor((vim.o.columns - width) / 2),
		style = "minimal",
		border = "rounded",
		title = title,
		title_pos = "center",
	})
	local saved_text
	vim.api.nvim_create_autocmd("BufWriteCmd", {
		buffer = buf,
		callback = function()
			saved_text = table.concat(vim.api.nvim_buf_get_lines(buf, 0, -1, false), "\n")
			vim.bo[buf].modified = false
		end,
	})
	vim.api.nvim_create_autocmd("WinClosed", {
		pattern = tostring(win),
		once = true,
		callback = function()
			local text = saved_text
			vim.schedule(function()
				if text then
					send_extension_ui_response(ctx, event.id, { value = text })
				else
					send_extension_ui_response(ctx, event.id, { cancelled = true })
				end
			end)
		end,
	})
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
	ctx.state.spawn_running_count = tonumber(payload.running) or 0
	ctx.state.spawn_runs = type(payload.runs) == "table" and payload.runs or {}
	render_spawn_runs(ctx, ctx.state.spawn_runs)
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
		vim.defer_fn(function()
			ctx.session.sync()
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
			refresh_todo_tool_line(ctx)
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
				local summary = ctx.thinking.summary_lines(output_id, streaming)[1]
				ctx.transcript.set_line(state.active_thinking_line, summary)
			end
			return
		end
		local text = ctx.thinking.text(output_id) or ""
		if vim.trim(text) == "" then
			return
		end
		ctx.transcript.ensure_assistant_turn_started("Assistant")
		state.current_thinking_rendered = true
		ctx.transcript.begin_trace_item()
		ctx.transcript.append_lines(ctx.thinking.summary_lines(output_id, streaming))
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
		state.active_thinking_output_id = ctx.thinking.store_output("")
		state.active_thinking_line = nil
	elseif update.type == "thinking_delta" and ctx.config.show_thinking then
		if state.active_thinking_output_id then
			local delta = update.delta or ""
			ctx.thinking.append_output(state.active_thinking_output_id, delta)
			local title_may_have_changed = delta:find("[\r\n*#_]") ~= nil
			render_active_thinking_if_visible(true, title_may_have_changed)
		end
	elseif update.type == "thinking_end" and ctx.config.show_thinking then
		if state.active_thinking_output_id then
			local text = ctx.thinking.text(state.active_thinking_output_id) or ""
			local final_content = update.content or ""
			if vim.trim(text) == "" and vim.trim(final_content) ~= "" then
				ctx.thinking.append_output(state.active_thinking_output_id, final_content)
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
	if event.type == "response" then
		ctx.rpc.handle_response(event)
	elseif event.type == "agent_start" then
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
		else
			stop_activity(ctx)
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
		local should_refresh_from_file = not state.error_rendered_for_active_run and not abort_requested
		state.abort_requested = false
		ctx.transcript.touch()
		ctx.transcript.refresh_ui()
		ctx.actions.refresh_session_stats()
		if should_refresh_from_file then
			schedule_transcript_refresh(ctx)
		end
		ctx.actions.flush_queued_prompts()
		ctx.ui.notify("Pi finished")
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
		if state.is_streaming then
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
				local pending = state.pending_user_messages[fallback_index]
				if pending.header_line then
					ctx.transcript.set_line(pending.header_line, "## User")
				end
				table.remove(state.pending_user_messages, fallback_index)
				ctx.transcript.update_statusline()
				return
			end
		end
		if event.message and event.message.role == "toolResult" then
			if pi_skills.tool_result_skill_name(state, event.message) then
				ctx.skills.apply_tool_result(event.message)
				return
			end
			M.render_message(ctx, event.message)
		elseif event.message and event.message.role == "assistant" then
			ctx.tools.record_calls(event.message)
			if not state.current_message_started and not state.current_thinking_rendered then
				M.render_message(ctx, event.message)
			end
			render_skill_loads(ctx, event.message)
		elseif event.message and not state.current_message_started and not state.current_thinking_rendered then
			M.render_message(ctx, event.message)
		end
	elseif event.type == "tool_execution_start" then
		state.awaiting_agent_output = false
		if event.toolName == "edit" or event.toolName == "write" or event.toolName == "bash" then
			ctx.tools.record_execution_call(event.toolName, event.toolCallId, event.args)
		end
		start_activity(ctx, event.toolName or "tool", event.toolCallId)
		if event.toolName == "spawn" then
			render_or_update_live_tool(ctx, event, "Subagent starting…", { status = "running" })
		elseif event.toolName == "bash" then
			render_or_update_live_tool(ctx, event, "", { status = "running" })
		end
		-- Non-spawn/non-bash tool output is rendered from the final toolResult message. Rendering
		-- every tool_execution_* stream creates empty/duplicate tool blocks for tools
		-- that only publish their output at completion.
		return
	elseif event.type == "tool_execution_update" then
		if event.toolName == "spawn" then
			local partial = type(event.partialResult) == "table" and event.partialResult or {}
			render_or_update_live_tool(ctx, event, partial_result_text(partial), partial.details or { status = "running" })
		elseif event.toolName == "bash" then
			local partial = type(event.partialResult) == "table" and event.partialResult or {}
			render_or_update_live_tool(ctx, event, partial_result_text(partial), partial.details or { status = "running" })
		elseif event.toolName == "spawn_control" then
			local partial = type(event.partialResult) == "table" and event.partialResult or {}
			update_spawn_details(ctx, event.toolName, partial.details, partial_result_text(partial))
		end
		return
	elseif event.type == "tool_execution_end" then
		local execution_result = type(event.result) == "table" and event.result or nil
		local is_error = event.isError == true or (execution_result and execution_result.isError == true)
		if is_error then
			ctx.logs.add("error", "Tool execution failed: " .. tostring(event.toolName or "tool"), message_utils.extract_content_text(execution_result and execution_result.content))
		end
		if event.toolName == "spawn" then
			local result = type(event.result) == "table" and event.result or {}
			local details = type(result.details) == "table" and shallow_copy(result.details) or {}
			if is_error and not details.status then
				details.status = "error"
			end
			render_or_update_live_tool(ctx, event, message_utils.extract_content_text(result.content), details)
		elseif event.toolName == "bash" then
			local result = type(event.result) == "table" and event.result or {}
			local details = type(result.details) == "table" and shallow_copy(result.details) or {}
			details.status = details.status or "completed"
			render_or_update_live_tool(ctx, event, message_utils.extract_content_text(result.content), details)
		elseif event.toolName == "spawn_control" then
			local result = type(event.result) == "table" and event.result or {}
			update_spawn_details(ctx, event.toolName, result.details, message_utils.extract_content_text(result.content))
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
