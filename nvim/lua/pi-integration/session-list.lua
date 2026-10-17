-- Organization and interaction semantics shared by the overview and sidebar.
local runtime = require("pi-integration.runtime")
local pins = require("pi-integration.session-pins")
local organization = require("pi-integration.session-organization")
local icons = require("pi-integration.status-icons")
local M = {}

function M.text(value)
	return type(value) == "string" and value:gsub("[%c]", " ") or ""
end

function M.same(left, right)
	if not left or not right then return false end
	if left.key == right.key then return true end
	if left.kind == "session" and right.kind == "session" then
		local a, b = left.entry, right.entry
		return a.id == b.id or a.path ~= nil and runtime.canonical_path(a.path) == runtime.canonical_path(b.path)
	end
	return false
end

local summary_order = { "Working", "Waiting", "Idle", "Done", "Loading", "Compacting", "Error", "Not Open" }
local summary_status = { Retrying = "Working", Starting = "Loading", Stopped = "Error", Unresponsive = "Error" }

function M.group_summary(node)
	local counts, parts = {}, {}
	for _, entry in ipairs(node.entries) do
		local status = summary_status[entry.status] or entry.status
		counts[status] = (counts[status] or 0) + 1
	end
	for _, status in ipairs(summary_order) do
		if counts[status] then table.insert(parts, icons.get(status).icon .. " " .. counts[status]) end
	end
	return parts
end

function M.group_label(node, compact)
	local label = " " .. (node.collapsed and "▸ " or "▾ ") .. node.name
	if #node.entries == 0 then return label .. " (empty)" end
	label = label .. " (" .. #node.entries .. ")"
	if node.collapsed and not compact then label = label .. " · " .. table.concat(M.group_summary(node), " · ") end
	return label
end

function M.session_prefix(node)
	local pin = node.entry.pinned and " " or "  "
	local arrow = node.running > 0 and (node.expanded and "▾ " or "▸ ") or "  "
	return pin .. arrow
end

function M.session_suffix(node)
	return node.running > 0 and not node.expanded and (" · " .. icons.subagent_icon .. " " .. node.running) or ""
end

function M.subagent_label(node)
	local run = node.run
	local name = M.text(run.agent)
	if name == "" then name = M.text(run.role) end
	if name == "" then name = "Subagent" end
	local progress = M.text(run.progress)
	return "       " .. icons.subagent_icon .. " " .. name .. " · running" .. (progress ~= "" and (" — " .. progress) or "")
end

function M.new()
	local list = {}
	local collapsed, expanded = {}, {}

	function list.build(instances, query, reveal)
		local entries, err = pins.merge(instances)
		if not entries then return nil, err end
		local sections
		sections, err = organization.sections(entries)
		if not sections then return nil, err end
		local nodes = {}
		query = (query or ""):lower()
		for _, section in ipairs(sections) do
			local matching = {}
			for _, entry in ipairs(section.entries) do
				local searchable = table.concat({
					M.text(entry.title), M.text(entry.project), M.text(entry.directory),
					M.text(entry.cwd), M.text(entry.workspace_id), M.text(entry.status), section.name,
				}, " "):lower()
				if query == "" or searchable:find(query, 1, true) then table.insert(matching, entry) end
				if reveal and (entry.id == reveal.id or reveal.path and runtime.canonical_path(entry.path) == runtime.canonical_path(reveal.path)) then
					collapsed[section.id] = false
				end
			end
			if query == "" or #matching > 0 then
				local group = {
					kind = "group", key = "group:" .. section.id, id = section.id, name = section.name,
					entries = matching, count = section.count, collapsed = collapsed[section.id] == true,
				}
				table.insert(nodes, group)
				if not group.collapsed then
					for _, entry in ipairs(matching) do
						local running = {}
						-- Old publishers provide only the count; current ones also provide rows.
						for _, run in ipairs(type(entry.subagent_runs) == "table" and entry.subagent_runs or {}) do
							if type(run) == "table" and run.status == "running" then table.insert(running, run) end
						end
						local node = {
							kind = "session", key = entry.organization_key, entry = entry,
							group_id = section.id, neighbors = matching,
							running = math.max(#running, tonumber(entry.subagents) or 0),
							expanded = #running > 0 and expanded[entry.organization_key] == true,
						}
						table.insert(nodes, node)
						if node.expanded then
							for _, run in ipairs(running) do table.insert(nodes, { kind = "subagent", run = run }) end
						end
					end
				end
			end
		end
		return nodes, entries
	end

	function list.bind(map, selected, navigation, config, report, refresh)
		local function session()
			local node = selected()
			return node and node.kind == "session" and node.entry or nil
		end
		local function toggle()
			local node = selected()
			if not node then return end
			if node.kind == "group" then
				collapsed[node.id] = not node.collapsed
			elseif node.kind == "session" and node.running > 0 then
				expanded[node.key] = not node.expanded
			end
			refresh()
		end
		map("j", function() navigation.move(vim.v.count1) end, "Next group or session")
		map("k", function() navigation.move(-vim.v.count1) end, "Previous group or session")
		map("<Down>", function() navigation.move(vim.v.count1) end, "Next group or session")
		map("<Up>", function() navigation.move(-vim.v.count1) end, "Previous group or session")
		map("<Tab>", toggle, "Expand/collapse group or subagents")
		map("<CR>", function()
			local node = selected()
			if node and node.kind == "group" then return toggle() end
			local entry = session()
			if not entry then return end
			if entry.status == "Not Open" then
				report(runtime.launch(config.launcher, entry.cwd, entry.path))
			else
				report(runtime.focus(entry.id))
			end
		end, "Focus/reopen session or toggle group")
		map("p", function()
			local entry = session()
			if entry then report(pins.toggle(entry)) end
		end, "Toggle session pin")
		for key, delta in pairs({ J = 1, K = -1 }) do
			map(key, function()
				local node = selected()
				if node then report(organization.move(node, delta * vim.v.count1)) end
			end, delta == 1 and "Move group/session down" or "Move group/session up")
		end
		map("g", function()
			local entry = session()
			local function create()
				vim.ui.input({ prompt = "New group: " }, function(name)
					if name then report(organization.create(name, entry)) end
				end)
			end
			if not entry then return create() end
			local choices = { { id = "", name = "Ungrouped" } }
			-- Read again: another viewer may have added/deleted a group since rendering.
			local current, err = organization.sections({})
			if not current then return report(nil, err) end
			for _, section in ipairs(current) do
				if section.id ~= "" then table.insert(choices, section) end
			end
			table.insert(choices, { name = "+ New group…", create = true })
			vim.ui.select(choices, { prompt = "Assign session to group", format_item = function(choice) return choice.name end, pi_select_layout = "compact" }, function(choice)
				if not choice then return end
				if choice.create then create() else report(organization.assign(entry, choice.id)) end
			end)
		end, "Assign session to group / create group")
		map("dd", function()
			local node = selected()
			if not node then return end
			if node.kind == "group" then
				if node.id == "" then return report(nil, "Ungrouped cannot be deleted") end
				-- Include hidden closed sessions and changes from other viewers.
				local current, err = organization.sections({})
				if not current then return report(nil, err) end
				local group
				for _, section in ipairs(current) do if section.id == node.id then group = section end end
				if not group then return report(nil, "That group no longer exists") end
				if group.count == 0 then return report(organization.delete(node.id)) end
				vim.ui.select({ "Yes", "No" }, { prompt = "Delete group '" .. group.name .. "' and move its " .. group.count .. " sessions to Ungrouped?", pi_select_layout = "compact" }, function(choice)
					if choice == "Yes" then report(organization.delete(node.id, true)) end
				end)
				return
			end
			local entry = session()
			if not entry then return end
			local entries, err = runtime.list()
			if not entries then return report(nil, err) end
			local current
			for _, candidate in ipairs(entries) do
				if candidate.id == entry.id and candidate.pid == entry.pid then current = candidate; break end
			end
			if not current then return report(nil, "That conversation is no longer open") end
			if runtime.kill_needs_confirmation(current) then
				vim.ui.select({ "Yes", "No" }, { prompt = "Kill running conversation " .. M.text(current.title) .. " and close its window?", pi_select_layout = "compact" }, function(choice)
					if choice == "Yes" then report(runtime.kill(current, true)) end
				end)
			else
				report(runtime.kill(current, false))
			end
		end, "Kill session / delete group (keep sessions)")
	end

	return list
end

return M
