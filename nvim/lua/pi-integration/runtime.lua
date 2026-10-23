local hosts = require("pi-integration.service-hosts")
local tmux = require("pi-integration.backends.tmux")
local M = {}
function M.available() return true end
function M.start_overview()
	hosts.start()
	if tmux.available() then return tmux.start_overview() end
	return true
end
function M.list() return hosts.list() end
function M.list_async(callback) vim.schedule(function() callback(hosts.list()) end) end
function M.last_focused(entries)
	local latest
	for _, entry in ipairs(entries) do
		if entry.last_focused_at and entry.last_focused_at > 0 and (not latest or entry.last_focused_at > latest.last_focused_at) then latest = entry end
	end
	return latest
end
function M.canonical_path(path) return path end -- Owner paths are never resolved locally.
function M.open(entry) return hosts.open(entry) end
function M.control(entry, action, argument) return hosts.manage(entry, action, argument) end
function M.kill(entry) return hosts.manage(entry, "kill") end
return M
