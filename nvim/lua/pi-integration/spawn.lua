local floats = require("pi-integration.floats")

local M = {}

local function read_file_text(path)
	if not path or vim.fn.filereadable(path) ~= 1 then
		return nil
	end
	return table.concat(vim.fn.readfile(path), "\n")
end

local function open_text(ctx, title, path, filetype)
	local text = read_file_text(path)
	if not text then
		ctx.ui.notify("Could not read " .. tostring(path), vim.log.levels.WARN)
		return
	end
	local buf = vim.api.nvim_create_buf(false, true)
	vim.api.nvim_buf_set_name(buf, "pi://spawn/" .. vim.fn.fnamemodify(path, ":t"))
	vim.api.nvim_set_option_value("buftype", "nofile", { buf = buf })
	vim.api.nvim_set_option_value("bufhidden", "wipe", { buf = buf })
	vim.api.nvim_set_option_value("swapfile", false, { buf = buf })
	vim.api.nvim_set_option_value("filetype", filetype or "markdown", { buf = buf })
	vim.api.nvim_buf_set_lines(buf, 0, -1, false, vim.split(text, "\n", { plain = true }))
	vim.api.nvim_set_option_value("modifiable", false, { buf = buf })

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
	local close_win = function()
		floats.close_window(win)
	end
	floats.close_on_win_leave(buf, close_win, { win = win, parent = ctx.state.transcript_win })
	vim.keymap.set("n", "q", close_win, { buffer = buf, silent = true, desc = "Close spawn artifact" })
	vim.keymap.set("n", "<Esc>", close_win, { buffer = buf, silent = true, desc = "Close spawn artifact" })
	vim.keymap.set("n", "y", function()
		vim.fn.setreg("+", text)
		ctx.ui.notify("Yanked spawn artifact")
	end, { buffer = buf, silent = true, desc = "Yank spawn artifact" })
end

local function worktree_info(run)
	return type(run.worktree) == "table" and run.worktree or nil
end

local function run_label(run)
	local agent = run.agent or "generic"
	local status = run.status or "unknown"
	local id = run.runId or "unknown"
	local worktree = worktree_info(run)
	local integration = worktree and worktree.integration
	local suffix = integration and integration ~= vim.NIL and (" · " .. tostring(integration)) or ""
	return string.format("%s · %s · %s%s", status, agent, id, suffix)
end

local function artifact_path(run, kind)
	if kind == "brief" then
		return run.briefPath
	elseif kind == "result" then
		return run.resultPath
	elseif kind == "transcript" then
		return run.transcriptPath
	elseif kind == "status" then
		return run.statusPath
	elseif kind == "subagent prompt" then
		return run.agentPromptPath
	elseif kind == "patch" then
		local worktree = worktree_info(run)
		return worktree and worktree.patchPath
	end
	return nil
end

local function send_spawn_action(ctx, run, action)
	local id = run.runId
	if not id or id == "" then
		ctx.ui.notify("Spawn run has no id", vim.log.levels.ERROR)
		return
	end
	ctx.rpc.send({ type = "prompt", message = "/spawn-control " .. action .. " " .. id }, function(event)
		if not event.success then
			ctx.ui.notify(event.error or ("Could not send spawn action: " .. action), vim.log.levels.ERROR)
		elseif action == "join" then
			ctx.ui.notify("Joining subagent " .. id)
		elseif action == "stop" then
			ctx.ui.notify("Stopping subagent " .. id)
		else
			ctx.ui.notify("Requested subagent " .. action .. ": " .. id)
		end
	end)
end

local function pick_send_action(ctx, run)
	local actions = { "status", "join", "stop" }
	vim.ui.select(actions, { prompt = "Send subagent action" }, function(choice)
		if choice then
			send_spawn_action(ctx, run, choice)
		end
	end)
end

local function pick_run_action(ctx, run)
	local choices = {}
	local function add(label, kind, filetype)
		local path = artifact_path(run, kind)
		if path and path ~= "" and path ~= vim.NIL then
			table.insert(choices, { label = label, kind = kind, path = path, filetype = filetype })
		end
	end
	add("transcript", "transcript", "json")
	add("result", "result", "markdown")
	add("brief", "brief", "markdown")
	add("status", "status", "json")
	add("subagent prompt", "subagent prompt", "markdown")
	add("patch", "patch", "diff")
	table.insert(choices, { label = "send action", kind = "send-action" })

	vim.ui.select(choices, {
		prompt = "Subagent " .. tostring(run.runId or ""),
		format_item = function(item)
			return item.label .. (item.path and ("  " .. item.path) or "")
		end,
	}, function(choice)
		if not choice then
			return
		end
		if choice.kind == "send-action" then
			pick_send_action(ctx, run)
		elseif choice.kind == "transcript" then
			require("pi-integration.spawn-transcript").open(ctx, choice.path, "Spawn transcript")
		else
			open_text(ctx, "Spawn " .. choice.label, choice.path, choice.filetype)
		end
	end)
end

function M.pick(ctx)
	local runs = ctx.state.spawn_runs or {}
	if #runs == 0 then
		ctx.ui.notify("No spawned subagents in this session", vim.log.levels.WARN)
		return
	end

	local choices = {}
	for index = #runs, 1, -1 do
		table.insert(choices, runs[index])
	end

	vim.ui.select(choices, {
		prompt = "Spawned subagents",
		format_item = run_label,
	}, function(choice)
		if choice then
			pick_run_action(ctx, choice)
		end
	end)
end

return M
