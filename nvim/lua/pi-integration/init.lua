local M = {}

local EMPTY_SESSION_NOTICE = "Send a message to begin. This session will be saved after the first response."

local message_utils = require("pi-integration.utils.message")
local state = require("pi-integration.state").new()

M.config = {
	binary = "pi",
	agent_dir = nil,
	provider = nil,
	model = nil,
	session_dir = nil,
	archive_after_days = 180,
	show_thinking = true,
	show_stderr = false,
	log_max_entries = 1000,
	access_modes = { "readonly", "ask", "edit", "full" },
	integration_modes = { "ask", "allowed" },
	session_dirs = {
		"~/.pi/agent/sessions",
		"~/.pi/sessions",
	},
	tree_entry_types = {
		message = true,
		branch_summary = true,
		compaction = true,
		bashExecution = true,
		custom_message = true,
		model_change = true,
		thinking_level_change = true,
		label = true,
	},
	tree_filter_modes = { "default", "user-only", "all" },
}

local function notify(msg, level)
	vim.notify(msg, level or vim.log.levels.INFO, { title = "pi-console" })
end

local function valid_buf(buf)
	return buf and vim.api.nvim_buf_is_valid(buf)
end

local function set_modifiable(buf, value)
	vim.api.nvim_set_option_value("modifiable", value, { buf = buf })
end

local pi_transcript
local pi_rpc
local pi_events
local pi_layout
local pi_actions
local pi_logs
local integration_ctx
local setup_keymaps
local function normalize_model_metadata(provider, model)
	local model_id = model
	if type(model) == "table" then
		provider = provider or model.provider or model.providerName or model.providerId
		model_id = model.modelId or model.id or model.name
	end
	if (not provider) and type(model_id) == "string" and model_id:find("/", 1, true) then
		provider, model_id = model_id:match("^([^/]+)/(.+)$")
	end
	return provider, model_id
end

local function set_model_metadata(provider, model)
	provider, model = normalize_model_metadata(provider, model)
	state.provider = provider or state.provider
	state.model_id = model or state.model_id
end

local update_transcript_statusline

local function transcript_ctx()
	return {
		state = state,
		config = M.config,
		buffer = {
			valid = valid_buf,
			set_modifiable = set_modifiable,
		},
		transcript = {
			update_statusline = update_transcript_statusline,
		},
	}
end

local function metadata_lines()
	return pi_transcript.metadata_lines(transcript_ctx())
end

local function render_transcript()
	return pi_transcript.render(transcript_ctx())
end

local function refresh_transcript_ui()
	return pi_transcript.refresh_ui(transcript_ctx())
end

local function touch_transcript()
	return pi_transcript.touch(transcript_ctx())
end

local function is_agent_active()
	return state.is_streaming or state.is_retrying
end

local function transcript_line_count()
	return pi_transcript.line_count(transcript_ctx())
end

local function transcript_win_valid()
	return pi_transcript.win_valid(transcript_ctx())
end

local function clear_transcript_items()
	return pi_transcript.clear_transcript_items(transcript_ctx())
end

local function append_lines(lines)
	return pi_transcript.append_lines(transcript_ctx(), lines)
end

local function append_text(text)
	return pi_transcript.append_text(transcript_ctx(), text)
end

local function append_message_header(role)
	return pi_transcript.append_message_header(transcript_ctx(), role)
end

local function append_status(text)
	return pi_transcript.append_status(transcript_ctx(), text)
end

local pi_tool_output = require("pi-integration.tool-output")
local pi_thinking_output = require("pi-integration.thinking-output")
local pi_compaction_output = require("pi-integration.compaction-output")
local pi_skills = require("pi-integration.skills")
local pi_pickers
local extract_text

local function tool_output_ctx(parent_win)
	return {
		state = state,
		ui = {
			notify = notify,
		},
		window = {
			parent = parent_win,
		},
	}
end

local function reset_transcript_outputs()
	pi_tool_output.reset(state)
	pi_thinking_output.reset(state)
	pi_skills.reset(state)
end

local function record_tool_calls(message)
	return pi_tool_output.record_calls(state, message)
end

local function record_tool_execution_call(tool_name, tool_call_id, args)
	return pi_tool_output.record_execution_call(state, tool_name, tool_call_id, args)
end

local function store_tool_output(tool_name, text, filetype, details, message)
	local tool_call_id = message_utils.tool_call_id(message)
	return pi_tool_output.store(state, tool_name, text, filetype, details, pi_tool_output.display_for_result(state, message), tool_call_id)
end

local function store_or_update_live_tool_output(tool_name, tool_call_id, text, filetype, details, display)
	return pi_tool_output.store_or_update_live(state, tool_name, tool_call_id, text, filetype, details, display)
end

local function store_or_update_spawn_run_output(run, text)
	return pi_tool_output.store_or_update_spawn_run(state, run, text)
end

local function bind_spawn_run_output(run, output_id, line)
	return pi_tool_output.bind_spawn_run(state, run, output_id, line)
end

local function store_tool_display(message)
	return pi_tool_output.display_for_result(state, message)
end

local function live_tool_output_id(tool_call_id)
	return pi_tool_output.live_output_id(state, tool_call_id)
end

local function tool_output_summary_lines(output_id)
	return pi_tool_output.summary_lines(state, output_id)
end

local function store_thinking_output(text)
	return pi_thinking_output.store(state, text)
end

local function append_thinking_output(output_id, delta)
	return pi_thinking_output.append(state, output_id, delta)
end

local function thinking_output_text(output_id)
	return pi_thinking_output.text(state, output_id)
end

local function thinking_output_summary_lines(output_id, streaming)
	return pi_thinking_output.summary_lines(state, output_id, streaming)
end

local function store_skill_prompt(load)
	return pi_skills.store_load(state, load)
end

local function skill_summary_lines(output_id)
	return pi_skills.summary_lines(state, output_id)
end

local function apply_skill_tool_result(message)
	return pi_skills.apply_tool_result(state, message, extract_text(message))
end

local function begin_trace_item()
	return pi_transcript.begin_trace_item(transcript_ctx())
end

local function remove_status(text)
	return pi_transcript.remove_status(transcript_ctx(), text)
end

local function end_trace_item()
	return pi_transcript.end_trace_item(transcript_ctx())
end

local function register_transcript_item(item)
	return pi_transcript.register_transcript_item(transcript_ctx(), item)
end

local function set_transcript_line(line, text)
	return pi_transcript.set_line(transcript_ctx(), line, text)
end

local function open_transcript_item_under_cursor()
	local cursor = vim.api.nvim_win_get_cursor(0)
	local item = pi_transcript.transcript_item_at_line(transcript_ctx(), cursor[1])
	if not item then
		return false
	end
	if item.kind == "tool" then
		return pi_tool_output.open_float(tool_output_ctx(), item.output_id)
	elseif item.kind == "thinking" then
		return pi_thinking_output.open_float(tool_output_ctx(), item.output_id)
	elseif item.kind == "skill" then
		return pi_skills.open_float(tool_output_ctx(), item.output_id)
	elseif item.kind == "compaction" then
		return pi_compaction_output.open_float(tool_output_ctx(), item)
	end
	return false
end

local function clear_assistant_placeholder()
	return pi_transcript.clear_assistant_placeholder(transcript_ctx())
end

local function clear_assistant_placeholder_spinner()
	return pi_transcript.clear_assistant_placeholder_spinner(transcript_ctx())
end

local function start_assistant_placeholder()
	return pi_transcript.start_assistant_placeholder(transcript_ctx())
end

local function assistant_placeholder_active()
	return pi_transcript.assistant_placeholder_active(transcript_ctx())
end

local function ensure_assistant_turn_started(role)
	return pi_transcript.ensure_assistant_turn_started(transcript_ctx(), role)
end

local function render_error_message(title, message)
	return pi_transcript.render_error_message(transcript_ctx(), title, message)
end

local function assistant_error_text(message)
	if type(message) ~= "table" or message.role ~= "assistant" then
		return nil
	end
	if message.stopReason ~= "error" and message.stopReason ~= "aborted" then
		return nil
	end
	if type(message.errorMessage) == "string" and message.errorMessage ~= "" then
		return message.errorMessage
	end
	return "Request " .. tostring(message.stopReason)
end

local function event_error_text(event)
	if type(event) ~= "table" then
		return nil
	end

	local assistant_error = assistant_error_text(event)
	if assistant_error then
		return assistant_error
	end

	for _, key in ipairs({ "errorMessage", "error", "message", "reason" }) do
		if type(event[key]) == "string" and event[key] ~= "" then
			return event[key]
		end
	end

	for _, key in ipairs({ "error", "assistantMessageEvent", "message" }) do
		local nested = event[key]
		if type(nested) == "table" then
			local nested_error = event_error_text(nested)
			if nested_error then
				return nested_error
			end
		end
	end

	if type(event.messages) == "table" then
		for index = #event.messages, 1, -1 do
			local nested_error = event_error_text(event.messages[index])
			if nested_error then
				return nested_error
			end
		end
	end

	return nil
end

local function recent_stderr_text()
	if #state.last_stderr_lines == 0 then
		return nil
	end
	return table.concat(state.last_stderr_lines, "\n")
end

local function add_log(level, message, details)
	return pi_logs.add(integration_ctx(), level, message, details)
end

local function show_logs()
	return pi_logs.show(integration_ctx())
end

local function send(cmd, callback)
	return pi_rpc.send(integration_ctx(), cmd, callback)
end

local function set_input_text(text)
	if not valid_buf(state.input_buf) then
		return
	end
	vim.api.nvim_buf_set_lines(state.input_buf, 0, -1, false, vim.split(text or "", "\n", { plain = true }))
	if state.input_win and vim.api.nvim_win_is_valid(state.input_win) then
		vim.api.nvim_set_current_win(state.input_win)
		vim.api.nvim_win_set_cursor(state.input_win, { vim.api.nvim_buf_line_count(state.input_buf), 0 })
	end
end

extract_text = function(message)
	return message_utils.extract_text(message)
end

local function handle_response(event)
	return pi_rpc.handle_response(integration_ctx(), event)
end

local function handle_event(event)
	return pi_events.handle_event(integration_ctx(), event)
end

local function create_buffer(name, filetype, modifiable)
	return pi_layout.create_buffer(integration_ctx(), name, filetype, modifiable)
end

local function set_buffer_lines(buf, lines, modifiable)
	return pi_layout.set_buffer_lines(integration_ctx(), buf, lines, modifiable)
end

local load_session_messages_from_file
local render_messages

local pi_keymaps = require("pi-integration.keymaps")
local pi_help = require("pi-integration.help")
local pi_statusline = require("pi-integration.statusline")
local pi_usage = require("pi-integration.usage")
local pi_tree = require("pi-integration.tree")
local pi_sessions = require("pi-integration.sessions")
local pi_session = require("pi-integration.session-controller")
local pi_spawn = require("pi-integration.spawn")
local pi_messages = require("pi-integration.messages")
pi_transcript = require("pi-integration.transcript")
pi_rpc = require("pi-integration.rpc")
pi_events = require("pi-integration.events")
pi_layout = require("pi-integration.layout")
pi_actions = require("pi-integration.actions")
pi_logs = require("pi-integration.logs")
pi_pickers = require("pi-integration.pickers")

local integration_context = {
	state = state,
	ui = {
		notify = notify,
	},
	buffer = {
		valid = valid_buf,
		set_modifiable = set_modifiable,
		create = create_buffer,
		set_lines = set_buffer_lines,
	},
	messages = {
		extract_text = extract_text,
	},
	rpc = {
		send = send,
		handle_event = handle_event,
		handle_response = handle_response,
		event_error_text = event_error_text,
		recent_stderr_text = recent_stderr_text,
	},
	events = {
		set_loading = function(loading)
			return pi_events.set_loading(integration_ctx(), loading)
		end,
		start_activity = function(label)
			return pi_events.start_activity(integration_ctx(), label)
		end,
	},
	logs = {
		add = add_log,
		show = show_logs,
	},
	transcript = {
		win_valid = transcript_win_valid,
		metadata_lines = metadata_lines,
		update_statusline = update_transcript_statusline,
		refresh_ui = refresh_transcript_ui,
		touch = touch_transcript,
		append_status = append_status,
		remove_status = remove_status,
		append_lines = append_lines,
		append_text = append_text,
		append_message_header = append_message_header,
		line_count = transcript_line_count,
		clear_items = clear_transcript_items,
		begin_trace_item = begin_trace_item,
		end_trace_item = end_trace_item,
		register_item = register_transcript_item,
		set_line = set_transcript_line,
		open_item_under_cursor = open_transcript_item_under_cursor,
		start_assistant_placeholder = start_assistant_placeholder,
		assistant_placeholder_active = assistant_placeholder_active,
		ensure_assistant_turn_started = ensure_assistant_turn_started,
		clear_assistant_placeholder = clear_assistant_placeholder,
		clear_assistant_placeholder_spinner = clear_assistant_placeholder_spinner,
		render_error_message = render_error_message,
	},
	tools = {
		record_calls = record_tool_calls,
		record_execution_call = record_tool_execution_call,
		store_output = store_tool_output,
		store_or_update_live_output = store_or_update_live_tool_output,
		store_or_update_spawn_run_output = store_or_update_spawn_run_output,
		bind_spawn_run = bind_spawn_run_output,
		store_display = store_tool_display,
		live_output_id = live_tool_output_id,
		summary_lines = tool_output_summary_lines,
	},
	thinking = {
		store_output = store_thinking_output,
		append_output = append_thinking_output,
		text = thinking_output_text,
		summary_lines = thinking_output_summary_lines,
	},
	skills = {
		store_prompt = store_skill_prompt,
		summary_lines = skill_summary_lines,
		apply_tool_result = apply_skill_tool_result,
	},
	session = {
		set_model_metadata = set_model_metadata,
		set_input_text = set_input_text,
		reset_outputs = reset_transcript_outputs,
		apply_state = function(data, new_session)
			return pi_session.apply_state(integration_ctx(), data, new_session)
		end,
		sync = function(options)
			return pi_session.sync(integration_ctx(), options)
		end,
		switch_session = function(path)
			return pi_session.switch_session(integration_ctx(), path)
		end,
		is_agent_active = is_agent_active,
	},
	access = {},
	window = {},
	notices = {
		empty_session = EMPTY_SESSION_NOTICE,
	},
}

integration_context.access.is_mode = function(mode)
	return pi_pickers.is_access_mode({ config = M.config }, mode)
end

integration_context.integration = {
	is_mode = function(mode)
		return pi_pickers.is_integration_mode({ config = M.config }, mode)
	end,
}

integration_ctx = function()
	integration_context.config = M.config
	integration_context.actions = M
	integration_context.window.parent = state.transcript_win
	integration_context.transcript.update_statusline = update_transcript_statusline
	integration_context.session.setup_keymaps = setup_keymaps
	return integration_context
end

setup_keymaps = function()
	pi_keymaps.setup(integration_ctx())
end

update_transcript_statusline = function()
	local ctx = integration_ctx()
	pi_statusline.update(ctx)
	pi_layout.update_input_sidebar(ctx)
end

function M.setup(opts)
	M.config = vim.tbl_deep_extend("force", M.config, opts or {})
	state.access_mode = "ask"
	state.integration_mode = "ask"
	set_model_metadata(M.config.provider, M.config.model)
	pi_statusline.setup(integration_ctx())
end

function M.open(session_file)
	if session_file then
		state.pending_session_file = require("pi-integration.runtime").canonical_path(session_file)
	end
	pi_layout.open(integration_ctx())
	require("pi-integration.runtime").start(state)
	pi_rpc.start(integration_ctx())
end

function M.show_input()
	pi_layout.show_input(integration_ctx())
	update_transcript_statusline()
end

function M.show_transcript()
	pi_layout.show_transcript(integration_ctx())
	if state.session_file or state.pending_session_file or (state.job and state.job > 0) then
		M.refresh_messages()
	end
end

function M.restore_status_footer()
	update_transcript_statusline()
end

function M.start()
	pi_rpc.start(integration_ctx())
end

function M.refresh_session_stats()
	pi_actions.refresh_session_stats(integration_ctx())
end

function M.submit_prompt()
	pi_actions.submit_prompt(integration_ctx())
end

function M.fail_pending_prompts()
	pi_actions.fail_pending_prompts(integration_ctx())
end

function M.flush_queued_prompts()
	pi_actions.flush_queued_prompts(integration_ctx())
end

function M.finish_loading_if_ready()
	pi_actions.finish_loading_if_ready(integration_ctx())
end

function M.abort()
	pi_actions.abort(integration_ctx())
end

function M.history()
	pi_actions.history(integration_ctx())
end

function M.show_workspace_diff()
	pi_actions.show_workspace_diff(integration_ctx())
end

function M.toggle_notifications()
	pi_actions.toggle_notifications(integration_ctx())
end

function M.rename_session()
	pi_actions.rename_session(integration_ctx())
end

function M.new_session()
	pi_session.new_session(integration_ctx())
end

function M.new_session_window()
	pi_session.new_session_window(integration_ctx())
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

load_session_messages_from_file = function(path)
	return pi_messages.load_session_messages_from_file(integration_ctx(), path, state.tree_leaf_id)
end

local function load_session_messages_from_records(records, leaf_id)
	return pi_messages.load_session_messages_from_records(integration_ctx(), records, leaf_id)
end

local function collect_message_lines(messages)
	return pi_messages.collect_message_lines(integration_ctx(), messages)
end

local function apply_collected_transcript_items(items)
	return pi_transcript.apply_collected_transcript_items(transcript_ctx(), items)
end

local function scroll_transcript_to_bottom()
	return pi_transcript.scroll_to_bottom(transcript_ctx())
end

render_messages = function(messages)
	if not valid_buf(state.transcript_buf) then
		return
	end

	local ctx = transcript_ctx()
	local preserve_view = pi_transcript.is_focused(ctx)

	touch_transcript()
	reset_transcript_outputs()
	local lines, items = collect_message_lines(messages)
	pi_transcript.preserve_focused_view(ctx, function()
		set_buffer_lines(state.transcript_buf, lines, false)
	end)
	apply_collected_transcript_items(items)
	update_transcript_statusline()
	render_transcript()
	if not preserve_view then
		scroll_transcript_to_bottom()
		vim.schedule(scroll_transcript_to_bottom)
	end
end

function M.restore_session_transcript(path, leaf_id)
	if valid_buf(state.transcript_buf) then
		render_messages(pi_messages.load_session_messages_from_file(integration_ctx(), path, leaf_id))
	end
end

function M.refresh_messages()
	if is_agent_active() then
		notify("Pi is active; transcript refresh will run after the current run finishes.", vim.log.levels.WARN)
		return
	end

	if state.job and state.job > 0 then
		send({ type = "get_entries" }, function(event)
			if not event.success or not event.data then
				notify("Could not get session entries", vim.log.levels.ERROR)
				return
			end

			state.tree_leaf_id = normalize_leaf_id(event.data.leafId)
			render_messages(load_session_messages_from_records(event.data.entries or {}, state.tree_leaf_id))
			M.refresh_session_stats()
		end)
		return
	end

	local path = state.pending_session_file or state.session_file
	if path and path ~= "" then
		render_messages(load_session_messages_from_file(path))
		return
	end

	notify("Pi is not running.", vim.log.levels.WARN)
end

function M.show_tree()
	pi_tree.show(integration_ctx())
end

function M.set_access_mode(mode)
	pi_pickers.set_access_mode(integration_ctx(), mode)
end

function M.pick_access_mode()
	pi_pickers.pick_access_mode(integration_ctx())
end

function M.cycle_access_mode()
	pi_pickers.cycle_access_mode(integration_ctx())
end

function M.set_integration_mode(mode)
	pi_pickers.set_integration_mode(integration_ctx(), mode)
end

function M.pick_integration_mode()
	pi_pickers.pick_integration_mode(integration_ctx())
end

function M.cycle_integration_mode()
	pi_pickers.cycle_integration_mode(integration_ctx())
end

function M.show_help()
	pi_help.toggle(integration_ctx())
end

function M.show_logs()
	pi_logs.show(integration_ctx())
end

function M.show_usage()
	pi_usage.toggle(integration_ctx())
end

function M.pick_thinking()
	pi_pickers.pick_thinking(integration_ctx())
end

function M.pick_model()
	pi_pickers.pick_model(integration_ctx())
end

function M.pick_command()
	pi_pickers.pick_command(integration_ctx())
end

function M.restore_pending_action()
	require("pi-integration.pending-picker").restore(integration_ctx())
end

function M.get_commands(callback)
	send({ type = "get_commands" }, function(event)
		local commands = event.success and event.data and event.data.commands or {}
		callback(commands)
	end)
end

local function restart_in_cwd(path)
	local cwd = vim.fs.normalize(vim.fn.fnamemodify(vim.fn.expand(path), ":p"))
	if vim.fn.isdirectory(cwd) ~= 1 then
		notify("Directory does not exist: " .. cwd, vim.log.levels.ERROR)
		return
	end
	if cwd == vim.fs.normalize(vim.fn.getcwd()) then
		notify("Pi is already using " .. cwd)
		return
	end

	local ok, error_message = pcall(vim.api.nvim_set_current_dir, cwd)
	if not ok then
		notify("Could not change CWD: " .. tostring(error_message), vim.log.levels.ERROR)
		return
	end
	pi_rpc.restart(integration_ctx(), { fresh_session = true })
end

function M.change_cwd(path)
	if state.has_sent_message or state.pending_session_file then
		notify("CWD can only be changed before the first message. Start a new session to use another directory.", vim.log.levels.WARN)
		return
	end

	if type(path) == "string" and vim.trim(path) ~= "" then
		restart_in_cwd(vim.trim(path))
		return
	end

	local cwd = (state.workspace and state.workspace.cwd) or vim.fn.getcwd()
	require("pi-integration.directory-history").input(
		{ prompt = "Pi CWD: ", default = cwd, completion = "dir" },
		function(selected)
			if selected and vim.trim(selected) ~= "" then
				restart_in_cwd(vim.trim(selected))
			end
		end
	)
end

function M.restart()
	pi_rpc.restart(integration_ctx())
end

function M.pick_session()
	pi_sessions.pick(integration_ctx())
end

function M.maybe_prompt_session_archive()
	pi_sessions.maybe_prompt_archive(integration_ctx())
end

function M.pick_spawn()
	pi_spawn.pick(integration_ctx())
end
vim.api.nvim_create_autocmd("VimLeavePre", {
	callback = function()
		pi_rpc.stop(integration_ctx())
	end,
})

return M
