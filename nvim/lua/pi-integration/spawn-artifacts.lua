local floats = require("pi-integration.floats")
local buffer_utils = require("pi-integration.utils.buffer")
local markdown_render = require("pi-integration.markdown-render")
local message_utils = require("pi-integration.utils.message")

local M = {}

-- text_label matches the "- Label: path" lines in spawn tool output.
local artifact_types = {
	{ key = "transcript", run_key = "transcriptPath", label = "transcript", text_label = "Transcript", filetype = "json" },
	{ key = "result", run_key = "resultPath", label = "report", text_label = "Result", filetype = "markdown" },
	{ key = "patch", label = "diff", text_label = "Patch", filetype = "diff" },
}

-- result.md holds the worker's report envelope; show the report, not the JSON.
local function report_markdown(text)
	local context = message_utils.agent_context(text)
	if not context then return text end
	local report = context.payload.report
	if type(report) ~= "table" then return message_utils.agent_payload_text(context.payload) or text end
	local lines = {}
	if type(report.outcome) == "string" then vim.list_extend(lines, { "**Outcome:** " .. report.outcome, "" }) end
	if type(report.summary) == "string" and report.summary ~= "" then vim.list_extend(lines, { report.summary, "" }) end
	for _, field in ipairs({ "findings", "verification", "uncertainty" }) do
		local value = report[field]
		if type(value) == "string" and value ~= "" then
			vim.list_extend(lines, { "## " .. field:gsub("^%l", string.upper), "", value, "" })
		end
	end
	return table.concat(lines, "\n")
end

local function run_label(run)
	local name = type(run.agent) == "string" and run.agent ~= "" and run.agent
		or type(run.role) == "string" and run.role ~= "" and run.role or "Subagent"
	return name .. (type(run.status) == "string" and run.status ~= "" and (" · " .. run.status) or "")
end

function M.paths(run, text)
	run = type(run) == "table" and run or {}
	if type(run.runs) == "table" then
		local runs = {}
		for _, member in ipairs(run.runs) do
			local paths = M.paths(member)
			if paths then
				table.insert(runs, { runId = member.runId or member.id, label = run_label(member), artifacts = paths })
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
			path = text:match("%- " .. artifact.text_label .. ": ([^\n]+)")
		end
		if type(path) == "string" and path ~= "" then
			artifacts[artifact.key] = path
			found = true
		end
	end
	artifacts.runId = run.runId or run.id
	artifacts.agent = run.agent
	artifacts.role = run.role
	return found and artifacts or nil
end

local function artifact_choices(artifacts)
	local choices = {}
	if artifacts.runs then
		for index, run in ipairs(artifacts.runs) do
			local label = (run.label or "Subagent") .. " " .. index
			for _, choice in ipairs(artifact_choices(run.artifacts)) do
				choice.label = choice.label .. " · " .. label
				table.insert(choices, choice)
			end
		end
		return choices
	end
	for _, artifact in ipairs(artifact_types) do
		local path = artifacts[artifact.key]
		if type(path) == "string" and path ~= "" then
			table.insert(choices, {
				label = artifact.label, kind = artifact.key, path = path, filetype = artifact.filetype,
				runId = artifacts.runId or path:match("/runs/([^/]+)/"),
				subagent = { agent = artifacts.agent, role = artifacts.role },
			})
		end
	end
	return choices
end

local function open_text(ctx, title, path, filetype, is_output, page, query, anchor)
	assert(ctx.resources and page, "Artifact page required")
	local text = page.text
	-- Reports are small; render only when this page holds the whole file.
	local report = query.kind == "spawn" and query.artifact == "result" and page.offset == 0
		and (page.nextOffset == nil or page.nextOffset == vim.NIL)
	if report then text = report_markdown(text) end
	local state = ctx.state
	floats.close_window(state.spawn_win)
	state.spawn_win = nil
	state.spawn_buf = nil
	local buf = buffer_utils.create_scratch({
		filetype = filetype or "markdown",
		lines = vim.split(text, "\n", { plain = true }),
	})

	ctx.resources.qualify(buf, title, query.kind == "file" and path or nil)
	local markdown = vim.bo[buf].filetype == "markdown"
	if markdown then markdown_render.prepare_buffer(buf, { latex = true }) end
	local width = math.min(math.max(72, math.floor(vim.o.columns * 0.82)), vim.o.columns - 4)
	if markdown then width = math.min(width, 100) end
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
		title = " " .. (ctx.resources and ("[" .. ctx.resources.label .. "] ") or "") .. title .. (not report and (" [bytes " .. page.offset .. ".." .. (page.offset + #page.text) .. "/" .. page.size .. "]") or "") .. " ",
		title_pos = "left",
	})
	vim.api.nvim_set_option_value("wrap", true, { win = win })
	vim.api.nvim_set_option_value("linebreak", true, { win = win })
	vim.api.nvim_set_option_value("breakindent", true, { win = win })
	if markdown then markdown_render.render(buf, win, { latex = true }) end
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
	floats.close_on_win_leave(buf, close_win, { win = win, parent = ctx.window.parent, on_dismiss = function()
		if state.spawn_win == win then state.spawn_win, state.spawn_buf = nil, nil end
		if not ctx.resources.current() then return end
		ctx.resources.select()
		if ctx.on_dismiss then ctx.on_dismiss() end
	end })
	if ctx.resources then
		local function navigate(offset)
			ctx.resources.open(vim.tbl_extend("force", query, { offset = offset, version = page.version }), title, filetype, nil, ctx.on_dismiss)
		end
		vim.keymap.set("n", "n", function()
			if page.nextOffset and page.nextOffset ~= vim.NIL then navigate(page.nextOffset) else ctx.ui.notify("End of document") end
		end, { buffer = buf, desc = "Next document chunk" })
		vim.keymap.set("n", "p", function() navigate(0) end, { buffer = buf, desc = "First document chunk" })
		vim.keymap.set("n", "r", function()
			local fresh = vim.tbl_extend("force", query, { offset = 0 }); fresh.version = nil
			ctx.resources.open(fresh, title, filetype, nil, ctx.on_dismiss)
		end, { buffer = buf, desc = "Reload document" })
		vim.keymap.set("n", "<CR>", function() require("pi-integration.utils.markdown-links").follow(nil, ctx.resources) end, { buffer = buf, desc = "Follow link" })
		if anchor then pcall(require("pi-integration.utils.markdown-links").jump_to_heading, anchor) end
	end
	local description = is_output and "spawn output" or "spawn artifact"
	local dismiss = function()
		if ctx.resources then ctx.resources.select() end
		floats.dismiss_window(win)
		if state.spawn_win == win then state.spawn_win, state.spawn_buf = nil, nil end
	end
	vim.keymap.set("n", "q", dismiss, { buffer = buf, silent = true, desc = "Close " .. description })
	vim.keymap.set("n", "<Esc>", dismiss, { buffer = buf, silent = true, desc = "Close " .. description })
	vim.keymap.set("n", "y", function()
		vim.fn.setreg("+", text)
		ctx.ui.notify("Yanked " .. description)
	end, { buffer = buf, silent = true, desc = "Yank " .. description })
end

local function select_artifact(ctx, choices, prompt, is_output)
	local ticket = ctx.resources and ctx.resources.select()
	vim.ui.select(choices, {
		prompt = prompt,
		pi_select_layout = "compact",
		format_item = function(item)
			return item.label
		end,
	}, function(choice)
		if ctx.resources and not ctx.resources.current(ticket) then return end
		if not choice then
			if ctx.on_dismiss then ctx.on_dismiss() end
			return
		end
		local function return_to_picker()
			select_artifact(ctx, choices, prompt, is_output)
		end
		if choice.kind == "transcript" then
			local query = ctx.resources and { kind = "spawn", runId = choice.runId, artifact = choice.kind } or nil
			require("pi-integration.spawn-transcript").open(vim.tbl_extend("force", ctx, { on_dismiss = return_to_picker }),
				choice.path, "Spawn transcript", query, nil, choice.subagent)
		else
			ctx.resources.open({ kind = "spawn", runId = choice.runId, artifact = choice.kind }, "Spawn " .. choice.label, choice.filetype, nil, return_to_picker)
		end
	end)
end

-- Inline outputs already contain normalized artifact paths in output.spawn.
function M.open_output(ctx, output, start_label)
	if not output.spawn then
		return false
	end
	local choices = artifact_choices(output.spawn)
	if #choices == 0 then
		ctx.ui.notify("No spawn artifacts found for this tool call", vim.log.levels.WARN)
		return true
	end
	select_artifact(ctx, choices, "Open spawn artifact · " .. start_label, true)
	return true
end

function M.pick_run(ctx, run)
	local choices = artifact_choices(M.paths(run) or {})
	if #choices == 0 then
		ctx.ui.notify("No artifacts for this subagent yet", vim.log.levels.WARN)
		if ctx.on_dismiss then ctx.on_dismiss() end
		return
	end
	local artifact_ctx = {
		state = ctx.state,
		resources = ctx.resources,
		ui = ctx.ui,
		on_dismiss = ctx.on_dismiss,
		window = { parent = ctx.state.transcript_win },
	}
	select_artifact(artifact_ctx, choices, run_label(run), false)
end

function M.open_resource(ctx, query, title, filetype, page, anchor)
	open_text(ctx, title, page.path, filetype, false, page, query, anchor)
end
return M
