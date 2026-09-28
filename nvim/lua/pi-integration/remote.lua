local M = {}

local function integration()
	return require("pi-integration")
end

local actions = {
	cycle_access_mode = function()
		integration().cycle_access_mode()
	end,
	cycle_integration_mode = function()
		integration().cycle_integration_mode()
	end,
	set_access_mode = function(mode)
		integration().set_access_mode(mode)
	end,
	set_integration_mode = function(mode)
		integration().set_integration_mode(mode)
	end,
	toggle_notifications = function()
		integration().toggle_notifications()
	end,
}

function M.dispatch(request)
	if type(request) ~= "table" or type(request.action) ~= "string" then
		return { ok = false, error = "Invalid remote action" }
	end
	local action = actions[request.action]
	if not action then
		return { ok = false, error = "Unsupported remote action: " .. request.action }
	end
	local ok, err = pcall(action, request.argument)
	if not ok then
		return { ok = false, error = tostring(err) }
	end
	require("pi-integration.runtime").publish()
	return { ok = true }
end

return M
