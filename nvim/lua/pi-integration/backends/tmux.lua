local json = require("pi-integration.utils.json")
local build_info = require("pi-integration.build-info")
local M = {}
local option = "@pi_console"
local tab_option = "@pi_console_tab"
local owner_pane
local owner_window
local pending_launches = {}
local publication, pending_snapshot, pending_heartbeat, last_published
local last_publication, last_tab_refresh = -math.huge, -math.huge

local tabs = require("pi-integration.backends.tmux-tabs")

function M.available()
	return vim.env.TMUX ~= nil and vim.env.TMUX_PANE ~= nil and vim.fn.executable("tmux") == 1
end

local function command_result(result, raw)
	if result.code ~= 0 then
		local message = vim.trim(result.stderr or "")
		return nil, message ~= "" and message or ("tmux exited with code " .. tostring(result.code))
	end
	return raw and (result.stdout or "") or vim.trim(result.stdout or "")
end

local function command(args, raw)
	local argv = { "tmux" }
	vim.list_extend(argv, args)
	return command_result(vim.system(argv, { text = true }):wait(2000), raw)
end

local function command_async(args, callback)
	local argv = vim.list_extend({ "tmux" }, args)
	local ok, process = pcall(vim.system, argv, { text = true, timeout = 2000 }, vim.schedule_wrap(function(result)
		callback(command_result(result))
	end))
	if not ok then vim.schedule(function() callback(nil, tostring(process)) end) end
end

local list_args = { "list-panes", "-a", "-F", "#{pane_id}\t#{session_id}\t#{window_id}\t#{pane_dead}\t#{" .. option .. "}" }

local function parse_instances(output)
	local instances = {}
	local seen = {}
	for line in output:gmatch("[^\n]+") do
		local pane, session, window, dead, payload = line:match("^(%%%d+)\t(%$%d+)\t(@%d+)\t(%d)\t(.+)$")
		local entry = payload and json.decode_object(payload)
		if
			entry
			and entry.version == 1
			and dead == "0"
			and not seen[pane]
			and type(entry.pid) == "number"
			and entry.pid > 0
			and entry.pid == math.floor(entry.pid)
			and type(entry.title) == "string"
			and (type(entry.cwd) == "string" or entry.cwd == nil and entry.frontend_attachment == true and entry.session_id == nil)
			and type(entry.status) == "string"
			and type(entry.updated) == "number"
			and vim.uv.kill(entry.pid, 0)
		then
			-- Pane IDs stay stable when windows are renamed, reordered, or panes moved.
			entry.id = pane
			entry.location = "tmux " .. session .. ":" .. window .. "." .. pane
			if os.time() - entry.updated > 10 then
				entry.status = "Unresponsive"
			end
			table.insert(instances, entry)
			seen[pane] = true
		end
	end
	table.sort(instances, function(a, b)
		return tonumber(a.id:sub(2)) < tonumber(b.id:sub(2))
	end)
	return instances
end

function M.list()
	local output, err = command(list_args)
	if not output then return nil, err end
	return parse_instances(output)
end

function M.list_async(callback)
	command_async(list_args, function(output, err)
		callback(output and parse_instances(output) or nil, err)
	end)
end

function M.is_focused()
	local output, err = command({ "list-clients", "-F", "#{pane_id}\t#{client_flags}\t#{client_control_mode}" })
	if not output then
		return nil, err
	end
	for line in output:gmatch("[^\n]+") do
		local pane, flags, control = line:match("^(%%%d+)\t(.-)\t([01])$")
		if pane == vim.env.TMUX_PANE and control == "0" and ("," .. flags .. ","):find(",focused,", 1, true) then
			return true
		end
	end
	return false
end

-- Keyboard focus excludes visible inactive splits. Match every ordinary
-- client's window instead, including linked windows in other sessions.
function M.is_visible_async(callback)
	local argv = { "tmux", "display-message", "-p", "-t", vim.env.TMUX_PANE,
		"pane\t#{window_id}\t#{pane_active}\t#{window_zoomed_flag}",
		";", "list-clients", "-F", "client\t#{window_id}\t#{client_control_mode}\t#{client_flags}" }
	local ok, process = pcall(vim.system, argv, { text = true, timeout = 2000 }, vim.schedule_wrap(function(result)
		local output, err = command_result(result, true)
		if not output then callback(nil, err); return end
		local window, active, zoomed = output:match("pane\t(@%d+)\t([01])\t([01])")
		if not window then callback(nil, "Missing tmux pane visibility"); return end
		if zoomed == "1" and active ~= "1" then callback(false); return end
		for line in output:gmatch("[^\n]+") do
			local viewed, control, flags = line:match("^client\t(@%d+)\t([01])\t(.*)$")
			if viewed == window and control == "0" and not ("," .. flags .. ","):find(",suspended,", 1, true) then
				callback(true); return
			end
		end
		callback(false)
	end))
	if not ok then vim.schedule(function() callback(nil, tostring(process)) end) end
end

function M.focus(id)
	if not id:match("^%%%d+$") then
		return nil, "Invalid tmux pane ID"
	end
	-- Resolve the window again: the pane may have moved since the last refresh.
	local target, err = command({ "display-message", "-p", "-t", id, "#{session_id}\t#{window_id}\t#{pane_dead}" })
	if not target then
		return nil, "That pane is no longer open: " .. (err or "")
	end
	local session, window, dead = target:match("^(%$%d+)\t(@%d+)\t(%d)$")
	if not session or dead == "1" then
		return nil, "That pane is no longer open"
	end
	local source = command({ "display-message", "-p", "-t", vim.env.TMUX_PANE, "#{session_id}" })
	if source ~= session then
		local context = require("pi-integration.backends.tmux-input").client()
		local clients, client_err = command({ "list-clients", "-F", "#{client_name}\t#{client_pid}\t#{session_id}\t#{pane_id}" })
		if not clients then
			return nil, client_err
		end
		local matches = {}
		for line in clients:gmatch("[^\n]+") do
			local name, pid, client_session, pane = line:match("^(.-)\t(%d+)\t(%$%d+)\t(%%%d+)$")
			if client_session == source and (not context or context.name == name
				and context.pid == tonumber(pid) and context.pane == pane and pane == vim.env.TMUX_PANE) then
				table.insert(matches, name)
			end
		end
		if #matches ~= 1 then
			return nil, context and "The initiating tmux client is no longer viewing this pane"
				or "Cannot identify a unique tmux client to switch between sessions"
		end
		-- A popup must hand navigation back to its outer client when the
		-- destination contains that popup, rather than displaying itself.
		local switched, switch_err = command_result(vim.system({
			"bash", vim.g.pi_console_root .. "/tmux/scripts/popup-client.sh", "--switch",
			vim.env.TMUX:match("^(.*),%d+,%d+$"), matches[1], session,
		}, { text = true }):wait(2000))
		if not switched then
			return nil, switch_err
		end
	end
	return command({ "select-window", "-t", session .. ":" .. window, ";", "select-pane", "-t", id })
end

function M.close_frontend(entry)
	local instances, err = M.list()
	if not instances then return nil, err end
	local target
	for _, instance in ipairs(instances) do
		if instance.id == entry.frontend_pane and instance.pid == entry.pid then target = instance; break end
	end
	if not target then return nil, "That frontend is no longer open" end
	if not target.frontend_attachment or target.session_id then return nil, "Frontend changed; select the action again" end
	if type(target.server) ~= "string" or target.server == "" then return nil, "Frontend is still starting or does not support closing; try again after restarting it" end
	local connected, channel = pcall(vim.fn.sockconnect, "pipe", target.server, { rpc = true })
	if not connected or channel == 0 then return nil, "Could not connect to the frontend" end
	local ok, result = pcall(vim.fn.rpcrequest, channel, "nvim_exec_lua",
		"return { require('pi-integration.service-frontend').close_unstarted(...) }", { target.pid })
	vim.fn.chanclose(channel)
	if not ok then return nil, tostring(result) end
	return result[1], result[2]
end

-- Remove only sidebar companions when this is the window's sole content pane.
function M.close_sidebar()
	local panes = command({ "list-panes", "-t", vim.env.TMUX_PANE, "-F", "#{pane_id}\t#{@pi_sidebar}" })
	if not panes then return end
	local sidebars = {}
	for line in panes:gmatch("[^\n]+") do
		local pane, sidebar = line:match("^(%%%d+)\t(.*)$")
		if pane ~= vim.env.TMUX_PANE then
			if sidebar ~= "1" then return end
			table.insert(sidebars, pane)
		end
	end
	for _, pane in ipairs(sidebars) do command({ "kill-pane", "-t", pane }) end
end

local function launch_window(shell_command, cwd, entry, callback)
	command_async({ "display-message", "-p", "-t", vim.env.TMUX_PANE, "#{session_id}" }, function(session, session_err)
		if not session then callback(nil, session_err); return end
		local name = "New Session"
		command_async({ "new-window", "-d", "-P", "-F", "#{pane_id}\t#{pane_pid}", "-t", session .. ":", "-n", name, "-c", cwd, shell_command }, function(target, err)
			if not target then callback(nil, err); return end
			local pane, pid = target:match("^(%%%d+)\t(%d+)$")
			if not pane then callback(nil, "Could not identify the new conversation pane"); return end
			-- Reserve before focusing. -o preserves any metadata the new editor
			-- has already published. The pane is in the launching session, so no
			-- cross-session client discovery is needed here.
			command_async({
				"set-option", "-wo", "-t", pane, tab_option, json.encode({ pane = pane, name = name }),
				";", "set-option", "-po", "-t", pane, option,
				json.encode(vim.tbl_extend("force", {
					version = 1, build = build_info.snapshot(), pid = tonumber(pid), updated = os.time(),
					cwd = cwd, status = "Starting", is_starting = true, activity = "Starting pi-console",
				}, entry)),
				";", "select-window", "-t", pane, ";", "select-pane", "-t", pane,
			}, callback)
		end)
	end)
end

function M.launch_service(launcher, target, session_id, cwd, resume)
	if not M.available() then return nil, "Opening a conversation window requires tmux" end
	local args = { "bash", launcher }
	if session_id then vim.list_extend(args, { resume and "--resume" or "--attach", session_id })
	else
		if not cwd or cwd == "" then return nil, "New conversation requires a directory on the selected host" end
		vim.list_extend(args, { "--new", "--cwd", cwd })
	end
	if target.expected_host then vim.list_extend(args, { "--expected-host", target.expected_host }) end
	if target.service_remote then
		vim.list_extend(args, { "--remote", target.service_remote })
	elseif target.service_root then vim.list_extend(args, { "--root", target.service_root }) end
	local shell_command = table.concat(vim.tbl_map(vim.fn.shellescape, args), " ")
	-- Keep repeated selections from racing the asynchronous pane reservation.
	local key = session_id and json.encode({ target.service_remote or "", target.service_root or "", session_id })
	if key and pending_launches[key] then return true end
	if key then pending_launches[key] = true end
	-- This is a local frontend window; an owner's cwd is never a local tmux path.
	launch_window(shell_command, vim.fn.getcwd(), { frontend_attachment = true,
		host_id = target.expected_host, session_id = session_id, title = "Conversation" }, function(opened, err)
		if key then pending_launches[key] = nil end
		if not opened then require("pi-integration.logs").notify(err, vim.log.levels.ERROR) end
	end)
	-- Success means launch accepted; asynchronous failures are reported above.
	return true
end

function M.start_overview()
	local pane = vim.env.TMUX_PANE
	local marked, err = command({
		"set-option", "-w", "-t", pane, "@pi_overview", "1",
		";", "set-option", "-w", "-t", pane, "@pi_overview_pane", pane,
		";", "set-option", "-wF", "-t", pane, "window-status-style", "#{window-status-style},fg=#42D9F3",
		";", "set-option", "-wF", "-t", pane, "window-status-current-style", "#{window-status-current-style},fg=#42D9F3",
	})
	if not marked then
		return nil, err
	end
	-- Also register directly started/restored overview editors, not only windows
	-- created by the tmux helper. Drop the marker when the overview exits.
	vim.api.nvim_create_autocmd("VimLeavePre", {
		once = true,
		callback = function()
			local owner = command({ "show-options", "-wv", "-t", pane, "@pi_overview_pane" })
			if owner == pane then
				command({ "set-option", "-wu", "-t", pane, "@pi_overview", ";", "set-option", "-wu", "-t", pane, "@pi_overview_pane" })
			end
		end,
	})
	return true
end

local function publish_tab(snapshot, run, reconcile)
	if reconcile then
		local installed, install_err = tabs.install_hooks(run)
		if not installed then return nil, install_err end
	end
	local window, err = run({
		"set-option", "-p", "-t", owner_pane, option, json.encode(snapshot),
		";", "display-message", "-p", "-t", owner_pane, "#{window_id}",
	})
	if not window then return nil, err end
	local moved = owner_window ~= window
	if owner_window and moved then
		tabs.refresh(owner_window, run)
	end
	owner_window = window
	if reconcile or moved then return tabs.refresh(window, run) end
	return true
end

function M.publish(snapshot, heartbeat_only)
	-- Keep only the latest overlapping publication, never a queue of stale tabs.
	if publication then
		pending_snapshot, pending_heartbeat = snapshot, pending_heartbeat or heartbeat_only
		return true
	end
	local semantic = vim.tbl_extend("force", snapshot, {})
	semantic.updated = nil
	local now = vim.uv.hrtime() / 1000000
	local changed = not vim.deep_equal(semantic, last_published)
	if not changed and not heartbeat_only and now - last_publication < 5000 then return true end
	-- Periodically reconcile external theme changes, independently of liveness.
	local reconcile = changed or now - last_tab_refresh >= 30000
	owner_pane = owner_pane or vim.env.TMUX_PANE
	local update = {}
	publication = update
	-- Keep the existing tab/ownership logic sequential, but yield at every
	-- subprocess so Neovim can handle input while tmux is working.
	update.thread = coroutine.create(function()
		local published = publish_tab(snapshot, function(args, raw)
			-- Shutdown finishes the remaining operations synchronously so tab
			-- cleanup sees all installed styles and their ownership marker.
			if publication ~= update then return command(args, raw) end
			return command_result(coroutine.yield(args), raw)
		end, reconcile)
		if published then
			last_published, last_publication = semantic, vim.uv.hrtime() / 1000000
			if reconcile then last_tab_refresh = last_publication end
		end
	end)
	local function advance(...)
		if publication ~= update then return end
		local ok, args = coroutine.resume(update.thread, ...)
		if not ok or coroutine.status(update.thread) == "dead" then
			publication = nil
			if not ok then error(args) end
			local pending, heartbeat = pending_snapshot, pending_heartbeat
			pending_snapshot, pending_heartbeat = nil, nil
			if pending then M.publish(pending, heartbeat) end
			return
		end
		local argv = { "tmux" }
		vim.list_extend(argv, args)
		local started, process = pcall(vim.system, argv, { text = true, timeout = 2000 }, vim.schedule_wrap(function(result)
			advance(result)
		end))
		if not started then
			publication = nil
			error(process)
		end
		update.process = process
	end
	advance()
	return true
end

function M.clear()
	-- Finish the in-flight update before cleanup. Its scheduled callback is
	-- invalidated first, so it cannot restore metadata after shutdown.
	local update = publication
	publication, pending_snapshot, pending_heartbeat, last_published = nil, nil, nil, nil
	last_publication, last_tab_refresh = -math.huge, -math.huge
	if update and update.process then
		local ok, err = coroutine.resume(update.thread, update.process:wait(2000))
		if not ok then require("pi-integration.logs").notify(tostring(err), vim.log.levels.ERROR) end
	end
	if owner_pane then
		-- Do not remove a replacement instance's metadata during shutdown.
		local payload = command({ "show-options", "-pv", "-t", owner_pane, option })
		local entry = payload and json.decode_object(payload)
		if entry and entry.pid == vim.uv.os_getpid() then
			command({ "set-option", "-pu", "-t", owner_pane, option })
		end
		if owner_window and (not entry or entry.pid == vim.uv.os_getpid()) then
			tabs.refresh(owner_window, command)
		end
		owner_window = nil
		owner_pane = nil
	end
end

return M
