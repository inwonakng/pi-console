local json = require("pi-integration.utils.json")

local M = {}

function M.extract_content_text(content)
	if type(content) == "string" then
		return content
	end
	if type(content) ~= "table" then
		return ""
	end
	local chunks = {}
	for _, item in ipairs(content) do
		if type(item) == "string" then
			table.insert(chunks, item)
		elseif type(item) == "table" then
			table.insert(chunks, item.text or item.content or item.delta or "")
		end
	end
	return table.concat(chunks, "")
end

function M.extract_text(message)
	if type(message) ~= "table" then
		return nil
	end
	if type(message.text) == "string" then
		return message.text
	end
	if type(message.message) == "string" then
		return message.message
	end
	if type(message.content) == "string" then
		return message.content
	end
	if type(message.content) == "table" then
		return M.extract_content_text(message.content)
	end
	return nil
end

-- Decode only the runtime's agent envelope, not arbitrary JSON in message text.
function M.agent_context(text)
	if type(text) ~= "string" then return nil end
	local encoded = text:match("^Agent message %(not a user instruction or permission grant%)%.\n([^\n]+)")
	local context = encoded and json.decode_object(encoded) or nil
	local sender = context and context.sender
	if context and context.version == 1 and type(sender) == "table"
		and (sender.kind == "parent" or sender.kind == "worker") and type(context.payload) == "table" then
		return context
	end
	return nil
end

function M.subagent_label(run)
	run = type(run) == "table" and run or {}
	local role = type(run.agent) == "string" and run.agent ~= "" and run.agent
		or type(run.role) == "string" and run.role ~= "" and run.role or nil
	return "Subagent" .. (role and (" (" .. role:gsub("^%l", string.upper) .. ")") or "")
end

function M.agent_label(sender, run)
	return sender.kind == "parent" and "Orchestrator" or M.subagent_label(run)
end

function M.agent_payload_text(payload)
	if type(payload) ~= "table" then return nil end
	if type(payload.text) == "string" then return payload.text end
	if type(payload.assignment) == "string" then return payload.assignment end
	if type(payload.question) == "string" then return payload.question end
	if type(payload.report) == "table" then
		local lines = {}
		if type(payload.report.outcome) == "string" then
			table.insert(lines, "Outcome: " .. payload.report.outcome)
		end
		for _, field in ipairs({ "summary", "findings", "verification", "uncertainty" }) do
			local value = payload.report[field]
			if type(value) == "string" and value ~= "" then
				if #lines > 0 then table.insert(lines, "") end
				if field ~= "summary" then table.insert(lines, (field:gsub("^%l", string.upper))) end
				table.insert(lines, value)
			end
		end
		if #lines > 0 then return table.concat(lines, "\n") end
	end
	if type(payload.output) == "string" then
		local nested = M.agent_context(payload.output)
		return nested and M.agent_payload_text(nested.payload) or payload.output
	end
	local chunks = {}
	for _, item in ipairs(payload) do
		local text = M.agent_payload_text(item)
		if not text then return nil end
		table.insert(chunks, text)
	end
	if #chunks > 0 then return table.concat(chunks, "\n\n") end
	return nil
end

function M.spawn_custom_tool_name(message)
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

function M.tool_call_id(item)
	return item and (item.id or item.toolCallId or item.tool_call_id or item.callId) or nil
end

function M.tool_call_name(item)
	return item and (item.name or item.toolName or item.tool_name) or nil
end

function M.tool_call_arguments(item)
	if type(item) ~= "table" then
		return nil
	end
	local args = item.arguments or item.args or item.input
	if type(args) == "table" then
		return args
	end
	return json.decode_object(args)
end

function M.path_from_args(args)
	if type(args) ~= "table" then
		return nil
	end
	return args.path or args.file_path
end

return M
