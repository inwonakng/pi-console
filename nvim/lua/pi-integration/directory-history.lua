local M = {}

-- Owner directories are display strings here, never arguments to local fs helpers.
function M.owner_input(opts, on_choice)
	local store = require("pi-integration.frontend-store")
	local saved = store.load("owner-directories", vim.empty_dict())
	local browse, input
	local function current()
		if opts.current() then return true end
		vim.notify("Owner connection changed; directory selection cancelled", vim.log.levels.WARN)
		return false
	end
	input = function(default)
		vim.ui.input({ prompt = "Absolute directory on " .. opts.label .. ": ", default = default or saved[opts.key] or "/" }, function(path)
			if path and path ~= "" and current() then browse(path, 0) end
		end)
	end
	browse = function(path, offset)
		if not current() then return end
		opts.request({ path = path, offset = offset }, function(ok, page)
			if not current() then return end
			if not ok then vim.notify(page.message or "Owner directory unavailable", vim.log.levels.WARN); input(path); return end
			local choices = { { label = "Use " .. page.path, use = true }, { label = "Enter another path", input = true } }
			if page.path ~= "/" then table.insert(choices, { label = "Parent directory", path = page.path:match("^(.*)/[^/]+$") == "" and "/" or page.path:match("^(.*)/[^/]+$") }) end
			for _, directory in ipairs(page.entries or {}) do table.insert(choices, { label = directory, path = directory }) end
			if page.nextOffset and page.nextOffset ~= vim.NIL then table.insert(choices, { label = "More directories", offset = page.nextOffset }) end
			vim.ui.select(choices, { prompt = "Directory on " .. opts.label, format_item = function(item) return item.label end }, function(choice)
				if not choice or not current() then return end
				if choice.use then
					local ok_save, err = store.update("owner-directories", vim.empty_dict(), function(data) data[opts.key] = page.path; return true end)
					if not ok_save then vim.notify(tostring(err), vim.log.levels.WARN) end
					on_choice(page.path)
				elseif choice.input then input(page.path)
				else browse(choice.path or page.path, choice.offset or 0) end
			end)
		end)
	end
	input()
end
return M
