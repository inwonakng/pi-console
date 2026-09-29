local root = vim.fn.getcwd()
vim.opt.runtimepath:append(root .. "/nvim")

local actions = require("pi-integration.actions")
local events = require("pi-integration.events")
local messages = require("pi-integration.messages")
local session_controller = require("pi-integration.session-controller")

local function assert_equal(actual, expected, label)
	if not vim.deep_equal(actual, expected) then
		error(string.format("%s\nexpected: %s\nactual:   %s", label, vim.inspect(expected), vim.inspect(actual)))
	end
end

local input_buf = vim.api.nvim_create_buf(false, true)
vim.api.nvim_buf_set_lines(input_buf, 0, -1, false, { "continue" })

local rendered = {}
local sent = {}
local callbacks = {}
local state = {
	input_buf = input_buf,
	is_loading = true,
	is_streaming = false,
	is_retrying = false,
	awaiting_agent_output = false,
	pending_user_messages = {},
	command_sources = {
		["pi-history"] = "extension",
		["skill:review"] = "skill",
	},
	workspace = { transitionPending = true },
}

local ctx = {
	state = state,
	buffer = {
		valid = function(buf)
			return vim.api.nvim_buf_is_valid(buf)
		end,
	},
	ui = {
		notify = function() end,
	},
	notices = {
		empty_session = "empty",
	},
	transcript = {
		remove_status = function() end,
		touch = function() end,
		append_message_header = function(role)
			table.insert(rendered, "## " .. role)
		end,
		append_text = function(text)
			table.insert(rendered, text)
		end,
		line_count = function()
			return #rendered + 2
		end,
		set_line = function(_, text)
			table.insert(rendered, text)
		end,
		update_statusline = function() end,
	},
	events = {
		set_loading = function(loading)
			state.is_loading = loading
		end,
		start_activity = function() end,
	},
	rpc = {
		send = function(cmd, callback)
			table.insert(sent, cmd)
			table.insert(callbacks, callback)
		end,
	},
	messages = {
		extract_text = function(message)
			return message.content
		end,
	},
}

ctx.actions = {
	finish_loading_if_ready = function()
		actions.finish_loading_if_ready(ctx)
	end,
	flush_queued_prompts = function()
		actions.flush_queued_prompts(ctx)
	end,
}

-- A prompt submitted during restoration is visible immediately but is not sent.
actions.submit_prompt(ctx)
assert_equal(#sent, 0, "loading prompt must not reach RPC")
assert_equal(state.pending_user_messages[1].status, "queued", "loading prompt is queued")
assert_equal(rendered, { "## User · Queued", "continue" }, "queued prompt is rendered optimistically")
assert_equal(vim.api.nvim_buf_get_lines(input_buf, 0, -1, false), { "" }, "queued prompt clears the editor")

-- Transcript reconstruction keeps optimistic queued messages visible.
local collected = messages.collect_message_lines({
	state = state,
	transcript = { metadata_lines = function() return { "---", "---" } end },
	messages = { extract_text = function(message) return message.content end },
	tools = {},
	thinking = {},
	skills = {},
	notices = { empty_session = "empty" },
}, {})
assert(vim.tbl_contains(collected, "## User · Queued"), "refresh must retain queued message heading")
assert(vim.tbl_contains(collected, "continue"), "refresh must retain queued message text")

-- The ready handshake flushes exactly one queued prompt and marks it as sending.
state.workspace.transitionPending = false
state.workspace_status_received = true
state.session_sync_complete = true
actions.finish_loading_if_ready(ctx)
assert_equal(state.is_loading, false, "ready handshake ends loading")
assert_equal(#sent, 1, "ready handshake sends queued prompt once")
assert_equal(sent[1], { type = "prompt", message = "continue" }, "queued prompt RPC payload")
assert_equal(state.pending_user_messages[1].status, "sending", "flushed prompt is marked sending")

-- The persisted user event reconciles the optimistic entry instead of duplicating it.
events.handle_event(ctx, {
	type = "message_end",
	message = { role = "user", content = "continue" },
})
assert_equal(#state.pending_user_messages, 0, "persisted user event acknowledges optimistic prompt")
assert_equal(rendered[#rendered], "## User", "acknowledged prompt loses its transient status")

-- Slash prompt templates are agent prompts, not immediate extension commands.
state.awaiting_agent_output = false
vim.api.nvim_buf_set_lines(input_buf, 0, -1, false, { "/skill:review" })
actions.submit_prompt(ctx)
assert_equal(#sent, 2, "slash prompt template is sent")
callbacks[2]({ type = "response", success = true })
assert_equal(#state.pending_user_messages, 1, "preflight success does not acknowledge a slash prompt template")
events.handle_event(ctx, {
	type = "message_end",
	message = { role = "user", content = "expanded skill prompt" },
})
assert_equal(#state.pending_user_messages, 0, "expanded user event acknowledges slash prompt template")

-- Discoverable extension commands acknowledge from their successful preflight response.
state.awaiting_agent_output = false
vim.api.nvim_buf_set_lines(input_buf, 0, -1, false, { "/pi-history" })
actions.submit_prompt(ctx)
assert_equal(#state.pending_user_messages, 1, "extension command is optimistic until RPC success")
callbacks[3]({ type = "response", success = true })
assert_equal(#state.pending_user_messages, 0, "extension command success acknowledges optimistic entry")

-- A process exit fails an unacknowledged send and restores its text.
state.awaiting_agent_output = false
vim.api.nvim_buf_set_lines(input_buf, 0, -1, false, { "survive restart" })
actions.submit_prompt(ctx)
assert_equal(state.pending_user_messages[1].status, "sending", "prompt is in flight before exit")
actions.fail_pending_prompts(ctx)
assert_equal(state.pending_user_messages[1].status, "failed", "in-flight prompt is failed on exit")
assert_equal(vim.api.nvim_buf_get_lines(input_buf, 0, -1, false), { "survive restart" }, "failed prompt returns to editor")

-- Multiple loading submissions flush one at a time in FIFO order.
state.pending_user_messages = {}
state.is_loading = true
state.workspace.transitionPending = true
vim.api.nvim_buf_set_lines(input_buf, 0, -1, false, { "first queued" })
actions.submit_prompt(ctx)
vim.api.nvim_buf_set_lines(input_buf, 0, -1, false, { "second queued" })
actions.submit_prompt(ctx)
assert_equal(#sent, 4, "loading holds every queued prompt")
state.workspace.transitionPending = false
state.workspace_status_received = true
state.session_sync_complete = true
actions.finish_loading_if_ready(ctx)
assert_equal(sent[5].message, "first queued", "FIFO flush sends first prompt first")
assert_equal(state.pending_user_messages[1].status, "sending", "first FIFO prompt is sending")
assert_equal(state.pending_user_messages[2].status, "queued", "second FIFO prompt remains queued")
events.handle_event(ctx, { type = "message_end", message = { role = "user", content = "first queued" } })
state.awaiting_agent_output = false
state.is_streaming = false
actions.flush_queued_prompts(ctx)
assert_equal(sent[6].message, "second queued", "FIFO flush sends second prompt after first turn")

-- An older get_state response cannot complete a newer synchronization generation.
local sync_callbacks = {}
local sync_actions_called = 0
local sync_failures = 0
local sync_state = { session_sync_generation = 0, is_loading = true }
local sync_ctx = {
	state = sync_state,
	rpc = {
		send = function(_, callback)
			table.insert(sync_callbacks, callback)
		end,
	},
	ui = { notify = function() end },
	events = {
		set_loading = function(loading) sync_state.is_loading = loading end,
	},
	actions = {
		finish_loading_if_ready = function() sync_actions_called = sync_actions_called + 1 end,
		refresh_messages = function() sync_actions_called = sync_actions_called + 1 end,
		refresh_session_stats = function() sync_actions_called = sync_actions_called + 1 end,
		fail_pending_prompts = function() sync_failures = sync_failures + 1 end,
	},
	transcript = {},
	session = {},
	buffer = {},
}
session_controller.sync(sync_ctx)
session_controller.sync(sync_ctx)
sync_callbacks[1]({ success = true, data = {} })
assert_equal(sync_actions_called, 0, "stale sync response is ignored")
sync_callbacks[2]({ success = false, error = "sync failed" })
assert_equal(sync_ctx.state.is_loading, false, "sync failure stops loading")
assert_equal(sync_ctx.state.loading_error, "sync failed", "sync failure records a terminal error")
assert_equal(sync_failures, 1, "sync failure visibly fails queued prompts")

print("loading queue regression checks passed")
