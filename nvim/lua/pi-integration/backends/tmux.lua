local json = require("pi-integration.utils.json")
local build_info = require("pi-integration.build-info")
local M = {}
local option = "@pi_console"
local tab_option = "@pi_console_tab"
local owner_pane
local owner_window
local publication

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
			and type(entry.cwd) == "string"
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
	local argv = vim.list_extend({ "tmux" }, list_args)
	local ok, process = pcall(vim.system, argv, { text = true, timeout = 2000 }, vim.schedule_wrap(function(result)
		local output, err = command_result(result)
		callback(output and parse_instances(output) or nil, err)
	end))
	if not ok then
		vim.schedule(function() callback(nil, tostring(process)) end)
	end
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
		local switched, switch_err = command({ "switch-client", "-c", matches[1], "-t", session })
		if not switched then
			return nil, switch_err
		end
	end
	return command({ "select-window", "-t", session .. ":" .. window, ";", "select-pane", "-t", id })
end

function M.kill(entry)
	local instances, err = M.list()
	if not instances then
		return nil, err
	end
	local found = false
	for _, current in ipairs(instances) do
		if current.id == entry.id and current.pid == entry.pid then
			found = true
			break
		end
	end
	if not found then
		return nil, "That conversation is no longer open"
	end
	local target, target_err = command({ "display-message", "-p", "-t", entry.id, "#{window_id}\t#{pane_dead}" })
	if not target then
		return nil, target_err
	end
	local window, dead = target:match("^(@%d+)\t(%d)$")
	if not window or dead ~= "0" then
		return nil, "That pane is no longer open"
	end
	local panes, panes_err = command({ "list-panes", "-t", window, "-F", "#{pane_id}\t#{==:#{@pi_sidebar},1}" })
	if not panes then
		return nil, panes_err
	end
	for line in panes:gmatch("[^\n]+") do
		local pane, sidebar = line:match("^(%%%d+)\t([01])$")
		if pane ~= entry.id and sidebar ~= "1" then
			return nil, "Cannot close a tmux window containing other panes"
		end
	end
	return command({ "kill-window", "-t", window })
end

local function launch_window(shell_command, cwd, entry)
	local session, session_err = command({ "display-message", "-p", "-t", vim.env.TMUX_PANE, "#{session_id}" })
	if not session then return nil, session_err end
	local name = "New Session"
	local target, err = command({ "new-window", "-d", "-P", "-F", "#{pane_id}\t#{pane_pid}", "-t", session .. ":", "-n", name, "-c", cwd, shell_command })
	if not target then
		return nil, err
	end
	local pane, pid = target:match("^(%%%d+)\t(%d+)$")
	if not pane then
		return nil, "Could not identify the new conversation pane"
	end
	local marked, mark_err = command({ "set-option", "-wo", "-t", pane, tab_option, json.encode({ pane = pane, name = name }) })
	if not marked then
		return nil, mark_err
	end
	-- Reserve the session while Neovim starts, so a second selection focuses
	-- this window instead of opening the same history again. -o never replaces
	-- a snapshot already published by the new instance.
	command({
		"set-option",
		"-po",
		"-t",
		pane,
		option,
		json.encode(vim.tbl_extend("force", {
			version = 1,
			build = build_info.snapshot(),
			pid = tonumber(pid),
			updated = os.time(),
			cwd = cwd,
			status = "Starting",
			is_starting = true,
			activity = "Starting pi-console",
		}, entry)),
	})
	return M.focus(pane)
end

function M.launch(launcher, cwd, path)
	local shell_command = "bash " .. vim.fn.shellescape(launcher)
	if path then shell_command = shell_command .. " --session " .. vim.fn.shellescape(path) end
	return launch_window(shell_command, cwd, { path = path,
		title = path and vim.fn.fnamemodify(path, ":t") or "New Session", is_new_session = path == nil })
end

function M.launch_service(launcher, target, session_id)
	if not M.available() then return nil, "Opening a service frontend requires tmux" end
	local args = { "bash", launcher, "--resume", session_id }
	if target.service_remote then
		vim.list_extend(args, { "--remote", target.service_remote, "--credential-file", target.credential_file })
		if target.ca_file then vim.list_extend(args, { "--ca-file", target.ca_file }) end
	elseif target.service_root then vim.list_extend(args, { "--root", target.service_root }) end
	local shell_command = table.concat(vim.tbl_map(vim.fn.shellescape, args), " ")
	-- This is a local frontend window; an owner's cwd is never a local tmux path.
	return launch_window(shell_command, vim.fn.getcwd(), { frontend_attachment = true,
		host_id = target.expected_host, session_id = session_id, title = "Cloned conversation" })
end

function M.review_workspace(root, before, after)
	if not M.available() then
		return nil, "Workspace diff review requires tmux"
	end
	local script = vim.g.pi_console_root .. "/pi/scripts/review-workspace.sh"
	local args = { "bash", script, root, before, after }
	local quoted = vim.tbl_map(vim.fn.shellescape, args)
	local pane, err = command({
		"split-window",
		"-h",
		"-P",
		"-F",
		"#{pane_id}",
		"-t",
		vim.env.TMUX_PANE,
		"-c",
		root,
		table.concat(quoted, " "),
	})
	if not pane then
		return nil, err
	end
	if not pane:match("^%%%d+$") then
		return nil, "tmux did not return the reviewer pane ID"
	end
	return command({ "select-pane", "-t", pane })
end

function M.start_overview()
	local pane = vim.env.TMUX_PANE
	local marked, err = command({ "set-option", "-w", "-t", pane, "@pi_overview", "1", ";", "set-option", "-w", "-t", pane, "@pi_overview_pane", pane })
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

function M.mark_service_frontend()
	owner_pane = owner_pane or vim.env.TMUX_PANE
	return command({ "set-option", "-p", "-t", owner_pane, "@pi_service_frontend", "1", ";",
		"set-option", "-p", "-t", owner_pane, "@pi_service_frontend_pid", tostring(vim.uv.os_getpid()) })
end

local function publish_tab(snapshot, run)
	local installed, install_err = tabs.install_hooks(run)
	if not installed then return nil, install_err end
	local marker, marker_error = run({ "set-option", "-p", "-t", owner_pane, "@pi_service_frontend", snapshot.frontend_attachment and "1" or "0" })
	if not marker then return nil, marker_error end
	local window, err = run({
		"set-option", "-p", "-t", owner_pane, option, json.encode(snapshot),
		";", "display-message", "-p", "-t", owner_pane, "#{window_id}",
	})
	if not window then return nil, err end
	if owner_window and owner_window ~= window then
		tabs.refresh(owner_window, run)
	end
	owner_window = window
	return tabs.refresh(window, run)
end

function M.publish(snapshot)
	-- Skip overlapping refreshes rather than queueing stale snapshots.
	if publication then return true end
	owner_pane = owner_pane or vim.env.TMUX_PANE
	local update = {}
	publication = update
	-- Keep the existing tab/ownership logic sequential, but yield at every
	-- subprocess so Neovim can handle input while tmux is working.
	update.thread = coroutine.create(function()
		publish_tab(snapshot, function(args, raw)
			-- Shutdown finishes the remaining operations synchronously so tab
			-- cleanup sees all installed styles and their ownership marker.
			if publication ~= update then return command(args, raw) end
			return command_result(coroutine.yield(args), raw)
		end)
	end)
	local function advance(...)
		if publication ~= update then return end
		local ok, args = coroutine.resume(update.thread, ...)
		if not ok or coroutine.status(update.thread) == "dead" then
			publication = nil
			if not ok then error(args) end
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
	publication = nil
	if update and update.process then
		local ok, err = coroutine.resume(update.thread, update.process:wait(2000))
		if not ok then vim.notify(tostring(err), vim.log.levels.ERROR) end
	end
	if owner_pane then
		-- Do not remove a replacement instance's metadata during shutdown.
		local payload = command({ "show-options", "-pv", "-t", owner_pane, option })
		local entry = payload and json.decode_object(payload)
		if entry and entry.pid == vim.uv.os_getpid() then
			command({ "set-option", "-pu", "-t", owner_pane, option })
		end
		local marker_pid = command({ "show-options", "-pqv", "-t", owner_pane, "@pi_service_frontend_pid" })
		if marker_pid == tostring(vim.uv.os_getpid()) then
			command({ "set-option", "-pu", "-t", owner_pane, "@pi_service_frontend", ";",
				"set-option", "-pu", "-t", owner_pane, "@pi_service_frontend_pid" })
		end
		if owner_window and (not entry or entry.pid == vim.uv.os_getpid()) then
			tabs.refresh(owner_window, command)
		end
		owner_window = nil
		owner_pane = nil
	end
end

return M
