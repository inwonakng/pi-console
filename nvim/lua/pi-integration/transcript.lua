local markdown_render = require("pi-integration.markdown-render")
local tool_groups = require("pi-integration.tool-groups")
local tool_output = require("pi-integration.tool-output")

local M = {}

local quote_ns = vim.api.nvim_create_namespace("pi-console-transcript-quotes")

local function yaml_value(value)
	if value == nil or value == "" then
		return "null"
	end
	local text = tostring(value):gsub("\\", "\\\\"):gsub('"', '\\"')
	return '"' .. text .. '"'
end

local function session_label(state)
	if not state.session_file or state.session_file == "" then
		return nil
	end
	return vim.fn.fnamemodify(state.session_file, ":t")
end

function M.metadata_lines(ctx)
	local state = ctx.state
	return {
		"---",
		"title: " .. yaml_value(state.session_name or "Pi Session"),
		"model: " .. yaml_value(state.model_id or ctx.config.model),
		"provider: " .. yaml_value(state.provider or ctx.config.provider),
		"thinking: " .. yaml_value(state.thinking_level),
		"access: " .. yaml_value(state.access_mode),
		"integration: " .. yaml_value(state.integration_mode),
		"session: " .. yaml_value(session_label(state)),
		"cwd: " .. yaml_value(vim.fn.getcwd()),
		"last_updated: " .. yaml_value(state.last_updated),
		"---",
	}
end

function M.metadata_end(ctx)
	local state = ctx.state
	if not ctx.buffer.valid(state.transcript_buf) then
		return nil
	end
	local first = vim.api.nvim_buf_get_lines(state.transcript_buf, 0, 1, false)[1]
	if first ~= "---" then
		return nil
	end
	local lines = vim.api.nvim_buf_get_lines(state.transcript_buf, 1, -1, false)
	for index, line in ipairs(lines) do
		if line == "---" then
			return index + 1
		end
	end
	return nil
end

function M.win_valid(ctx)
	local state = ctx.state
	return state.transcript_win
		and vim.api.nvim_win_is_valid(state.transcript_win)
		and ctx.buffer.valid(state.transcript_buf)
		and vim.api.nvim_win_get_buf(state.transcript_win) == state.transcript_buf
end

function M.is_focused(ctx)
	return M.win_valid(ctx) and vim.api.nvim_get_current_win() == ctx.state.transcript_win
end

function M.preserve_focused_view(ctx, callback)
	local state = ctx.state
	if not M.is_focused(ctx) then
		callback()
		return
	end

	local cursor = vim.api.nvim_win_get_cursor(state.transcript_win)
	local view = vim.fn.winsaveview()
	callback()

	if not M.win_valid(ctx) or not ctx.buffer.valid(state.transcript_buf) then
		return
	end
	local line_count = vim.api.nvim_buf_line_count(state.transcript_buf)
	cursor[1] = math.min(cursor[1], line_count)
	vim.api.nvim_win_set_cursor(state.transcript_win, cursor)
	view.lnum = cursor[1]
	vim.fn.winrestview(view)
end

local function lines_equal(left, right)
	if #left ~= #right then
		return false
	end
	for index, line in ipairs(left) do
		if line ~= right[index] then
			return false
		end
	end
	return true
end

function M.update_metadata(ctx)
	local state = ctx.state
	if not ctx.buffer.valid(state.transcript_buf) then
		return
	end
	local end_line = M.metadata_end(ctx)
	local lines = M.metadata_lines(ctx)
	if end_line then
		local current = vim.api.nvim_buf_get_lines(state.transcript_buf, 0, end_line, false)
		if lines_equal(current, lines) then
			return
		end
	end
	M.preserve_focused_view(ctx, function()
		ctx.buffer.set_modifiable(state.transcript_buf, true)
		if end_line then
			vim.api.nvim_buf_set_lines(state.transcript_buf, 0, end_line, false, lines)
		else
			vim.api.nvim_buf_set_lines(state.transcript_buf, 0, 0, false, lines)
		end
		ctx.buffer.set_modifiable(state.transcript_buf, false)
	end)
end

function M.has_body(ctx)
	local state = ctx.state
	local end_line = M.metadata_end(ctx)
	if not end_line then
		return false
	end
	local lines = vim.api.nvim_buf_get_lines(state.transcript_buf, end_line, -1, false)
	for _, line in ipairs(lines) do
		if line ~= "" then
			return true
		end
	end
	return false
end

local function tool_summary_rows(state, preview)
	local rows = {}
	for _, group in ipairs(state.transcript_items or {}) do
		if group.kind == "tool_group" then
			rows[group.start_line] = { output_id = group.children[1].output_id, stats = #group.children == 1 }
			if not preview then
				for _, child in ipairs(group.children) do
					rows[child.start_line] = { output_id = child.output_id, stats = true }
				end
			end
		end
	end
	return rows
end

local function apply_edit_stat_highlights(buf, line_index, line)
	local stats_start, _, add_count, remove_count = line:find("%+(%d+)/%-(%d+) · [^·]+$")
	if not stats_start then
		return
	end
	local add_start = stats_start
	local add_end = add_start + #add_count
	local remove_start = add_end + 2
	local remove_end = remove_start + #remove_count
	local _, block_separator_end = line:find(" · ", remove_end + 1, true)
	if not block_separator_end then
		return
	end
	local block_start = block_separator_end + 1
	vim.api.nvim_buf_set_extmark(buf, quote_ns, line_index - 1, add_start - 1, {
		end_col = add_end,
		hl_group = "PiEditAdd",
		priority = 325,
	})
	vim.api.nvim_buf_set_extmark(buf, quote_ns, line_index - 1, remove_start - 1, {
		end_col = remove_end,
		hl_group = "PiEditDelete",
		priority = 325,
	})
	vim.api.nvim_buf_set_extmark(buf, quote_ns, line_index - 1, block_start - 1, {
		end_col = #line,
		hl_group = "PiEditBlockCount",
		priority = 325,
	})
end

function M.apply_quote_highlights_to_buffer(buf, state, opts)
	if type(buf) ~= "number" or not vim.api.nvim_buf_is_valid(buf) then
		return
	end

	vim.api.nvim_buf_clear_namespace(buf, quote_ns, 0, -1)
	local lines = vim.api.nvim_buf_get_lines(buf, 0, -1, false)
	local rows = state and tool_summary_rows(state, opts and opts.preview) or {}
	for index, line in ipairs(lines) do
		local row = rows[index]
		local highlight = row and tool_output.summary_highlight(state, row.output_id)
		if not highlight and line:find("> 󰇥 ", 1, true) == 1 then
			highlight = "PiToolQuote"
		elseif not highlight and line:find("> 󰔛 ", 1, true) == 1 then
			highlight = "PiThinkingQuote"
		elseif not highlight and line:find("> 󰗨 Session compacted here", 1, true) == 1 then
			highlight = "PiThinkingQuote"
		elseif not highlight and line:find("> 󰢱 Using skill:", 1, true) == 1 then
			highlight = "PiSkillQuote"
		end
		if highlight then
			vim.api.nvim_buf_set_extmark(buf, quote_ns, index - 1, 0, {
				end_col = #line,
				hl_group = highlight,
				priority = 250,
			})
			vim.api.nvim_buf_set_extmark(buf, quote_ns, index - 1, 0, {
				virt_text = { { "▋", "PiQuoteBar" } },
				virt_text_pos = "overlay",
				priority = 300,
			})
			local output = row and state.tool_outputs[row.output_id]
			if row and row.stats and output and output.name == "edit" then
				apply_edit_stat_highlights(buf, index, line)
			end
			local failure_start = line:find("✗ failed", 1, true)
				or line:find("✗ exited ", 1, true)
				or line:find("✗ sandbox blocked", 1, true)
				or line:find("%d+ failed$")
			if failure_start then
				vim.api.nvim_buf_set_extmark(buf, quote_ns, index - 1, failure_start - 1, {
					end_col = #line,
					hl_group = "DiagnosticError",
					priority = 325,
				})
			end
		end
	end
end

function M.apply_quote_highlights(ctx)
	local state = ctx.state
	if not ctx.buffer.valid(state.transcript_buf) then
		return
	end
	M.apply_quote_highlights_to_buffer(state.transcript_buf, state)
end

function M.render(ctx)
	local state = ctx.state
	if not ctx.buffer.valid(state.transcript_buf) then
		return
	end
	if not M.win_valid(ctx) then
		return
	end

	vim.schedule(function()
		if ctx.buffer.valid(state.transcript_buf) and M.win_valid(ctx) then
			for _, win in ipairs(vim.api.nvim_list_wins()) do
				if vim.api.nvim_win_get_buf(win) == state.transcript_buf then
					tool_groups.apply_folds(state, win)
				end
			end
			markdown_render.render(state.transcript_buf, state.transcript_win, { latex = true, event = "PiNvim" })
			M.apply_quote_highlights(ctx)
		end
	end)
end

function M.touch(ctx)
	ctx.state.last_updated = os.date("%Y-%m-%d %H:%M:%S %z")
end

function M.refresh_ui(ctx)
	M.update_metadata(ctx)
	ctx.transcript.update_statusline()
	M.render(ctx)
end

function M.schedule_refresh(ctx)
	local state = ctx.state
	if state.transcript_refresh_scheduled then
		return
	end
	state.transcript_refresh_scheduled = true
	vim.defer_fn(function()
		state.transcript_refresh_scheduled = false
		if ctx.buffer.valid(state.transcript_buf) then
			M.refresh_ui(ctx)
		end
	end, 30)
end

function M.line_count(ctx)
	if not ctx.buffer.valid(ctx.state.transcript_buf) then
		return 0
	end
	return vim.api.nvim_buf_line_count(ctx.state.transcript_buf)
end

function M.scroll_to_bottom_unless_focused(ctx)
	local state = ctx.state
	if M.win_valid(ctx) and not M.is_focused(ctx) then
		vim.api.nvim_win_set_cursor(state.transcript_win, { vim.api.nvim_buf_line_count(state.transcript_buf), 0 })
		M.with_win(ctx, function()
			vim.cmd("normal! zb")
		end)
	end
end

function M.with_win(ctx, callback)
	if not M.win_valid(ctx) then
		return
	end
	vim.api.nvim_win_call(ctx.state.transcript_win, callback)
end

function M.append_lines(ctx, lines)
	local state = ctx.state
	if not ctx.buffer.valid(state.transcript_buf) then
		return
	end
	state.pending_transcript_item_separator = false
	if type(lines) == "string" then
		lines = vim.split(lines, "\n", { plain = true })
	end
	M.preserve_focused_view(ctx, function()
		ctx.buffer.set_modifiable(state.transcript_buf, true)
		local line_count = vim.api.nvim_buf_line_count(state.transcript_buf)
		local last_line = vim.api.nvim_buf_get_lines(state.transcript_buf, line_count - 1, line_count, false)[1]
		if lines[1] == "" and last_line == "" then
			table.remove(lines, 1)
		end
		if line_count == 1 and vim.api.nvim_buf_get_lines(state.transcript_buf, 0, 1, false)[1] == "" then
			vim.api.nvim_buf_set_lines(state.transcript_buf, 0, 1, false, lines)
		else
			vim.api.nvim_buf_set_lines(state.transcript_buf, line_count, line_count, false, lines)
		end
		ctx.buffer.set_modifiable(state.transcript_buf, false)
	end)
	M.scroll_to_bottom_unless_focused(ctx)
	M.schedule_refresh(ctx)
end

function M.append_text(ctx, text)
	local state = ctx.state
	if not ctx.buffer.valid(state.transcript_buf) or text == nil or text == "" then
		return
	end

	local parts = vim.split(text, "\n", { plain = true })
	M.preserve_focused_view(ctx, function()
		ctx.buffer.set_modifiable(state.transcript_buf, true)

		local last = vim.api.nvim_buf_line_count(state.transcript_buf)
		local current = vim.api.nvim_buf_get_lines(state.transcript_buf, last - 1, last, false)[1] or ""
		if state.pending_transcript_item_separator and current == "" then
			vim.api.nvim_buf_set_lines(state.transcript_buf, last, last, false, { parts[1] })
			last = last + 1
		else
			vim.api.nvim_buf_set_lines(state.transcript_buf, last - 1, last, false, { current .. parts[1] })
		end
		state.pending_transcript_item_separator = false

		if #parts > 1 then
			local rest = {}
			for i = 2, #parts do
				table.insert(rest, parts[i])
			end
			vim.api.nvim_buf_set_lines(state.transcript_buf, last, last, false, rest)
		end

		ctx.buffer.set_modifiable(state.transcript_buf, false)
	end)
	M.scroll_to_bottom_unless_focused(ctx)
	M.schedule_refresh(ctx)
end

local function normalized_header_role(role)
	role = role or "Message"
	if role == "You" then
		return "User"
	end
	return role
end

local function last_buffer_line(ctx)
	local state = ctx.state
	if not ctx.buffer.valid(state.transcript_buf) then
		return nil
	end
	local line_count = vim.api.nvim_buf_line_count(state.transcript_buf)
	return vim.api.nvim_buf_get_lines(state.transcript_buf, line_count - 1, line_count, false)[1]
end

function M.append_message_header(ctx, role)
	local state = ctx.state
	role = normalized_header_role(role)
	if role == "Assistant" and state.assistant_block_open then
		if not state.pending_transcript_item_separator and last_buffer_line(ctx) ~= "" then
			M.append_lines(ctx, { "" })
		end
		return false
	end
	state.assistant_block_open = role == "Assistant"
	if M.has_body(ctx) then
		M.append_lines(ctx, { "", "---", "", "## " .. role, "", "" })
	else
		M.append_lines(ctx, { "", "## " .. role, "", "" })
	end
	return true
end

function M.append_status(ctx, text)
	M.append_lines(ctx, { "> " .. text })
end

function M.remove_status(ctx, text)
	local state = ctx.state
	if not ctx.buffer.valid(state.transcript_buf) then
		return
	end
	local target = "> " .. text
	M.preserve_focused_view(ctx, function()
		ctx.buffer.set_modifiable(state.transcript_buf, true)
		local lines = vim.api.nvim_buf_get_lines(state.transcript_buf, 0, -1, false)
		for index = #lines, 1, -1 do
			if lines[index] == target then
				vim.api.nvim_buf_set_lines(state.transcript_buf, index - 1, index, false, {})
			end
		end
		ctx.buffer.set_modifiable(state.transcript_buf, false)
	end)
	M.schedule_refresh(ctx)
end

function M.set_line(ctx, line, text)
	local state = ctx.state
	if not ctx.buffer.valid(state.transcript_buf) then
		return
	end
	local line_count = vim.api.nvim_buf_line_count(state.transcript_buf)
	if line < 1 or line > line_count then
		return
	end
	M.preserve_focused_view(ctx, function()
		ctx.buffer.set_modifiable(state.transcript_buf, true)
		vim.api.nvim_buf_set_lines(state.transcript_buf, line - 1, line, false, { text or "" })
		ctx.buffer.set_modifiable(state.transcript_buf, false)
	end)
	M.schedule_refresh(ctx)
end

function M.scroll_to_bottom(ctx)
	local state = ctx.state
	if M.win_valid(ctx) and ctx.buffer.valid(state.transcript_buf) then
		vim.api.nvim_win_set_cursor(state.transcript_win, { vim.api.nvim_buf_line_count(state.transcript_buf), 0 })
		M.with_win(ctx, function()
			vim.cmd("normal! zb")
		end)
	end
end

function M.clear_transcript_items(ctx)
	ctx.state.transcript_items = {}
	ctx.state.tool_items_by_output = {}
	ctx.state.tool_group_expanded = {}
end

function M.apply_collected_transcript_items(ctx, items)
	ctx.state.transcript_items = items or {}
end

function M.register_transcript_item(ctx, item)
	if type(item) ~= "table" then
		return
	end
	item.start_line = item.start_line or item.line
	item.end_line = item.end_line or item.start_line
	if not item.start_line or not item.end_line then
		return
	end
	table.insert(ctx.state.transcript_items, item)
end

function M.transcript_item_at_line(ctx, line)
	return tool_groups.item_at_line(ctx.state.transcript_items, line)
end

function M.write_tool_output(ctx, output_id)
	local state = ctx.state
	if not ctx.buffer.valid(state.transcript_buf) then
		return
	end
	local existing = state.tool_items_by_output and state.tool_items_by_output[output_id]
	if not existing then
		M.ensure_assistant_turn_started(ctx, "Assistant")
		M.remove_pending_transcript_item_separator(ctx)
		local previous = state.transcript_items[#state.transcript_items]
		if not previous or previous.kind ~= "tool_group" or previous.end_line ~= M.line_count(ctx) then
			M.begin_trace_item(ctx)
		end
	end
	tool_groups.write_output(state, state.transcript_items, output_id, M.line_count(ctx) + 1, function(line, text)
		if line <= M.line_count(ctx) then
			M.set_line(ctx, line, text)
		else
			M.append_lines(ctx, { text })
		end
	end)
	if not existing then
		M.end_trace_item(ctx)
	end
end

function M.remove_pending_transcript_item_separator(ctx)
	local state = ctx.state
	if not state.pending_transcript_item_separator or not ctx.buffer.valid(state.transcript_buf) then
		return false
	end

	local removed = false
	M.preserve_focused_view(ctx, function()
		ctx.buffer.set_modifiable(state.transcript_buf, true)
		local line_count = vim.api.nvim_buf_line_count(state.transcript_buf)
		local last_line = vim.api.nvim_buf_get_lines(state.transcript_buf, line_count - 1, line_count, false)[1]
		if last_line == "" then
			vim.api.nvim_buf_set_lines(state.transcript_buf, line_count - 1, line_count, false, {})
			removed = true
		end
		ctx.buffer.set_modifiable(state.transcript_buf, false)
	end)
	state.pending_transcript_item_separator = false
	return removed
end

function M.append_transcript_item_separator(ctx)
	local state = ctx.state
	M.preserve_focused_view(ctx, function()
		ctx.buffer.set_modifiable(state.transcript_buf, true)
		local line_count = vim.api.nvim_buf_line_count(state.transcript_buf)
		vim.api.nvim_buf_set_lines(state.transcript_buf, line_count, line_count, false, { "" })
		ctx.buffer.set_modifiable(state.transcript_buf, false)
	end)
	state.pending_transcript_item_separator = true
	M.schedule_refresh(ctx)
end

function M.begin_trace_item(ctx)
	if M.remove_pending_transcript_item_separator(ctx) then
		return true
	end
	local last_line = last_buffer_line(ctx)
	if last_line == nil then
		return false
	end
	if last_line ~= "" then
		M.append_lines(ctx, { "" })
		return true
	end

	local state = ctx.state
	local line_count = vim.api.nvim_buf_line_count(state.transcript_buf)
	if line_count < 2 then
		return false
	end
	local previous_line = vim.api.nvim_buf_get_lines(state.transcript_buf, line_count - 2, line_count - 1, false)[1]
	if previous_line ~= "" then
		return false
	end
	M.preserve_focused_view(ctx, function()
		ctx.buffer.set_modifiable(state.transcript_buf, true)
		vim.api.nvim_buf_set_lines(state.transcript_buf, line_count - 1, line_count, false, {})
		ctx.buffer.set_modifiable(state.transcript_buf, false)
	end)
	return true
end

function M.end_trace_item(ctx)
	return M.append_transcript_item_separator(ctx)
end

function M.stop_placeholder_timer(ctx)
	local state = ctx.state
	if state.placeholder_timer then
		state.placeholder_timer:stop()
		state.placeholder_timer:close()
		state.placeholder_timer = nil
	end
end

function M.set_placeholder_line(ctx, text)
	local state = ctx.state
	if not ctx.buffer.valid(state.transcript_buf) or not state.placeholder_line then
		return
	end
	local line_count = vim.api.nvim_buf_line_count(state.transcript_buf)
	if state.placeholder_line < 1 or state.placeholder_line > line_count then
		return
	end
	M.preserve_focused_view(ctx, function()
		ctx.buffer.set_modifiable(state.transcript_buf, true)
		vim.api.nvim_buf_set_lines(state.transcript_buf, state.placeholder_line - 1, state.placeholder_line, false, { text })
		ctx.buffer.set_modifiable(state.transcript_buf, false)
	end)
	M.schedule_refresh(ctx)
end

function M.clear_assistant_placeholder(ctx)
	local state = ctx.state
	M.stop_placeholder_timer(ctx)
	if not ctx.buffer.valid(state.transcript_buf) or not state.placeholder_start_line or not state.placeholder_line then
		state.placeholder_start_line = nil
		state.placeholder_line = nil
		return
	end
	local start_line = state.placeholder_start_line - 1
	local end_line = state.placeholder_line
	local line_count = vim.api.nvim_buf_line_count(state.transcript_buf)
	if start_line < 0 or end_line > line_count then
		state.placeholder_start_line = nil
		state.placeholder_line = nil
		return
	end
	M.preserve_focused_view(ctx, function()
		ctx.buffer.set_modifiable(state.transcript_buf, true)
		vim.api.nvim_buf_set_lines(state.transcript_buf, start_line, end_line, false, {})
		ctx.buffer.set_modifiable(state.transcript_buf, false)
	end)
	state.placeholder_start_line = nil
	state.placeholder_line = nil
	M.schedule_refresh(ctx)
end

function M.clear_assistant_placeholder_spinner(ctx)
	local state = ctx.state
	M.stop_placeholder_timer(ctx)
	if not ctx.buffer.valid(state.transcript_buf) or not state.placeholder_line then
		state.placeholder_start_line = nil
		state.placeholder_line = nil
		return
	end
	local line_count = vim.api.nvim_buf_line_count(state.transcript_buf)
	if state.placeholder_line < 1 or state.placeholder_line > line_count then
		state.placeholder_start_line = nil
		state.placeholder_line = nil
		return
	end
	M.preserve_focused_view(ctx, function()
		ctx.buffer.set_modifiable(state.transcript_buf, true)
		vim.api.nvim_buf_set_lines(state.transcript_buf, state.placeholder_line - 1, state.placeholder_line, false, {})
		ctx.buffer.set_modifiable(state.transcript_buf, false)
	end)
	state.placeholder_start_line = nil
	state.placeholder_line = nil
	M.schedule_refresh(ctx)
end

function M.start_assistant_placeholder(ctx)
	local state = ctx.state
	M.clear_assistant_placeholder(ctx)
	local line_count = vim.api.nvim_buf_line_count(state.transcript_buf)
	local replacing_empty =
		line_count == 1 and vim.api.nvim_buf_get_lines(state.transcript_buf, 0, 1, false)[1] == ""
	local header_added = M.append_message_header(ctx, "Assistant")
	state.placeholder_start_line = header_added and (replacing_empty and 1 or (line_count + 1))
		or (line_count + 1)
	M.append_lines(ctx, { "⠋" })
	state.placeholder_line = vim.api.nvim_buf_line_count(state.transcript_buf)
	state.placeholder_tick = 1

	local frames = {
		"⠋",
		"⠙",
		"⠩",
		"⠸",
		"⠼",
		"⠴",
		"⠦",
		"⠧",
	}
	local timer = vim.uv.new_timer()
	state.placeholder_timer = timer
	timer:start(250, 250, vim.schedule_wrap(function()
		if state.placeholder_timer ~= timer then
			return
		end
		state.placeholder_tick = (state.placeholder_tick % #frames) + 1
		M.set_placeholder_line(ctx, frames[state.placeholder_tick])
	end))
end

function M.assistant_placeholder_active(ctx)
	return ctx.state.placeholder_start_line ~= nil and ctx.state.placeholder_line ~= nil
end

function M.ensure_assistant_turn_started(ctx, role)
	local state = ctx.state
	if state.current_message_started then
		return false
	end
	if M.assistant_placeholder_active(ctx) then
		M.clear_assistant_placeholder_spinner(ctx)
	else
		M.append_message_header(ctx, role or "Assistant")
	end
	state.current_message_started = true
	return true
end

function M.render_error_message(ctx, title, message)
	M.clear_assistant_placeholder(ctx)
	ctx.state.error_rendered_for_active_run = true
	M.append_message_header(ctx, title)
	M.append_lines(ctx, tostring(message or ""))
end

return M
