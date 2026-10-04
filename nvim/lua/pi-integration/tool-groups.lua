local message_utils = require("pi-integration.utils.message")

local M = {}

local labels = { read = "Read", edit = "Edit", write = "Write" }

local function tool_name(state, item)
	local output = item.kind == "tool" and state.tool_outputs[item.output_id]
	return output and labels[output.name] and output.name or nil
end

local function adjacent(lines, left, right)
	for line = left.end_line + 1, right.start_line - 1 do
		if lines[line] ~= "" then
			return false
		end
	end
	return true
end

local function shift_lines(state, items, at)
	for _, item in ipairs(items) do
		if item.start_line >= at then
			item.start_line = item.start_line + 1
		end
		if item.end_line >= at then
			item.end_line = item.end_line + 1
		end
	end
	-- These live-update targets must continue pointing to the original rows.
	for _, key in ipairs({ "active_thinking_line", "todo_tool_line", "placeholder_start_line", "placeholder_line" }) do
		if state[key] and state[key] >= at then
			state[key] = state[key] + 1
		end
	end
	for _, key in ipairs({ "live_tool_lines", "spawn_run_lines" }) do
		for id, line in pairs(state[key] or {}) do
			if line >= at then
				state[key][id] = line + 1
			end
		end
	end
end

local function summary(state, group)
	local files, failures = {}, 0
	for _, child in ipairs(group.children) do
		local output = state.tool_outputs[child.output_id]
		local path = output.display and output.display.kind == "file" and output.display.path
			or message_utils.path_from_args(output.args)
		if path then
			files[path] = true
		end
		if output.is_error then
			failures = failures + 1
		end
	end
	local file_count = vim.tbl_count(files)
	local text = "> 󰇥 " .. labels[group.name] .. " · " .. #group.children .. " calls"
	if file_count > 0 then
		text = text .. " · " .. file_count .. (file_count == 1 and " file" or " files")
	end
	if failures > 0 then
		text = text .. " · " .. failures .. " failed"
	end
	return text
end

-- Used both by the history collector and by the live transcript. Existing
-- headers are retained; only a newly promoted singleton inserts a buffer row.
function M.collect(state, lines, items)
	local runs, existing = {}, {}
	local previous, run
	for _, item in ipairs(items) do
		if item.kind == "tool_group" then
			existing[item.children[1].output_id] = item
		else
			local name = tool_name(state, item)
			if name and run and name == run.name and adjacent(lines, previous, item) then
				table.insert(run.children, item)
			elseif name then
				run = { name = name, children = { item } }
				table.insert(runs, run)
			else
				run = nil
			end
			previous = item
		end
	end

	local edits = {}
	for _, candidate in ipairs(runs) do
		if #candidate.children > 1 then
			local first = candidate.children[1]
			local group = existing[first.output_id]
			if not group then
				local at = first.start_line
				local output = state.tool_outputs[first.output_id]
				group = {
					kind = "tool_group",
					name = candidate.name,
					key = output.tool_call_id,
					live = state.is_agent_running or state.is_streaming or state.is_retrying or false,
				}
				shift_lines(state, items, at)
				group.start_line, group.end_line = at, at
				for index, item in ipairs(items) do
					if item == first then
						table.insert(items, index, group)
						break
					end
				end
				table.insert(lines, at, "")
				table.insert(edits, { line = at, insert = true })
			end
			group.children = candidate.children
			local text = summary(state, group)
			if lines[group.start_line] ~= text then
				lines[group.start_line] = text
				table.insert(edits, { line = group.start_line, text = text })
			end
		end
	end
	return edits
end

function M.foldtext()
	local line = vim.fn.getline(vim.v.foldstart)
	return (line:gsub("^> 󰇥 ", "▸ "))
end

local function fold_end(group)
	return group.children[#group.children].end_line
end

function M.apply_folds(state, win)
	if not win or not vim.api.nvim_win_is_valid(win) then
		return
	end
	local groups = {}
	for _, item in ipairs(state.transcript_items or {}) do
		if item.kind == "tool_group" then
			local choice = item.manual_expanded
			if item.key and state.tool_group_expanded then
				choice = state.tool_group_expanded[item.key]
			end
			item.expanded = choice == true or (choice == nil and item.live == true)
			table.insert(groups, item)
		end
	end
	vim.api.nvim_win_call(win, function()
		local view = vim.fn.winsaveview()
		vim.wo.foldmethod = "manual"
		vim.wo.foldenable = true
		vim.wo.foldlevel = 0
		vim.wo.foldcolumn = "0"
		vim.wo.foldtext = "v:lua.require('pi-integration.tool-groups').foldtext()"
		vim.cmd("normal! zE")
		for _, group in ipairs(groups) do
			local last = fold_end(group)
			vim.cmd(string.format("%d,%dfold", group.start_line, last))
			if group.expanded then
				vim.cmd(tostring(group.start_line) .. "foldopen")
			elseif view.lnum > group.start_line and view.lnum <= last then
				view.lnum, view.col = group.start_line, 0
			end
		end
		vim.fn.winrestview(view)
	end)
end

function M.update(ctx)
	local state, buf = ctx.state, ctx.state.transcript_buf
	local lines = vim.api.nvim_buf_get_lines(buf, 0, -1, false)
	local edits = M.collect(state, lines, state.transcript_items)
	local wins, views = {}, {}
	for _, win in ipairs(vim.api.nvim_list_wins()) do
		if vim.api.nvim_win_get_buf(win) == buf then
			table.insert(wins, win)
			views[win] = vim.api.nvim_win_call(win, vim.fn.winsaveview)
		end
	end
	if #edits > 0 then
		ctx.buffer.set_modifiable(buf, true)
		for _, edit in ipairs(edits) do
			local row = edit.line - 1
			vim.api.nvim_buf_set_lines(buf, row, edit.insert and row or row + 1, false, { edit.text or "" })
			if edit.insert then
				for _, view in pairs(views) do
					if view.lnum >= edit.line then
						view.lnum = view.lnum + 1
					end
					if view.topline >= edit.line then
						view.topline = view.topline + 1
					end
				end
			end
		end
		ctx.buffer.set_modifiable(buf, false)
	end
	for _, win in ipairs(wins) do
		vim.api.nvim_win_call(win, function()
			vim.fn.winrestview(views[win])
		end)
		M.apply_folds(state, win)
	end
end

function M.toggle(ctx, group)
	group.manual_expanded = not group.expanded
	if group.key then
		ctx.state.tool_group_expanded = ctx.state.tool_group_expanded or {}
		ctx.state.tool_group_expanded[group.key] = group.manual_expanded
	end
	M.apply_folds(ctx.state, vim.api.nvim_get_current_win())
	return true
end

function M.settle(state)
	for _, item in ipairs(state.transcript_items or {}) do
		if item.kind == "tool_group" then
			item.live = false
		end
	end
end

function M.apply_highlights(state, buf, ns)
	for _, group in ipairs(state.transcript_items or {}) do
		if group.kind == "tool_group" then
			vim.api.nvim_buf_set_extmark(buf, ns, group.start_line - 1, 0, {
				virt_text = { { "▾   ", "PiToolQuote" } },
				virt_text_pos = "overlay",
				priority = 310,
			})
			for index, child in ipairs(group.children) do
				local branch = index == #group.children and "└─  " or "├─  "
				vim.api.nvim_buf_set_extmark(buf, ns, child.start_line - 1, 0, {
					virt_text = { { branch, "PiToolQuote" } },
					virt_text_pos = "overlay",
					priority = 310,
				})
				local next_child = group.children[index + 1]
				if next_child then
					for line = child.end_line + 1, next_child.start_line - 1 do
						vim.api.nvim_buf_set_extmark(buf, ns, line - 1, 0, {
							virt_text = { { "│", "PiToolQuote" } },
							virt_text_pos = "overlay",
							priority = 310,
						})
					end
				end
			end
		end
	end
end

-- Session-picker previews are static text, not interactive transcripts.
function M.preview_lines(lines, items)
	local hidden, headers = {}, {}
	for _, item in ipairs(items) do
		if item.kind == "tool_group" then
			headers[item.start_line] = true
			for line = item.start_line + 1, fold_end(item) do
				hidden[line] = true
			end
		end
	end
	local result = {}
	for index, line in ipairs(lines) do
		if not hidden[index] then
			table.insert(result, headers[index] and (line:gsub("^> 󰇥 ", "> ▸ ")) or line)
		end
	end
	return result
end

return M
