local M = {}

-- Track the live RPC picker for response/timeout/session cleanup. Only explicitly
-- resumable requests keep exclusive ownership when their window is hidden.
local active

function M.owns_buffer(buf)
	return active ~= nil and active.request.resumable and active.buf == buf
end

local function refresh(picker)
	picker.ctx.transcript.refresh_ui()
end

local function close(picker)
	if picker.buf and vim.api.nvim_buf_is_valid(picker.buf) then
		require("fzf-lua").win.close()
	end
end

local function finish(picker, choice, respond)
	if active ~= picker then
		return
	end
	active = nil
	picker.request.hidden = nil
	-- Release ownership before closing: on_close and delayed choice callbacks
	-- must not answer a disposed request or close the next dialog.
	close(picker)
	if respond then
		picker.on_choice(choice)
	end
	local state = picker.ctx.state
	state.pending_ui_requests[picker.id] = nil
	if state.active_ui_request_id == picker.id then
		state.active_ui_request_id = nil
	end
	refresh(picker)
end

function M.can_open(request_id)
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
	if not picker or not picker.request.resumable or picker.request.hidden then
		return
	end
	picker.request.hidden = true
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
	elseif picker.win and vim.api.nvim_win_is_valid(picker.win) then
		vim.api.nvim_set_current_win(picker.win)
		vim.cmd("startinsert")
	end
	refresh(picker)
end

-- When Pi is still alive (e.g. abort/switch), settle the waiting RPC dialog.
-- On process exit or after session replacement, only dispose its frontend.
function M.clear(ctx, respond)
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
		if request.resumable then
			for _, key in ipairs({ "<Esc>", "<C-c>" }) do
				vim.keymap.set({ "t", "n" }, key, M.hide, { buffer = event.bufnr, nowait = true, desc = "Hide pending Pi action" })
			end
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

return M
