local M = {}

-- Track the live RPC dialog for response/timeout/session cleanup. Select and
-- confirm requests keep ownership when hidden; input uses a Markdown float.
local active
local drain

-- Main and side agents share the same dialog surface. Keep subsequent RPC
-- requests pending instead of denying them when another approval is visible.
function M.enqueue(ctx, event, dispatch)
	local queue = ctx.state.pending_ui_queue or {}
	ctx.state.pending_ui_queue = queue
	table.insert(queue, {
		event = event,
		dispatch = dispatch,
		expires = type(event.timeout) == "number" and (vim.uv.now() + event.timeout) or nil,
	})
	drain(ctx)
	ctx.transcript.refresh_ui()
end

drain = function(ctx)
	if active then return end
	local queue = ctx.state.pending_ui_queue or {}
	while not active and #queue > 0 do
		local request = table.remove(queue, 1)
		if request.expires and request.expires <= vim.uv.now() then
			ctx.rpc.send({ type = "extension_ui_response", id = request.event.id, cancelled = true })
		else
			if request.expires then request.event.timeout = request.expires - vim.uv.now() end
			local ok, err = pcall(request.dispatch, request.event)
			if not ok then
				ctx.logs.add("error", "Pi dialog failed", tostring(err))
				ctx.rpc.send({ type = "extension_ui_response", id = request.event.id, cancelled = true })
			end
		end
	end
end

function M.owns_buffer(buf)
	return active ~= nil and active.request.resumable and active.buf == buf
end

local function refresh(picker)
	picker.ctx.transcript.refresh_ui()
end

local function close(picker)
	if picker.focus then picker.focus:release(); picker.focus = nil end
	if picker.buf and vim.api.nvim_buf_is_valid(picker.buf) then
		if picker.input then
			vim.api.nvim_buf_delete(picker.buf, { force = true })
		else
			require("fzf-lua").win.close()
		end
	end
end

local function finish(picker, choice, respond, explicit_cancel)
	if active ~= picker then
		return
	end
	active = nil
	if picker.request.expires and picker.request.expires <= vim.uv.now() then
		respond = false
	end
	picker.request.hidden = nil
	-- Release ownership before closing: on_close and delayed choice callbacks
	-- must not answer a disposed request or close the next dialog.
	close(picker)
	if respond then
		if explicit_cancel and picker.request.on_cancel then
			picker.request.on_cancel()
		elseif choice ~= nil or not picker.request.dismiss_on_close then
			picker.on_choice(choice)
		end
	end
	local state = picker.ctx.state
	state.pending_ui_requests[picker.id] = nil
	if state.active_ui_request_id == picker.id then
		state.active_ui_request_id = nil
	end
	refresh(picker)
	vim.schedule(function() drain(picker.ctx) end)
end

function M.clear_side(ctx, generation, dialog_ids)
	local keep = {}
	for _, id in ipairs(dialog_ids) do keep[id] = true end
	local function stale(request)
		return request.side_dialog_id and (request.side_conversation_id ~= generation or not keep[request.side_dialog_id])
	end
	local queue = ctx.state.pending_ui_queue or {}
	for index = #queue, 1, -1 do
		local request = queue[index]
		if stale(request.event) then
			table.remove(queue, index)
			ctx.rpc.send({ type = "extension_ui_response", id = request.event.id, cancelled = true })
		end
	end
	if active and active.ctx.state == ctx.state and stale(active.request) then
		finish(active, nil, true)
	end
end

function M.can_open(request_id)
	if active and active.request.expires and active.request.expires <= vim.uv.now() then
		finish(active, nil, false)
	end
	if not active or request_id == active.id then
		return true
	end
	if not active.request.resumable then
		-- Replacing an ordinary picker cancels its RPC request before opening
		-- the next UI. Its delayed callback must not close the new picker.
		finish(active, nil, true)
		return true
	end
	active.ctx.ui.notify("Resolve the pending action first (<leader>pa).", vim.log.levels.WARN)
	return false
end

function M.hide()
	local picker = active
	if not picker or picker.input or not picker.request.resumable or picker.request.hidden then
		return
	end
	picker.request.hidden = true
	if picker.focus then picker.focus:release(); picker.focus = nil end
	require("fzf-lua").hide()
	local win = picker.ctx.state.transcript_win
	if win and vim.api.nvim_win_is_valid(win) then
		vim.api.nvim_set_current_win(win)
	end
	vim.cmd("stopinsert")
	refresh(picker)
end

function M.restore(ctx)
	local picker = active
	if not picker or not picker.request.resumable or picker.ctx.state ~= ctx.state then
		ctx.ui.notify("No pending picker to restore.")
		return
	end
	if picker.request.expires and picker.request.expires <= vim.uv.now() then
		finish(picker, nil, false)
		return
	end
	if picker.request.hidden then
		picker.request.hidden = nil
		require("fzf-lua").unhide()
		local floats = require("pi-integration.floats")
		if not picker.focus and floats.has_focus_group() and picker.win and vim.api.nvim_win_is_valid(picker.win) then
			picker.focus = floats.focus_group({ picker.win })
		end
	elseif picker.win and vim.api.nvim_win_is_valid(picker.win) then
		vim.api.nvim_set_current_win(picker.win)
		vim.cmd("startinsert")
	end
	refresh(picker)
end

-- When Pi is still alive (e.g. abort/switch), settle the waiting RPC dialog.
-- On process exit or after session replacement, only dispose its frontend.
function M.clear_main(ctx, respond)
	local queue = ctx.state.pending_ui_queue or {}
	for index = #queue, 1, -1 do
		local request = queue[index]
		if not request.event.side_dialog_id then
			table.remove(queue, index)
			if respond then ctx.rpc.send({ type = "extension_ui_response", id = request.event.id, cancelled = true }) end
		end
	end
	if active and active.ctx.state == ctx.state and not active.request.side_dialog_id then
		finish(active, nil, respond)
	end
end

function M.clear(ctx, respond)
	local queue = ctx.state.pending_ui_queue or {}
	ctx.state.pending_ui_queue = {}
	if respond then
		for _, request in ipairs(queue) do
			ctx.rpc.send({ type = "extension_ui_response", id = request.event.id, cancelled = true })
		end
	end
	if active and active.ctx.state == ctx.state then
		finish(active, nil, respond)
	end
end

function M.select(ctx, id, items, opts, on_choice)
	if not M.can_open(id) then
		on_choice(nil)
		return
	end
	local request = ctx.state.pending_ui_requests[id]
	local picker = { ctx = ctx, id = id, request = request, on_choice = on_choice }
	active = picker
	opts.pi_request_id = id
	opts.no_hide = true -- do not enable fzf-lua's hide-on-accept profile
	opts.no_resume = true -- completed RPC dialogs must not be replayed
	opts.on_create = function(event)
		request.hidden = nil
		picker.buf = event.bufnr
		picker.win = event.winid
		local floats = require("pi-integration.floats")
		if picker.focus then picker.focus:release(); picker.focus = nil end
		if floats.has_focus_group() then picker.focus = floats.focus_group({ event.winid }) end
		if request.resumable then
			for _, key in ipairs({ "<Esc>", "<C-c>" }) do
				vim.keymap.set({ "t", "n" }, key, M.hide, { buffer = event.bufnr, nowait = true, desc = "Hide pending Pi action" })
			end
			vim.keymap.set({ "t", "n" }, "<C-q>", function()
				finish(picker, nil, true, true)
			end, { buffer = event.bufnr, nowait = true, desc = "Cancel pending Pi action" })
		end
		if not picker.watching_buffer then
			picker.watching_buffer = true
			vim.api.nvim_create_autocmd("BufWipeout", {
				buffer = event.bufnr,
				once = true,
				callback = function()
					-- A hidden terminal deleted externally will never deliver fzf's
					-- choice callback. A normal selection deletes a visible terminal;
					-- let its scheduled callback settle the request, without a timer race.
					if active == picker and request.hidden then
						picker.buf = nil -- already being wiped; do not delete recursively
						finish(picker, nil, true)
					end
				end,
			})
		end
	end
	if request.expires then
		vim.defer_fn(function()
			if active == picker then
				finish(picker, nil, false)
			end
		end, math.max(0, request.expires - vim.uv.now()))
	end
	local ok, err = pcall(vim.ui.select, items, opts, function(choice)
		finish(picker, choice, true)
	end)
	if not ok or (active == picker and not picker.buf) then
		ctx.logs.add("error", "Pi picker failed", ok and "fzf-lua did not open a picker" or tostring(err))
		finish(picker, nil, true)
	end
	refresh(picker)
end

-- Use the same ownership and response guards for ordinary RPC input requests.
-- Nothing here depends on which extension asked or on the wording of its title.
function M.input(ctx, event, on_input)
	if not M.can_open(event.id) then
		on_input(nil)
		return
	end
	local request = ctx.state.pending_ui_requests[event.id]
	local picker = { ctx = ctx, id = event.id, request = request, on_choice = on_input, input = true }
	active = picker
	if request.expires then
		vim.defer_fn(function()
			if active == picker then
				finish(picker, nil, false)
			end
		end, math.max(0, request.expires - vim.uv.now()))
	end
	local title = event.title or "Pi input"
	local ok, err = pcall(function()
		picker.buf, picker.win = require("pi-integration.utils.markdown-editor").open({
			name = "pi://input/" .. tostring(event.id),
			title = " " .. title:gsub("[\r\n]+", " ") .. " (:wq to submit) ",
			footer = event.placeholder,
			text = event.prefill or "",
		}, function(text)
			finish(picker, text, true)
		end)
		vim.cmd("startinsert")
	end)
	if not ok then
		ctx.logs.add("error", "Pi input failed", tostring(err))
		finish(picker, nil, true)
	end
	refresh(picker)
	return picker.buf
end

return M
