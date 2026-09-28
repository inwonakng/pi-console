local M = {}

local CACHE_TTL_MS = 5000

local function now_ms()
	return math.floor(vim.uv.hrtime() / 1000000)
end

local function pi_input_buffer(bufnr)
	return vim.api.nvim_buf_get_name(bufnr or 0) == "pi://input"
end

local function slash_command_range(ctx)
	local line_before_cursor = ctx.line:sub(1, ctx.cursor[2])
	local leading, typed = line_before_cursor:match("^(%s*)/([^%s]*)$")
	if not leading then
		return nil
	end

	local start_character = #leading
	return {
		typed = typed,
		range = {
			start = { line = ctx.cursor[1] - 1, character = start_character },
			["end"] = { line = ctx.cursor[1] - 1, character = ctx.cursor[2] },
		},
	}
end

local function command_sort_prefix(command)
	if command.source == "skill" then
		return "0"
	end
	if command.source == "prompt" then
		return "1"
	end
	if command.source == "extension" then
		return "2"
	end
	return "9"
end

local function command_filter_text(command, label)
	if command.source == "skill" then
		local skill_name = tostring(command.name or ""):match("^skill:(.+)$")
		if skill_name and skill_name ~= "" then
			return table.concat({ label, "/" .. skill_name, skill_name }, " ")
		end
	end
	return label
end

local function command_item(command, range)
	local name = tostring(command.name or "")
	local label = "/" .. name
	local source = tostring(command.source or "command")
	local description = command.description or ""
	local location = command.location and (" · " .. tostring(command.location)) or ""
	local path = command.path and ("\n\n`" .. tostring(command.path) .. "`") or ""

	return {
		label = label,
		kind = require("blink.cmp.types").CompletionItemKind.Text,
		detail = source .. location,
		filterText = command_filter_text(command, label),
		sortText = command_sort_prefix(command) .. label,
		textEdit = {
			newText = label .. " ",
			range = range,
		},
		documentation = description ~= "" and {
			kind = "markdown",
			value = description .. path,
		} or nil,
	}
end

local source = {}

function source.new(opts)
	local self = setmetatable({}, { __index = source })
	self.opts = opts or {}
	self.cache = nil
	self.cache_time = 0
	return self
end

function source:enabled()
	return pi_input_buffer(0)
end

function source:get_trigger_characters()
	return { "/" }
end

function source:get_completions(ctx, callback)
	if not pi_input_buffer(ctx.bufnr) then
		callback({ is_incomplete_forward = false, is_incomplete_backward = false, items = {} })
		return
	end

	local slash = slash_command_range(ctx)
	if not slash then
		callback({ is_incomplete_forward = false, is_incomplete_backward = false, items = {} })
		return
	end

	local function complete(commands)
		local items = {}
		for _, command in ipairs(commands or {}) do
			if command.name then
				table.insert(items, command_item(command, slash.range))
			end
		end
		callback({
			items = items,
			is_incomplete_forward = false,
			is_incomplete_backward = false,
		})
	end

	local current_time = now_ms()
	if self.cache and (current_time - self.cache_time) < (self.opts.cache_ttl_ms or CACHE_TTL_MS) then
		complete(self.cache)
		return
	end

	require("pi-integration").get_commands(function(commands)
		self.cache = commands or {}
		self.cache_time = now_ms()
		complete(self.cache)
	end)
end

M.new = source.new

return M
