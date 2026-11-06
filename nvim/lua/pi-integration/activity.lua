-- Consecutive trace rows (thinking, tools, skills, permissions) form one
-- activity: a summary header followed by flat child rows. Finished children
-- fold under the header; running children stay visible below the fold.
local message_utils = require("pi-integration.utils.message")
local tool_output = require("pi-integration.tool-output")

local M = {}

M.icon = "󰣖"
M.open_icon = "󰅀"
M.closed_icon = "󰅂"

local function tool_call(state, output)
	return output.tool_call_id and state.tool_calls and state.tool_calls[output.tool_call_id]
end

local function tool_failed(state, output)
	local status = type(output.details) == "table" and output.details.status or nil
	local call = tool_call(state, output)
	return output.is_error or (call and call.execution_status == "interrupted")
		or status == "error" or status == "failed" or status == "aborted"
end

function M.is_running(state, child)
	if child.streaming then
		return true
	end
	if child.kind ~= "tool" then
		return false
	end
	local output = state.tool_outputs[child.output_id]
	local call = output and tool_call(state, output)
	return call ~= nil and call.execution_status == "running"
end

local function plural(count, word)
	return count .. " " .. word .. (count == 1 and "" or "s")
end

local function summary(state, activity)
	local files, paths, agents, failures = {}, {}, 0, 0
	for _, child in ipairs(activity.children) do
		if child.kind == "tool" then
			local output = state.tool_outputs[child.output_id]
			if output then
				local failed = tool_failed(state, output)
				if failed then
					failures = failures + 1
				elseif output.name == "edit" or output.name == "write" then
					local path = output.display and output.display.kind == "file" and output.display.path
						or message_utils.path_from_args(output.args)
					if path and not files[path] then
						files[path] = true
						table.insert(paths, path)
					end
				elseif output.name == "spawn" then
					local runs = type(output.details) == "table" and output.details.runs
					agents = agents + (type(runs) == "table" and math.max(#runs, 1) or 1)
				end
			end
		elseif child.kind == "skill" then
			local output = state.skill_outputs and state.skill_outputs[child.output_id]
			if output and output.is_error then
				failures = failures + 1
			end
		end
	end

	local text, segments = "> " .. M.icon, {}
	local function add(part, highlight)
		text = text .. (#segments == 0 and " " or " · ")
		table.insert(segments, { #text, #text + #part, highlight })
		text = text .. part
	end
	add(plural(#activity.children, "step"), nil)
	if #paths > 0 then
		local names = {}
		for index = 1, math.min(#paths, 2) do
			table.insert(names, vim.fs.basename(paths[index]))
		end
		local more = #paths > 2 and (" +" .. (#paths - 2)) or ""
		add(tool_output.summary_icon("edit") .. " " .. table.concat(names, ", ") .. more, "PiActivityFiles")
	end
	if agents > 0 then
		add(tool_output.summary_icon("spawn") .. " " .. plural(agents, "agent"), "PiActivityAgents")
	end
	if failures > 0 then
		add("✗ " .. failures .. " failed", "DiagnosticError")
	end
	return text, segments
end

function M.refresh(state, activity, write)
	local text
	text, activity.segments = summary(state, activity)
	write(activity.start_line, text)
end

-- Rows are only replaced or appended; earlier rows never move. A child joins
-- the trailing activity when at most one blank separator precedes it.
function M.append(state, items, child, text, at, write)
	local activity = items[#items]
	local start = activity and activity.kind == "activity" and at - activity.end_line <= 2
	if not start then
		activity = { kind = "activity", key = child.key, start_line = at, end_line = at, children = {} }
		table.insert(items, activity)
		at = at + 1
	end
	child.start_line, child.end_line = at, at
	table.insert(activity.children, child)
	activity.end_line = at
	M.refresh(state, activity, write)
	write(at, text)
	return activity
end

function M.write_tool(state, items, output_id, at, write)
	state.tool_items_by_output = state.tool_items_by_output or {}
	local text = "> " .. tool_output.summary_text(state, output_id)
	local entry = state.tool_items_by_output[output_id]
	if entry then
		write(entry.child.start_line, text)
		M.refresh(state, entry.activity, write)
		return false
	end
	local output = state.tool_outputs[output_id]
	local child = { kind = "tool", output_id = output_id, key = output.tool_call_id or ("tool:" .. output_id) }
	local activity = M.append(state, items, child, text, at, write)
	state.tool_items_by_output[output_id] = { activity = activity, child = child }
	return true
end

function M.update_row(state, items, kind, output_id, text, write)
	for _, activity in ipairs(items) do
		if activity.kind == "activity" then
			for _, child in ipairs(activity.children) do
				if child.kind == kind and child.output_id == output_id then
					write(child.start_line, text)
					M.refresh(state, activity, write)
					return
				end
			end
		end
	end
end

function M.item_at_line(items, line)
	for _, item in ipairs(items or {}) do
		if line >= item.start_line and line <= item.end_line then
			if item.kind == "activity" and line ~= item.start_line then
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
	local buf = vim.api.nvim_win_get_buf(win)
	local previous = vim.w[win].pi_transcript_folds
	-- Native z commands change window folds, not activity_expanded. Read those
	-- choices before rebuilding so transcript updates do not undo them.
	if previous and previous.buf == buf and vim.wo[win].foldmethod == "manual" then
		state.activity_expanded = state.activity_expanded or {}
		vim.api.nvim_win_call(win, function()
			for _, fold in ipairs(previous.folds) do
				if vim.fn.foldlevel(fold[1]) > 0 then
					fold[3] = vim.fn.foldclosed(fold[1]) == -1
					state.activity_expanded[fold[4]] = fold[3]
				end
			end
		end)
	end
	local folds = {}
	for _, activity in ipairs(state.transcript_items or {}) do
		if activity.kind == "activity" then
			activity.expanded = (state.activity_expanded or {})[activity.key] == true
			local last = activity.end_line
			for _, child in ipairs(activity.children) do
				if M.is_running(state, child) then
					last = child.start_line - 1
					break
				end
			end
			activity.folded = last > activity.start_line and not activity.expanded
			if last > activity.start_line then
				table.insert(folds, { activity.start_line, last, activity.expanded, activity.key })
			end
		end
	end
	local tick = vim.api.nvim_buf_get_changedtick(buf)
	if previous and previous.buf == buf and previous.tick == tick and vim.deep_equal(previous.folds, folds)
		and vim.wo[win].foldmethod == "manual" then
		vim.w[win].pi_transcript_folds = previous
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
		for _, fold in ipairs(folds) do
			local first, last, expanded = unpack(fold)
			vim.cmd(string.format("%d,%dfold", first, last))
			if expanded then
				vim.cmd(tostring(first) .. "foldopen")
			elseif view.lnum > first and view.lnum <= last then
				view.lnum, view.col = first, 0
			end
		end
		vim.fn.winrestview(view)
	end)
	vim.w[win].pi_transcript_folds = { buf = buf, tick = tick, folds = folds }
end

function M.toggle(ctx, activity)
	M.apply_folds(ctx.state, vim.api.nvim_get_current_win())
	local expanded = not activity.expanded
	if vim.fn.foldlevel(activity.start_line) > 0 then
		expanded = vim.fn.foldclosed(activity.start_line) ~= -1
		vim.cmd(tostring(activity.start_line) .. (expanded and "foldopen" or "foldclose"))
	end
	ctx.state.activity_expanded = ctx.state.activity_expanded or {}
	ctx.state.activity_expanded[activity.key] = expanded
	activity.expanded = expanded
	return true
end

-- Session-picker previews are static text, not interactive transcripts.
function M.preview_lines(lines, items)
	local hidden = {}
	for _, item in ipairs(items) do
		if item.kind == "activity" then
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
		copy.end_line = item.kind == "activity" and copy.start_line or line_map[item.end_line]
		copy.expanded = false
		table.insert(preview_items, copy)
	end
	return result, preview_items
end

return M
