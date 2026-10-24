local store = require("pi-integration.frontend-store")
local M = {}
local function key(entry)
	if entry.host_id and entry.session_id then return vim.json.encode({ entry.host_id, entry.session_id }) end
end
function M.refresh(host_id, rows, host_name)
	local ok, result, message, code = pcall(function()
		local by_id = {}
		for _, row in ipairs(rows) do by_id[row.id] = row end
		local function refresh(pins)
			local changed = false
			for _, pin in pairs(pins) do
				local row = pin.host_id == host_id and by_id[pin.session_id]
				if row then
					local title = type(row.name) == "string" and row.name:match("%S") and row.name or "Untitled session"
					if pin.title ~= title or pin.cwd ~= row.cwd or pin.directory ~= row.cwd or pin.host_name ~= host_name then
						pin.title, pin.cwd, pin.directory, pin.host_name = title, row.cwd, row.cwd, host_name
						changed = true
					end
				end
			end
			return changed
		end
		-- Most summaries change only live activity. Avoid a write lock for those.
		if not refresh(store.load("pins", vim.empty_dict())) then return true end
		return store.update("pins", vim.empty_dict(), function(pins)
			-- Recompute under the lock; never restore a concurrently removed pin.
			refresh(pins)
			return true
		end)
	end)
	if not ok then return nil, tostring(result) end
	return result, message, code
end
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
		entry.pinned = id ~= nil and pins[id] ~= nil
		if id then seen[id] = true end
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
