local source = {}

function source.new() return setmetatable({}, { __index = source }) end

function source:enabled()
	return require("pi-integration.directory-history").completion_context() ~= nil
end

function source:get_trigger_characters() return { "/", "~" } end

function source:get_completions(ctx, callback)
	local history = require("pi-integration.directory-history")
	local context = history.completion_context()
	local typed = ctx.line:sub(1, ctx.cursor[2])
	local parent = typed == "~" and "~/" or typed:match("^(.*/)")
	local cancelled = false
	local items = {}
	local function current()
		return not cancelled and history.completion_context() == context and context.current()
	end
	local function finish()
		callback({ items = items, is_incomplete_forward = true, is_incomplete_backward = true })
	end
	if not context or not parent or not (parent:sub(1, 1) == "/" or parent:sub(1, 2) == "~/") then
		finish(); return
	end
	local function page(offset)
		context.request({ path = parent, offset = offset }, function(ok, result)
			if not current() then return end
			if not ok then items = {}; finish(); return end
			for _, path in ipairs(result.entries or {}) do
				local name = path:match("[^/]+$") .. "/"
				table.insert(items, {
					label = name,
					kind = require("blink.cmp.types").CompletionItemKind.Folder,
					filterText = parent .. name,
					textEdit = {
						newText = parent .. name,
						range = {
							start = { line = ctx.cursor[1] - 1, character = 0 },
							["end"] = { line = ctx.cursor[1] - 1, character = #ctx.line },
						},
					},
				})
			end
			if result.nextOffset and result.nextOffset ~= vim.NIL then page(result.nextOffset)
			else finish() end
		end)
	end
	page(0)
	return function() cancelled = true end
end

return source
