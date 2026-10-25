-- Window labels belong to the user; conversation state belongs to panes.
-- Every publisher can refresh a window. Compare-and-swap commits prevent peers
-- from overwriting each other's saved theme formats or manual window renames.
local json = require("pi-integration.utils.json")
local icons = require("pi-integration.status-icons")
local M = {}
local option = "@pi_console_tab"
local formats = { "window-status-format", "window-status-current-format" }
local hooks_installed = false

function M.install_hooks(run)
	if hooks_installed then return true end
	local socket, err = run({ "display-message", "-p", "#{socket_path}" })
	if not socket then return nil, err end
	local root = vim.fs.normalize(vim.fs.dirname(debug.getinfo(1, "S").source:sub(2)) .. "/../../../..")
	local command = table.concat(vim.tbl_map(vim.fn.shellescape,
		{ vim.v.progpath, "--headless", "-u", "NONE", "-i", "NONE", "-l", root .. "/tmux/scripts/refresh-tabs.lua", socket }), " ")
	local action = "run-shell -b " .. vim.fn.shellescape(command)
	-- A removed pane may no longer supply a target window to its after-hook.
	-- Scan marked windows only on process/pane removal, never on resize.
	local hook_command = "if-shell -F '#{!=:#{S:#{W:#{@pi_console_tab}}},}' " .. vim.fn.shellescape(action)
	local args = {}
	for _, hook in ipairs({ "pane-exited", "pane-died", "after-kill-pane" }) do
		vim.list_extend(args, { "set-hook", "-g", hook .. "[82]", hook_command, ";" })
	end
	table.remove(args)
	local installed, install_err = run(args)
	if not installed then return nil, install_err end
	hooks_installed = true
	return true
end

local function change(changes, args)
	table.insert(changes, table.concat(vim.tbl_map(vim.fn.shellescape, args), " "))
end

local function literal(value)
	return "#{l:" .. value:gsub("[#},]", "#%0") .. "}"
end

local function read_formats(window, run)
	local boundary = "pi-console-format-" .. vim.uv.hrtime()
	local args = {}
	for _, name in ipairs(formats) do
		vim.list_extend(args, {
			"show-options", "-wqv", "-t", window, name,
			";", "display-message", "-p", boundary,
			";", "show-options", "-gqv", name,
			";", "display-message", "-p", boundary, ";",
		})
	end
	table.remove(args)
	local output, err = run(args, true)
	if not output then return nil, err end
	local values = vim.split(output, boundary .. "\n", { plain = true })
	if #values ~= 5 then return nil, "Unexpected tmux status-format output" end
	local result = {}
	for index, name in ipairs(formats) do
		local current = values[index * 2 - 1]
		result[name] = {
			current = current ~= "" and current:gsub("\n$", "") or nil,
			global = values[index * 2]:gsub("\n$", ""),
		}
	end
	return result
end

local function decorate(format, statuses)
	local parts, pos, restore = {}, 1, "#[default]"
	while pos <= #format do
		local pair = format:sub(pos, pos + 1)
		local token, finish
		if pair == "#[" then
			finish = format:find("]", pos + 2, true)
			if not finish then return nil end
			token = format:sub(pos, finish)
			-- tmux has only one saved-default slot, already used by status-format.
			if token:find("push-default", 1, true) or token:find("pop-default", 1, true) then return nil end
			restore = restore .. token
		elseif pair == "#{" then
			token = format:match("#%b{}", pos)
			if not token then return nil end
			finish = pos + #token - 1
		elseif pair == "#W" or pair == "##" then
			token, finish = pair, pos + 1
		else
			token, finish = format:sub(pos, pos), pos
		end
		-- Leave conditional expressions and escaped names alone. Themes which
		-- already truncate their name keep that expression and its width.
		if token == "#W" or token == "#{window_name}" or token:match("^#{=[^:]+:window_name}$") then
			local name = token == "#W" or token == "#{window_name}"
			token = (name and "#{=40:window_name}" or token) .. " " .. statuses .. restore
		end
		table.insert(parts, token)
		pos = finish + 1
	end
	return table.concat(parts)
end

local function restore_formats(window, tab, current, changes)
	for name, saved in pairs(tab.formats or {}) do
		if current[name] and current[name].current == saved.installed then
			local args = { "set-option", saved.inherited and "-wu" or "-w", "-t", window, name }
			if not saved.inherited then table.insert(args, saved.base) end
			change(changes, args)
		end
	end
end

function M.refresh(window, run, attempt)
	local boundary = "pi-console-panes-" .. vim.uv.hrtime()
	local output, err = run({ "display-message", "-p", "-t", window,
		"#{version}\t#{window_name}\t#{automatic-rename}\t#{" .. option .. "}",
		";", "display-message", "-p", boundary,
		";", "list-panes", "-t", window, "-F", "#{pane_id}\t#{pane_dead}\t#{@pi_sidebar}\t#{@pi_console}" }, true)
	if not output then return nil, err end
	local sections = vim.split(output, boundary .. "\n", { plain = true })
	if #sections ~= 2 then return nil, "Unexpected tmux pane metadata" end
	local info, pane_output = sections[1]:gsub("\n$", ""), sections[2]
	local version, name, automatic, payload = info:match("^(.-)\t(.-)\t(.-)\t(.*)$")
	if not name then return nil, "Unexpected tmux window metadata" end
	local previous = json.decode_object(payload)
	local tab = previous and previous.version == 2 and vim.deepcopy(previous) or { version = 2, formats = {} }
	local entries, pane_count = {}, 0
	for line in pane_output:gmatch("[^\n]+") do
		local pane, dead, sidebar, value = line:match("^(%%%d+)\t(%d)\t(.-)\t(.*)$")
		if pane and sidebar ~= "1" then
			pane_count = pane_count + 1
			local entry = json.decode_object(value)
			if dead == "0" and entry and entry.version == 1 and type(entry.pid) == "number"
				and entry.pid > 0 and entry.pid == math.floor(entry.pid)
				and type(entry.status) == "string" and type(entry.title) == "string"
				and type(entry.updated) == "number" and vim.uv.kill(entry.pid, 0) then
				entry.pane = pane
				if os.time() - entry.updated > 10 then entry.status = "Unresponsive" end
				table.insert(entries, entry)
			end
		end
	end
	table.sort(entries, function(a, b) return tonumber(a.pane:sub(2)) < tonumber(b.pane:sub(2)) end)
	if #entries == 0 and not previous then return true end
	local current, format_err = read_formats(window, run)
	if not current then return nil, format_err end
	local changes = {}
	-- Upgrade launcher markers and old single-pane decorations without losing
	-- their saved theme. No existing custom window name is adopted here.
	if previous and previous.version ~= 2 then
		restore_formats(window, previous, current, changes)
		for key, saved in pairs(previous.formats or {}) do
			if current[key] and current[key].current == saved.installed then
				current[key].current = not saved.inherited and saved.base or nil
			end
		end
		change(changes, { "set-option", "-wu", "-t", window, "@pi_console_tab_color" })
		if name == previous.name then
			tab.managed_name, tab.name = true, name
			tab.original_name, tab.original_rename = "pi", "on"
		end
	end
	if tab.name and name ~= tab.name then tab.managed_name = false end
	if #entries == 0 then
		restore_formats(window, tab, current, changes)
		if tab.managed_name and name == tab.name then
			change(changes, { "rename-window", "-t", window, tab.original_name })
			change(changes, { "set-option", "-w", "-t", window, "automatic-rename", tab.original_rename })
		end
		if previous then change(changes, { "set-option", "-wu", "-t", window, option }) end
	else
		if tab.managed_name == nil and #entries == 1 and pane_count == 1 then
			tab.managed_name = automatic == "1" or automatic == "on"
			tab.original_name, tab.original_rename = name, automatic
		end
		if tab.managed_name and (automatic == "1" or automatic == "on") then
			change(changes, { "set-option", "-w", "-t", window, "automatic-rename", "off" })
		end
		if tab.managed_name and #entries == 1 and pane_count == 1 then
			local entry = entries[1]
			local label = type(entry.slug) == "string" and entry.slug ~= "" and entry.slug or entry.title
			local title = vim.trim(label:gsub("[%c]", " "))
			if title == "" then title = "New Session" end
			if name ~= title then change(changes, { "rename-window", "-t", window, title }) end
			tab.name = title
		end
		local major, minor = version:match("^(%d+)%.(%d+)")
		local native = major and (tonumber(major) > 3 or tonumber(major) == 3 and tonumber(minor) >= 8)
		local statuses = {}
		for _, entry in ipairs(entries) do
			local style = icons.get(entry.status)
			local icon = native and icons.tmux_animation(entry.status) or nil
			table.insert(statuses, "#[fg=" .. style.color .. (style.bold and ",bold" or ",nobold") .. "]"
				.. (icon or icons.tab_name(entry.status)))
		end
		for _, key in ipairs(formats) do
			local format, saved = current[key], tab.formats[key]
			local inherited = format.current == nil or saved and format.current == saved.installed and saved.inherited
			local base = inherited and format.global or saved and format.current == saved.installed and saved.base or format.current
			local status_text = table.concat(statuses, " ")
			local installed = decorate(base, status_text)
			if not installed or installed == base then
				-- A theme may hide its name inside a nested option/conditional.
				-- Keep that format intact and append rather than dropping icons.
				installed = base .. " " .. status_text .. "#[default]"
			end
			if format.current ~= installed then change(changes, { "set-option", "-w", "-t", window, key, installed }) end
			tab.formats[key] = { base = base, installed = installed, inherited = inherited == true }
		end
		if not vim.deep_equal(tab, previous) then
			change(changes, { "set-option", "-w", "-t", window, option, json.encode(tab) })
		end
	end
	if #changes == 0 then return true end
	local unchanged = "#{&&:#{==:#{window_name}," .. literal(name)
		.. "},#{==:#{" .. option .. "}," .. literal(payload) .. "}}"
	local result, commit_err = run({ "if-shell", "-F", "-t", window, unchanged,
		table.concat(changes, " ; ") .. " ; display-message -p pi-console-updated",
		"display-message -p pi-console-conflict" })
	if not result then return nil, commit_err end
	if result == "pi-console-conflict" then
		if (attempt or 0) >= 3 then return nil, "Window changed repeatedly during tab refresh" end
		return M.refresh(window, run, (attempt or 0) + 1)
	end
	return true
end

return M
