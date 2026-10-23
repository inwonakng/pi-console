local M = {}
local LIMIT = 10

local function add_recent(directories, path)
	if type(path) ~= "string" or path:sub(1, 1) ~= "/" or path:find("[%z\r\n]") then return end
	for i = #directories, 1, -1 do
		if directories[i] == path then table.remove(directories, i) end
	end
	directories[#directories + 1] = path
	if #directories > LIMIT then table.remove(directories, 1) end
end

local function recent_directories(paths)
	local directories = {}
	for _, path in ipairs(type(paths) == "table" and paths or {}) do add_recent(directories, path) end
	return directories
end

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
		local autocmd = vim.api.nvim_create_autocmd("CmdwinEnter", {
			pattern = "@",
			callback = function(event)
				local draft = vim.api.nvim_buf_get_lines(event.buf, -2, -1, false)[1] or ""
				local history = store.load("owner-directory-history", vim.empty_dict())
				local lines = {}
				for _, path in ipairs(recent_directories(history[opts.key])) do
					if path ~= draft then lines[#lines + 1] = path end
				end
				lines[#lines + 1] = draft
				local column = vim.api.nvim_win_get_cursor(0)[2]
				vim.api.nvim_buf_set_lines(event.buf, 0, -1, false, lines)
				vim.api.nvim_win_set_cursor(0, { #lines, math.min(column, #draft) })
				vim.api.nvim_win_set_height(0, #lines)
			end,
		})
		local function cleanup()
			if autocmd then vim.api.nvim_del_autocmd(autocmd); autocmd = nil end
		end
		-- The preceding fzf picker can leave insertion pending across native input().
		vim.cmd("stopinsert")
		local ok, err = pcall(vim.ui.input, {
			prompt = "Absolute directory on " .. opts.label .. ": ", default = default or saved[opts.key] or "/",
		}, function(path)
			cleanup()
			if path and path ~= "" and current() then browse(path, 0) end
		end)
		if not ok then cleanup(); error(err) end
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
					local ok_history, history_err = store.update("owner-directory-history", vim.empty_dict(), function(data)
						local directories = recent_directories(data[opts.key])
						add_recent(directories, page.path)
						data[opts.key] = directories
						return true
					end)
					if not ok_history then vim.notify(tostring(history_err), vim.log.levels.WARN) end
					on_choice(page.path)
				elseif choice.input then input(page.path)
				else browse(choice.path or page.path, choice.offset or 0) end
			end)
		end)
	end
	input()
end
return M
