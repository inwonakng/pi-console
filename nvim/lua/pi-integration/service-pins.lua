local store = require("pi-integration.frontend-store")
local M = {}
local function key(entry) return vim.json.encode({ entry.host_id, entry.session_id }) end
function M.toggle(entry)
	if not entry.host_id or not entry.session_id then return nil, "Session has no owner identity" end
	return store.update("pins", vim.empty_dict(), function(pins)
		local id = key(entry)
		if pins[id] then pins[id] = nil else
			pins[id] = { id = entry.id, host_id = entry.host_id, session_id = entry.session_id,
				host_name = entry.host_name, title = entry.title, cwd = entry.cwd, directory = entry.directory }
		end
		return true
	end)
end
function M.merge(instances)
	local ok, pins = pcall(store.load, "pins", vim.empty_dict())
	if not ok then return nil, tostring(pins) end
	local entries, seen = {}, {}
	for _, instance in ipairs(instances) do
		local entry = vim.deepcopy(instance)
		local id = key(entry)
		entry.pinned = pins[id] ~= nil
		seen[id] = true
		table.insert(entries, entry)
	end
	local ids = vim.tbl_keys(pins); table.sort(ids)
	for _, id in ipairs(ids) do
		if not seen[id] then
			local entry = vim.deepcopy(pins[id])
			entry.pinned = true
			local host = require("pi-integration.service-hosts").find(entry.host_id)
			entry.connected = host and host.connected or false
			entry.host_name = host and host.alias or entry.host_name
			entry.status = entry.connected and "Not Open" or "Disconnected"
			entry.location = entry.host_name
			table.insert(entries, entry)
		end
	end
	return entries
end
return M
