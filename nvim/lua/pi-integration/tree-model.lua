local M = {}

local function is_workspace_location(record)
	return record.type == "custom" and record.customType == "pi-workspace-location"
end

local function workspace_after(record, inherited)
	if not is_workspace_location(record) then
		return inherited
	end
	local data = type(record.data) == "table" and record.data or {}
	if type(data.workspaceId) ~= "string" or data.workspaceId == "" then
		return nil
	end
	return {
		id = data.workspaceId,
		label = data.label or data.workspaceId,
		cwd = data.cwd,
	}
end

local function boundary_kind(record)
	if record.type == "message" and record.message and record.message.role == "user" then
		return "user"
	elseif record.type == "branch_summary" then
		return "branch_summary"
	elseif record.type == "compaction" then
		return "compaction"
	elseif record.type == "custom_message"
		and record.customType ~= "workspace-continuation"
		and record.display ~= false
	then
		return "custom"
	elseif record.type == "model_change"
		or record.type == "thinking_level_change"
		or record.type == "label"
	then
		return "meta"
	end
	return nil
end

local function group_is_assistant_activity(raw_records)
	for _, raw in ipairs(raw_records) do
		local record = raw.record
		if record.type == "bashExecution" then
			return true
		end
		if record.type == "message" and record.message then
			local role = record.message.role
			if role == "assistant" or role == "toolResult" or role == "bashExecution" then
				return true
			end
		end
	end
	return false
end

local function add_display_node(model, parent, kind, raw_records)
	local records = {}
	for _, raw in ipairs(raw_records) do
		table.insert(records, raw.record)
	end
	local first = raw_records[1]
	local last = raw_records[#raw_records]
	local transition
	for _, raw in ipairs(raw_records) do
		if is_workspace_location(raw.record) then
			local data = type(raw.record.data) == "table" and raw.record.data or {}
			transition = {
				id = type(data.workspaceId) == "string" and data.workspaceId or nil,
				label = data.label or data.workspaceId or "Origin checkout",
				cwd = data.cwd,
			}
		end
	end
	local node = {
		kind = kind,
		record = first.record,
		records = records,
		start_id = first.record.id,
		target_id = last.record.id,
		workspace = last.workspace,
		transition = transition,
		parent = parent,
		children = {},
	}
	if parent then
		table.insert(parent.children, node)
	else
		table.insert(model.roots, node)
	end
	table.insert(model.nodes, node)
	for _, raw in ipairs(raw_records) do
		model.by_record_id[raw.record.id] = node
	end
	return node
end

local function is_cursor(raw)
	return raw.record.type == "custom" and raw.record.customType == "pi-workspace-cursor"
end

local function project_raw(model, raw, parent)
	local kind = boundary_kind(raw.record)
	if kind then
		local node = add_display_node(model, parent, kind, { raw })
		for _, child in ipairs(raw.children) do
			project_raw(model, child, node)
		end
		return
	end

	-- Pi stores a new assistant record after each tool round-trip. Collapse the
	-- non-branching records into one logical turn, but stop at real conversation forks.
	local grouped = { raw }
	local current = raw
	local next_children
	while true do
		local progression = {}
		local cursor_branches = {}
		for _, child in ipairs(current.children) do
			if is_cursor(child) then
				-- Cursors stay hidden, but still stop aggregation from following a
				-- sibling branch and representing that sibling as the active leaf.
				table.insert(cursor_branches, child)
			else
				table.insert(progression, child)
			end
		end
		if is_workspace_location(current.record) then
			next_children = {}
			vim.list_extend(next_children, progression)
			vim.list_extend(next_children, cursor_branches)
			table.sort(next_children, function(left, right)
				return left.order < right.order
			end)
			break
		elseif #cursor_branches == 0 and #progression == 1 and not boundary_kind(progression[1].record) then
			current = progression[1]
			table.insert(grouped, current)
		else
			next_children = {}
			vim.list_extend(next_children, progression)
			vim.list_extend(next_children, cursor_branches)
			table.sort(next_children, function(left, right)
				return left.order < right.order
			end)
			break
		end
	end

	local next_parent = parent
	if group_is_assistant_activity(grouped) then
		next_parent = add_display_node(model, parent, "assistant", grouped)
	elseif is_workspace_location(current.record) then
		next_parent = add_display_node(model, parent, "location", grouped)
	end
	for _, child in ipairs(next_children) do
		project_raw(model, child, next_parent)
	end
end

function M.build(records)
	local model = {
		roots = {},
		nodes = {},
		by_record_id = {},
		raw_by_id = {},
		last_id = nil,
	}
	local raw_records = {}
	for index, record in ipairs(records or {}) do
		if record and record.id then
			local raw = { record = record, children = {}, order = index }
			model.raw_by_id[record.id] = raw
			model.last_id = record.id
			table.insert(raw_records, raw)
		end
	end

	local raw_roots = {}
	for _, raw in ipairs(raw_records) do
		local parent = raw.record.parentId and model.raw_by_id[raw.record.parentId] or nil
		if parent then
			raw.parent = parent
			table.insert(parent.children, raw)
		else
			table.insert(raw_roots, raw)
		end
	end

	local function assign_workspace(raw, inherited)
		raw.workspace = workspace_after(raw.record, inherited)
		for _, child in ipairs(raw.children) do
			assign_workspace(child, raw.workspace)
		end
	end
	for _, root in ipairs(raw_roots) do
		assign_workspace(root, nil)
		project_raw(model, root, nil)
	end
	return model
end

function M.node_for_record(model, id)
	local raw = id and model.raw_by_id[id] or nil
	while raw do
		local node = model.by_record_id[raw.record.id]
		if node then
			return node
		end
		raw = raw.parent
	end
	return nil
end

local function assistant_content_text(message)
	if type(message) ~= "table" then
		return ""
	end
	if type(message.content) == "string" then
		return message.content
	end
	if type(message.content) ~= "table" then
		return ""
	end
	local chunks = {}
	for _, item in ipairs(message.content) do
		if type(item) == "string" then
			table.insert(chunks, item)
		elseif type(item) == "table" and item.type == "text" and type(item.text) == "string" then
			table.insert(chunks, item.text)
		end
	end
	return table.concat(chunks, "")
end

local function tool_names(node)
	local names = {}
	local seen = {}
	local function add(name)
		if type(name) == "string" and name ~= "" and not seen[name] then
			seen[name] = true
			table.insert(names, name)
		end
	end
	for _, record in ipairs(node.records) do
		if record.type == "message" and record.message then
			if record.message.role == "toolResult" then
				add(record.message.toolName)
			end
			if type(record.message.content) == "table" then
				for _, item in ipairs(record.message.content) do
					if type(item) == "table" and (item.type == "toolCall" or item.type == "tool_call") then
						add(item.name or item.toolName or item.tool_name)
					end
				end
			end
		elseif record.type == "bashExecution" then
			add("bash")
		end
	end
	return names
end

function M.node_text(node, extract_text)
	if node.kind == "assistant" then
		local chunks = {}
		for _, record in ipairs(node.records) do
			if record.type == "message" and record.message and record.message.role == "assistant" then
				local text = assistant_content_text(record.message)
				if text ~= "" then
					table.insert(chunks, text)
				end
			end
		end
		if #chunks > 0 then
			return table.concat(chunks, "\n\n")
		end
		local names = tool_names(node)
		if #names > 0 then
			return "(tool activity: " .. table.concat(names, ", ") .. ")"
		end
		return "(workspace activity)"
	end

	local record = node.record
	if record.type == "message" and record.message then
		return extract_text(record.message) or ""
	elseif record.type == "branch_summary" or record.type == "compaction" then
		return record.summary or record.type
	elseif record.type == "custom_message" then
		return extract_text(record) or record.content or "custom message"
	elseif is_workspace_location(record) then
		local data = type(record.data) == "table" and record.data or {}
		local label = data.label or data.workspaceId or "Origin checkout"
		return label .. (type(data.cwd) == "string" and (" · " .. data.cwd) or "")
	elseif record.type == "model_change" then
		return table.concat(vim.tbl_filter(function(part)
			return part and part ~= ""
		end, { record.provider, record.modelId }), "/")
	elseif record.type == "thinking_level_change" then
		return record.thinkingLevel or "thinking level changed"
	elseif record.type == "label" then
		return record.label or "label cleared"
	end
	return ""
end

function M.node_title(node)
	if node.kind == "user" then
		return "User"
	elseif node.kind == "assistant" then
		return "Assistant"
	elseif node.kind == "branch_summary" then
		return "Branch summary"
	elseif node.kind == "compaction" then
		return "Compaction"
	elseif node.kind == "custom" then
		return "Custom"
	elseif node.kind == "location" then
		return "→ Workspace"
	elseif node.kind == "meta" then
		local record = node.record
		if record.type == "model_change" then
			return "Model"
		elseif record.type == "thinking_level_change" then
			return "Thinking"
		elseif record.type == "label" then
			return "Label"
		end
	end
	return "Entry"
end

function M.node_visible(node, mode)
	mode = mode or "default"
	if mode == "user-only" then
		return node.kind == "user"
	end
	if node.kind == "meta" then
		return mode == "all"
	end
	return true
end

return M
