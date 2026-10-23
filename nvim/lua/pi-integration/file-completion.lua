local M = {}

local function pi_input_buffer(bufnr)
	return vim.api.nvim_buf_get_name(bufnr or 0) == "pi://input"
end

local function explicit_path(typed)
	return typed:sub(1, 1) == "/" or typed == "~" or typed:sub(1, 2) == "~/"
		or typed:sub(1, 2) == "./" or typed:sub(1, 3) == "../"
end

local function file_reference_range(ctx)
	local before = ctx.line:sub(1, ctx.cursor[2])
	local start, typed = before:match("()@([^%s]*)$")
	local marker = "@"
	if start and (start == 1 or before:sub(start - 1, start - 1):match("%s")) then
		if typed:sub(1, 2) == "z:" then return nil end
	else
		marker = ""
		-- Keep quoted directory names with spaces intact, without expanding them locally.
		start, typed = before:match('()"([^"]*)$')
		if not typed or not explicit_path(typed) then start, typed = before:match("()'([^']*)$") end
		if typed and explicit_path(typed) then start = start + 1
		else start, typed = before:match("()([^%s\"'`]+)$") end
		if not typed or not explicit_path(typed) then return nil end
	end

	return {
		-- Relative @ references use the full project index; Blink does the fuzzy filtering.
		prefix = explicit_path(typed) and (typed == "~" and "~/" or typed:match("^(.*/)")) or "",
		marker = marker,
		range = {
			start = { line = ctx.cursor[1] - 1, character = start - 1 },
			["end"] = { line = ctx.cursor[1] - 1, character = ctx.cursor[2] },
		},
	}
end

local function path_depth(relative_path)
	local depth = 0
	for _ in relative_path:gmatch("/") do
		depth = depth + 1
	end
	return depth
end

local function path_sort_text(relative_path)
	return ("%03d:%04d:%s"):format(path_depth(relative_path), #relative_path, relative_path)
end

local function basename(relative_path)
	return relative_path:match("[^/]+$") or relative_path
end

local function path_item(entry, reference)
	local completion_kind = require("blink.cmp.types").CompletionItemKind
	local relative_path = entry.path
	local is_directory = entry.kind == "directory"

	return {
		label = reference.marker .. relative_path,
		kind = is_directory and completion_kind.Folder or completion_kind.File,
		detail = is_directory and "directory" or "file",
		filterText = reference.marker .. relative_path .. " " .. relative_path .. " " .. basename(relative_path),
		sortText = path_sort_text(relative_path),
		textEdit = {
			newText = reference.marker .. relative_path,
			range = reference.range,
		},
	}
end

local source = {}

function source.new()
	local self = setmetatable({}, { __index = source })
	return self
end

function source:enabled()
	return pi_input_buffer(0)
end

function source:get_trigger_characters()
	return { "@", "/", ".", "~" }
end

function source:get_completions(ctx, callback)
	self.query = (self.query or 0) + 1
	local query = self.query
	if not pi_input_buffer(ctx.bufnr) then
		callback({ is_incomplete_forward = false, is_incomplete_backward = false, items = {} })
		return
	end

	local reference = file_reference_range(ctx)
	if not reference then
		callback({ is_incomplete_forward = false, is_incomplete_backward = false, items = {} })
		return
	end

	local cancelled = false
	local cancel = require("pi-integration.service-frontend").complete_files(reference.prefix, function(data)
		if cancelled or query ~= self.query then return end
		local warning = data.error or (data.truncated and "Project scan limit reached; use an explicit path for omitted files.")
		if warning and warning ~= self.last_error then vim.notify("Owner completion: " .. warning, vim.log.levels.WARN) end
		self.last_error = warning
		local items = {}
		for _, entry in ipairs(data.entries or {}) do
			local item = path_item(entry, reference)
			item.detail = "owner " .. item.detail
			table.insert(items, item)
		end
		callback({ items = items, is_incomplete_forward = data.error ~= nil, is_incomplete_backward = data.error ~= nil })
	end)
	return function()
		cancelled = true
		if cancel then cancel() end
	end
end

M.new = source.new

return M
