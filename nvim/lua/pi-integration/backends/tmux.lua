local json = require("pi-integration.utils.json")
local M = {}
local option = "@pi_console"
local owner_pane

function M.available()
	return vim.env.TMUX ~= nil and vim.env.TMUX_PANE ~= nil and vim.fn.executable("tmux") == 1
end

local function command(args)
	local argv = { "tmux" }
	vim.list_extend(argv, args)
	local result = vim.system(argv, { text = true }):wait(2000)
	if result.code ~= 0 then
		local message = vim.trim(result.stderr or "")
		return nil, message ~= "" and message or ("tmux exited with code " .. tostring(result.code))
	end
	return vim.trim(result.stdout or "")
end

function M.list()
	local output, err = command({ "list-panes", "-a", "-F", "#{pane_id}\t#{session_id}\t#{window_id}\t#{pane_dead}\t#{" .. option .. "}" })
	if not output then
		return nil, err
	end
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
		local clients, client_err = command({ "list-clients", "-F", "#{client_name}\t#{session_id}" })
		if not clients then
			return nil, client_err
		end
		local matches = {}
		for line in clients:gmatch("[^\n]+") do
			local name, client_session = line:match("^(.-)\t(%$%d+)$")
			if client_session == source then
				table.insert(matches, name)
			end
		end
		if #matches ~= 1 then
			return nil, "Cannot identify a unique tmux client to switch between sessions"
		end
		local switched, switch_err = command({ "switch-client", "-c", matches[1], "-t", session })
		if not switched then
			return nil, switch_err
		end
	end
	return command({ "select-window", "-t", window, ";", "select-pane", "-t", id })
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
	local panes, panes_err = command({ "list-panes", "-t", window, "-F", "#{pane_id}" })
	if not panes then
		return nil, panes_err
	end
	if panes ~= entry.id then
		return nil, "Cannot close a tmux window containing other panes"
	end
	return command({ "kill-window", "-t", window })
end

function M.launch(launcher, cwd, path)
	local ensure_script = vim.fn.fnamemodify(launcher, ":h:h") .. "/tmux/scripts/open-agents-overview.sh"
	local ensured = vim.system({ "bash", ensure_script, "--ensure", vim.env.TMUX_PANE }, { text = true }):wait(5000)
	if ensured.code ~= 0 then
		return nil, "Could not create the agents overview: " .. vim.trim(ensured.stderr or "")
	end
	local shell_command = "bash " .. vim.fn.shellescape(launcher)
	if path then
		shell_command = shell_command .. " --session " .. vim.fn.shellescape(path)
	end
	local target, err = command({ "new-window", "-d", "-P", "-F", "#{pane_id}\t#{pane_pid}", "-t", "=agents:", "-n", "pi", "-c", cwd, shell_command })
	if not target then
		return nil, err
	end
	local pane, pid = target:match("^(%%%d+)\t(%d+)$")
	if not pane then
		return nil, "Could not identify the new conversation pane"
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
		json.encode({
			version = 1,
			pid = tonumber(pid),
			updated = os.time(),
			path = path,
			title = path and vim.fn.fnamemodify(path, ":t") or "New Session",
			is_new_session = path == nil,
			cwd = cwd,
			status = "Starting",
			activity = "Starting pi-console",
		}),
	})
	return M.focus(pane)
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

function M.publish(snapshot)
	owner_pane = owner_pane or vim.env.TMUX_PANE
	return command({ "set-option", "-p", "-t", owner_pane, option, json.encode(snapshot) })
end

function M.clear()
	if owner_pane then
		-- Do not remove a replacement instance's metadata during shutdown.
		local payload = command({ "show-options", "-pv", "-t", owner_pane, option })
		local entry = payload and json.decode_object(payload)
		if entry and entry.pid == vim.uv.os_getpid() then
			command({ "set-option", "-pu", "-t", owner_pane, option })
		end
		owner_pane = nil
	end
end

return M
