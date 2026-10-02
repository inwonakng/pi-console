local json = require("pi-integration.utils.json")

local M = {}
local LIMIT = 10

local function history_path()
	return vim.fs.joinpath(vim.fn.stdpath("state"), "pi-console", "recent-directories.json")
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
			if type(path) == "string" and path ~= "" and not path:find("\n", 1, true) then
				add_recent(directories, path)
			end
		end
	end
	return directories
end

function M.record(cwd)
	local path = vim.uv.fs_realpath(cwd)
	if not path or path:find("\n", 1, true) or vim.fn.isdirectory(path) ~= 1 then
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

return M
