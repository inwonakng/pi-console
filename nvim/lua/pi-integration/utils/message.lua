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
