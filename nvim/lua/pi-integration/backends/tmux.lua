local json = require("pi-integration.utils.json")
local icons = require("pi-integration.status-icons")
local build_info = require("pi-integration.build-info")
local M = {}
local option = "@pi_console"
local tab_option = "@pi_console_tab"
local owner_pane
local owner_window

local tab_name = icons.tab_name

function M.available()
	return vim.env.TMUX ~= nil and vim.env.TMUX_PANE ~= nil and vim.fn.executable("tmux") == 1
end

local function command(args, raw)
	local argv = { "tmux" }
	vim.list_extend(argv, args)
	local result = vim.system(argv, { text = true }):wait(2000)
	if result.code ~= 0 then
		local message = vim.trim(result.stderr or "")
		return nil, message ~= "" and message or ("tmux exited with code " .. tostring(result.code))
	end
	return raw and (result.stdout or "") or vim.trim(result.stdout or "")
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
	local name = tab_name("Starting")
	local session = vim.env.PI_CONSOLE_TMUX_SESSION or "agents-dev"
	local target, err = command({ "new-window", "-d", "-P", "-F", "#{pane_id}\t#{pane_pid}", "-t", "=" .. session .. ":", "-n", name, "-c", cwd, shell_command })
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
		json.encode({
			version = 1,
			build = build_info.snapshot(),
			pid = tonumber(pid),
			updated = os.time(),
			path = path,
			title = path and vim.fn.fnamemodify(path, ":t") or "New Session",
			is_new_session = path == nil,
			cwd = cwd,
			status = "Starting",
			is_starting = true,
			activity = "Starting pi-console",
		}),
	})
	return M.focus(pane)
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

local tab_formats = { "window-status-format", "window-status-current-format" }

local function local_format(window, option_name)
	local output, err = command({ "show-options", "-wqv", "-t", window, option_name }, true)
	if not output then
		return nil, err
	end
	-- No output means inherited; a single newline means explicitly empty.
	return output ~= "" and output:gsub("\n$", "") or nil
end

local function global_format(option_name)
	local output, err = command({ "show-options", "-gqv", option_name }, true)
	return output and output:gsub("\n$", "") or nil, err
end

local function color_format(format, bold)
	local parts, pos, foreground, restore = {}, 1, "default", "#[default]"
	while pos <= #format do
		local pair = format:sub(pos, pos + 1)
		local token, finish
		if pair == "#[" then
			finish = format:find("]", pos + 2, true)
			if not finish then return nil end
			token = format:sub(pos, finish)
			if bold then
				-- Tmux's outer status-format already uses its single saved-default
				-- slot. Restore by replaying the original styles, not by nesting pushes.
				if token:find("push-default", 1, true) or token:find("pop-default", 1, true) then return nil end
				restore = restore .. token
			end
			if token:match("^#%[%s*default") or token:match("^#%[%s*none") then
				foreground = "default"
			end
			local fg = token:match("fg=([^,%]]+)")
			-- Simple literal colors and option lookups cover the bundled/default
			-- and Catppuccin formats. Leave complex style expressions untouched.
			if fg then
				if fg:find("#{", 1, true) and not fg:match("^#{[%w_@%-]+}$") then return nil end
				foreground = fg
			end
		elseif pair == "#{" then
			token = format:match("#%b{}", pos)
			if not token then return nil end
			finish = pos + #token - 1
		elseif pair == "#W" or pair == "##" then
			token, finish = pair, pos + 1
		else
			token, finish = format:sub(pos, pos), pos
		end
		-- Do not rewrite names inside conditionals, comparisons, or escaped ##W.
		if token == "#W" or token == "#{window_name}" then
			if bold then
				token = "#[fg=#{@pi_console_tab_color},bold]" .. token .. restore
			else
				token = "#[fg=#{@pi_console_tab_color}]" .. token .. "#[fg=" .. foreground .. "]"
			end
		end
		table.insert(parts, token)
		pos = finish + 1
	end
	return table.concat(parts)
end

local function style_tab(window, tab, status)
	tab.formats = tab.formats or {}
	for _, option_name in ipairs(tab_formats) do
		local current, err = local_format(window, option_name)
		if err then return nil, err end
		local saved = tab.formats[option_name]
		local inherited = current == nil or saved and current == saved.installed and saved.inherited
		local base = current
		if inherited then
			base, err = global_format(option_name)
		elseif saved and current == saved.installed then
			base = saved.base
		end
		if not base then return nil, err end
		local decorated = color_format(base, icons.get(status).bold)
		if decorated and decorated ~= base then
			if current ~= decorated then
				local ok
				ok, err = command({ "set-option", "-w", "-t", window, option_name, decorated })
				if not ok then return nil, err end
			end
			tab.formats[option_name] = { base = base, installed = decorated, inherited = inherited == true }
		else
			-- A new theme may use an unsupported expression. Release our old
			-- override instead of freezing the theme or rewriting its logic.
			if saved and current == saved.installed then
				local args = { "set-option", inherited and "-wu" or "-w", "-t", window, option_name }
				if not inherited then table.insert(args, base) end
				command(args)
			end
			tab.formats[option_name] = nil
		end
	end
	local color = icons.get(status).color
	if tab.color ~= color then
		local ok, err = command({ "set-option", "-w", "-t", window, "@pi_console_tab_color", color })
		if not ok then return nil, err end
		tab.color = color
	end
	return true
end

local function release_tab_style(window, tab)
	for option_name, saved in pairs(tab.formats or {}) do
		local current = local_format(window, option_name)
		if current == saved.installed then
			local args = { "set-option", saved.inherited and "-wu" or "-w", "-t", window, option_name }
			if not saved.inherited then table.insert(args, saved.base) end
			command(args)
		end
	end
	command({ "set-option", "-wu", "-t", window, "@pi_console_tab_color" })
end

local function release_tab(keep_managed)
	if not owner_window then
		return
	end
	local target = command({ "display-message", "-p", "-t", owner_window, "#{window_name}\t#{" .. tab_option .. "}" })
	local name, payload = (target or ""):match("^(.-)\t(.+)$")
	local tab = payload and json.decode_object(payload)
	if tab and tab.pane == owner_pane and tab.pid == vim.uv.os_getpid() then
		release_tab_style(owner_window, tab)
		-- Leave manual renames and replacement instances alone.
		if name == tab.name then
			local args = { "rename-window", "-t", owner_window, "pi" }
			if keep_managed then
				-- Keep the launcher marker so a frontend restart can reclaim this tab.
				vim.list_extend(args, { ";", "set-option", "-w", "-t", owner_window, tab_option,
					json.encode({ pane = owner_pane, name = "pi" }) })
			else
				vim.list_extend(args, { ";", "set-option", "-wu", "-t", owner_window, tab_option })
			end
			command(args)
		else
			command({ "set-option", "-wu", "-t", owner_window, tab_option })
		end
	end
	owner_window = nil
end

local function publish_tab(status)
	local target, err = command({ "display-message", "-p", "-t", owner_pane, "#{window_id}\t#{window_name}\t#{" .. tab_option .. "}" })
	if not target then
		return nil, err
	end
	local window, name, payload = target:match("^(@%d+)\t(.-)\t(.*)$")
	if owner_window and owner_window ~= window then
		-- Moving a pane must not leave its old tab decorated or claim its destination.
		release_tab()
	end
	local tab = payload and json.decode_object(payload)
	if not tab or tab.pane ~= owner_pane then
		return true
	end
	if name ~= tab.name then
		-- A user-supplied name permanently opts this window out of icon naming.
		release_tab_style(window, tab)
		owner_window = nil
		return command({ "set-option", "-wu", "-t", window, tab_option })
	end
	owner_window = window
	local previous = json.encode(tab)
	local styled, style_err = style_tab(window, tab, status)
	if not styled then return nil, style_err end
	local next_name = tab_name(status)
	tab.pane, tab.pid, tab.name = owner_pane, vim.uv.os_getpid(), next_name
	local payload_next = json.encode(tab)
	if name == next_name and payload_next == previous then
		return true
	end
	return command({
		"rename-window", "-t", window, next_name,
		";", "set-option", "-w", "-t", window, tab_option, payload_next,
	})
end

function M.publish(snapshot)
	owner_pane = owner_pane or vim.env.TMUX_PANE
	local published, err = command({ "set-option", "-p", "-t", owner_pane, option, json.encode(snapshot) })
	if not published then
		return nil, err
	end
	return publish_tab(snapshot.status)
end

function M.clear()
	if owner_pane then
		-- Do not remove a replacement instance's metadata during shutdown.
		local payload = command({ "show-options", "-pv", "-t", owner_pane, option })
		local entry = payload and json.decode_object(payload)
		if entry and entry.pid == vim.uv.os_getpid() then
			command({ "set-option", "-pu", "-t", owner_pane, option })
		end
		if not entry or entry.pid == vim.uv.os_getpid() then
			release_tab(true)
		else
			owner_window = nil
		end
		owner_pane = nil
	end
end

return M
