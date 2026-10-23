local M = {}

local pi_skills = require("pi-integration.skills")
local pi_tool_output = require("pi-integration.tool-output")
local pi_thinking_output = require("pi-integration.thinking-output")
local message_utils = require("pi-integration.utils.message")
local time_utils = require("pi-integration.utils.time")
local tool_groups = require("pi-integration.tool-groups")

local function message_role_title(message)
	local role = message.role or message.type or "message"
	if role == "toolResult" then
		return "Tool"
	end
	if role == "user" or role == "You" then
		return "User"
	end
	return role:gsub("^%l", string.upper)
end

local function add_message_separator(lines, has_body)
	if has_body then
		vim.list_extend(lines, { "", "---", "" })
	else
		table.insert(lines, "")
	end
end

local function remove_trailing_blank(lines)
	if lines[#lines] == "" then
		table.remove(lines)
	end
end

local function is_trace_like(kind)
	return kind == "tool" or kind == "thinking" or kind == "skill"
end

local function format_integer(value)
	local number = tonumber(value)
	if not number then
		return nil
	end
	local text = tostring(math.floor(number))
	local result = text:reverse():gsub("(%d%d%d)", "%1,"):reverse():gsub("^,", "")
	return result
end

local function append_compaction_summary(lines, items, message, has_body)
	add_message_separator(lines, has_body)
	local marker_line = #lines + 1
	local parts = { "󰗨 Session compacted here" }
	local tokens = format_integer(message.tokensBefore)
	if tokens then
		table.insert(parts, tokens .. " tokens before")
	end
	if type(message.firstKeptEntryId) == "string" and message.firstKeptEntryId ~= "" then
		table.insert(parts, "kept from " .. message.firstKeptEntryId)
	end
	if type(message.timestamp) == "string" and message.timestamp ~= "" then
		table.insert(parts, time_utils.format_timestamp(message.timestamp))
	end
	vim.list_extend(lines, { "> " .. table.concat(parts, " · "), "" })
	table.insert(items, {
		kind = "compaction",
		start_line = marker_line,
		end_line = marker_line,
		summary = message.summary,
	})
	return true, "compaction"
end

local function has_tool_item(state, tool_call_id)
	local output_id = tool_call_id and state.live_tool_output_by_call[tool_call_id]
	return output_id and state.tool_items_by_output[output_id] ~= nil
end

local function write_tool_output(ctx, lines, items, output_id)
	return tool_groups.write_output(ctx.state, items, output_id, #lines + 1, function(line, text)
		lines[line] = text
	end)
end

local function update_existing_spawn_output(ctx, lines, items, message, text)
	local updated, remaining, represented = pi_tool_output.update_spawn_outputs(ctx.state, message.details, text)
	for _, output_id in ipairs(updated) do write_tool_output(ctx, lines, items, output_id) end
	return represented, remaining
end

local function render_tool_summary(ctx, lines, items, message, ensure_assistant_block)
	if not ctx.state.show_nested_tools and pi_tool_output.is_codemode_child(ctx.state, message) then return false end
	local name = message.toolName or "tool"
	local text = message_utils.extract_text(message) or ""
	local tool_call_id = message_utils.tool_call_id(message)
	local details = message.details
	if name == "spawn_control" then
		local call = ctx.state.tool_calls[tool_call_id]
		if not message.isError and details == nil and call and call.execution_status == "running" then return false end
		local represented, remaining = update_existing_spawn_output(ctx, lines, items, message, not message.isError and text or nil)
		if not message.isError and represented then return false end
		if not message.isError then details = remaining end
	end
	if ensure_assistant_block and not has_tool_item(ctx.state, tool_call_id) then ensure_assistant_block() end
	local output_id = pi_tool_output.store_or_update_live(
		ctx.state, name, tool_call_id, text, nil, details,
		pi_tool_output.display_for_result(ctx.state, message), message.isError
	)
	local added = write_tool_output(ctx, lines, items, output_id)
	if added then
		table.insert(lines, "")
	end
	return added
end

local function append_thinking_summary(ctx, lines, items, text)
	if type(text) ~= "string" or text == "" then
		return false
	end
	local output_id = pi_thinking_output.store(ctx.state, text)
	vim.list_extend(lines, pi_thinking_output.summary_lines(ctx.state, output_id, false))
	local line = #lines
	table.insert(lines, "")
	table.insert(items, {
		kind = "thinking",
		start_line = line,
		end_line = line,
		output_id = output_id,
	})
	return true
end

local function append_skill_load_summaries(ctx, lines, items, loads, has_body, previous_kind, options)
	if type(loads) ~= "table" or #loads == 0 then
		return false
	end
	options = options or {}
	if options.current_message_started then
		-- The caller already emitted the assistant heading for this trace-only turn.
	elseif has_body and is_trace_like(previous_kind) then
		remove_trailing_blank(lines)
	else
		add_message_separator(lines, has_body)
	end
	for _, load in ipairs(loads) do
		local output_id = pi_skills.store_load(ctx.state, load)
		vim.list_extend(lines, pi_skills.summary_lines(ctx.state, output_id))
		local line = #lines
		table.insert(items, {
			kind = "skill",
			start_line = line,
			end_line = line,
			output_id = output_id,
		})
	end
	table.insert(lines, "")
	return true
end

local function append_text_message(lines, message, text, has_body)
	local text_lines = vim.split(text, "\n", { plain = true })
	add_message_separator(lines, has_body)
	table.insert(lines, "## " .. message_role_title(message))
	local header_line = #lines
	table.insert(lines, "")
	vim.list_extend(lines, text_lines)
	return header_line
end

local function append_assistant_blocks(ctx, lines, items, message, has_body, options)
	options = options or {}
	local content = message.content
	if type(content) ~= "table" then
		local text = message_utils.extract_text(message)
		if text and text ~= "" then
			if options.continue_trace then
				if lines[#lines] ~= "" then
					table.insert(lines, "")
				end
				vim.list_extend(lines, vim.split(text, "\n", { plain = true }))
			else
				append_text_message(lines, message, text, has_body)
			end
			return true, "message"
		end
		return false, nil
	end

	local started = false
	local appended = false
	local pending_text = {}
	local last_rendered_kind = nil

	local function ensure_assistant_message()
		if started then
			return
		end
		if options.continue_trace then
			started = true
			return
		end
		add_message_separator(lines, has_body)
		table.insert(lines, "## " .. message_role_title(message))
		table.insert(lines, "")
		started = true
	end

	local function ensure_inline_gap(kind)
		local previous_kind = last_rendered_kind
		if not previous_kind and not appended and options.continue_trace then
			previous_kind = options.previous_kind
		end
		if is_trace_like(kind) and is_trace_like(previous_kind) then
			remove_trailing_blank(lines)
		elseif previous_kind and lines[#lines] ~= "" then
			table.insert(lines, "")
		end
	end

	local function flush_text()
		local text = table.concat(pending_text, "")
		pending_text = {}
		if text == "" then
			return
		end
		ensure_assistant_message()
		ensure_inline_gap("message")
		vim.list_extend(lines, vim.split(text, "\n", { plain = true }))
		appended = true
		last_rendered_kind = "message"
	end

	for _, item in ipairs(content) do
		if type(item) == "string" then
			table.insert(pending_text, item)
		elseif type(item) == "table" then
			if item.type == "thinking" then
				flush_text()
				local thinking = item.thinking or item.text or ""
				if thinking ~= "" then
					ensure_assistant_message()
					ensure_inline_gap("thinking")
					if append_thinking_summary(ctx, lines, items, thinking) then
						appended = true
						last_rendered_kind = "thinking"
					end
				end
			elseif item.type == "text" or item.text then
				table.insert(pending_text, item.text or item.content or item.delta or "")
			end
		end
	end
	flush_text()
	return appended, last_rendered_kind
end

local function with_tool_executions(messages, tools)
	if not tools or #tools == 0 then return messages or {} end
	local calls, results, ambiguous, by_id, at_message = {}, {}, {}, {}, {}
	for index, message in ipairs(messages or {}) do
		if message.role == "assistant" and type(message.content) == "table" then
			for _, block in ipairs(message.content) do
				if type(block) == "table" and (block.type == "toolCall" or block.type == "tool_call") then
					local id = message_utils.tool_call_id(block)
					if id then
						if calls[id] then ambiguous[id] = true end
						calls[id] = index
					end
				end
			end
		elseif message.role == "toolResult" and message.toolCallId then
			if results[message.toolCallId] then ambiguous[message.toolCallId] = true end
			results[message.toolCallId] = index
		end
	end
	for _, tool in ipairs(tools) do by_id[tool.toolCallId] = tool end
	for _, tool in ipairs(tools) do
		local root, seen = tool, {}
		while root and root.parentToolCallId do
			local parent = root.parentToolCallId
			if seen[parent] then root = nil; break end
			seen[parent] = true
			root = by_id[parent] or { toolCallId = parent }
		end
		local id = root and root.toolCallId
		local at = id and not ambiguous[id] and (calls[id] or results[id])
		-- A reused ID cannot identify which occurrence owns a retained execution.
		if at and calls[id] and results[id] and results[id] < calls[id] then at = nil end
		if at and not results[tool.toolCallId] then
			at_message[at] = at_message[at] or {}
			table.insert(at_message[at], tool)
		end
	end
	local visible = {}
	for index, message in ipairs(messages or {}) do
		table.insert(visible, message)
		-- Nested calls have no standalone history message. Keep their live records
		-- beside the root call, and omit records whose history anchor is gone.
		for _, tool in ipairs(at_message[index] or {}) do
			table.insert(visible, vim.tbl_extend("force", tool, { role = "tool_execution_start" }))
			if tool.result then
				table.insert(visible, vim.tbl_extend("force", tool, { role = "tool_execution_end" }))
			elseif tool.partialResult then
				table.insert(visible, vim.tbl_extend("force", tool, { role = "tool_execution_update" }))
			end
		end
	end
	return visible
end

function M.collect_message_lines(ctx, messages, tools)
	local lines = ctx.transcript.metadata_lines()
	local items = {}
	ctx.state.tool_items_by_output = {}
	local has_body = false
	local last_rendered_kind = nil
	local assistant_block_open = false

	local function ensure_assistant_block()
		if assistant_block_open then
			if has_body and is_trace_like(last_rendered_kind) then
				remove_trailing_blank(lines)
			elseif last_rendered_kind and lines[#lines] ~= "" then
				table.insert(lines, "")
			end
			return false
		end
		add_message_separator(lines, has_body)
		table.insert(lines, "## Assistant")
		table.insert(lines, "")
		has_body = true
		assistant_block_open = true
		return true
	end

	local function close_assistant_block()
		assistant_block_open = false
	end

	for _, message in ipairs(with_tool_executions(messages, tools)) do
		local role = message.role or message.type
		local appended = false
		local rendered_kind = nil
		if role == "tool_execution_end" then
			local result = type(message.result) == "table" and message.result or {}
			message = {
				role = "toolResult",
				toolName = message.toolName,
				toolCallId = message.toolCallId,
				parentToolCallId = message.parentToolCallId,
				content = result.content,
				details = result.details,
				isError = message.isError == true or result.isError == true,
			}
			role = "toolResult"
		end
		if role == "tool_execution_start" or role == "tool_execution_update" then
			if role == "tool_execution_start" then
				pi_tool_output.record_execution_call(ctx.state, message.toolName, message.toolCallId, message.args,
					message.state == "interrupted" and "interrupted" or "running", message.parentToolCallId)
			end
			if not pi_skills.tool_result_skill_name(ctx.state, message) then
				local partial = type(message.partialResult) == "table" and message.partialResult or {}
				appended = render_tool_summary(ctx, lines, items, {
					toolName = message.toolName,
					toolCallId = message.toolCallId,
					parentToolCallId = message.parentToolCallId,
					content = partial.content,
					details = partial.details,
				}, ensure_assistant_block)
				rendered_kind = appended and "tool" or nil
			end
		elseif role == "agent_settled" or role == "agent_end" or role == "child_exit" then
			if not message.willRetry then
				for _, output_id in ipairs(pi_tool_output.interrupt_executions(ctx.state)) do
					if ctx.state.tool_items_by_output[output_id] then
						write_tool_output(ctx, lines, items, output_id)
					end
				end
			end
		elseif role == "toolResult" then
			local name = message.toolName or "tool"
			local text = message_utils.extract_text(message) or ""
			local tool_call_id = message_utils.tool_call_id(message)
			pi_tool_output.record_execution_call(ctx.state, name, tool_call_id, nil, "completed", message.parentToolCallId)
			if pi_skills.tool_result_skill_name(ctx.state, message) then
				pi_skills.apply_tool_result(ctx.state, message, text)
				appended = false
			elseif name == "spawn" and not message.isError and not has_tool_item(ctx.state, tool_call_id)
				and update_existing_spawn_output(ctx, lines, items, message, text) then
				appended = false
			else
				appended = render_tool_summary(ctx, lines, items, message, ensure_assistant_block)
				rendered_kind = appended and "tool" or nil
			end
		elseif role == "bashExecution" then
			ensure_assistant_block()
			local output_id = pi_tool_output.store(ctx.state, "bash", message.output or "", "text", { fullOutputPath = message.fullOutputPath })
			ctx.state.tool_outputs[output_id].display = { kind = "bash", command = message.command }
			appended = write_tool_output(ctx, lines, items, output_id)
			rendered_kind = appended and "tool" or nil
		elseif role == "compactionSummary" then
			close_assistant_block()
			appended, rendered_kind = append_compaction_summary(lines, items, message, has_body)
		elseif role == "assistant" then
			pi_tool_output.record_calls(ctx.state, message)
			local skill_loads = pi_skills.collect_loads(ctx.state, message)
			appended, rendered_kind = append_assistant_blocks(ctx, lines, items, message, has_body, {
				continue_trace = assistant_block_open,
				previous_kind = last_rendered_kind,
			})
			if appended then
				assistant_block_open = true
			end
			local skill_loads_start_trace_turn = false
			if #skill_loads > 0 and not assistant_block_open then
				ensure_assistant_block()
				skill_loads_start_trace_turn = true
			end
			local previous_kind = rendered_kind or last_rendered_kind
			if append_skill_load_summaries(ctx, lines, items, skill_loads, has_body, previous_kind, {
				current_message_started = skill_loads_start_trace_turn,
			}) then
				assistant_block_open = true
				appended = true
				rendered_kind = "skill"
			end
		elseif role == "custom" then
			local name = message_utils.spawn_custom_tool_name(message)
			if name then
				local text = message_utils.extract_text(message) or ""
				local represented, remaining = update_existing_spawn_output(ctx, lines, items, message, name ~= "spawn" and text or nil)
				if not represented then
					ensure_assistant_block()
					-- A fallback control/completion row is not an owning spawn ack.
					local output_id = pi_tool_output.store(ctx.state, "spawn_control", text, nil, remaining)
					appended = write_tool_output(ctx, lines, items, output_id)
					if appended then table.insert(lines, "") end
					rendered_kind = appended and "tool" or nil
				end
			elseif message.display == false then
				appended = false
			else
				local text = message_utils.extract_text(message)
				if text and text ~= "" then
					close_assistant_block()
					append_text_message(lines, message, text, has_body)
					appended = true
					rendered_kind = "message"
				end
			end
		else
			local text = message_utils.extract_text(message)
			if text and text ~= "" then
				close_assistant_block()
				append_text_message(lines, message, text, has_body)
				appended = true
				rendered_kind = "message"
			end
		end
		if appended then
			has_body = true
			last_rendered_kind = rendered_kind
		end
	end

	if not has_body then
		vim.list_extend(lines, { "", "> " .. ctx.notices.empty_session })
	end

	return lines, items
end

return M
