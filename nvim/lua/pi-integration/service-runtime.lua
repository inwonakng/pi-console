local hosts = require("pi-integration.service-hosts")
local M = {}
function M.available() return true end
function M.start_overview()
	hosts.start()
	local tmux = require("pi-integration.backends.tmux")
	if tmux.available() then return tmux.start_overview() end
	return true
end
function M.list() return hosts.list() end
function M.list_async(callback) vim.schedule(function() callback(hosts.list()) end) end
function M.last_focused() return nil end
function M.canonical_path(path) return path end -- Owner paths are never resolved on this machine.
function M.focus(id)
	for _, entry in ipairs(hosts.list()) do if entry.id == id then return hosts.open(entry) end end
	return nil, "Session is no longer live; refresh or explicitly resume a pin"
end
function M.open(entry) return hosts.open(entry) end
function M.control(entry, action, argument)
	for _, current in ipairs(hosts.list()) do
		if current.id == entry.id then
			if not current.connected then return nil, "Host disconnected; mutations disabled" end
			if current.service_epoch ~= entry.service_epoch or current.runtime_revision ~= entry.runtime_revision
				or (current.controller and current.controller.grantId) ~= (entry.controller and entry.controller.grantId) then
				return nil, "Session/runtime/controller changed; select the action again"
			end
			return require("pi-integration.service-frontend").overview_control(entry, action, argument)
		end
	end
	return nil, "Session is no longer live; refresh or explicitly resume a pin"
end
function M.kill_needs_confirmation() return true end
function M.kill(entry) return M.control(entry, "kill") end
function M.launch() hosts.new_conversation(); return true end
function M.publish() end
return M
