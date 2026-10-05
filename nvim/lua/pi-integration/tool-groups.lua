local message_utils = require("pi-integration.utils.message")
local tool_output = require("pi-integration.tool-output")

local M = {}

local function summary(state, group)
	if #group.children == 1 then
		return "> 󰇥 " .. tool_output.summary_text(state, group.children[1].output_id)
	end
	local files, failures, running = {}, 0, 0
	for _, child in ipairs(group.children) do
		local output = state.tool_outputs[child.output_id]
		local path = output.display and output.display.kind == "file" and output.display.path
			or message_utils.path_from_args(output.args)
		if path then
			files[path] = true
		end
		local status = type(output.details) == "table" and output.details.status or nil
		local call = output.tool_call_id and state.tool_calls and state.tool_calls[output.tool_call_id]
		local execution = call and call.execution_status
		if output.is_error or execution == "interrupted" or status == "error" or status == "failed" or status == "aborted" then
			failures = failures + 1
		elseif execution == "running" or status == "running" then
			running = running + 1
		end
	end
	local file_count = vim.tbl_count(files)
	local text = "> 󰇥 " .. group.name .. " · " .. #group.children .. " calls"
	if file_count > 0 then
		text = text .. " · " .. file_count .. (file_count == 1 and " file" or " files")
	end
	if running > 0 then
		text = text .. " · " .. running .. " running"
	end
	if failures > 0 then
		text = text .. " · " .. failures .. " failed"
	end
	return text
end

local function child_text(state, group, child)
	local branch = child == group.children[#group.children] and "└─ " or "├─ "
	return "> " .. branch .. tool_output.summary_text(state, child.output_id)
end

-- Both history and live rendering use this placement operation. The writer
-- replaces an existing row or appends a new one; it never inserts earlier rows.
function M.write_output(state, items, output_id, at, write)
	state.tool_items_by_output = state.tool_items_by_output or {}
	local entry = state.tool_items_by_output[output_id]
	if entry then
		write(entry.child.start_line, child_text(state, entry.group, entry.child))
		write(entry.group.start_line, summary(state, entry.group))
		return false
	end

	local output = state.tool_outputs[output_id]
	local group = items[#items]
	-- Callers leave at most one blank separator between consecutive trace items.
	if not group or group.kind ~= "tool_group" or group.name ~= output.name or at - group.end_line > 2 then
		group = {
			kind = "tool_group",
			name = output.name,
			key = output.tool_call_id or output_id,
			start_line = at,
			end_line = at,
			children = {},
		}
		table.insert(items, group)
		at = at + 1
	else
		local previous = group.children[#group.children]
		-- The previous last branch becomes an interior branch when we append.
		write(previous.start_line, "> ├─ " .. tool_output.summary_text(state, previous.output_id))
	end
	local child = { kind = "tool", output_id = output_id, start_line = at, end_line = at }
	table.insert(group.children, child)
	group.end_line = at
	state.tool_items_by_output[output_id] = { group = group, child = child }
	write(group.start_line, summary(state, group))
	write(at, child_text(state, group, child))
	return true
end

function M.item_at_line(items, line)
	for _, item in ipairs(items or {}) do
		if line >= item.start_line and line <= item.end_line then
			if item.kind == "tool_group" and line ~= item.start_line then
				return M.item_at_line(item.children, line)
			end
			return item
		end
	end
	return nil
end

function M.apply_folds(state, win)
	if not win or not vim.api.nvim_win_is_valid(win) then
		return
	end
	vim.api.nvim_win_call(win, function()
		local view = vim.fn.winsaveview()
		vim.wo.foldmethod = "manual"
		vim.wo.foldenable = true
		vim.wo.foldlevel = 0
		vim.wo.foldcolumn = "0"
		vim.wo.foldtext = ""
		vim.opt_local.fillchars:append({ fold = " " })
		vim.cmd("normal! zE")
		for _, group in ipairs(state.transcript_items or {}) do
			if group.kind == "tool_group" then
				local choice = (state.tool_group_expanded or {})[group.key]
				local running = false
				for _, child in ipairs(group.children) do
					local output = state.tool_outputs[child.output_id]
					local call = output.tool_call_id and state.tool_calls and state.tool_calls[output.tool_call_id]
					if call and call.execution_status == "running" then
						running = true
						break
					end
				end
				group.expanded = choice == true or (choice == nil and running)
				vim.cmd(string.format("%d,%dfold", group.start_line, group.end_line))
				if group.expanded then
					vim.cmd(tostring(group.start_line) .. "foldopen")
				elseif view.lnum > group.start_line and view.lnum <= group.end_line then
					view.lnum, view.col = group.start_line, 0
				end
			end
		end
		vim.fn.winrestview(view)
	end)
end

function M.toggle(ctx, group)
	ctx.state.tool_group_expanded = ctx.state.tool_group_expanded or {}
	ctx.state.tool_group_expanded[group.key] = not group.expanded
	M.apply_folds(ctx.state, vim.api.nvim_get_current_win())
	return true
end

-- Session-picker previews are static text, not interactive transcripts.
function M.preview_lines(lines, items)
	local hidden = {}
	for _, item in ipairs(items) do
		if item.kind == "tool_group" then
			for line = item.start_line + 1, item.end_line do
				hidden[line] = true
			end
		end
	end
	local result, line_map = {}, {}
	for index, line in ipairs(lines) do
		if not hidden[index] then
			table.insert(result, line)
			line_map[index] = #result
		end
	end
	local preview_items = {}
	for _, item in ipairs(items) do
		local copy = vim.tbl_extend("force", {}, item)
		copy.start_line = line_map[item.start_line]
		copy.end_line = item.kind == "tool_group" and copy.start_line or line_map[item.end_line]
		copy.expanded = false
		table.insert(preview_items, copy)
	end
	return result, preview_items
end

return M
