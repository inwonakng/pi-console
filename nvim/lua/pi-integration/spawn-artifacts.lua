local floats = require("pi-integration.floats")
local buffer_utils = require("pi-integration.utils.buffer")

local M = {}

local artifact_types = {
	{ key = "result", run_key = "resultPath", label = "result", filetype = "markdown" },
	{ key = "transcript", run_key = "transcriptPath", label = "transcript", filetype = "json" },
	{ key = "brief", run_key = "briefPath", label = "brief", filetype = "markdown" },
	{ key = "status", run_key = "statusPath", label = "status", filetype = "json" },
	{ key = "agent_prompt", run_key = "agentPromptPath", label = "subagent prompt", filetype = "markdown" },
	{ key = "patch", label = "patch", filetype = "diff" },
}

function M.paths(run, text)
	run = type(run) == "table" and run or {}
	if type(run.runs) == "table" then
		local runs = {}
		for _, member in ipairs(run.runs) do
			local paths = M.paths(member)
			if paths then
				table.insert(runs, { runId = member.runId or member.id, artifacts = paths })
			end
		end
		-- List text can contain matched runs too. Never infer a remaining
		-- run's artifacts from the first paths in that unfiltered text.
		return #runs > 0 and { runs = runs } or nil
	end
	local artifacts, found = {}, false
	for _, artifact in ipairs(artifact_types) do
		local path = artifact.run_key and run[artifact.run_key]
		if artifact.key == "patch" then
			local worktree = type(run.worktree) == "table" and run.worktree or nil
			path = run.patchPath or (worktree and worktree.patchPath)
		end
		if (type(path) ~= "string" or path == "") and type(text) == "string" then
			local label = artifact.label:gsub("^%l", string.upper)
			path = text:match("%- " .. label .. ": ([^\n]+)")
		end
		if type(path) == "string" and path ~= "" then
			artifacts[artifact.key] = path
			found = true
		end
	end
	return found and artifacts or nil
end

local function artifact_choices(artifacts, transcript_first)
	local choices = {}
	if artifacts.runs then
		for _, run in ipairs(artifacts.runs) do
			local id = tostring(run.runId or "unknown")
			id = id:match("([^-]+)$") or id
			for _, choice in ipairs(artifact_choices(run.artifacts, transcript_first)) do
				choice.label = choice.label .. " · " .. id
				table.insert(choices, choice)
			end
		end
		return choices
	end
	for _, artifact in ipairs(artifact_types) do
		local path = artifacts[artifact.key]
		if type(path) == "string" and path ~= "" then
			local choice = { label = artifact.label, kind = artifact.key, path = path, filetype = artifact.filetype }
			if transcript_first and artifact.key == "transcript" then
				table.insert(choices, 1, choice)
			else
				table.insert(choices, choice)
			end
		end
	end
	return choices
end

local function open_text(ctx, title, path, filetype, is_output)
	if not path or vim.fn.filereadable(path) ~= 1 then
		ctx.ui.notify("Could not read " .. tostring(path), vim.log.levels.WARN)
		return
	end
	local text = table.concat(vim.fn.readfile(path), "\n")
	local state = ctx.state
	floats.close_window(state.spawn_win)
	state.spawn_win = nil
	state.spawn_buf = nil
	local buf = buffer_utils.create_scratch({
		filetype = filetype or "markdown",
		lines = vim.split(text, "\n", { plain = true }),
	})

	vim.api.nvim_buf_set_name(buf, "pi://spawn/" .. buf .. "/" .. vim.fn.fnamemodify(path, ":t"))
	local width = math.min(math.max(72, math.floor(vim.o.columns * 0.82)), vim.o.columns - 4)
	local height = math.min(math.max(16, math.floor(vim.o.lines * 0.75)), vim.o.lines - 4)
	local row = math.max(1, math.floor((vim.o.lines - height) / 2))
	local col = math.max(0, math.floor((vim.o.columns - width) / 2))
	local win = vim.api.nvim_open_win(buf, true, {
		relative = "editor",
		width = width,
		height = height,
		row = row,
		col = col,
		style = "minimal",
		border = "rounded",
		title = " " .. title .. " ",
		title_pos = "left",
	})
	vim.api.nvim_set_option_value("wrap", true, { win = win })
	vim.api.nvim_set_option_value("number", false, { win = win })
	vim.api.nvim_set_option_value("relativenumber", false, { win = win })
	state.spawn_buf = buf
	state.spawn_win = win
	local close_win = function()
		if buffer_utils.window_matches(win, buf) then
			floats.close_window(win)
		end
		if state.spawn_win == win then
			state.spawn_win = nil
		end
		if state.spawn_buf == buf then
			state.spawn_buf = nil
		end
	end
	floats.close_on_win_leave(buf, close_win, { win = win, parent = ctx.window.parent })
	local description = is_output and "spawn output" or "spawn artifact"
	vim.keymap.set("n", "q", close_win, { buffer = buf, silent = true, desc = "Close " .. description })
	vim.keymap.set("n", "<Esc>", close_win, { buffer = buf, silent = true, desc = "Close " .. description })
	vim.keymap.set("n", "y", function()
		vim.fn.setreg("+", text)
		ctx.ui.notify("Yanked " .. description)
	end, { buffer = buf, silent = true, desc = "Yank " .. description })
end

local function select_artifact(ctx, choices, prompt, is_output, send_action)
	vim.ui.select(choices, {
		prompt = prompt,
		pi_select_layout = "compact",
		format_item = function(item)
			return item.label .. (item.path and ("  " .. item.path) or "")
		end,
	}, function(choice)
		if not choice then
			return
		end
		if choice.kind == "send-action" then
			send_action()
		elseif choice.kind == "transcript" then
			require("pi-integration.spawn-transcript").open(ctx, choice.path, "Spawn transcript")
		else
			open_text(ctx, "Spawn " .. choice.label, choice.path, choice.filetype, is_output)
		end
	end)
end

-- Inline outputs already contain normalized artifact paths in output.spawn.
function M.open_output(ctx, output)
	if not output.spawn then
		return false
	end
	local choices = artifact_choices(output.spawn, false)
	if #choices == 0 then
		ctx.ui.notify("No spawn artifacts found for this tool call", vim.log.levels.WARN)
		return true
	end
	select_artifact(ctx, choices, "Open spawn artifact", true)
	return true
end

function M.pick_run(ctx, run, send_action)
	local artifacts = M.paths(run) or {}
	local choices = artifact_choices(artifacts, true)
	table.insert(choices, { label = "send action", kind = "send-action" })
	local artifact_ctx = {
		state = ctx.state,
		ui = ctx.ui,
		window = { parent = ctx.state.transcript_win },
	}
	select_artifact(artifact_ctx, choices, "Subagent " .. tostring(run.runId or ""), false, send_action)
end

return M
