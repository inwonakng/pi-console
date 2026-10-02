local floats = require("pi-integration.floats")

local M = {}

local function editable_index(ctx, target)
	for index, pending in ipairs(ctx.state.pending_user_messages or {}) do
		if pending == target and (pending.status == "queued" or pending.status == "failed") then
			return index
		end
	end
end

local function resume(ctx)
	ctx.transcript.update_statusline()
	ctx.actions.flush_queued_prompts()
end

local function edit(ctx, pending)
	if not editable_index(ctx, pending) then
		ctx.ui.notify("That message is no longer queued.", vim.log.levels.WARN)
		return
	end
	if pending.edit_win and vim.api.nvim_win_is_valid(pending.edit_win) then
		vim.api.nvim_set_current_win(pending.edit_win)
		return
	end

	local buf, win
	buf, win = require("pi-integration.utils.markdown-editor").open({
		title = " Queued message (:wq to save, :q! to return) ",
		title_pos = "left",
		text = pending.text,
		width = 90,
		height = 20,
		prepare_text = function(text)
			if not editable_index(ctx, pending) then
				ctx.ui.notify("That message is no longer queued.", vim.log.levels.WARN)
				return nil
			end
			text = vim.trim(text)
			if text == "" then
				ctx.ui.notify("Message is empty; use the queue picker to delete it.", vim.log.levels.WARN)
				return nil
			end
			return text
		end,
	}, function(text)
		if pending.edit_buf ~= buf then
			return
		end
		pending.edit_buf = nil
		pending.edit_win = nil
		if editable_index(ctx, pending) then
			if text then
				pending.text = text
				pending.status = "queued"
			end
			resume(ctx)
		end
	end)
	pending.edit_buf = buf
	pending.edit_win = win
	ctx.transcript.update_statusline()
end

function M.close_editors(ctx)
	for _, pending in ipairs(ctx.state.pending_user_messages or {}) do
		local buf, win = pending.edit_buf, pending.edit_win
		pending.edit_buf = nil
		pending.edit_win = nil
		if win then
			floats.close_window(win)
		end
		if buf and vim.api.nvim_buf_is_valid(buf) then
			vim.api.nvim_buf_delete(buf, { force = true })
		end
	end
end

function M.pick(ctx)
	local entries, by_id = {}, {}
	for index, pending in ipairs(ctx.state.pending_user_messages or {}) do
		if pending.status == "queued" or pending.status == "failed" then
			local id = tostring(index)
			by_id[id] = pending
			local summary = pending.text:gsub("%s+", " ")
			local label = pending.status == "failed" and " [failed]" or pending.edit_buf and " [editing]" or ""
			table.insert(entries, id .. "\t" .. (#entries + 1) .. label .. " · " .. summary)
		end
	end
	if #entries == 0 then
		ctx.ui.notify("No queued messages.")
		return
	end
	local function selected(items)
		local id = items and items[1] and items[1]:match("^(%d+)\t")
		return id and by_id[id]
	end
	local function reopen()
		vim.schedule(function()
			M.pick(ctx)
		end)
	end
	require("fzf-lua").fzf_exec(entries, {
		prompt = "Queued messages > ",
		fzf_opts = { ["--delimiter"] = "[\t]", ["--with-nth"] = "2..", ["--no-sort"] = true },
		previewer = {
			_ctor = function()
				local previewer = require("fzf-lua.previewer.builtin").buffer_or_file:extend()
				function previewer:parse_entry(entry)
					local pending = selected({ entry })
					local text = pending and editable_index(ctx, pending) and pending.text or "This message is no longer queued."
					return { content = vim.split(text, "\n", { plain = true }), filetype = "markdown" }
				end
				return previewer
			end,
		},
		actions = {
			enter = {
				fn = function(items)
					local pending = selected(items)
					if pending then
						edit(ctx, pending)
					end
				end,
				header = "edit",
			},
			["ctrl-x"] = {
				fn = function(items)
					local pending = selected(items)
					local index = editable_index(ctx, pending)
					if index then
						table.remove(ctx.state.pending_user_messages, index)
						if pending.edit_win then
							floats.close_window(pending.edit_win)
						end
						resume(ctx)
					else
						ctx.ui.notify("That message is no longer queued.", vim.log.levels.WARN)
					end
					reopen()
				end,
				header = "delete",
			},
		},
	})
end

return M
