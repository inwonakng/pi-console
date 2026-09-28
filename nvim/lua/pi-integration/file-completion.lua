local M = {}

local CACHE_TTL_MS = 5000
local DEFAULT_MAX_FILES = 50000
local DEFAULT_IGNORED_DIRS = {
	[".git"] = true,
	[".venv"] = true,
	["venv"] = true,
	["node_modules"] = true,
	["__pycache__"] = true,
	[".mypy_cache"] = true,
	[".pytest_cache"] = true,
	[".ruff_cache"] = true,
	[".tox"] = true,
	["dist"] = true,
	["build"] = true,
	["target"] = true,
	[".next"] = true,
	[".turbo"] = true,
	[".cache"] = true,
}

local function now_ms()
	return math.floor(vim.uv.hrtime() / 1000000)
end

local function pi_input_buffer(bufnr)
	return vim.api.nvim_buf_get_name(bufnr or 0) == "pi://input"
end

local function join_path(parent, child)
	if parent:sub(-1) == "/" then
		return parent .. child
	end
	return parent .. "/" .. child
end

local function file_reference_range(ctx)
	local line_before_cursor = ctx.line:sub(1, ctx.cursor[2])
	local at_start, typed = line_before_cursor:match("()@([^%s@]*)$")
	if not at_start then
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

local function merged_ignored_dirs(opts)
	local ignored = vim.deepcopy(DEFAULT_IGNORED_DIRS)
	for _, name in ipairs(opts.ignored_dirs or {}) do
		ignored[tostring(name)] = true
	end
	return ignored
end

local function fd_path(opts)
	local configured = opts.fd_path
	if configured and configured ~= "" and vim.fn.executable(configured) == 1 then
		return configured
	end
	if vim.fn.executable("fd") == 1 then
		return "fd"
	end
	if vim.fn.executable("fdfind") == 1 then
		return "fdfind"
	end
	return nil
end

local function scan_files_with_fd(cwd, opts)
	local executable = fd_path(opts)
	if not executable then
		return nil
	end

	local ignored_dirs = merged_ignored_dirs(opts)
	local max_files = opts.max_files or DEFAULT_MAX_FILES
	local args = {
		executable,
		"--base-directory",
		cwd,
		"--max-results",
		tostring(max_files),
		"--type",
		"f",
		"--type",
		"d",
		"--hidden",
		"--follow",
	}

	for name in pairs(ignored_dirs) do
		vim.list_extend(args, { "--exclude", name })
	end
	table.insert(args, ".")

	local lines = vim.fn.systemlist(args)
	if vim.v.shell_error ~= 0 then
		return nil
	end

	local results = {}
	for _, line in ipairs(lines) do
		local path = tostring(line):gsub("\\", "/"):gsub("^%./", "")
		if path ~= "" then
			local is_directory = path:sub(-1) == "/"
			if is_directory then
				path = path:sub(1, -2)
			end
			table.insert(results, { path = path, kind = is_directory and "directory" or "file" })
		end
	end
	return results
end

local function scan_files_with_lua(cwd, opts)
	local ignored_dirs = merged_ignored_dirs(opts)
	local max_files = opts.max_files or DEFAULT_MAX_FILES
	local results = {}

	local function walk(dir, prefix)
		if #results >= max_files then
			return
		end

		local scanner = vim.uv.fs_scandir(dir)
		if not scanner then
			return
		end

		local entries = {}
		while true do
			local name, kind = vim.uv.fs_scandir_next(scanner)
			if not name then
				break
			end
			table.insert(entries, { name = name, kind = kind })
		end

		table.sort(entries, function(a, b)
			if a.kind == b.kind then
				return a.name < b.name
			end
			return a.kind == "directory"
		end)

		for _, entry in ipairs(entries) do
			if #results >= max_files then
				return
			end

			if not (prefix == "" and entry.name:sub(1, 1) == ".") then
				local relative = prefix == "" and entry.name or (prefix .. "/" .. entry.name)
				local absolute = join_path(dir, entry.name)

				if entry.kind == "directory" then
					if not ignored_dirs[entry.name] then
						table.insert(results, { path = relative, kind = "directory" })
						walk(absolute, relative)
					end
				elseif entry.kind == "file" or entry.kind == "link" then
					table.insert(results, { path = relative, kind = "file" })
				end
			end
		end
	end

	walk(cwd, "")
	return results
end

local function scan_files(cwd, opts)
	return scan_files_with_fd(cwd, opts) or scan_files_with_lua(cwd, opts)
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
	return { "@" }
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

	local cwd = self.opts.get_cwd and self.opts.get_cwd(ctx) or vim.fn.getcwd()
	local current_time = now_ms()
	local cache_ttl_ms = self.opts.cache_ttl_ms or CACHE_TTL_MS
	if not self.cache or self.cache.cwd ~= cwd or (current_time - self.cache_time) >= cache_ttl_ms then
		self.cache = {
			cwd = cwd,
			files = scan_files(cwd, self.opts),
		}
		self.cache_time = current_time
	end

	local items = {}
	for _, entry in ipairs(self.cache.files) do
		table.insert(items, path_item(entry, reference.range))
	end

	callback({
		items = items,
		is_incomplete_forward = false,
		is_incomplete_backward = false,
	})
end

M.new = source.new

return M
