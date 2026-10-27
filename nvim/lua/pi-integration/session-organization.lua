local json = require("pi-integration.utils.json")

local M = {}

local function valid_name(name)
	return type(name) == "string" and name ~= "" and name == vim.trim(name) and not name:find("%c")
end

local function entry_key(entry)
	if type(entry) ~= "table" then
		return nil
	end
	if entry.host_id and entry.session_id then return "service:" .. json.encode({ entry.host_id, entry.session_id }) end
	if entry.frontend_id then return "frontend:" .. entry.frontend_id end
end

local function valid_key(key)
	if type(key) ~= "string" then
		return false
	end
	if key:sub(1, 9) == "frontend:" then
		local tuple = json.decode(key:sub(10))
		return type(tuple) == "table" and vim.islist(tuple) and #tuple == 2
			and type(tuple[1]) == "string" and tuple[1]:match("^%%%d+$") ~= nil
			and type(tuple[2]) == "number" and tuple[2] > 0 and tuple[2] % 1 == 0
			and "frontend:" .. json.encode(tuple) == key
	end
	if key:sub(1, 8) == "service:" then
		local tuple = json.decode(key:sub(9))
		return type(tuple) == "table" and vim.islist(tuple) and #tuple == 2
			and type(tuple[1]) == "string" and tuple[1] ~= "" and type(tuple[2]) == "string" and tuple[2] ~= ""
			and "service:" .. json.encode(tuple) == key
	end
	return false
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
	local ok, state = pcall(require("pi-integration.frontend-store").load, "organization", { version = 1, groups = {}, ungrouped = {} })
	if not ok or not valid_state(state) then return nil, "Invalid organization: " .. tostring(state) end
	return state
end

local function with_state(callback)
	return require("pi-integration.frontend-store").update("organization", { version = 1, groups = {}, ungrouped = {} }, function(state)
		if not valid_state(state) then return nil, "Invalid organization" end
		return callback(state)
	end)
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
	for _, frontend in ipairs(entry.frontend_keys or {}) do
		local keys, index = locate(state, frontend)
		if keys then
			local previous, position = locate(state, key)
			if previous == state.ungrouped and keys ~= state.ungrouped then
				table.remove(previous, position)
				keys[index] = key
			elseif previous then table.remove(keys, index)
			else keys[index] = key end
		end
	end
	entry.organization_key = key
	return key
end

local function sync(state, entries)
	local visible = {}
	for _, entry in ipairs(entries) do
		local key, err = resolve_entry(state, entry)
		if not key then
			return nil, err
		end
		visible[key] = true
		if not locate(state, key) then
			local destination = group_keys(state, entry.initial_group) or state.ungrouped
			table.insert(destination, key)
		end
	end
	local lists = { state.ungrouped }
	for _, group in ipairs(state.groups) do table.insert(lists, group.keys) end
	for _, keys in ipairs(lists) do
		for index = #keys, 1, -1 do
			if keys[index]:sub(1, 9) == "frontend:" and not visible[keys[index]] then table.remove(keys, index) end
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
