local M = {}

local pi_skills = require("pi-integration.skills")
local pi_tool_output = require("pi-integration.tool-output")
local pi_thinking_output = require("pi-integration.thinking-output")
local message_utils = require("pi-integration.utils.message")
local time_utils = require("pi-integration.utils.time")
local tool_groups = require("pi-integration.tool-groups")

local function message_role_title(message, state)
	local role = message.role or message.type or "message"
	local details = type(message.details) == "table" and message.details or {}
	local context = role == "custom" and message_utils.agent_context(message_utils.extract_text(message)) or nil
	local sender = details.sender or (context and context.sender)
	if role == "custom" and type(sender) == "table" and (sender.kind == "parent" or sender.kind == "worker") then
		return message_utils.agent_label(sender, details)
	end
	if role == "assistant" and state and state.subagent then
		return message_utils.subagent_label(state.subagent)
	end
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

local function append_text_message(lines, message, text, has_body, state)
	local context = message.role == "custom" and message_utils.agent_context(text) or nil
	if context then text = message_utils.agent_payload_text(context.payload) or text end
	local text_lines = vim.split(text, "\n", { plain = true })
	add_message_separator(lines, has_body)
	table.insert(lines, "## " .. message_role_title(message, state))
	local header_line = #lines
	table.insert(lines, "")
	vim.list_extend(lines, text_lines)
	return header_line
end

function M.append_error(lines, text, has_body, title)
	append_text_message(lines, { role = title or "Error" }, tostring(text or ""), has_body)
end

local function append_assistant_blocks(ctx, lines, items, message, has_body, options)
	options = options or {}
	local content = message.content
	if type(content) ~= "table" then
		content = { { type = "text", text = message_utils.extract_text(message) or "" } }
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
		table.insert(lines, "## " .. message_role_title(message, ctx.state))
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
	local calls, results, by_id, at_message, anchors = {}, {}, {}, {}, {}
	local call_positions, result_positions = {}, {}
	for index, message in ipairs(messages or {}) do
		if message.messageKey then
			if anchors[message.messageKey] ~= nil then anchors[message.messageKey] = false
			else anchors[message.messageKey] = index end
		end
		if message.role == "assistant" and type(message.content) == "table" then
			for _, block in ipairs(message.content) do
				if type(block) == "table" and (block.type == "toolCall" or block.type == "tool_call") then
					local id = message_utils.tool_call_id(block)
					if id then
						calls[id] = index
						call_positions[id] = call_positions[id] or {}
						table.insert(call_positions[id], index)
					end
				end
			end
		elseif message.role == "toolResult" and message.toolCallId then
			results[message.toolCallId] = index
			result_positions[message.toolCallId] = result_positions[message.toolCallId] or {}
			table.insert(result_positions[message.toolCallId], index)
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
		local key = tool.messageKey or (root and root.messageKey)
		local at = key and anchors[key] or (not key and id and (calls[id] or results[id]))
		local result_at, call_at = results[tool.toolCallId], calls[tool.toolCallId] or (id and calls[id])
		local has_result = result_at and (not call_at or result_at > call_at)
		if key and at then
			-- Old nested records can outlive a reused parent ID. Attach them only
			-- to their observed owner, and look for results in that occurrence.
			local boundary = #messages + 1
			for _, position in ipairs(call_positions[id] or {}) do
				if position > at then boundary = position; break end
			end
			has_result = false
			for _, position in ipairs(result_positions[tool.toolCallId] or {}) do
				if position > at and position < boundary then has_result = true; break end
			end
		end
		if at and not has_result then
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

-- RPC call IDs identify live executions, but providers may reuse them in later
-- turns. Give each historical occurrence its own rendering key, including its
-- nested execution records, so later results cannot update an earlier row.
local function scope_tool_calls(messages)
	local visible, current, counts, completed = {}, {}, {}, {}
	local function next_key(id)
		counts[id] = (counts[id] or 0) + 1
		current[id] = id .. ":" .. counts[id]
		completed[id] = nil
		return current[id]
	end
	for _, original in ipairs(messages) do
		local message = original
		local role = original.role or original.type or ""
		if role == "assistant" and type(original.content) == "table" then
			for index, block in ipairs(original.content) do
				if type(block) == "table" and (block.type == "toolCall" or block.type == "tool_call") then
					local id = message_utils.tool_call_id(block)
					if id then
						if message == original then
							message = vim.tbl_extend("force", {}, original)
							message.content = vim.list_slice(original.content)
						end
						message.content[index] = vim.tbl_extend("force", {}, block, { id = next_key(id) })
					end
				end
			end
		elseif role == "toolResult" or role:match("^tool_execution_") then
			-- Args, result content and details are read-only throughout output rendering.
			message = vim.tbl_extend("force", {}, original)
			local id = message_utils.tool_call_id(message)
			if id then
				if not current[id] or role == "tool_execution_start" and completed[id]
					or role == "toolResult" and completed[id] == "toolResult" then next_key(id) end
				message.id, message.toolCallId = nil, current[id]
				-- Spawn logs contain both execution_end and message_end for a
				-- result. They describe the same occurrence, not another call.
				if role == "toolResult" or role == "tool_execution_end" then completed[id] = role end
			end
			if message.parentToolCallId then message.parentToolCallId = current[message.parentToolCallId] end
		end
		table.insert(visible, message)
	end
	return visible
end

-- Keep this list aligned with the three output modules' reset functions.
-- tool_items_by_output also belongs to the renderer and shares objects with items.
local output_state_fields = {
	"tool_outputs", "next_tool_output_id", "tool_calls", "live_tool_output_by_call",
	"spawn_run_output_by_id", "todo_tool_output_id", "tool_items_by_output",
	"thinking_outputs", "next_thinking_output_id", "active_thinking_output_id", "active_thinking_line",
	"skill_tool_calls", "skill_outputs", "next_skill_output_id",
}

local function render_dependencies(state)
	local workspace = type(state.workspace) == "table" and state.workspace or {}
	return {
		show_nested_tools = state.show_nested_tools,
		workspace_path = workspace.path,
		workspace_cwd = workspace.cwd,
		todo_status = state.todo_status,
		session_file = state.session_file,
		spawn_runs_session_file = state.spawn_runs_session_file,
		spawn_runs = state.spawn_runs,
		subagent = state.subagent,
	}
end

local function prefix_matches(checkpoint, visible, prefix_end, metadata, dependencies)
	if not checkpoint or checkpoint.count > prefix_end
		or not vim.deep_equal(checkpoint.metadata, metadata)
		or not vim.deep_equal(checkpoint.dependencies, dependencies) then return false end
	for index = 1, checkpoint.count do
		if not vim.deep_equal(checkpoint.messages[index], visible[index]) then return false end
	end
	return true
end

-- With a cache, this collector owns output resets. Without one, callers retain
-- the existing reset contract. Cache only the prefix before the latest user turn:
-- retry-error suppression cannot cross that boundary. Suffix events may still
-- update earlier spawn/tool/skill rows, so restore a fresh, shared object graph.
function M.collect_message_lines(ctx, messages, tools, cache)
	local lines = ctx.transcript.metadata_lines()
	local metadata = cache and vim.deepcopy(lines)
	local dependencies = cache and render_dependencies(ctx.state)
	local items = {}
	if cache then
		pi_tool_output.reset(ctx.state)
		pi_thinking_output.reset(ctx.state)
		pi_skills.reset(ctx.state)
	end
	ctx.state.tool_items_by_output = {}
	local has_body = false
	local last_rendered_kind = nil
	local assistant_block_open = false
	local visible = scope_tool_calls(with_tool_executions(messages, tools))
	local prefix_end, first_message = 0, 1
	if cache then
		for index, message in ipairs(visible) do
			local role = message.role or message.type
			if role == "user" or role == "You" then prefix_end = index - 1 end
		end
		local checkpoint = cache.checkpoint
		if prefix_matches(checkpoint, visible, prefix_end, metadata, dependencies) then
			local restored = vim.deepcopy({ lines = checkpoint.lines, items = checkpoint.items, state = checkpoint.state })
			lines, items = restored.lines, restored.items
			for _, field in ipairs(output_state_fields) do ctx.state[field] = restored.state[field] end
			has_body = checkpoint.has_body
			last_rendered_kind = checkpoint.last_rendered_kind
			assistant_block_open = checkpoint.assistant_block_open
			first_message = checkpoint.count + 1
		else
			cache.checkpoint = nil
		end
	end

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
		table.insert(lines, "## " .. message_role_title({ role = "assistant" }, ctx.state))
		table.insert(lines, "")
		has_body = true
		assistant_block_open = true
		return true
	end

	local function close_assistant_block()
		assistant_block_open = false
	end

	local superseded_errors, retry_error = {}, nil
	for index, message in ipairs(visible) do
		local role = message.role or message.type
		if role == "assistant" and message.stopReason ~= "aborted"
			and (message.stopReason == "error" or message.errorMessage) then
			-- Keep response content, but only the latest error in a retry sequence.
			if retry_error then superseded_errors[retry_error] = true end
			retry_error = index
		elseif role ~= "agent_end" or not message.willRetry then
			retry_error = nil
		end
	end

	for index = first_message, #visible do
		if cache and prefix_end > 0 and index == prefix_end + 1
			and (not cache.checkpoint or cache.checkpoint.count ~= prefix_end) then
			local prefix, output_state = {}, {}
			for at = 1, prefix_end do prefix[at] = visible[at] end
			for _, field in ipairs(output_state_fields) do output_state[field] = ctx.state[field] end
			-- Copy items and their state lookup together to preserve group/child identity.
			-- Never retain final-render rows: later events can rewrite this prefix.
			cache.checkpoint = vim.deepcopy({
				count = prefix_end, metadata = metadata, dependencies = dependencies,
				lines = lines, items = items, state = output_state,
				has_body = has_body, last_rendered_kind = last_rendered_kind,
				assistant_block_open = assistant_block_open,
			})
			-- Scoped wrappers and snapshot content are never mutated by the renderer.
			cache.checkpoint.messages = prefix
		end
		local message = visible[index]
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
				local output_id = pi_skills.apply_tool_result(ctx.state, message, text)
				for _, item in ipairs(items) do
					if item.kind == "skill" and item.output_id == output_id then
						lines[item.start_line] = pi_skills.summary_lines(ctx.state, output_id)[1]
					end
				end
				appended = false
				if message.isError then
					appended = render_tool_summary(ctx, lines, items, message, ensure_assistant_block)
					rendered_kind = appended and "tool" or nil
				end
			elseif name == "spawn" and not message.isError and not has_tool_item(ctx.state, tool_call_id)
				and update_existing_spawn_output(ctx, lines, items, message, text) then
				appended = false
			else
				appended = render_tool_summary(ctx, lines, items, message, ensure_assistant_block)
				rendered_kind = appended and "tool" or nil
			end
		elseif role == "permission" then
			ensure_assistant_block()
			require("pi-integration.permission-output").append(ctx, lines, items, message.permission)
			appended, rendered_kind = true, "tool"
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
			if not superseded_errors[index]
				and (message.stopReason == "error" or message.stopReason == "aborted" or message.errorMessage) then
				M.append_error(lines,
					message.errorMessage or (message.stopReason == "aborted" and "Response aborted." or "Model request failed."),
					has_body or appended, message.stopReason == "aborted" and "Aborted" or "Error")
				close_assistant_block()
				appended, rendered_kind = true, "error"
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
					append_text_message(lines, message, text, has_body, ctx.state)
					appended = true
					rendered_kind = "message"
				end
			end
		else
			local text = message_utils.extract_text(message)
			if text and text ~= "" then
				close_assistant_block()
				append_text_message(lines, message, text, has_body, ctx.state)
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
