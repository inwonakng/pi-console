local floats = require("pi-integration.floats")
local buffer_utils = require("pi-integration.utils.buffer")
local json = require("pi-integration.utils.json")
local message_utils = require("pi-integration.utils.message")
local markdown_render = require("pi-integration.markdown-render")
local pi_messages = require("pi-integration.messages")
local pi_tool_output = require("pi-integration.tool-output")
local pi_thinking_output = require("pi-integration.thinking-output")
local pi_skills = require("pi-integration.skills")
local pi_transcript = require("pi-integration.transcript")

local M = {}

local function decode_json(line)
	return json.decode_object(line)
end

local function extract_text(message)
	return message_utils.extract_text(message)
end

local function read_messages(path)
	local messages = {}
	if not path or vim.fn.filereadable(path) ~= 1 then
		return messages
	end
	for _, line in ipairs(vim.fn.readfile(path)) do
		local record = decode_json(line)
		local event = type(record) == "table" and record.event or nil
		if type(event) == "table" and event.type == "message_end" and type(event.message) == "table" then
			table.insert(messages, event.message)
		end
	end
	return messages
end

local function metadata_lines(path)
	return {
		"---",
		"title: \"Spawn transcript\"",
		"source: \"" .. tostring(path):gsub("\\", "\\\\"):gsub('"', '\\"') .. "\"",
		"last_updated: \"" .. os.date("%Y-%m-%d %H:%M:%S %z") .. "\"",
		"---",
	}
end

local function make_render_ctx(state, path)
	return {
		state = state,
		messages = {
			extract_text = extract_text,
		},
		transcript = {
			metadata_lines = function()
				return metadata_lines(path)
			end,
		},
		tools = {
			record_calls = function(message)
				return pi_tool_output.record_calls(state, message)
			end,
			record_execution_call = function(tool_name, tool_call_id, args)
				return pi_tool_output.record_execution_call(state, tool_name, tool_call_id, args)
			end,
			store_output = function(tool_name, text, filetype, details, message)
				local tool_call_id = message_utils.tool_call_id(message)
				return pi_tool_output.store(state, tool_name, text, filetype, details, pi_tool_output.display_for_result(state, message), tool_call_id)
			end,
			store_or_update_spawn_run_output = function(run, text)
				return pi_tool_output.store_or_update_spawn_run(state, run, text)
			end,
			bind_spawn_run = function(run, output_id, line)
				return pi_tool_output.bind_spawn_run(state, run, output_id, line)
			end,
			summary_lines = function(output_id)
				return pi_tool_output.summary_lines(state, output_id)
			end,
		},
		thinking = {
			store_output = function(text)
				return pi_thinking_output.store(state, text)
			end,
			summary_lines = function(output_id, streaming)
				return pi_thinking_output.summary_lines(state, output_id, streaming)
			end,
		},
		skills = {
			store_prompt = function(load)
				return pi_skills.store_load(state, load)
			end,
			summary_lines = function(output_id)
				return pi_skills.summary_lines(state, output_id)
			end,
			apply_tool_result = function(message)
				return pi_skills.apply_tool_result(state, message, extract_text(message))
			end,
		},
	}
end

local function render_lines(path, state)
	state.transcript_items = {}
	pi_tool_output.reset(state)
	pi_thinking_output.reset(state)
	pi_skills.reset(state)
	local lines, items = pi_messages.collect_message_lines(make_render_ctx(state, path), read_messages(path))
	state.transcript_items = items or {}
	return lines
end

local function transcript_ctx(state)
	return {
		state = state,
		buffer = {
			valid = buffer_utils.valid,
			set_modifiable = buffer_utils.set_modifiable,
			set_lines = buffer_utils.set_lines,
		},
		transcript = {
			update_statusline = function() end,
		},
	}
end

local function render_transcript_ui(state)
	pi_transcript.render(transcript_ctx(state))
end

local function item_at_line(state, line)
	for _, item in ipairs(state.transcript_items or {}) do
		local start_line = item.start_line or item.line
		local end_line = item.end_line or start_line
		if start_line and end_line and line >= start_line and line <= end_line then
			return item
		end
	end
	return nil
end

local function open_item(ctx, state, parent_win)
	local cursor = vim.api.nvim_win_get_cursor(0)
	local item = item_at_line(state, cursor[1])
	if not item then
		return false
	end
	local child_ctx = {
		state = state,
		ui = {
			notify = ctx.ui.notify,
		},
		window = {
			parent = parent_win,
		},
	}
	if item.kind == "tool" then
		return pi_tool_output.open_float(child_ctx, item.output_id)
	elseif item.kind == "thinking" then
		return pi_thinking_output.open_float(child_ctx, item.output_id)
	elseif item.kind == "skill" then
		return pi_skills.open_float(child_ctx, item.output_id)
	end
	return false
end

function M.open(ctx, path, title)
	if not path or vim.fn.filereadable(path) ~= 1 then
		ctx.ui.notify("Could not read " .. tostring(path), vim.log.levels.WARN)
		return
	end

	local state = {
		tool_outputs = {},
		next_tool_output_id = 0,
		tool_calls = {},
		live_tool_output_by_call = {},
		spawn_run_output_by_id = {},
		spawn_run_lines = {},
		thinking_outputs = {},
		next_thinking_output_id = 0,
		skill_tool_calls = {},
		skill_outputs = {},
		next_skill_output_id = 0,
		transcript_items = {},
		transcript_buf = nil,
		transcript_win = nil,
	}

	local buf = buffer_utils.create_scratch({
		name = "pi://spawn/transcript/" .. vim.fn.fnamemodify(path, ":h:t"),
		filetype = "markdown",
	})
	markdown_render.prepare_buffer(buf, { latex = true })

	state.transcript_buf = buf

	local function refresh()
		local lines = render_lines(path, state)
		buffer_utils.set_lines(buf, lines, false)
		if state.transcript_win then
			render_transcript_ui(state)
		end
	end
	refresh()

	local width = math.min(math.max(72, math.floor(vim.o.columns * 0.82)), vim.o.columns - 4)
	local height = math.min(math.max(16, math.floor(vim.o.lines * 0.75)), vim.o.lines - 4)
	local row = math.max(1, math.floor((vim.o.lines - height) / 2))
	local col = math.max(0, math.floor((vim.o.columns - width) / 2))
	local win = vim.api.nvim_open_win(buf, true, {
		relative = "editor",
		width = width,
		height = height,
		row = row,
		col = col,
		style = "minimal",
		border = "rounded",
		title = " " .. (title or "Spawn transcript") .. " ",
		title_pos = "left",
	})
	state.transcript_win = win
	vim.api.nvim_set_option_value("wrap", true, { win = win })
	vim.api.nvim_set_option_value("number", false, { win = win })
	vim.api.nvim_set_option_value("relativenumber", false, { win = win })
	vim.api.nvim_set_option_value("signcolumn", "no", { win = win })
	render_transcript_ui(state)

	local close_win = function()
		floats.close_window(win)
	end
	floats.close_on_win_leave(buf, close_win, { win = win, parent = ctx.window.parent })
	vim.keymap.set("n", "q", close_win, { buffer = buf, silent = true, desc = "Close spawn transcript" })
	vim.keymap.set("n", "<Esc>", close_win, { buffer = buf, silent = true, desc = "Close spawn transcript" })
	vim.keymap.set("n", "r", function()
		refresh()
		ctx.ui.notify("Refreshed spawn transcript")
	end, { buffer = buf, silent = true, desc = "Refresh spawn transcript" })
	vim.keymap.set("n", "<CR>", function()
		open_item(ctx, state, win)
	end, { buffer = buf, silent = true, desc = "Open nested spawn item" })
end

return M
