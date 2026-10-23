local source = {}

local function input_buffer(buf)
	return vim.api.nvim_buf_get_name(buf or 0) == "pi://input"
end

function source.new()
	return setmetatable({ query = 0 }, { __index = source })
end

function source:enabled()
	return input_buffer(0)
end

function source:get_trigger_characters()
	return { "/" }
end

function source:get_completions(ctx, callback)
	self.query = self.query + 1
	local query = self.query
	local leading = ctx.line:sub(1, ctx.cursor[2]):match("^(%s*)/[^%s]*$")
	if not input_buffer(ctx.bufnr) or not leading then
		callback({ items = {}, is_incomplete_forward = false, is_incomplete_backward = false })
		return
	end
	local range = {
		start = { line = ctx.cursor[1] - 1, character = #leading },
		["end"] = { line = ctx.cursor[1] - 1, character = ctx.cursor[2] },
	}
	require("pi-integration").get_commands(function(commands, err, captured)
		if query ~= self.query then callback({ items = {}, is_incomplete_forward = true, is_incomplete_backward = true }); return end
		if err and err ~= self.last_error then vim.notify("Owner command completion: " .. err, vim.log.levels.WARN) end
		self.last_error = err
		local items = {}
		for _, command in ipairs(commands) do
			local label = "/" .. command.name
			local info = command.sourceInfo or {}
			local description = command.description or ""
			local path = info.path and ("\n\n`" .. info.path .. "`") or ""
			local skill = command.source == "skill" and command.name:match("^skill:(.+)$")
			table.insert(items, {
				label = label,
				kind = require("blink.cmp.types").CompletionItemKind.Text,
				detail = "owner " .. command.source .. (info.scope and (" (" .. info.scope .. ")") or ""),
				filterText = skill and (label .. " /" .. skill .. " " .. skill) or label,
				sortText = ({ skill = "0", prompt = "1", extension = "2" })[command.source] .. label,
				textEdit = { newText = label .. " ", range = range },
				data = { pi_command_context = captured },
				documentation = description ~= "" and { kind = "markdown", value = description .. path } or nil,
			})
		end
		callback({ items = items, is_incomplete_forward = true, is_incomplete_backward = true })
	end)
end

function source:execute(_, item, callback, default_implementation)
	if require("pi-integration").command_context_current(item.data.pi_command_context) then
		default_implementation()
	else
		vim.notify("Owner context changed; complete the command again.", vim.log.levels.WARN)
	end
	callback()
end

return { new = source.new }
