local floats = require("pi-integration.floats")
local help = require("pi-integration.help")
local list_cursor = require("pi-integration.list-cursor")
local guard = require("pi-integration.utils.guard")
local json = require("pi-integration.utils.json")
local time_utils = require("pi-integration.utils.time")
local tree_model = require("pi-integration.tree-model")

local M = {}

local tree_preview_augroup = vim.api.nvim_create_augroup("PiNvimTreePreview", { clear = true })
local tree_highlight_ns = vim.api.nvim_create_namespace("pi-console-tree-highlights")
local search_highlight_ns = vim.api.nvim_create_namespace("pi-console-tree-search")
local workspace_highlight_count = 14

local function decode_record(line)
	return json.decode_object(line)
end

local function node_text(ctx, node)
	return tree_model.node_text(node, ctx.messages.extract_text)
end

local function node_title(node)
	return tree_model.node_title(node)
end

local function node_visible(ctx, node)
	if not tree_model.node_visible(node, ctx.state.tree_filter_mode) then
		return false
	end
	if node.kind == "location" then
		return true
	end
	local configured = ctx.config.tree_entry_types
	if not configured then
		return true
	end
	if node.kind == "user" or node.kind == "assistant" then
		return configured.message == true
	end
	return configured[node.record.type] == true
end

local function cycle_filter_mode(ctx)
	local modes = ctx.config.tree_filter_modes or { "default", "user-only", "all" }
	local current = ctx.state.tree_filter_mode or modes[1]
	for index, mode in ipairs(modes) do
		if mode == current then
			ctx.state.tree_filter_mode = modes[(index % #modes) + 1]
			return ctx.state.tree_filter_mode
		end
	end
	ctx.state.tree_filter_mode = modes[1]
	return ctx.state.tree_filter_mode
end

local function display_width(text)
	return vim.fn.strdisplaywidth(tostring(text or ""))
end

local function truncate_display(text, max_width)
	text = tostring(text or "")
	if not max_width or max_width <= 0 then
		return ""
	end
	if display_width(text) <= max_width then
		return text
	end

	local suffix = max_width >= 3 and "..." or string.rep(".", max_width)
	local target_width = max_width - display_width(suffix)
	if target_width <= 0 then
		return suffix
	end

	local low = 0
	local high = vim.fn.strcharlen(text)
	while low < high do
		local mid = math.ceil((low + high) / 2)
		if display_width(vim.fn.strcharpart(text, 0, mid)) <= target_width then
			low = mid
		else
			high = mid - 1
		end
	end
	return vim.fn.strcharpart(text, 0, low) .. suffix
end

local function compact_text(text, max_width)
	text = tostring(text or ""):gsub("%s+", " ")
	text = vim.trim(text)
	if text == "" then
		text = "(no text)"
	end
	return truncate_display(text, max_width or 96)
end

local function read_session_tree(ctx, path)
	local records = ctx.state.tree_records
	if not ctx.tree then
		if not path or vim.fn.filereadable(path) ~= 1 then return {}, nil end
		records = {}
		for _, line in ipairs(vim.fn.readfile(path)) do
			local record = decode_record(line)
			if record then table.insert(records, record) end
		end
	end
	local model = tree_model.build(records or {})
	local requested_leaf = ctx.state.tree_leaf_id
	if not ctx.tree and requested_leaf == nil then requested_leaf = model.last_id end
	local active_ids = {}
	local raw = model.raw_by_id[requested_leaf]
	while raw do
		active_ids[raw.record.id] = true
		raw = raw.parent
	end
	local query = ctx.state.tree_search_query or ""
	local included = {}
	local matches = {}
	for _, node in ipairs(model.nodes) do
		local in_scope = ctx.state.tree_scope ~= "branch" or active_ids[node.start_id]
		if in_scope and node_visible(ctx, node) then
			if query == "" then
				included[node] = true
			elseif node.kind == "user" or node.kind == "assistant" then
				local positions = tree_model.match_positions(node_text(ctx, node), query)
				if #positions > 0 then
					matches[node] = positions
					local ancestor = node
					while ancestor do
						included[ancestor] = true
						ancestor = ancestor.parent
					end
				end
			end
		end
	end
	local visible = {}
	local visible_by_node = {}
	for _, node in ipairs(model.nodes) do
		if included[node] and node_visible(ctx, node) then
			local view = {
				kind = node.kind,
				record = node.record,
				records = node.records,
				start_id = node.start_id,
				target_id = node.target_id,
				workspace = node.workspace,
				transition = node.transition,
				model_node = node,
				match_positions = matches[node],
				search_context = query ~= "" and not matches[node],
				children = {},
			}
			visible_by_node[node] = view
			table.insert(visible, view)
		end
	end

	local roots = {}
	for _, node in ipairs(visible) do
		local parent = node.model_node.parent
		while parent and not visible_by_node[parent] do
			parent = parent.parent
		end
		local parent_view = parent and visible_by_node[parent] or nil
		if parent_view then
			node.parent = parent_view
			table.insert(parent_view.children, node)
		else
			table.insert(roots, node)
		end
	end

	local leaf_node = tree_model.node_for_record(model, requested_leaf)
	while leaf_node and not visible_by_node[leaf_node] do
		leaf_node = leaf_node.parent
	end
	local leaf_view = leaf_node and visible_by_node[leaf_node] or nil
	local focus_view = leaf_view
	while focus_view and focus_view.kind ~= "user" and focus_view.kind ~= "assistant" do
		focus_view = focus_view.parent
	end
	return roots, leaf_view and leaf_view.target_id or nil, focus_view and focus_view.target_id or nil
end

local function node_title_highlight(node)
	if node.kind == "user" then
		return "PiTreeUser"
	elseif node.kind == "assistant" then
		return "PiTreeAssistant"
	elseif node.kind == "custom" then
		return "PiTreeCustom"
	end
	return "PiTreeMeta"
end

local function win_valid(win)
	return win and vim.api.nvim_win_is_valid(win)
end

local function tree_window_width(ctx)
	local state = ctx.state
	if win_valid(state.tree_win) then
		return vim.api.nvim_win_get_width(state.tree_win)
	end
	return state.tree_width or math.min(math.max(72, math.floor(vim.o.columns * 0.82)), vim.o.columns - 4)
end

local function workspace_hash(workspace)
	local label = type(workspace) == "table" and workspace.label or nil
	return type(label) == "string" and label:match("([%x]+)$") or nil
end

local function workspace_color_seed(workspace)
	local id = type(workspace.id) == "string" and workspace.id or tostring(workspace.label or "")
	local suffix = id:match("([%x]+)$")
	local numeric = suffix and tonumber(suffix:sub(-8), 16) or nil
	if numeric then
		return numeric
	end
	local seed = 0
	for index = 1, #id do
		seed = (seed * 31 + id:byte(index)) % 2147483647
	end
	return seed
end

local function workspace_highlight(ctx, workspace)
	local id = type(workspace.id) == "string" and workspace.id or workspace.label
	if type(id) ~= "string" or id == "" then
		return nil
	end

	local state = ctx.state
	local assigned = state.tree_workspace_highlights
	local occupied = state.tree_workspace_highlight_slots
	if assigned[id] then
		return assigned[id]
	end

	local first = (workspace_color_seed(workspace) % workspace_highlight_count) + 1
	for offset = 0, workspace_highlight_count - 1 do
		local slot = ((first + offset - 1) % workspace_highlight_count) + 1
		if not occupied[slot] then
			local group = "PiTreeWorkspace" .. slot
			occupied[slot] = id
			assigned[id] = group
			return group
		end
	end

	return "PiTreeWorkspace" .. first
end

local function render_node_line(ctx, node, leaf_id, lines, line_nodes, highlights_by_line, line_prefix)
	local current = node.target_id == leaf_id
	local marker = current and "●" or "○"
	local title = node_title(node)
	local workspace = ""
	local workspace_data
	if node.kind ~= "location" and node.transition then
		workspace_data = node.transition
		workspace = " [→ " .. node.transition.label .. "]"
	elseif node.workspace then
		workspace_data = node.workspace
		workspace = " [" .. node.workspace.label .. "]"
	end
	local label_prefix = string.format("%s%s %s  ", line_prefix, marker, node.target_id)
	local heading = label_prefix .. title .. workspace .. ": "
	local suffix = current and "  ← current" or ""
	local max_width = math.max(1, tree_window_width(ctx) - 1)
	local text_width = max_width - display_width(heading) - display_width(suffix)
	local text = node_text(ctx, node)
	if node.match_positions then
		-- Begin near the first match, even when the matching text is far beyond the summary.
		local first = vim.fn.charidx(text, node.match_positions[1])
		local start = math.max(0, first - 16)
		text = (start > 0 and "… " or "") .. vim.fn.strcharpart(text, start)
	end
	local label = heading .. compact_text(text, text_width) .. suffix
	label = truncate_display(label, max_width)
	table.insert(lines, label)
	line_nodes[#lines] = node
	local highlights = {
		{
			start_col = #label_prefix,
			end_col = #label_prefix + #title,
			hl_group = node_title_highlight(node),
		},
	}
	local hash = workspace_hash(workspace_data)
	local hash_offset = hash and workspace:find(hash, 1, true) or nil
	if hash_offset then
		local start_col = #label_prefix + #title + hash_offset - 1
		local end_col = start_col + #hash
		if end_col <= #label then
			table.insert(highlights, {
				start_col = start_col,
				end_col = end_col,
				hl_group = workspace_highlight(ctx, workspace_data),
			})
		end
	end
	if node.search_context then
		highlights = { { start_col = 0, end_col = #label, hl_group = "Comment" } }
	end
	highlights_by_line[#lines] = highlights
end

local function render_node(ctx, node, leaf_id, lines, line_nodes, highlights_by_line, line_prefix, child_prefix)
	render_node_line(ctx, node, leaf_id, lines, line_nodes, highlights_by_line, line_prefix)

	local child_count = #node.children
	if child_count == 0 then
		return
	end

	if child_count == 1 then
		-- Most session history is a single parent→child chain. Keep that
		-- continuation visually flat so long conversations do not drift right.
		render_node(ctx, node.children[1], leaf_id, lines, line_nodes, highlights_by_line, child_prefix, child_prefix)
		return
	end

	-- Only spend horizontal space when there is an actual branch.
	for index, child in ipairs(node.children) do
		local is_last = index == child_count
		local connector = is_last and "└─ " or "├─ "
		local next_child_prefix = child_prefix .. (is_last and "   " or "│  ")
		render_node(ctx, child, leaf_id, lines, line_nodes, highlights_by_line, child_prefix .. connector, next_child_prefix)
	end
end

local function render_nodes(ctx, nodes, leaf_id, lines, line_nodes, highlights_by_line)
	if #nodes == 1 then
		render_node(ctx, nodes[1], leaf_id, lines, line_nodes, highlights_by_line, "", "")
		return
	end
	-- Hidden session metadata can be the common ancestor of every visible branch.
	-- Draw top-level siblings as a fork instead of presenting them as unrelated roots.
	for index, node in ipairs(nodes) do
		local is_last = index == #nodes
		local connector = is_last and "└─ " or "├─ "
		local child_prefix = is_last and "   " or "│  "
		render_node(ctx, node, leaf_id, lines, line_nodes, highlights_by_line, connector, child_prefix)
	end
end

local function apply_tree_highlights(ctx)
	local state = ctx.state
	if not ctx.buffer.valid(state.tree_buf) then
		return
	end

	vim.api.nvim_buf_clear_namespace(state.tree_buf, tree_highlight_ns, 0, -1)
	for line, highlights in pairs(state.tree_highlights_by_line or {}) do
		for _, highlight in ipairs(highlights) do
			vim.api.nvim_buf_set_extmark(state.tree_buf, tree_highlight_ns, line - 1, highlight.start_col, {
				end_col = highlight.end_col,
				hl_group = highlight.hl_group,
				priority = highlight.priority or 250,
			})
		end
	end
end

local function focus_input_window(ctx)
	local state = ctx.state
	state.input_win = require("pi-integration.utils.buffer").find_window(state.input_buf, state.input_win)
	if state.input_win then
		vim.api.nvim_set_current_win(state.input_win)
	end
end

local function close_tree_window(ctx, preserve_data)
	local state = ctx.state
	if ctx.tree and not preserve_data then
		state.tree_request = (state.tree_request or 0) + 1
		state.tree_records, state.tree_context, state.tree_leaf_id = nil, nil, nil
	end
	floats.close_descendants(state.tree_win)
	floats.close_window(state.tree_win)
	floats.close_window(state.tree_preview_win)
	state.tree_win = nil
	state.tree_preview_win = nil
	if ctx.tree and not preserve_data then
		for _, buf in ipairs({ state.tree_buf, state.tree_preview_buf }) do
			if vim.api.nvim_buf_is_valid(buf) then vim.api.nvim_buf_delete(buf, { force = true }) end
		end
		state.tree_buf, state.tree_preview_buf = nil, nil
		state.tree_nodes_by_line, state.tree_match_rows, state.tree_highlights_by_line = {}, {}, {}
		state.tree_preview_entry_id, state.tree_preview_query = nil, nil
	end
end

local function current_node(ctx)
	local win = vim.api.nvim_get_current_win()
	if ctx.buffer.valid(ctx.state.tree_buf) and vim.api.nvim_win_get_buf(win) ~= ctx.state.tree_buf and win_valid(ctx.state.tree_win) then
		win = ctx.state.tree_win
	end
	local cursor = vim.api.nvim_win_get_cursor(win)
	return ctx.state.tree_nodes_by_line[cursor[1]]
end

local function preview_lines(ctx, node)
	if not node or not node.record then
		return { "No tree entry selected." }
	end
	local first = node.records[1]
	local last = node.records[#node.records]
	local lines = {
		string.format("%s  %s", node_title(node), node.target_id or ""),
	}
	if node.start_id ~= node.target_id then
		table.insert(lines, "records: " .. node.start_id .. " → " .. node.target_id)
	end
	if node.parent then
		table.insert(lines, "parent: " .. node.parent.target_id)
	end
	if first.timestamp then
		local time = time_utils.format_timestamp(first.timestamp)
		if last.timestamp and last.timestamp ~= first.timestamp then
			time = time .. " → " .. time_utils.format_timestamp(last.timestamp)
		end
		table.insert(lines, "time: " .. time)
	end
	if node.transition then
		table.insert(lines, "workspace transition: " .. node.transition.label .. (node.transition.id and (" (" .. node.transition.id .. ")") or ""))
		if node.transition.cwd then
			table.insert(lines, "cwd: " .. node.transition.cwd)
		end
	elseif node.workspace then
		table.insert(lines, "workspace: " .. node.workspace.label .. " (" .. node.workspace.id .. ")")
		if node.workspace.cwd then
			table.insert(lines, "cwd: " .. node.workspace.cwd)
		end
	end
	table.insert(lines, "")

	local text = node_text(ctx, node)
	if text == "" then
		text = vim.inspect(node.records)
	end
	local text_row = #lines
	vim.list_extend(lines, vim.split(tostring(text), "\n", { plain = true }))
	return lines, text_row
end

local function preview_entry_id(node)
	return node and node.target_id or nil
end

local function update_preview(ctx)
	local state = ctx.state
	if not ctx.buffer.valid(state.tree_preview_buf) then
		return
	end

	local node = current_node(ctx)
	local entry_id = preview_entry_id(node)
	local previous_entry_id = state.tree_preview_entry_id
	local previous_query = state.tree_preview_query
	local lines, text_row = preview_lines(ctx, node)
	ctx.buffer.set_lines(state.tree_preview_buf, lines, false)
	vim.api.nvim_buf_clear_namespace(state.tree_preview_buf, search_highlight_ns, 0, -1)
	local first_match_line
	if text_row and node.match_positions then
		local offset, index = 0, 1
		for row = text_row + 1, #lines do
			local text = lines[row]
			while index <= #node.match_positions and node.match_positions[index] < offset + #text do
				local col = node.match_positions[index] - offset
				if col >= 0 then
					local next_col = vim.fn.byteidx(text, vim.fn.charidx(text, col) + 1)
					vim.api.nvim_buf_set_extmark(state.tree_preview_buf, search_highlight_ns, row - 1, col, {
						end_col = next_col, hl_group = "Search",
					})
					first_match_line = first_match_line or row
				end
				index = index + 1
			end
			offset = offset + #text + 1
		end
	end
	state.tree_preview_entry_id = entry_id
	state.tree_preview_query = state.tree_search_query

	if not win_valid(state.tree_preview_win) then
		return
	end

	local line = first_match_line or 1
	if entry_id == previous_entry_id and previous_query == state.tree_search_query then
		local ok, cursor = pcall(vim.api.nvim_win_get_cursor, state.tree_preview_win)
		if ok and cursor then
			line = math.min(math.max(cursor[1], 1), vim.api.nvim_buf_line_count(state.tree_preview_buf))
		end
	end
	pcall(vim.api.nvim_win_set_cursor, state.tree_preview_win, { line, 0 })
end

local function scroll_preview(ctx, direction)
	local state = ctx.state
	if not (win_valid(state.tree_preview_win) and ctx.buffer.valid(state.tree_preview_buf)) then
		return
	end
	if vim.api.nvim_win_get_buf(state.tree_preview_win) ~= state.tree_preview_buf then
		return
	end

	pcall(vim.api.nvim_win_call, state.tree_preview_win, function()
		local view = vim.fn.winsaveview()
		local line_count = math.max(1, vim.api.nvim_buf_line_count(state.tree_preview_buf))
		local height = math.max(1, vim.api.nvim_win_get_height(state.tree_preview_win))
		local max_topline = math.max(1, line_count - height + 1)
		local page = math.max(1, height - 1)
		local target_topline = math.min(math.max((view.topline or 1) + (direction * page), 1), max_topline)
		view.topline = target_topline
		view.lnum = target_topline
		view.col = 0
		view.curswant = 0
		vim.fn.winrestview(view)
	end)
end

local function selected_tree_position(ctx)
	local state = ctx.state
	local win = win_valid(state.tree_win) and state.tree_win or vim.api.nvim_get_current_win()
	local ok, cursor = pcall(vim.api.nvim_win_get_cursor, win)
	local row = ok and cursor[1] or 1
	local node = (state.tree_nodes_by_line or {})[row]
	return {
		row = row,
		entry_id = node and node.target_id or nil,
		parent_id = node and node.parent and node.parent.target_id or nil,
	}
end

local function save_tree_view(ctx)
	if not win_valid(ctx.state.tree_win) then
		return nil
	end
	local ok, view = pcall(vim.api.nvim_win_call, ctx.state.tree_win, function()
		return vim.fn.winsaveview()
	end)
	return ok and view or nil
end

local function find_tree_line_by_id(ctx, entry_id)
	if not entry_id then
		return nil
	end
	for line, node in pairs(ctx.state.tree_nodes_by_line or {}) do
		if node and node.target_id == entry_id then
			return line
		end
	end
	return nil
end

local function render_tree_buffer(ctx, opts)
	opts = opts or {}
	local state = ctx.state
	local path = state.session_file or state.pending_session_file
	if not ctx.tree and (not path or path == "") then
		ctx.ui.notify("No Pi session selected yet.", vim.log.levels.WARN)
		return false
	end

	local roots, leaf_id, focus_id = read_session_tree(ctx, path)
	if #roots == 0 and not opts.allow_empty and (state.tree_search_query or "") == "" and state.tree_scope ~= "branch" then
		ctx.ui.notify("No tree entries found in this session.", vim.log.levels.WARN)
		return false
	end

	if not ctx.buffer.valid(state.tree_buf) then
		state.tree_buf = ctx.buffer.create("pi://tree", "text", false)
	end
	if not ctx.buffer.valid(state.tree_preview_buf) then
		state.tree_preview_buf = ctx.buffer.create("pi://tree-preview", "markdown", false)
	end

	local lines, highlights = {}, {}
	local function hint_line(items)
		local text, spans = "", {}
		for _, item in ipairs(items) do
			if text ~= "" then text = text .. " · " end
			table.insert(spans, { start_col = #text, end_col = #text + #item[1], hl_group = "PiOverviewKey" })
			text = text .. item[1] .. " " .. item[2]
		end
		table.insert(lines, text)
		table.insert(spans, 1, { start_col = 0, end_col = #text, hl_group = "PiOverviewStatusLine", priority = 200 })
		highlights[#lines] = spans
	end
	local filters = { default = "Default", ["user-only"] = "User only", all = "All entries" }
	local mode = state.tree_filter_mode or "default"
	hint_line({ { "b", state.tree_scope == "branch" and "Current branch" or "Full tree" }, { "o", filters[mode] or mode } })
	if ctx.tree and not ctx.tree.writable(state.tree_context) then
		hint_line({ { "r", "Refresh (read-only)" }, { "/", "Search" }, { "?", "Help" }, { "q", "Close" } })
	else
		hint_line({ { "Enter", "Jump" }, { "c", "Clone" }, { "d", "Delete" }, { "/", "Search" }, { "?", "Help" }, { "q", "Close" } })
	end
	local query = state.tree_search_query or ""
	local search_row
	if query ~= "" then
		table.insert(lines, "")
		search_row = #lines
	end
	table.insert(lines, "")
	state.tree_nodes_by_line = {}
	state.tree_match_rows = {}
	state.tree_highlights_by_line = highlights
	state.tree_workspace_highlights = {}
	state.tree_workspace_highlight_slots = {}
	if #roots == 0 then
		table.insert(lines, (state.tree_search_query or "") ~= "" and "No matching turns." or "No tree entries found in this session.")
	else
		render_nodes(ctx, roots, leaf_id, lines, state.tree_nodes_by_line, state.tree_highlights_by_line)
	end
	for row, node in pairs(state.tree_nodes_by_line) do
		if node.match_positions then table.insert(state.tree_match_rows, row) end
	end
	table.sort(state.tree_match_rows)
	if search_row then
		local suffix = " · " .. #state.tree_match_rows .. " matches · "
		local key_hint = "n/N Next/previous"
		local query_width = tree_window_width(ctx) - display_width("Search: " .. suffix .. key_hint)
		local prefix = "Search: " .. truncate_display(query, math.max(1, query_width)) .. suffix
		lines[search_row] = prefix .. key_hint
		highlights[search_row] = {
			{ start_col = 0, end_col = #lines[search_row], hl_group = "PiOverviewStatusLine", priority = 200 },
			{ start_col = #prefix, end_col = #prefix + 3, hl_group = "PiOverviewKey" },
		}
	end
	ctx.buffer.set_lines(state.tree_buf, lines, false)
	apply_tree_highlights(ctx)
	return true, focus_id
end

local function restore_tree_view(ctx, opts)
	opts = opts or {}
	local state = ctx.state
	if not win_valid(state.tree_win) or not ctx.buffer.valid(state.tree_buf) then
		return
	end

	local line = find_tree_line_by_id(ctx, opts.entry_id) or find_tree_line_by_id(ctx, opts.parent_id) or opts.row or 1
	local max_line = math.max(1, vim.api.nvim_buf_line_count(state.tree_buf))
	line = math.min(math.max(line, 1), max_line)

	pcall(vim.api.nvim_win_call, state.tree_win, function()
		if opts.view then
			local view = {}
			for key, value in pairs(opts.view) do
				view[key] = value
			end
			view.lnum = line
			view.col = 0
			view.curswant = 0
			vim.fn.winrestview(view)
		else
			vim.api.nvim_win_set_cursor(state.tree_win, { line, 0 })
		end
	end)
end

local function refresh_tree_in_place(ctx, opts)
	if not render_tree_buffer(ctx, { allow_empty = true }) then
		return false
	end
	restore_tree_view(ctx, opts)
	update_preview(ctx)
	return true
end

local function cycle_search_match(ctx, direction)
	local state = ctx.state
	local rows = state.tree_match_rows or {}
	if not win_valid(state.tree_win) or #rows == 0 then return end
	local current = vim.api.nvim_win_get_cursor(state.tree_win)[1]
	local target = direction > 0 and rows[1] or rows[#rows]
	if direction > 0 then
		for _, row in ipairs(rows) do
			if row > current then target = row; break end
		end
	else
		for index = #rows, 1, -1 do
			if rows[index] < current then target = rows[index]; break end
		end
	end
	vim.api.nvim_win_set_cursor(state.tree_win, { target, 0 })
	update_preview(ctx)
end

local function search_turns(ctx)
	local state = ctx.state
	local previous_query = state.tree_search_query or ""
	local previous_position = selected_tree_position(ctx)
	local buf = ctx.buffer.create("pi://tree-search", "text", false)
	ctx.buffer.set_lines(buf, { previous_query }, true)
	local win = vim.api.nvim_open_win(buf, true, {
		relative = "win", win = state.tree_win, row = 0, col = 0,
		width = math.max(1, tree_window_width(ctx) - 2), height = 1,
		style = "minimal", border = "rounded", title = " Search full turns · Enter accept · Esc cancel ",
	})
	local closing = false
	local function update_query()
		if closing or not win_valid(state.tree_win) then return end
		local query = vim.api.nvim_buf_get_lines(buf, 0, 1, false)[1] or ""
		if query == (state.tree_search_query or "") then return end
		local position = selected_tree_position(ctx)
		state.tree_search_query = query
		refresh_tree_in_place(ctx, position)
		local selected = current_node(ctx)
		if query ~= "" and #state.tree_match_rows > 0 and not (selected and selected.match_positions) then
			vim.api.nvim_win_set_cursor(state.tree_win, { state.tree_match_rows[1], 0 })
			update_preview(ctx)
		end
	end
	local function finish(accept)
		if closing then return end
		if accept then update_query() end
		closing = true
		if vim.api.nvim_get_current_win() == win then vim.cmd("stopinsert") end
		if not accept then state.tree_search_query = previous_query end
		if win_valid(state.tree_win) then
			vim.api.nvim_set_current_win(state.tree_win)
			if not accept then refresh_tree_in_place(ctx, previous_position) end
		end
		floats.close_window(win)
		if vim.api.nvim_buf_is_valid(buf) then vim.api.nvim_buf_delete(buf, { force = true }) end
	end
	floats.close_on_win_leave(buf, function() finish(false) end, { win = win, parent = state.tree_win })
	vim.api.nvim_create_autocmd({ "TextChanged", "TextChangedI" }, {
		buffer = buf,
		callback = update_query,
	})
	vim.keymap.set({ "n", "i" }, "<CR>", function() finish(true) end, { buffer = buf })
	vim.keymap.set({ "n", "i" }, "<Esc>", function() finish(false) end, { buffer = buf })
	vim.api.nvim_win_set_cursor(win, { 1, #previous_query })
	vim.cmd("startinsert!")
end

local function selected_session_path(ctx)
	local path = ctx.state.session_file or ctx.state.pending_session_file
	if not path or path == "" then
		ctx.ui.notify("No Pi session selected yet.", vim.log.levels.WARN)
		return nil
	end
	return path
end

local function jump_to_node(ctx, summarize)
	local node = current_node(ctx)
	if not node then
		return
	end
	if ctx.tree then
		local captured = ctx.state.tree_context
		if not ctx.tree.can_mutate(captured) then return end
		close_tree_window(ctx)
		ctx.tree.jump(node.target_id, summarize, captured)
		return
	end
	if not guard.if_history_change_allowed(ctx, "changing history") then
		return
	end
	local entry_id = node.target_id
	if not selected_session_path(ctx) then
		return
	end
	close_tree_window(ctx)

	local message = "/pi-tree-jump " .. entry_id .. (summarize and " --summary" or "")
	ctx.rpc.send({ type = "prompt", message = message }, function(event)
		if not event.success then
			ctx.ui.notify(event.error or "Could not navigate session tree", vim.log.levels.ERROR)
			return
		end
		ctx.rpc.send({ type = "get_state" }, function(state_event)
			if state_event.success and state_event.data then
				ctx.session.apply_state(state_event.data)
			end
			ctx.actions.refresh_messages()
			focus_input_window(ctx)
		end)
	end)
end

local function clone_node(ctx)
	local node = current_node(ctx)
	if not node or (node.kind ~= "user" and node.kind ~= "assistant") then
		ctx.ui.notify("Select a user or assistant turn to clone.", vim.log.levels.WARN)
		return
	end
	if ctx.tree then
		local captured = ctx.state.tree_context
		if not ctx.tree.can_mutate(captured, "clone") then return end
		close_tree_window(ctx)
		ctx.tree.clone(node.target_id, captured)
		return
	end
	if not guard.if_history_change_allowed(ctx, "cloning history") or ctx.state.tree_clone_pending then return end
	local runtime = require("pi-integration.runtime")
	if not runtime.available() then
		ctx.ui.notify("No supported backend for opening a clone in a new window.", vim.log.levels.ERROR)
		return
	end
	local state = ctx.state
	local source = state.session_file
	local request_id = tostring(vim.uv.hrtime())
	state.tree_clone_pending = true
	state.tree_clone_result = nil
	close_tree_window(ctx)
	ctx.rpc.send({ type = "prompt", message = "/pi-tree-clone " .. node.target_id .. " " .. request_id }, function(event)
		state.tree_clone_pending = false
		local result = state.tree_clone_result
		state.tree_clone_result = nil
		if not event.success then
			ctx.ui.notify(event.error or "Could not clone turn", vim.log.levels.ERROR)
		elseif not result or result.requestId ~= request_id or result.sourceSessionFile ~= source then
			ctx.ui.notify("Clone command returned no matching result.", vim.log.levels.ERROR)
		elseif result.error then
			ctx.ui.notify(result.error, vim.log.levels.ERROR)
		elseif not result.cancelled then
			local launched, err = runtime.launch(ctx.config.launcher, result.cwd, result.sessionFile)
			if not launched then
				ctx.ui.notify((err or "Could not open clone") .. "\nClone saved at: " .. result.sessionFile, vim.log.levels.ERROR)
			end
		end
	end)
end

local function delete_node(ctx)
	local node = current_node(ctx)
	if not node then
		return
	end
	if ctx.tree then
		local captured = ctx.state.tree_context
		if not ctx.tree.can_mutate(captured) then return end
		local position = selected_tree_position(ctx)
		position.view = save_tree_view(ctx)
		close_tree_window(ctx)
		ctx.tree.delete(node.start_id, captured, position)
		return
	end
	if not guard.if_history_change_allowed(ctx, "deleting history") then
		return
	end
	if not selected_session_path(ctx) then
		return
	end

	local position = selected_tree_position(ctx)
	position.view = save_tree_view(ctx)
	local entry_id = node.start_id

	-- The backend opens a mode picker and confirmation. Close the tree first so
	-- its transient-window cleanup cannot steal focus from those dialogs.
	close_tree_window(ctx)
	ctx.rpc.send({ type = "prompt", message = "/pi-tree-delete " .. entry_id }, function(event)
		if not event.success then
			ctx.ui.notify(event.error or "Could not delete session tree entry", vim.log.levels.ERROR)
			return
		end
		ctx.rpc.send({ type = "get_state" }, function(state_event)
			if state_event.success and state_event.data then
				ctx.session.apply_state(state_event.data)
			end
			ctx.actions.refresh_messages()
			M.show(ctx)
			refresh_tree_in_place(ctx, position)
		end)
	end)
end

local function show_tree(ctx, position)
	local state = ctx.state
	if win_valid(state.tree_win) then
		position = position or selected_tree_position(ctx)
		position.view = position.view or save_tree_view(ctx)
		refresh_tree_in_place(ctx, position)
		vim.api.nvim_set_current_win(state.tree_win)
		return
	end

	local width = math.min(math.max(72, math.floor(vim.o.columns * 0.82)), vim.o.columns - 4)
	state.tree_width = width
	local rendered, focus_id = render_tree_buffer(ctx)
	if not rendered then
		return
	end

	local outer_height = math.min(math.max(22, math.floor(vim.o.lines * 0.78)), vim.o.lines - 4)
	local top_height = math.max(8, math.floor((outer_height - 4) * 0.6))
	local preview_height = math.max(6, outer_height - top_height - 4)
	local row = math.max(1, math.floor((vim.o.lines - outer_height) / 2))
	local col = math.max(0, math.floor((vim.o.columns - width) / 2))

	close_tree_window(ctx, true)
	state.tree_win = vim.api.nvim_open_win(state.tree_buf, true, {
		relative = "editor",
		width = width,
		height = top_height,
		row = row,
		col = col,
		style = "minimal",
		border = "rounded",
		title = " Pi Tree ",
		title_pos = "center",
	})
	state.tree_preview_win = vim.api.nvim_open_win(state.tree_preview_buf, false, {
		relative = "editor",
		width = width,
		height = preview_height,
		row = row + top_height + 2,
		col = col,
		style = "minimal",
		border = "rounded",
		title = " Preview ",
		title_pos = "center",
	})
	vim.api.nvim_set_option_value("wrap", false, { win = state.tree_win })
	vim.api.nvim_set_option_value("cursorline", true, { win = state.tree_win })
	vim.api.nvim_set_option_value("cursorlineopt", "line", { win = state.tree_win })
	vim.api.nvim_set_option_value("wrap", true, { win = state.tree_preview_win })
	vim.api.nvim_set_option_value("cursorline", false, { win = state.tree_preview_win })
	list_cursor.attach(state.tree_buf)
	list_cursor.attach(state.tree_preview_buf)
	local first_row
	for row in pairs(state.tree_nodes_by_line) do first_row = math.min(first_row or row, row) end
	restore_tree_view(ctx, position or { entry_id = focus_id, row = state.tree_match_rows[1] or first_row or 1 })
	update_preview(ctx)
	floats.close_on_win_leave(state.tree_buf, function()
		close_tree_window(ctx)
	end, { win = state.tree_win })

	vim.keymap.set("n", "q", function()
		close_tree_window(ctx)
	end, { buffer = state.tree_buf, desc = "Close Pi tree" })
	vim.keymap.set("n", "<Esc>", function()
		close_tree_window(ctx)
	end, { buffer = state.tree_buf, desc = "Close Pi tree" })
	vim.keymap.set("n", "<CR>", function()
		jump_to_node(ctx, false)
	end, { buffer = state.tree_buf, desc = "Jump to tree entry" })
	vim.keymap.set("n", "?", function()
		state.tree_help = state.tree_help or {}
		help.toggle_window(state.tree_help, {
			name = "pi://tree-help", title = "History keys", parent = state.tree_win,
			lines = {
				"# Conversation history", "",
				"- `Enter` jump to the selected turn (preserves history).",
				"- `S` jump with a branch summary.",
				"- `c` clone through the selected turn into a new window.",
				ctx.tree and "- Connected viewers can browse; mutations require current control and an idle owner. Refresh after taking control." or "",
				ctx.tree and "- History is fetched from the owner; disconnecting closes this view. Offline browsing is unavailable." or "",
				"- `d` delete the turn and all descendants; choose whether to undo recorded work.",
				"- `b` toggle full tree / current branch.",
				"- `o` cycle entry filters.",
				"- `/` fuzzy search full turn text; Enter accepts, Esc cancels.",
				"- `n` / `N` locate the next / previous matching turn without jumping.",
				"- Clear the search query to reveal the located turn in the unfiltered tree.",
				"- `<C-f>` / `<C-b>` scroll the preview down / up.",
				"- `r` refresh without changing the selection.",
				"- `q` / `<Esc>` close this view.",
			},
		})
	end, { buffer = state.tree_buf, desc = "History tree help" })
	vim.keymap.set("n", "S", function()
		jump_to_node(ctx, true)
	end, { buffer = state.tree_buf, desc = "Jump to tree entry with summary" })
	vim.keymap.set("n", "<C-f>", function()
		scroll_preview(ctx, 1)
	end, { buffer = state.tree_buf, desc = "Scroll Pi tree preview down" })
	vim.keymap.set("n", "<C-b>", function()
		scroll_preview(ctx, -1)
	end, { buffer = state.tree_buf, desc = "Scroll Pi tree preview up" })
	vim.keymap.set("n", "c", function()
		clone_node(ctx)
	end, { buffer = state.tree_buf, desc = "Clone through turn in a new window" })
	vim.keymap.set("n", "/", function()
		search_turns(ctx)
	end, { buffer = state.tree_buf, desc = "Search full turn text" })
	vim.keymap.set("n", "n", function()
		cycle_search_match(ctx, 1)
	end, { buffer = state.tree_buf, desc = "Next matching turn" })
	vim.keymap.set("n", "N", function()
		cycle_search_match(ctx, -1)
	end, { buffer = state.tree_buf, desc = "Previous matching turn" })
	vim.keymap.set("n", "b", function()
		local position = selected_tree_position(ctx)
		state.tree_scope = state.tree_scope == "branch" and "all" or "branch"
		refresh_tree_in_place(ctx, position)
	end, { buffer = state.tree_buf, desc = "Toggle current branch / full tree" })
	vim.keymap.set("n", "d", function()
		delete_node(ctx)
	end, { buffer = state.tree_buf, desc = "Delete Pi tree entry subtree" })
	vim.keymap.set("n", "o", function()
		local position = selected_tree_position(ctx)
		position.view = save_tree_view(ctx)
		cycle_filter_mode(ctx)
		refresh_tree_in_place(ctx, position)
	end, { buffer = state.tree_buf, desc = "Cycle Pi tree filter" })
	vim.keymap.set("n", "r", function()
		M.show(ctx)
	end, { buffer = state.tree_buf, desc = "Refresh Pi tree" })
	vim.api.nvim_clear_autocmds({ group = tree_preview_augroup, buffer = state.tree_buf })
	vim.api.nvim_create_autocmd({ "CursorMoved", "CursorMovedI" }, {
		group = tree_preview_augroup,
		buffer = state.tree_buf,
		callback = function()
			update_preview(ctx)
		end,
	})
end

function M.show(ctx, position)
	if not ctx.tree then show_tree(ctx, position); return end
	local state = ctx.state
	if win_valid(state.tree_win) then
		position = position or selected_tree_position(ctx)
		position.view = position.view or save_tree_view(ctx)
	end
	state.tree_request = (state.tree_request or 0) + 1
	local request = state.tree_request
	state.tree_context = nil -- Disable mutations until a fresh owner read completes.
	ctx.tree.read(function(data, captured)
		if state.tree_request ~= request then return end
		if not data then close_tree_window(ctx); return end
		state.tree_records, state.tree_context = data.entries, captured
		state.tree_leaf_id = type(data.leafId) == "string" and data.leafId or nil
		show_tree(ctx, position)
	end)
end

function M.update(ctx)
	if win_valid(ctx.state.tree_win) then
		local position = selected_tree_position(ctx)
		position.view = save_tree_view(ctx)
		refresh_tree_in_place(ctx, position)
	end
end

M.close = close_tree_window

return M
