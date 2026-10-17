local json = require("pi-integration.utils.json")
local runtime = require("pi-integration.runtime")

local M = {}

local function organization_path()
	return vim.fs.joinpath(vim.fn.stdpath("state"), "pi-console", "session-organization.json")
end

local function valid_name(name)
	return type(name) == "string" and name ~= "" and name == vim.trim(name) and not name:find("%c")
end

local function live_key(entry)
	if type(entry.id) == "string" and entry.id ~= "" and type(entry.pid) == "number"
		and entry.pid > 0 and entry.pid % 1 == 0 then
		-- JSON encodes the tuple without delimiter collisions; paths are absolute.
		return "live:" .. json.encode({ entry.id, entry.pid })
	end
end

local function entry_key(entry)
	if type(entry) ~= "table" then
		return nil
	end
	return runtime.canonical_path(entry.path) or live_key(entry)
end

local function valid_key(key)
	if type(key) ~= "string" then
		return false
	end
	if key:sub(1, 5) == "live:" then
		local tuple = json.decode(key:sub(6))
		return type(tuple) == "table" and vim.islist(tuple) and #tuple == 2
			and live_key({ id = tuple[1], pid = tuple[2] }) == key
	end
	return key:sub(1, 1) == "/" and runtime.canonical_path(key) == key
end

local function valid_state(state)
	if type(state) ~= "table" or state.version ~= 1 or type(state.groups) ~= "table"
		or not vim.islist(state.groups) or type(state.ungrouped) ~= "table" or not vim.islist(state.ungrouped) then
		return false
	end
	for field in pairs(state) do
		if field ~= "version" and field ~= "groups" and field ~= "ungrouped" then
			return false
		end
	end
	local ids, names, keys = {}, { Ungrouped = true }, {}
	local function valid_keys(list)
		if type(list) ~= "table" or not vim.islist(list) then
			return false
		end
		for _, key in ipairs(list) do
			if not valid_key(key) or keys[key] then
				return false
			end
			keys[key] = true
		end
		return true
	end
	for _, group in ipairs(state.groups) do
		if type(group) ~= "table" or type(group.id) ~= "string" or group.id == "" or group.id:find("%c")
			or ids[group.id] or not valid_name(group.name) or names[group.name] or not valid_keys(group.keys) then
			return false
		end
		for field in pairs(group) do
			if field ~= "id" and field ~= "name" and field ~= "keys" then
				return false
			end
		end
		ids[group.id], names[group.name] = true, true
	end
	return valid_keys(state.ungrouped)
end

local function load()
	local file = organization_path()
	local stat, stat_error, code = vim.uv.fs_stat(file)
	if not stat then
		if code == "ENOENT" then
			return { version = 1, groups = {}, ungrouped = {} }
		end
		return nil, "Could not read session organization: " .. tostring(stat_error)
	end
	local ok, lines = pcall(vim.fn.readfile, file)
	if not ok then
		return nil, "Could not read session organization: " .. tostring(lines)
	end
	local state = json.decode(table.concat(lines, "\n"))
	if not valid_state(state) then
		return nil, "Invalid session organization file: " .. file
	end
	return state
end

local function save(state)
	local file = organization_path()
	local temporary = file .. "." .. vim.uv.os_getpid() .. ".tmp"
	local ok, err = pcall(function()
		if vim.fn.writefile({ json.encode(state) }, temporary) ~= 0 then
			error("could not write session organization")
		end
		local renamed, rename_error = vim.uv.fs_rename(temporary, file)
		if not renamed then
			error(rename_error)
		end
	end)
	vim.fn.delete(temporary)
	if not ok then
		return nil, "Could not save session organization: " .. tostring(err)
	end
	return true
end

local function with_state(callback)
	local lock = organization_path() .. ".lock"
	local made, mkdir_error = pcall(vim.fn.mkdir, vim.fs.dirname(lock), "p")
	if not made then
		return nil, "Could not prepare session organization: " .. tostring(mkdir_error)
	end
	-- Protect the entire read/modify/write, as in session-pins.
	local fd, lock_error, code = vim.uv.fs_open(lock, "wx", 384)
	if not fd then
		if code == "EEXIST" then
			return nil, "Session organization is busy; retry shortly. If this persists after closing all viewers, remove " .. lock
		end
		return nil, "Could not lock session organization: " .. tostring(lock_error)
	end
	local ok, result, err = pcall(function()
		local state, load_error = load()
		if not state then
			return nil, load_error
		end
		local before = vim.deepcopy(state)
		local value, callback_error = callback(state)
		if not value then
			return nil, callback_error
		end
		if not vim.deep_equal(before, state) then
			local saved, save_error = save(state)
			if not saved then
				return nil, save_error
			end
		end
		return value
	end)
	vim.uv.fs_close(fd)
	local removed, remove_error = vim.uv.fs_unlink(lock)
	if not removed then
		return nil, "Could not release session organization lock: " .. tostring(remove_error)
	end
	if not ok then
		return nil, "Could not update session organization: " .. tostring(result)
	end
	return result, err
end

local function group_keys(state, id)
	if id == "" then
		return state.ungrouped
	end
	for _, group in ipairs(state.groups) do
		if group.id == id then
			return group.keys
		end
	end
end

local function locate(state, key)
	for _, group in ipairs(state.groups) do
		for i, candidate in ipairs(group.keys) do
			if candidate == key then
				return group.keys, i
			end
		end
	end
	for i, candidate in ipairs(state.ungrouped) do
		if candidate == key then
			return state.ungrouped, i
		end
	end
end

local function resolve_entry(state, entry)
	local key = entry_key(entry)
	if not key then
		return nil, "Session has no saved path or live identity"
	end
	local ephemeral = live_key(entry)
	local keys, index = locate(state, ephemeral)
	if ephemeral ~= key and keys then
		local previous = locate(state, key)
		if previous then
			-- A saved assignment is authoritative. A stale viewer can reintroduce
			-- the live key after migration, or an initializing frontend can
			-- briefly appear unsaved before reopening an already organized path.
			table.remove(keys, index)
		else
			keys[index] = key
		end
	end
	entry.organization_key = key
	return key
end

local function sync(state, entries)
	for _, entry in ipairs(entries) do
		local key, err = resolve_entry(state, entry)
		if not key then
			return nil, err
		end
		if not locate(state, key) then
			table.insert(state.ungrouped, key)
		end
	end
	return true
end

local function sections(state, entries)
	local visible = {}
	for _, entry in ipairs(entries) do
		local key = entry.organization_key
		visible[key] = visible[key] or {}
		table.insert(visible[key], entry)
	end
	local result = {}
	local function append(id, name, keys)
		local section = { id = id, name = name, entries = {}, count = #keys }
		for _, key in ipairs(keys) do
			for _, entry in ipairs(visible[key] or {}) do
				table.insert(section.entries, entry)
			end
		end
		if id ~= "" or #section.entries > 0 then
			table.insert(result, section)
		end
	end
	for _, group in ipairs(state.groups) do
		append(group.id, group.name, group.keys)
	end
	append("", "Ungrouped", state.ungrouped)
	return result
end

function M.sections(entries)
	local state, err = load()
	if not state then
		return nil, err
	end
	local before = vim.deepcopy(state)
	local synced, sync_error = sync(state, entries)
	if not synced then
		return nil, sync_error
	end
	if vim.deep_equal(before, state) then
		return sections(state, entries)
	end
	return with_state(function(current)
		local updated, update_error = sync(current, entries)
		if not updated then
			return nil, update_error
		end
		return sections(current, entries)
	end)
end

local function tracked_entry(state, entry)
	local key, err = resolve_entry(state, entry)
	if not key then
		return nil, err
	end
	local keys, index = locate(state, key)
	if not keys then
		return nil, "Session is no longer tracked; refresh the session list"
	end
	return key, keys, index
end

local function assign(state, entry, destination)
	local key, keys, index = tracked_entry(state, entry)
	if not key then
		return nil, keys
	end
	if keys ~= destination then
		table.remove(keys, index)
		table.insert(destination, key)
	end
	return true
end

function M.assign(entry, group_id)
	return with_state(function(state)
		local destination = group_keys(state, group_id)
		if not destination then
			return nil, "Group no longer exists; refresh the session list"
		end
		return assign(state, entry, destination)
	end)
end

function M.create(name, entry)
	if type(name) ~= "string" or name:find("%c") or vim.trim(name) == "" then
		return nil, "Group name must be nonempty and contain no control characters"
	end
	name = vim.trim(name)
	return with_state(function(state)
		if name == "Ungrouped" then
			return nil, "A group with that name already exists"
		end
		for _, group in ipairs(state.groups) do
			if group.name == name then
				return nil, "A group with that name already exists"
			end
		end
		local id = "group:" .. vim.uv.os_getpid() .. ":" .. tostring(vim.uv.hrtime())
		while group_keys(state, id) do
			id = id .. ":1"
		end
		local group = { id = id, name = name, keys = {} }
		table.insert(state.groups, group)
		if entry then
			return assign(state, entry, group.keys)
		end
		return true
	end)
end

function M.move(node, delta)
	if type(node) ~= "table" or type(delta) ~= "number" or delta ~= delta or math.abs(delta) == math.huge or delta % 1 ~= 0 then
		return nil, "Move requires a group or session and an integer delta"
	end
	return with_state(function(state)
		if node.kind == "group" then
			for index, group in ipairs(state.groups) do
				if group.id == node.id then
					local target = math.max(1, math.min(#state.groups, index + delta))
					table.insert(state.groups, target, table.remove(state.groups, index))
					return true
				end
			end
			return nil, node.id == "" and "Ungrouped cannot be moved" or "Group no longer exists; refresh the session list"
		elseif node.kind ~= "session" then
			return nil, "Move requires a group or session"
		end
		local key, keys = tracked_entry(state, node.entry)
		if not key then
			return nil, keys
		end
		local visible
		if node.neighbors ~= nil then
			if type(node.neighbors) ~= "table" or not vim.islist(node.neighbors) then
				return nil, "Session neighbors must be an array"
			end
			visible = {}
			for _, entry in ipairs(node.neighbors) do
				local neighbor = entry_key(entry)
				if neighbor then
					visible[neighbor] = true
				end
			end
		end
		local positions, ordered, index = {}, {}, nil
		for position, candidate in ipairs(keys) do
			if not visible or visible[candidate] then
				table.insert(positions, position)
				table.insert(ordered, candidate)
				if candidate == key then
					index = #ordered
				end
			end
		end
		if not index then
			return nil, "Session is no longer in the visible group; refresh the session list"
		end
		local target = math.max(1, math.min(#ordered, index + delta))
		table.insert(ordered, target, table.remove(ordered, index))
		-- Reorder visible slots only; hidden sessions retain their stored order.
		for i, position in ipairs(positions) do
			keys[position] = ordered[i]
		end
		return true
	end)
end

function M.delete(group_id, confirmed)
	if group_id == "" then
		return nil, "Ungrouped cannot be deleted"
	end
	return with_state(function(state)
		for index, group in ipairs(state.groups) do
			if group.id == group_id then
				if #group.keys > 0 and not confirmed then
					return nil, "Group is no longer empty; refresh and confirm before deleting it"
				end
				for _, key in ipairs(group.keys) do
					table.insert(state.ungrouped, key)
				end
				table.remove(state.groups, index)
				return true
			end
		end
		return nil, "Group no longer exists; refresh the session list"
	end)
end

return M
