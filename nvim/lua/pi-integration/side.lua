local floats = require("pi-integration.floats")
local buffer = require("pi-integration.utils.buffer")
local markdown = require("pi-integration.markdown-render")
local messages = require("pi-integration.messages")
local transcript = require("pi-integration.transcript")
local tool_output = require("pi-integration.tool-output")
local thinking_output = require("pi-integration.thinking-output")
local skills = require("pi-integration.skills")
local tool_groups = require("pi-integration.tool-groups")
local json = require("pi-integration.utils.json")

local M = {}

local function valid(win)
	return win and vim.api.nvim_win_is_valid(win)
end

local function get_side(ctx)
	if not ctx.state.side then
		ctx.state.side = {
			render = require("pi-integration.state").new(),
			data = { messages = {}, draft = "", running = false },
			draft_sequence = 0,
			requests = {},
		}
	end
	return ctx.state.side
end

local function finish_request(ctx, side, id, event)
	local callback = side.requests[id]
	if not callback then return end
	side.requests[id] = nil
	if not event.success then
		ctx.ui.notify(event.error or "Could not update side conversation", vim.log.levels.ERROR)
	end
	callback(event)
end

local function command(ctx, payload, callback)
	local side = get_side(ctx)
	local id = tostring(vim.uv.hrtime())
	payload.requestId = id
	payload.parentSessionFile = ctx.state.session_file
	side.requests[id] = callback or function() end
	ctx.rpc.send({ type = "prompt", message = "/pi-side " .. vim.json.encode(payload) }, function(event)
		-- A native prompt response only confirms that the extension command ran.
		-- Its own acknowledgement determines whether the side action was accepted.
		if not event.success then finish_request(ctx, side, id, event) end
	end)
end

function M.reply(ctx, text)
	local reply = type(text) == "string" and json.decode_object(text) or nil
	local side = ctx.state.side
	if not side or not reply or reply.parentSessionFile ~= ctx.state.session_file then return end
	finish_request(ctx, side, reply.requestId, reply)
end

local function input_text(side)
	if not buffer.valid(side.input_buf) then return side.data.draft or "" end
	return table.concat(vim.api.nvim_buf_get_lines(side.input_buf, 0, -1, false), "\n")
end

local function save_draft(ctx, side)
	local text = input_text(side)
	if text == side.saved_draft then return end
	side.saved_draft = text
	command(ctx, { action = "draft", draft = text }, function(event)
		if not event.success and ctx.state.side == side then side.saved_draft = nil end
	end)
end

function M.hide(ctx, persist_draft)
	local side = ctx.state.side
	if not side or side.hiding then return end
	side.hiding = true
	if side.focus then side.focus:release(); side.focus = nil end
	side.draft_sequence = side.draft_sequence + 1
	if valid(side.input_win) then side.input_cursor = vim.api.nvim_win_get_cursor(side.input_win) end
	if valid(side.transcript_win) then side.transcript_view = vim.api.nvim_win_call(side.transcript_win, vim.fn.winsaveview) end
	for _, win in ipairs({ side.input_win, side.transcript_win }) do
		floats.close_descendants(win)
		floats.close_window(win)
	end
	side.input_win, side.transcript_win = nil, nil
	side.render.transcript_win = nil
	if valid(side.return_win) then vim.api.nvim_set_current_win(side.return_win) end
	side.hiding = false
	if persist_draft ~= false and not ctx.state.rpc_tearing_down and ctx.state.job then save_draft(ctx, side) end
end

local function render_ctx(ctx, side)
	return {
		state = side.render,
		config = ctx.config,
		buffer = buffer,
		notices = { empty_session = "Ask a side question. Main context is captured when the conversation starts." },
		transcript = {
			metadata_lines = function() return {} end,
			update_statusline = function() end,
		},
	}
end

local function render(ctx, side, follow_tail)
	if not buffer.valid(side.transcript_buf) then return end
	local state = side.render
	state.transcript_buf, state.transcript_win = side.transcript_buf, side.transcript_win
	local expanded = state.tool_group_expanded
	tool_output.reset(state)
	thinking_output.reset(state)
	skills.reset(state)
	state.tool_group_expanded = expanded
	local all = vim.deepcopy(side.data.messages or {})
	if type(side.data.partialMessage) == "table" then table.insert(all, side.data.partialMessage) end
	local lines, items = messages.collect_message_lines(render_ctx(ctx, side), all)
	if side.data.error and side.data.error ~= "" then
		vim.list_extend(lines, { "", "### Side error", "", side.data.error })
	end
	local preserve_view = follow_tail ~= true or vim.api.nvim_get_current_win() == side.transcript_win
	local view = valid(side.transcript_win) and vim.api.nvim_win_call(side.transcript_win, vim.fn.winsaveview)
	buffer.set_lines(side.transcript_buf, lines, false)
	state.transcript_items = items
	transcript.touch(render_ctx(ctx, side))
	transcript.render(render_ctx(ctx, side))
	if view and valid(side.transcript_win) then
		vim.api.nvim_win_call(side.transcript_win, function()
			if preserve_view then
				vim.fn.winrestview(view)
			else
				vim.api.nvim_win_set_cursor(side.transcript_win, { math.max(1, #lines), 0 })
				vim.cmd("normal! zb")
			end
		end)
	end
	M.refresh_status(ctx)
end

function M.refresh_status(ctx)
	local side = ctx.state.side
	if not side or not valid(side.transcript_win) then return end
	local request = (ctx.state.pending_ui_requests or {})[ctx.state.active_ui_request_id]
	local main_waiting = request and not request.side_dialog_id
	for _, queued in ipairs(ctx.state.pending_ui_queue or {}) do
		if not queued.event.side_dialog_id then main_waiting = true end
	end
	local main = main_waiting and "waiting"
		or require("pi-integration.state").is_agent_active(ctx.state) and "working" or "idle"
	local activity = #(side.data.dialogIds or {}) > 0 and "waiting"
		or side.data.running and (side.data.activity or "working") or "idle"
	local captured = side.data.capturedAt and (" | context: " .. side.data.capturedAt) or ""
	vim.api.nvim_win_set_config(side.transcript_win, {
		title = " Side | ask | " .. activity .. " | main: " .. main .. captured .. " ",
		title_pos = "left",
	})
end

function M.status(ctx, text)
	local data = type(text) == "string" and json.decode_object(text) or nil
	if type(data) ~= "table" then return end
	local parent = ctx.state.session_file or ctx.state.pending_session_file
	if parent and data.parentSessionFile ~= parent then return end
	local side = get_side(ctx)
	require("pi-integration.pending-picker").clear_side(ctx, data.id, data.dialogIds or {})
	local changed = side.data.id and side.data.id ~= data.id
	local content_changed = not vim.deep_equal(side.data.messages, data.messages)
		or not vim.deep_equal(side.data.partialMessage, data.partialMessage) or side.data.error ~= data.error
	side.data = data
	if buffer.valid(side.input_buf) then
		if changed or (not side.draft_loaded and input_text(side) == "") then
			buffer.set_lines(side.input_buf, vim.split(data.draft or "", "\n", { plain = true }), true)
			side.saved_draft = data.draft or ""
		end
		side.draft_loaded = true
	end
	render(ctx, side, content_changed)
end

local function open_item(ctx, side)
	local item = tool_groups.item_at_line(side.render.transcript_items, vim.api.nvim_win_get_cursor(0)[1])
	if not item then return end
	local child_ctx = {
		state = side.render,
		ui = ctx.ui,
		window = { parent = side.transcript_win },
	}
	if item.kind == "tool_group" then
		tool_groups.toggle(render_ctx(ctx, side), item)
		transcript.render(render_ctx(ctx, side))
		return
	end
	local before = {}
	for _, win in ipairs(vim.api.nvim_list_wins()) do before[win] = true end
	if item.kind == "tool" then tool_output.open_float(child_ctx, item.output_id)
	elseif item.kind == "thinking" then thinking_output.open_float(child_ctx, item.output_id)
	elseif item.kind == "skill" then skills.open_float(child_ctx, item.output_id) end
	local children = {}
	for _, win in ipairs(vim.api.nvim_list_wins()) do
		if not before[win] then table.insert(children, win) end
	end
	if #children > 0 then floats.focus_group(children) end
end

function M.submit(ctx)
	local side = get_side(ctx)
	local text = vim.trim(input_text(side))
	if text == "" then return end
	if side.data.running or side.submitting then
		ctx.ui.notify("The side conversation is working. Wait or use :PiSideAbort.", vim.log.levels.WARN)
		return
	end
	side.submitting = true
	local original = input_text(side)
	command(ctx, { action = "prompt", message = text }, function(event)
		if ctx.state.side ~= side then return end
		side.submitting = false
		if event.success and buffer.valid(side.input_buf) and input_text(side) == original then
			buffer.set_lines(side.input_buf, { "" }, true)
			side.saved_draft = ""
		end
	end)
end

local function geometry()
	local width = math.max(1, math.min(110, math.floor(vim.o.columns * 0.86), vim.o.columns - 4))
	local top = (vim.o.showtabline == 2 or (vim.o.showtabline == 1 and #vim.api.nvim_list_tabpages() > 1)) and 1 or 0
	local bottom = vim.o.cmdheight + (vim.o.laststatus > 0 and 1 or 0) + 1
	local usable_height = math.max(6, vim.o.lines - top - bottom)
	local total = math.max(6, math.floor(usable_height * 0.75))
	local input_height = math.max(1, math.min(8, math.floor(total * 0.25)))
	-- Both floats have a top and bottom border, included in the total footprint.
	local transcript_height = math.max(1, total - input_height - 4)
	return width, transcript_height, input_height,
		top + math.floor((usable_height - total) / 2), math.max(0, math.floor((vim.o.columns - width) / 2))
end

local function resize(side)
	if not valid(side.transcript_win) or not valid(side.input_win) then return end
	local width, th, ih, row, col = geometry()
	vim.api.nvim_win_set_config(side.transcript_win, { width = width, height = th, row = row, col = col })
	vim.api.nvim_win_set_config(side.input_win, { width = width, height = ih, row = row + th + 2, col = col })
end

local function ensure_buffers(ctx, side)
	if not buffer.valid(side.transcript_buf) then
		side.transcript_buf = buffer.create_scratch({ name = "pi://side/transcript", filetype = "markdown", bufhidden = "hide" })
		markdown.prepare_buffer(side.transcript_buf, { latex = true })
		vim.keymap.set("n", "<CR>", function() open_item(ctx, side) end, { buffer = side.transcript_buf, desc = "Open side transcript item" })
	end
	if not buffer.valid(side.input_buf) then
		side.input_buf = buffer.create_scratch({ name = "pi://side/input", filetype = "markdown", bufhidden = "hide", modifiable = true })
		markdown.prepare_buffer(side.input_buf)
		buffer.set_lines(side.input_buf, vim.split(side.data.draft or "", "\n", { plain = true }), true)
		vim.keymap.set({ "n", "i" }, "<C-CR>", function() M.submit(ctx) end, { buffer = side.input_buf, desc = "Send side message" })
		vim.api.nvim_create_autocmd({ "TextChanged", "TextChangedI" }, {
			buffer = side.input_buf,
			callback = function()
				side.draft_sequence = side.draft_sequence + 1
				local sequence = side.draft_sequence
				vim.defer_fn(function()
					if ctx.state.side == side and sequence == side.draft_sequence and ctx.state.job and not ctx.state.rpc_tearing_down then
						save_draft(ctx, side)
					end
				end, 500)
			end,
		})
	end
	for _, buf in ipairs({ side.transcript_buf, side.input_buf }) do
		vim.keymap.set("n", "<leader>pb", function() M.toggle(ctx) end, { buffer = buf, desc = "Toggle side conversation" })
		vim.keymap.set("n", "<leader>pa", ctx.actions.restore_pending_action, { buffer = buf, desc = "Restore pending action" })
		for _, lhs in ipairs({ "<C-k>", "<C-w>k", "<C-w><C-k>" }) do
			vim.keymap.set("n", lhs, function() if valid(side.transcript_win) then vim.api.nvim_set_current_win(side.transcript_win) end end, { buffer = buf })
		end
		for _, lhs in ipairs({ "<C-j>", "<C-w>j", "<C-w><C-j>" }) do
			vim.keymap.set("n", lhs, function() if valid(side.input_win) then vim.api.nvim_set_current_win(side.input_win) end end, { buffer = buf })
		end
	end
end

function M.toggle(ctx)
	local side = get_side(ctx)
	if valid(side.input_win) or valid(side.transcript_win) then M.hide(ctx); return end
	if ctx.state.is_loading or ctx.state.session_replacement_pending or ctx.state.rpc_tearing_down
		or not ctx.state.trust_status or ctx.state.trust_status.state ~= "ready" then
		ctx.ui.notify("Wait for Pi to finish loading before opening the side conversation.", vim.log.levels.WARN)
		return
	end
	side.return_win = vim.api.nvim_get_current_win()
	ensure_buffers(ctx, side)
	local width, th, ih, row, col = geometry()
	side.transcript_win = vim.api.nvim_open_win(side.transcript_buf, false, {
		relative = "editor", width = width, height = th, row = row, col = col,
		style = "minimal", border = "rounded", title = " Side conversation | ask ",
	})
	side.input_win = vim.api.nvim_open_win(side.input_buf, true, {
		relative = "editor", width = width, height = ih, row = row + th + 2, col = col,
		style = "minimal", border = "rounded", title = " Side input ",
		footer = " Ctrl+Enter: send | Space pb or :q: hide | :PiSideReset: reset ",
	})
	side.window_group = vim.api.nvim_create_augroup("PiSideWindows", { clear = true })
	for _, win in ipairs({ side.transcript_win, side.input_win }) do
		vim.wo[win].wrap, vim.wo[win].linebreak = true, true
		vim.wo[win].conceallevel = 2
		vim.api.nvim_create_autocmd("WinClosed", {
			group = side.window_group, pattern = tostring(win), once = true,
			callback = function() if not side.hiding and ctx.state.side == side then M.hide(ctx) end end,
		})
	end
	side.focus = floats.focus_group({ side.transcript_win, side.input_win })
	if side.input_cursor then pcall(vim.api.nvim_win_set_cursor, side.input_win, side.input_cursor) end
	render(ctx, side, side.transcript_view == nil)
	if side.transcript_view then
		vim.api.nvim_win_call(side.transcript_win, function() vim.fn.winrestview(side.transcript_view) end)
	end
	if not side.resize_autocmd then
		side.resize_autocmd = vim.api.nvim_create_autocmd("VimResized", {
			callback = function() if ctx.state.side == side then resize(side) end end,
		})
	end
	command(ctx, { action = "open" })
end

function M.reset(ctx)
	local side = ctx.state.side
	if side then side.draft_sequence = side.draft_sequence + 1 end
	command(ctx, { action = "reset" })
end

function M.abort(ctx)
	command(ctx, { action = "abort" })
end

function M.dispose(ctx)
	local side = ctx.state.side
	if not side then return end
	-- Do not send a stale draft to a replacement session.
	M.hide(ctx, false)
	ctx.state.side = nil
	if side.resize_autocmd then vim.api.nvim_del_autocmd(side.resize_autocmd) end
	if side.window_group then vim.api.nvim_del_augroup_by_id(side.window_group) end
	for _, buf in ipairs({ side.input_buf, side.transcript_buf }) do
		if buffer.valid(buf) then vim.api.nvim_buf_delete(buf, { force = true }) end
	end
end

function M.flush_draft(ctx)
	local side = ctx.state.side
	if not side or not buffer.valid(side.input_buf) or not ctx.state.job
		or ctx.state.rpc_tearing_down or ctx.state.session_replacement_pending then return true end
	side.draft_sequence = side.draft_sequence + 1
	local text = input_text(side)
	local done, success = false, false
	command(ctx, { action = "draft", draft = text }, function(event)
		success = event.success
		if success then side.saved_draft = text end
		done = true
	end)
	-- Give local IPC a bounded shutdown grace period before its process is stopped.
	if not vim.wait(2000, function() return done end, 10) then
		ctx.ui.notify("Could not save the latest side draft before stopping Pi.", vim.log.levels.WARN)
		return false
	end
	return success
end

function M.disconnected(ctx)
	local side = ctx.state.side
	if not side then return end
	if side.data.running then
		side.data.error = "Pi disconnected. Restart it to restore the finalized side transcript."
	end
	side.data.running = false
	side.submitting = false
	for id in pairs(side.requests) do
		finish_request(ctx, side, id, { success = false, error = "Pi disconnected before acknowledging the side action." })
	end
	render(ctx, side)
end

function M.session_changed(ctx, path)
	local side = ctx.state.side
	if side and side.data.parentSessionFile ~= path then M.dispose(ctx) end
end

return M
