-- Session UI depends on this module, not on a particular multiplexer.
-- Backends implement available/list/focus/launch/kill/publish/clear/start_overview.
-- start_overview registers the overview's location for backend navigation.
-- list() returns snapshots plus an opaque instance id and a readable location.
-- Session controls use each Neovim instance's RPC server, independent of its backend.
-- Operations return a non-nil value on success, or nil and an error message.
local M = {}
local timer
local publisher_state
local publisher_rpc_address
local publisher_rpc_mode

local function backend()
	local tmux = require("pi-integration.backends.tmux")
	if tmux.available() then
		return tmux
	end
end

function M.available()
	return backend() ~= nil
end

function M.start_overview()
	local transport = backend()
	if transport then
		return transport.start_overview()
	end
	return true
end

function M.canonical_path(path)
	if type(path) ~= "string" or path == "" then
		return nil
	end
	return vim.fn.resolve(vim.fn.fnamemodify(vim.fn.expand(path), ":p"))
end

function M.list()
	local transport = backend()
	if not transport then
		return {}
	end
	return transport.list()
end

function M.find_session(path)
	local instances, err = M.list()
	if not instances then
		return nil, err
	end
	path = M.canonical_path(path)
	for _, entry in ipairs(instances) do
		if path and M.canonical_path(entry.path) == path then
			return entry
		end
	end
end

function M.focus(id)
	local transport = backend()
	if not transport then
		return nil, "No supported session backend is available"
	end
	-- Avoid focusing a shell that has replaced the selected conversation.
	local instances, err = transport.list()
	if not instances then
		return nil, err
	end
	for _, entry in ipairs(instances) do
		if entry.id == id then
			return transport.focus(id)
		end
	end
	return nil, "That conversation is no longer open"
end

function M.control(entry, action, argument)
	local transport = backend()
	if not transport then
		return nil, "No supported session backend is available"
	end
	local instances, err = transport.list()
	if not instances then
		return nil, err
	end
	local current
	for _, candidate in ipairs(instances) do
		if candidate.id == entry.id and candidate.pid == entry.pid then
			current = candidate
			break
		end
	end
	if not current then
		return nil, "That conversation is no longer open"
	end
	if type(current.rpc_address) ~= "string" or current.rpc_address == "" then
		return nil, "That conversation is not ready for remote control"
	end

	local mode = current.rpc_mode == "tcp" and "tcp" or "pipe"
	local connected, channel = pcall(vim.fn.sockconnect, mode, current.rpc_address, { rpc = true })
	if not connected or channel == 0 then
		return nil, "Could not connect to that conversation"
	end
	local ok, result = pcall(
		vim.rpcrequest,
		channel,
		"nvim_exec_lua",
		[[return require("pi-integration.remote").dispatch(...)]],
		{ { action = action, argument = argument } }
	)
	pcall(vim.fn.chanclose, channel)
	if not ok then
		return nil, "Could not control that conversation: " .. tostring(result)
	end
	if type(result) ~= "table" or result.ok ~= true then
		return nil, type(result) == "table" and result.error or "The conversation rejected that action"
	end
	return true
end

function M.kill_needs_confirmation(entry)
	return entry.status ~= "Idle" and entry.status ~= "Stopped" and entry.status ~= "Error"
end

function M.kill(entry, confirmed)
	local transport = backend()
	if not transport then
		return nil, "No supported session backend is available"
	end
	local instances, err = transport.list()
	if not instances then
		return nil, err
	end
	for _, current in ipairs(instances) do
		if current.id == entry.id then
			if current.pid ~= entry.pid then
				return nil, "That conversation has changed since it was selected"
			end
			if M.kill_needs_confirmation(current) and not confirmed then
				return nil, "That conversation is now active; press d again to confirm"
			end
			return transport.kill(current)
		end
	end
	return nil, "That conversation is no longer open"
end

function M.launch(launcher, cwd, path)
	local transport = backend()
	if not transport then
		return nil, "No supported session backend is available"
	end
	if path then
		path = M.canonical_path(path)
		if not path then
			return nil, "Invalid session path"
		end
		local existing, err = M.find_session(path)
		if err then
			return nil, err
		end
		if existing then
			return M.focus(existing.id)
		end
		if vim.fn.filereadable(path) ~= 1 then
			return nil, "Session file no longer exists: " .. path
		end
	end
	if vim.fn.isdirectory(cwd) ~= 1 then
		return nil, "Directory no longer exists: " .. cwd
	end
	if vim.fn.filereadable(launcher) ~= 1 then
		return nil, "Launcher no longer exists: " .. launcher
	end
	return transport.launch(launcher, cwd, path)
end

local function snapshot(state)
	local status = "Idle"
	local waiting
	local request_id = state.active_ui_request_id
	local request = request_id and (state.pending_ui_requests or {})[request_id] or nil
	if request and (not request.expires or request.expires > vim.uv.now()) then
		waiting = request
	end
	if not state.job or state.job <= 0 then
		status = "Stopped"
	elseif waiting then
		status = "Waiting"
	elseif state.is_retrying then
		status = "Retrying"
	elseif state.is_compacting then
		status = "Compacting"
	elseif state.is_streaming or state.awaiting_agent_output then
		status = "Working"
	elseif state.error_rendered_for_active_run then
		status = "Error"
	end
	local path = state.session_file or state.pending_session_file
	local is_new_session = not state.session_name
		and not state.pending_session_file
		and (tonumber(state.message_count) or 0) == 0
	local title = state.session_name
		or (is_new_session and "New Session")
		or (path and vim.fn.fnamemodify(path, ":t"))
		or "New Session"
	return {
		version = 1,
		pid = vim.uv.os_getpid(),
		updated = os.time(),
		path = path,
		title = title,
		is_new_session = is_new_session,
		rpc_address = publisher_rpc_address,
		rpc_mode = publisher_rpc_mode,
		cwd = (state.workspace and state.workspace.cwd) or vim.fn.getcwd(),
		directory = (state.workspace and state.workspace.directory) or (state.workspace and state.workspace.cwd) or vim.fn.getcwd(),
		workspace_id = state.workspace and state.workspace.id,
		status = status,
		activity = waiting and waiting.label or state.activity_label or "",
		waiting = waiting,
		access_mode = state.access_mode,
		integration_mode = state.integration_mode,
		notification_status = state.notification_status,
		model = state.model_id,
		subagents = state.spawn_running_count or 0,
	}
end

function M.publish()
	local transport = backend()
	if publisher_state and transport then
		return transport.publish(snapshot(publisher_state))
	end
end

function M.stop()
	if timer then
		timer:stop()
		timer:close()
		timer = nil
	end
	publisher_state = nil
	publisher_rpc_address = nil
	publisher_rpc_mode = nil
	local transport = backend()
	if transport then
		transport.clear()
	end
end

function M.start(state)
	if timer or not M.available() then
		return
	end
	publisher_state = state
	publisher_rpc_address = vim.v.servername
	if publisher_rpc_address == "" then
		local ok, address = pcall(vim.fn.serverstart)
		publisher_rpc_address = ok and address or nil
	end
	if publisher_rpc_address then
		publisher_rpc_mode = publisher_rpc_address:find(":", 1, true) and "tcp" or "pipe"
	end
	M.publish()
	timer = vim.uv.new_timer()
	timer:start(
		1000,
		1000,
		vim.schedule_wrap(function()
			if timer then
				M.publish()
			end
		end)
	)
	vim.api.nvim_create_autocmd("VimLeavePre", { once = true, callback = M.stop })
end

return M
