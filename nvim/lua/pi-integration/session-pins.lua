local json = require("pi-integration.utils.json")
local runtime = require("pi-integration.runtime")

local M = {}
local metadata_fields = { "title", "cwd", "directory", "project", "workspace_id", "model" }

local function pins_path()
	return vim.fs.joinpath(vim.fn.stdpath("state"), "pi-console", "pinned-sessions.json")
end

local function load()
	-- Read on every use so separate overview instances see each other's pins.
	local stat, stat_error, code = vim.uv.fs_stat(pins_path())
	if not stat then
		if code == "ENOENT" then
			return vim.empty_dict()
		end
		return nil, "Could not read session pins: " .. tostring(stat_error)
	end
	local ok, lines = pcall(vim.fn.readfile, pins_path())
	if not ok then
		return nil, "Could not read session pins: " .. tostring(lines)
	end
	local decoded = json.decode_object(table.concat(lines, "\n"))
	if not decoded then
		return nil, "Invalid session pins file: " .. pins_path()
	end
	local pins = vim.empty_dict()
	for path, metadata in pairs(decoded) do
		path = runtime.canonical_path(path)
		if not path or type(metadata) ~= "table" or type(metadata.title) ~= "string" or type(metadata.cwd) ~= "string" then
			return nil, "Invalid session pin in: " .. pins_path()
		end
		local pin = {}
		for _, field in ipairs(metadata_fields) do
			if type(metadata[field]) == "string" then
				pin[field] = metadata[field]
			end
		end
		pins[path] = pin
	end
	return pins
end

local function save(pins)
	local file = pins_path()
	local temporary = file .. "." .. vim.uv.os_getpid() .. ".tmp"
	local ok, err = pcall(function()
		vim.fn.mkdir(vim.fs.dirname(file), "p")
		if vim.fn.writefile({ json.encode(pins) }, temporary) ~= 0 then
			error("could not write session pins")
		end
		local renamed, rename_error = vim.uv.fs_rename(temporary, file)
		if not renamed then
			error(rename_error)
		end
	end)
	vim.fn.delete(temporary)
	if not ok then
		return nil, "Could not save session pins: " .. tostring(err)
	end
	return true
end

local function with_pins(callback)
	local lock = pins_path() .. ".lock"
	local made, mkdir_error = pcall(vim.fn.mkdir, vim.fs.dirname(lock), "p")
	if not made then
		return nil, "Could not prepare session pins: " .. tostring(mkdir_error)
	end
	-- Serialize the whole read/modify/write, not just the atomic replacement.
	local fd, lock_error, code = vim.uv.fs_open(lock, "wx", 384)
	if not fd then
		if code == "EEXIST" then
			return nil, "Session pins are busy; retry shortly. If this persists after closing all overviews, remove " .. lock
		end
		return nil, "Could not lock session pins: " .. tostring(lock_error)
	end
	local ok, result, err = pcall(function()
		local pins, load_error = load()
		if not pins then
			return nil, load_error
		end
		return callback(pins)
	end)
	vim.uv.fs_close(fd)
	local removed, remove_error = vim.uv.fs_unlink(lock)
	if not removed then
		return nil, "Could not release session pin lock: " .. tostring(remove_error)
	end
	if not ok then
		return nil, "Could not update session pins: " .. tostring(result)
	end
	return result, err
end

local function metadata(entry)
	local pin = {}
	for _, field in ipairs(metadata_fields) do
		if type(entry[field]) == "string" then
			pin[field] = entry[field]
		end
	end
	return pin
end

function M.toggle(entry)
	local path = runtime.canonical_path(entry.path)
	if not path then
		return nil, "Save this session before pinning it"
	end
	return with_pins(function(pins)
		if pins[path] then
			pins[path] = nil
		else
			if vim.fn.filereadable(path) ~= 1 then
				return nil, "Save this session before pinning it"
			end
			pins[path] = metadata(entry)
		end
		return save(pins)
	end)
end

local function merge(instances, pins)
	local entries, open_paths = {}, {}
	local changed = false
	for _, instance in ipairs(instances) do
		local entry = vim.deepcopy(instance)
		local path = runtime.canonical_path(entry.path)
		entry.pinned = path ~= nil and pins[path] ~= nil
		if path then
			open_paths[path] = true
		end
		if entry.pinned then
			local current = metadata(entry)
			-- Reservations and initializing frontends have provisional metadata,
			-- regardless of their displayed activity status.
			if not entry.is_starting and not vim.deep_equal(pins[path], current) then
				pins[path] = current
				changed = true
			end
		end
		table.insert(entries, entry)
	end
	-- Keep closed pins in path order so refreshes do not shuffle them.
	local paths = vim.tbl_keys(pins)
	table.sort(paths)
	for _, path in ipairs(paths) do
		if not open_paths[path] then
			local entry = vim.deepcopy(pins[path])
			entry.id = "pinned:" .. path
			entry.path = path
			entry.pinned = true
			entry.status = "Not Open"
			entry.location = "—"
			table.insert(entries, entry)
		end
	end
	return entries, changed
end

function M.merge(instances)
	local pins, err = load()
	if not pins then
		return nil, err
	end
	local entries, changed = merge(instances, pins)
	if not changed then
		return entries
	end
	return with_pins(function(current)
		-- Re-read under the lock so refresh cannot restore a removed pin.
		local updated, metadata_changed = merge(instances, current)
		if metadata_changed then
			local saved, save_error = save(current)
			if not saved then
				return nil, save_error
			end
		end
		return updated
	end)
end

return M
