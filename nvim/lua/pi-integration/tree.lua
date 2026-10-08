local floats = require("pi-integration.floats")
local guard = require("pi-integration.utils.guard")
local json = require("pi-integration.utils.json")
local tree_model = require("pi-integration.tree-model")

local M = {}

local tree_preview_augroup = vim.api.nvim_create_augroup("PiNvimTreePreview", { clear = true })
local tree_highlight_ns = vim.api.nvim_create_namespace("pi-console-tree-highlights")
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
	if not path or vim.fn.filereadable(path) ~= 1 then
		return {}, nil
	end
	local records = {}
	for _, line in ipairs(vim.fn.readfile(path)) do
		local record = decode_record(line)
		if record then
			table.insert(records, record)
		end
	end
	local model = tree_model.build(records)
	local visible = {}
	local visible_by_node = {}
	for _, node in ipairs(model.nodes) do
		if node_visible(ctx, node) then
			local view = {
				kind = node.kind,
				record = node.record,
				records = node.records,
				start_id = node.start_id,
				target_id = node.target_id,
				workspace = node.workspace,
				transition = node.transition,
				model_node = node,
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

	local requested_leaf = ctx.state.tree_leaf_id
	if requested_leaf == nil then
		requested_leaf = model.last_id
	end
	local leaf_node = tree_model.node_for_record(model, requested_leaf)
	while leaf_node and not visible_by_node[leaf_node] do
		leaf_node = leaf_node.parent
	end
	local leaf_view = leaf_node and visible_by_node[leaf_node] or nil
	return roots, leaf_view and leaf_view.target_id or nil
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
	local label = heading .. compact_text(node_text(ctx, node), text_width) .. suffix
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
				priority = 250,
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

local function close_tree_window(ctx)
	local state = ctx.state
	floats.close_window(state.tree_win)
	floats.close_window(state.tree_preview_win)
	state.tree_win = nil
	state.tree_preview_win = nil
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
		local time = tostring(first.timestamp)
		if last.timestamp and last.timestamp ~= first.timestamp then
			time = time .. " → " .. tostring(last.timestamp)
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
	vim.list_extend(lines, vim.split(tostring(text), "\n", { plain = true }))
	return lines
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
	ctx.buffer.set_lines(state.tree_preview_buf, preview_lines(ctx, node), false)
	state.tree_preview_entry_id = entry_id

	if not win_valid(state.tree_preview_win) then
		return
	end

	local line = 1
	if entry_id == previous_entry_id then
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
	if not path or path == "" then
		ctx.ui.notify("No Pi session selected yet.", vim.log.levels.WARN)
		return false
	end

	local roots, leaf_id = read_session_tree(ctx, path)
	if #roots == 0 and not opts.allow_empty then
		ctx.ui.notify("No tree entries found in this session.", vim.log.levels.WARN)
		return false
	end

	if not ctx.buffer.valid(state.tree_buf) then
		state.tree_buf = ctx.buffer.create("pi://tree", "text", false)
	end
	if not ctx.buffer.valid(state.tree_preview_buf) then
		state.tree_preview_buf = ctx.buffer.create("pi://tree-preview", "markdown", false)
	end

	local lines = {
		"Pi session tree",
		"Filter: " .. (state.tree_filter_mode or "default") .. "    Layout: compressed",
		"<CR> jump   S jump with summary   <C-f>/<C-b> scroll preview",
		"d delete subtree   o cycle filter   r refresh   q close",
		"",
	}
	state.tree_nodes_by_line = {}
	state.tree_highlights_by_line = {}
	state.tree_workspace_highlights = {}
	state.tree_workspace_highlight_slots = {}
	if #roots == 0 then
		table.insert(lines, "No tree entries found in this session.")
	else
		render_nodes(ctx, roots, leaf_id, lines, state.tree_nodes_by_line, state.tree_highlights_by_line)
	end
	ctx.buffer.set_lines(state.tree_buf, lines, false)
	apply_tree_highlights(ctx)
	return true
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

local function delete_node(ctx)
	local node = current_node(ctx)
	if not node then
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
			if win_valid(ctx.state.tree_win) then
				refresh_tree_in_place(ctx, position)
				vim.api.nvim_set_current_win(ctx.state.tree_win)
			else
				focus_input_window(ctx)
			end
		end)
	end)
end

function M.show(ctx)
	local state = ctx.state
	if win_valid(state.tree_win) then
		local position = selected_tree_position(ctx)
		position.view = save_tree_view(ctx)
		refresh_tree_in_place(ctx, position)
		vim.api.nvim_set_current_win(state.tree_win)
		return
	end

	local width = math.min(math.max(72, math.floor(vim.o.columns * 0.82)), vim.o.columns - 4)
	state.tree_width = width
	if not render_tree_buffer(ctx) then
		return
	end

	local outer_height = math.min(math.max(22, math.floor(vim.o.lines * 0.78)), vim.o.lines - 4)
	local top_height = math.max(8, math.floor((outer_height - 4) * 0.6))
	local preview_height = math.max(6, outer_height - top_height - 4)
	local row = math.max(1, math.floor((vim.o.lines - outer_height) / 2))
	local col = math.max(0, math.floor((vim.o.columns - width) / 2))

	close_tree_window(ctx)
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
	vim.api.nvim_set_option_value("wrap", true, { win = state.tree_preview_win })
	vim.api.nvim_set_option_value("cursorline", false, { win = state.tree_preview_win })
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
	vim.keymap.set("n", "S", function()
		jump_to_node(ctx, true)
	end, { buffer = state.tree_buf, desc = "Jump to tree entry with summary" })
	vim.keymap.set("n", "<C-f>", function()
		scroll_preview(ctx, 1)
	end, { buffer = state.tree_buf, desc = "Scroll Pi tree preview down" })
	vim.keymap.set("n", "<C-b>", function()
		scroll_preview(ctx, -1)
	end, { buffer = state.tree_buf, desc = "Scroll Pi tree preview up" })
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
		local position = selected_tree_position(ctx)
		position.view = save_tree_view(ctx)
		refresh_tree_in_place(ctx, position)
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

return M
