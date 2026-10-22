local json = require("pi-integration.utils.json")

local M = {}
local LIMIT = 10

local function history_path()
	return vim.fs.joinpath(vim.fn.stdpath("state"), "pi-console", "recent-directories.json")
end

local function is_workspace_directory(path)
	local root = vim.env.PI_WORKSPACE_ROOT
		or vim.fs.joinpath(vim.env.XDG_STATE_HOME or vim.fn.expand("~/.local/state"), "pi", "workspaces")
	local trees = vim.fn.fnamemodify(vim.fs.joinpath(root, "trees"), ":p")
	trees = vim.fs.normalize(vim.uv.fs_realpath(trees) or vim.fn.resolve(trees)):gsub("/+$", "")
	-- Deleted workspaces still need filtering from saved history.
	path = vim.fs.normalize(vim.uv.fs_realpath(path) or vim.fn.resolve(path))
	return path == trees or path:sub(1, #trees + 1) == trees .. "/"
end

local function add_recent(directories, path)
	for i = #directories, 1, -1 do
		if directories[i] == path then
			table.remove(directories, i)
		end
	end
	directories[#directories + 1] = path
	if #directories > LIMIT then
		table.remove(directories, 1)
	end
end

local function load()
	-- Read on every use so other pi-console instances contribute their visits.
	local ok, lines = pcall(vim.fn.readfile, history_path())
	local decoded = ok and json.decode_object(table.concat(lines, "\n")) or nil
	local directories = {}
	if type(decoded) == "table" and vim.islist(decoded) then
		for _, path in ipairs(decoded) do
			if
				type(path) == "string"
				and path ~= ""
				and not path:find("\n", 1, true)
				and not is_workspace_directory(path)
			then
				add_recent(directories, path)
			end
		end
	end
	return directories
end

function M.record(cwd)
	local path = vim.uv.fs_realpath(cwd)
	if not path or path:find("\n", 1, true) or vim.fn.isdirectory(path) ~= 1 or is_workspace_directory(path) then
		return
	end
	local directories = load()
	if directories[#directories] == path then
		return
	end
	add_recent(directories, path)

	local file = history_path()
	local temporary = file .. "." .. vim.uv.os_getpid() .. ".tmp"
	local ok, err = pcall(function()
		vim.fn.mkdir(vim.fs.dirname(file), "p")
		if vim.fn.writefile({ json.encode(directories) }, temporary) ~= 0 then
			error("could not write directory history")
		end
		local renamed, rename_error = vim.uv.fs_rename(temporary, file)
		if not renamed then
			error(rename_error)
		end
	end)
	vim.fn.delete(temporary)
	if not ok then
		vim.notify("Could not save recent Pi directories: " .. tostring(err), vim.log.levels.WARN, { title = "pi-console" })
	end
end

function M.input(opts, on_choice)
	local autocmd = vim.api.nvim_create_autocmd("CmdwinEnter", {
		pattern = "@",
		callback = function(event)
			-- Retain the editable draft, but do not repeat it in the history list.
			local draft = vim.api.nvim_buf_get_lines(event.buf, -2, -1, false)[1] or ""
			local draft_path = draft ~= "" and vim.uv.fs_realpath(vim.fn.expand(draft)) or nil
			local lines = {}
			for _, path in ipairs(load()) do
				if path ~= draft_path then
					lines[#lines + 1] = path
				end
			end
			lines[#lines + 1] = draft
			local column = vim.api.nvim_win_get_cursor(0)[2]
			vim.api.nvim_buf_set_lines(event.buf, 0, -1, false, lines)
			vim.api.nvim_win_set_cursor(0, { #lines, math.min(column, #draft) })
			vim.api.nvim_win_set_height(0, #lines)
		end,
	})
	local function cleanup()
		if autocmd then
			vim.api.nvim_del_autocmd(autocmd)
			autocmd = nil
		end
	end
	local ok, err = pcall(vim.ui.input, opts, function(value)
		cleanup()
		on_choice(value)
	end)
	if not ok then
		cleanup()
		error(err)
	end
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
