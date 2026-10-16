local json = require("pi-integration.utils.json")
local icons = require("pi-integration.status-icons")
local build_info = require("pi-integration.build-info")
local M = {}
local option = "@pi_console"
local tab_option = "@pi_console_tab"
local owner_pane
local owner_window
local publication
local native_animation

local tab_name = icons.tab_name

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

local function read_formats(window, run)
	-- Delimit raw results: no output means inherited, while a newline means
	-- explicitly empty. A per-query boundary also permits multiline formats.
	local boundary = "pi-console-format-" .. vim.uv.hrtime()
	local args = {}
	for _, name in ipairs(tab_formats) do
		vim.list_extend(args, {
			"show-options", "-wqv", "-t", window, name,
			";", "display-message", "-p", boundary,
			";", "show-options", "-gqv", name,
			";", "display-message", "-p", boundary, ";",
		})
	end
	table.remove(args) -- no trailing command separator
	local output, err = run(args, true)
	if not output then return nil, err end
	local values = vim.split(output, boundary .. "\n", { plain = true })
	if #values ~= 5 then return nil, "Unexpected tmux status-format output" end
	local formats = {}
	for index, name in ipairs(tab_formats) do
		local current = values[index * 2 - 1]
		formats[name] = {
			current = current ~= "" and current:gsub("\n$", "") or nil,
			global = values[index * 2]:gsub("\n$", ""),
		}
	end
	return formats
end

local function color_format(format, bold, animation)
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
			token = animation or token
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

local function change(changes, args)
	table.insert(changes, table.concat(vim.tbl_map(vim.fn.shellescape, args), " "))
end

local function commit_tab(window, name, payload, changes, run)
	-- Reads yield to other clients. Commit tab writes together only if the
	-- observed name and ownership marker are still current. Literal values
	-- must escape tmux format delimiters, including those inside saved JSON.
	local unchanged = "#{&&:#{==:#{window_name},#{l:" .. name:gsub("[#},]", "#%0")
		.. "}},#{==:#{" .. tab_option .. "},#{l:" .. payload:gsub("[#},]", "#%0") .. "}}}"
	return run({ "if-shell", "-F", "-t", window, unchanged, table.concat(changes, " ; ") })
end

local function style_tab(window, tab, status, run, changes)
	local formats, err = read_formats(window, run)
	if not formats then return nil, err end
	tab.formats = tab.formats or {}
	local animation = native_animation and icons.tmux_animation(status) or nil
	local bold = icons.get(status).bold
	for _, option_name in ipairs(tab_formats) do
		local format = formats[option_name]
		local current, saved = format.current, tab.formats[option_name]
		format.inherited = current == nil or saved and current == saved.installed and saved.inherited
		format.base = format.inherited and format.global or saved and current == saved.installed and saved.base or current
		-- If either theme format cannot host the animation, keep frame-based
		-- window names so the active or inactive tab cannot freeze its icon.
		if animation then
			local decorated = color_format(format.base, bold, animation)
			if not decorated or decorated == format.base then animation = nil end
		end
	end
	for _, option_name in ipairs(tab_formats) do
		local format, saved = formats[option_name], tab.formats[option_name]
		local current, base = format.current, format.base
		local decorated = color_format(base, bold, animation)
		if decorated and decorated ~= base then
			if current ~= decorated then
				change(changes, { "set-option", "-w", "-t", window, option_name, decorated })
			end
			tab.formats[option_name] = { base = base, installed = decorated, inherited = format.inherited == true }
		else
			-- Release our override if a new theme uses an unsupported expression.
			if saved and current == saved.installed then
				local args = { "set-option", format.inherited and "-wu" or "-w", "-t", window, option_name }
				if not format.inherited then table.insert(args, base) end
				change(changes, args)
			end
			tab.formats[option_name] = nil
		end
	end
	local color = icons.get(status).color
	if tab.color ~= color then
		change(changes, { "set-option", "-w", "-t", window, "@pi_console_tab_color", color })
		tab.color = color
	end
	return true, nil, animation ~= nil
end

local function release_tab_style(window, tab, run, changes)
	local formats, err = read_formats(window, run)
	if not formats then return nil, err end
	for option_name, saved in pairs(tab.formats or {}) do
		local current = formats[option_name] and formats[option_name].current
		if current == saved.installed then
			local args = { "set-option", saved.inherited and "-wu" or "-w", "-t", window, option_name }
			if not saved.inherited then table.insert(args, saved.base) end
			change(changes, args)
		end
	end
	change(changes, { "set-option", "-wu", "-t", window, "@pi_console_tab_color" })
	return true
end

local function release_tab(keep_managed, run)
	run = run or command
	if not owner_window then
		return
	end
	local target = run({ "display-message", "-p", "-t", owner_window, "#{window_name}\t#{" .. tab_option .. "}" })
	local name, payload = (target or ""):match("^(.-)\t(.+)$")
	local tab = payload and json.decode_object(payload)
	if tab and tab.pane == owner_pane and tab.pid == vim.uv.os_getpid() then
		local changes = {}
		local released, err = release_tab_style(owner_window, tab, run, changes)
		if not released then return nil, err end
		-- Leave manual renames and replacement instances alone.
		if name == tab.name then
			change(changes, { "rename-window", "-t", owner_window, "pi" })
		end
		if name == tab.name and keep_managed then
			-- Keep the launcher marker so a frontend restart can reclaim this tab.
			change(changes, { "set-option", "-w", "-t", owner_window, tab_option,
				json.encode({ pane = owner_pane, name = "pi" }) })
		else
			change(changes, { "set-option", "-wu", "-t", owner_window, tab_option })
		end
		commit_tab(owner_window, name, payload, changes, run)
	end
	owner_window = nil
end

local function publish_tab(snapshot, run)
	-- Publish the heartbeat and read the tab in one tmux invocation.
	local target, err = run({
		"set-option", "-p", "-t", owner_pane, option, json.encode(snapshot),
		";", "display-message", "-p", "-t", owner_pane, "#{version}\t#{window_id}\t#{window_name}\t#{" .. tab_option .. "}",
	})
	if not target then
		return nil, err
	end
	local version, window, name, payload = target:match("^(.-)\t(@%d+)\t(.-)\t(.*)$")
	if native_animation == nil then
		local major, minor = (version or ""):match("^(%d+)%.(%d+)")
		native_animation = major ~= nil and (tonumber(major) > 3 or tonumber(major) == 3 and tonumber(minor) >= 8)
	end
	if owner_window and owner_window ~= window then
		-- Moving a pane must not leave its old tab decorated or claim its destination.
		release_tab(false, run)
	end
	local tab = payload and json.decode_object(payload)
	if not tab or tab.pane ~= owner_pane then
		return true
	end
	if name ~= tab.name then
		-- A user-supplied name permanently opts this window out of icon naming.
		local changes = {}
		local released, err = release_tab_style(window, tab, run, changes)
		if not released then return nil, err end
		change(changes, { "set-option", "-wu", "-t", window, tab_option })
		owner_window = nil
		return commit_tab(window, name, payload, changes, run)
	end
	owner_window = window
	local previous = vim.deepcopy(tab)
	local changes = {}
	local styled, style_err, animated = style_tab(window, tab, snapshot.status, run, changes)
	if not styled then return nil, style_err end
	local next_name = tab_name(snapshot.status, animated)
	tab.pane, tab.pid, tab.name = owner_pane, vim.uv.os_getpid(), next_name
	if #changes == 0 and name == next_name and vim.deep_equal(tab, previous) then
		return true
	end
	local payload_next = json.encode(tab)
	change(changes, { "rename-window", "-t", window, next_name })
	change(changes, { "set-option", "-w", "-t", window, tab_option, payload_next })
	return commit_tab(window, name, payload, changes, run)
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
		if not entry or entry.pid == vim.uv.os_getpid() then
			release_tab(true)
		else
			owner_window = nil
		end
		owner_pane = nil
	end
end

return M
