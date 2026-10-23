local M = {}

local function pi_input_buffer(bufnr)
	return vim.api.nvim_buf_get_name(bufnr or 0) == "pi://input"
end

local function file_reference_range(ctx)
	local line_before_cursor = ctx.line:sub(1, ctx.cursor[2])
	local at_start, typed = line_before_cursor:match("()@([^%s@]*)$")
	if not at_start or typed:sub(1, 2) == "z:" then
		return nil
	end

	if at_start > 1 then
		local previous = line_before_cursor:sub(at_start - 1, at_start - 1)
		if not previous:match("%s") then
			return nil
		end
	end

	return {
		typed = typed or "",
		range = {
			start = { line = ctx.cursor[1] - 1, character = at_start - 1 },
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

local function path_item(entry, range)
	local completion_kind = require("blink.cmp.types").CompletionItemKind
	local relative_path = entry.path
	local is_directory = entry.kind == "directory"

	return {
		label = "@" .. relative_path,
		kind = is_directory and completion_kind.Folder or completion_kind.File,
		detail = is_directory and "directory" or "file",
		filterText = "@" .. relative_path .. " " .. relative_path .. " " .. basename(relative_path),
		sortText = path_sort_text(relative_path),
		textEdit = {
			newText = "@" .. relative_path,
			range = range,
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
	return { "@", "/" }
end

function source:get_completions(ctx, callback)
	if not pi_input_buffer(ctx.bufnr) then
		callback({ is_incomplete_forward = false, is_incomplete_backward = false, items = {} })
		return
	end

	local reference = file_reference_range(ctx)
	if not reference then
		callback({ is_incomplete_forward = false, is_incomplete_backward = false, items = {} })
		return
	end

	self.query = (self.query or 0) + 1
	local query = self.query
	require("pi-integration.service-frontend").complete_files(reference.typed, function(data)
		if query ~= self.query then callback({ items = {}, is_incomplete_forward = true, is_incomplete_backward = true }); return end
		if data.error and data.error ~= self.last_error then vim.notify("Owner completion: " .. data.error, vim.log.levels.WARN) end
		self.last_error = data.error
		local items = {}
		for _, entry in ipairs(data.entries or {}) do
			local item = path_item(entry, reference.range)
			item.detail = "owner " .. item.detail
			table.insert(items, item)
		end
		callback({ items = items, is_incomplete_forward = data.incomplete == true, is_incomplete_backward = false })
	end)
end

M.new = source.new

return M
