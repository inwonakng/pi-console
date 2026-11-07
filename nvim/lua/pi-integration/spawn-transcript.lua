local floats = require("pi-integration.floats")
local buffer_utils = require("pi-integration.utils.buffer")
local json = require("pi-integration.utils.json")
local markdown_render = require("pi-integration.markdown-render")
local pi_messages = require("pi-integration.messages")
local pi_tool_output = require("pi-integration.tool-output")
local pi_thinking_output = require("pi-integration.thinking-output")
local pi_skills = require("pi-integration.skills")
local pi_transcript = require("pi-integration.transcript")
local activity = require("pi-integration.activity")

local M = {}

local function decode_json(line)
	return json.decode_object(line)
end

local function read_messages(contents)
	local messages, permissions = {}, {}
	for _, line in ipairs(vim.split(contents or "", "\n", { plain = true })) do
		local record = decode_json(line)
		local event = type(record) == "table" and record.event or nil
		if type(record) == "table" and require("pi-integration.permission-output").add_record(messages, permissions, record) then
			-- Decision entries update the row at the original request.
		elseif type(record) == "table" and record.type == "message" and type(record.message) == "table" then
			table.insert(messages, record.message)
		elseif type(record) == "table" and (record.type == "compaction" or record.type == "branch_summary") then
			table.insert(messages, { role = "assistant", content = { { type = "text", text = record.type .. ": " .. tostring(record.summary or "") } } })
		elseif type(event) == "table" then
			if event.type == "entry_appended" and type(event.entry) == "table" then
				require("pi-integration.permission-output").add_record(messages, permissions, event.entry)
			elseif event.type == "message_end" and type(event.message) == "table" then
				table.insert(messages, event.message)
			elseif event.type == "tool_execution_start" or event.type == "tool_execution_update"
				or event.type == "tool_execution_end" or event.type == "agent_end" or event.type == "agent_settled"
				or event.type == "child_exit" then
				table.insert(messages, event)
			end
		end
	end
	return messages
end

local function metadata_lines(path)
	return {
		"---",
		"title: \"Transcript\"",
		"source: \"" .. tostring(path):gsub("\\", "\\\\"):gsub('"', '\\"') .. "\"",
		"last_updated: \"" .. os.date("%Y-%m-%d %H:%M:%S %z") .. "\"",
		"---",
	}
end

local function make_render_ctx(state, path)
	return {
		state = state,
		notices = { empty_session = "No messages yet." },
		transcript = {
			metadata_lines = function()
				return metadata_lines(path)
			end,
		},
	}
end

local function render_lines(path, state, contents)
	state.transcript_items = {}
	pi_tool_output.reset(state)
	pi_thinking_output.reset(state)
	pi_skills.reset(state)
	local lines, items = pi_messages.collect_message_lines(make_render_ctx(state, path), read_messages(contents))
	state.transcript_items = items or {}
	return lines
end

local function transcript_ctx(state)
	return {
		state = state,
		buffer = {
			valid = buffer_utils.valid,
			set_modifiable = buffer_utils.set_modifiable,
			set_lines = buffer_utils.set_lines,
		},
		transcript = {
			update_statusline = function() end,
		},
	}
end

local function render_transcript_ui(state)
	pi_transcript.render(transcript_ctx(state))
end

local function open_item(ctx, state, parent_win)
	local cursor = vim.api.nvim_win_get_cursor(0)
	local item = activity.item_at_line(state.transcript_items, cursor[1])
	if not item then
		return false
	end
	local child_ctx = {
		state = state,
		resources = ctx.resources,
		ui = {
			notify = ctx.ui.notify,
		},
		window = {
			parent = parent_win,
		},
	}
	if item.kind == "activity" then
		activity.toggle(transcript_ctx(state), item)
		render_transcript_ui(state)
		return true
	elseif item.kind == "tool" then
		return pi_tool_output.open_float(child_ctx, item.output_id)
	elseif item.kind == "thinking" then
		return pi_thinking_output.open_float(child_ctx, item.output_id)
	elseif item.kind == "skill" then
		return pi_skills.open_float(child_ctx, item.output_id)
	end
	return false
end

-- Read every page up to the file size seen by the first page. Records appended
-- while loading stay out of this snapshot.
local function load_snapshot(ctx, query, callback)
	local parts, snapshot = {}, nil
	local function fetch(offset)
		local payload = vim.tbl_extend("force", query, { view = "transcript", offset = offset })
		if snapshot then payload.version, payload["end"] = snapshot.version, snapshot.size end
		ctx.resources.read(payload, function(page)
			snapshot = snapshot or { version = page.version, size = page.size, path = page.path }
			table.insert(parts, page.text)
			if page.nextOffset ~= nil and page.nextOffset ~= vim.NIL then
				fetch(page.nextOffset)
			else
				snapshot.boundary = page["end"]
				callback(snapshot, table.concat(parts))
			end
		end, function(error)
			ctx.ui.notify(error.message or "Could not read transcript")
		end)
	end
	fetch(0)
end

function M.open(ctx, path, title, query, contents, subagent, opts)
	assert(ctx.resources, "Session resources required")
	opts = opts or {}
	query = query or { kind = "spawn", runId = path and path:match("/runs/([^/]+)/"), artifact = "transcript" }
	local raw_title = (title or "Transcript") .. " (raw)"
	if not contents then
		if query.kind == "spawn" and query.artifact == "transcript" then
			load_snapshot(ctx, query, function(snapshot, text)
				M.open(ctx, snapshot.path, title, query, text, subagent, { snapshot = snapshot, view = opts.view })
			end)
		else
			ctx.resources.document(query, function(text, page)
				M.open(ctx, page.path, title, query, text, subagent, { view = opts.view })
			end)
		end
		return
	end
	local snapshot = opts.snapshot

	local owner = ctx.state
	floats.close_window(owner.spawn_win)
	owner.spawn_win = nil
	owner.spawn_buf = nil

	local state = {
		subagent = subagent,
		show_nested_tools = false,
		tool_outputs = {},
		next_tool_output_id = 0,
		tool_calls = {},
		live_tool_output_by_call = {},
		spawn_run_output_by_id = {},
		thinking_outputs = {},
		next_thinking_output_id = 0,
		skill_tool_calls = {},
		skill_outputs = {},
		next_skill_output_id = 0,
		transcript_items = {},
		transcript_buf = nil,
		transcript_win = nil,
	}

	local buf = buffer_utils.create_scratch({ filetype = "markdown" })
	ctx.resources.qualify(buf, title or "transcript", nil)
	markdown_render.prepare_buffer(buf, { latex = true })

	state.transcript_buf = buf

	local function refresh()
		local lines = render_lines(path, state, contents)
		buffer_utils.set_lines(buf, lines, false)
		if state.transcript_win then
			render_transcript_ui(state)
		end
	end
	refresh()

	local width = math.min(math.max(72, math.floor(vim.o.columns * 0.82)), vim.o.columns - 4)
	local height = math.min(math.max(16, math.floor(vim.o.lines * 0.70)), vim.o.lines - 4)
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
		title = " " .. (ctx.resources and ("[" .. ctx.resources.label .. "] ") or "") .. (title or "Spawn transcript") .. " ",
		title_pos = "left",
		footer = query.kind == "spawn" and " r reload | gR raw | q back " or " r reload | gR raw | q close ",
	})
	state.transcript_win = win
	owner.spawn_buf = buf
	owner.spawn_win = win
	vim.api.nvim_set_option_value("wrap", true, { win = win })
	vim.api.nvim_set_option_value("number", false, { win = win })
	vim.api.nvim_set_option_value("relativenumber", false, { win = win })
	vim.api.nvim_set_option_value("signcolumn", "no", { win = win })
	render_transcript_ui(state)
	if opts.view then
		-- Rendering applies folds on the next tick; restore after it.
		vim.schedule(function()
			if not buffer_utils.window_matches(win, buf) then return end
			if opts.view.at_bottom then pi_transcript.scroll_to_bottom(transcript_ctx(state))
			else vim.api.nvim_win_call(win, function() vim.fn.winrestview(opts.view.saved) end) end
		end)
	end

	local close_win = function()
		if buffer_utils.window_matches(win, buf) then floats.close_window(win) end
		if owner.spawn_win == win then owner.spawn_win = nil end
		if owner.spawn_buf == buf then owner.spawn_buf = nil end
	end
	floats.close_on_win_leave(buf, close_win, { win = win, parent = ctx.window and ctx.window.parent or owner.transcript_win,
		on_dismiss = function()
			if owner.spawn_win == win then owner.spawn_win, owner.spawn_buf = nil, nil end
			if not ctx.resources.current() then return end
			ctx.resources.select()
			if ctx.on_dismiss then ctx.on_dismiss() end
		end,
	})
	local dismiss = function()
		ctx.resources.select()
		floats.dismiss_window(win)
	end
	vim.keymap.set("n", "q", dismiss, { buffer = buf, silent = true, desc = "Close spawn transcript" })
	vim.keymap.set("n", "<Esc>", dismiss, { buffer = buf, silent = true, desc = "Close spawn transcript" })
	vim.keymap.set("n", "gR", function()
		ctx.resources.open(query, raw_title, "json", nil, ctx.on_dismiss)
	end, { buffer = buf, silent = true, desc = "Open raw paged transcript" })
	vim.keymap.set("n", "r", function()
		local view = {
			at_bottom = pi_transcript.is_at_bottom(transcript_ctx(state)),
			saved = vim.api.nvim_win_call(win, vim.fn.winsaveview),
		}
		M.open(ctx, path, title, query, nil, subagent, { view = view })
	end, { buffer = buf, silent = true, desc = "Reload transcript, keeping the scroll position" })
	if snapshot and snapshot.boundary ~= nil and snapshot.boundary ~= vim.NIL then
		-- Check for records written after the snapshot until some appear or the float closes.
		local timer, busy = vim.uv.new_timer(), false
		local function stop()
			if not timer:is_closing() then timer:stop(); timer:close() end
		end
		vim.api.nvim_create_autocmd("WinClosed", { pattern = tostring(win), once = true, callback = stop })
		local probe = vim.tbl_extend("force", query, { view = "transcript", offset = snapshot.boundary, version = snapshot.version })
		timer:start(3000, 3000, vim.schedule_wrap(function()
			if busy or timer:is_closing() then return end
			if not buffer_utils.window_matches(win, buf) then stop(); return end
			busy = true
			ctx.resources.peek(probe, function(ok, page)
				busy = false
				if not ok then stop(); return end
				if page.text == "" then return end
				stop()
				if buffer_utils.window_matches(win, buf) then
					vim.api.nvim_win_set_config(win, { footer = {
						{ " New activity: r to reload ", "WarningMsg" }, { "| gR raw | q back ", "FloatFooter" },
					} })
				end
			end)
		end))
	end
	vim.keymap.set("n", "<CR>", function()
		if not require("pi-integration.utils.markdown-links").follow((owner.workspace or {}).cwd, ctx.resources) then
			open_item(ctx, state, win)
		end
	end, { buffer = buf, silent = true, desc = "Follow link or open nested spawn item" })
end

return M
