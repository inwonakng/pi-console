local markdown_render = require("pi-integration.markdown-render")
local activity = require("pi-integration.activity")
local tool_output = require("pi-integration.tool-output")
local buffer = require("pi-integration.utils.buffer")

local M = {}

local quote_ns = vim.api.nvim_create_namespace("pi-console-transcript-quotes")
local interactive_transcripts = {}

local function yaml_value(value)
	if value == nil or value == vim.NIL or value == "" then
		return "null"
	end
	return vim.json.encode(tostring(value))
end

function M.metadata_lines(ctx)
	local state = ctx.state
	local title = state.session_name or "Untitled session"
	local cwd = state.session_cwd
	local lines = {
		"---",
		"title: " .. yaml_value(title),
		"session_id: " .. yaml_value(state.session_id),
		"model: " .. yaml_value(state.model_id or ctx.config.model),
		"provider: " .. yaml_value(state.provider or ctx.config.provider),
		"thinking: " .. yaml_value(state.thinking_level),
		"access: " .. yaml_value(state.access_mode),
		"integration: " .. yaml_value(state.integration_mode),
		"project: " .. yaml_value(state.workspace and state.workspace.project),
		"workspace: " .. yaml_value(cwd),
	}
	vim.list_extend(lines, {
		"host: " .. yaml_value(state.host_name),
		"connection: " .. yaml_value(state.connection_status),
		"client: " .. yaml_value(state.client_status),
	})
	table.insert(lines, "---")
	return lines
end

function M.metadata_end(ctx)
	local state = ctx.state
	if not ctx.buffer.valid(state.transcript_buf) then
		return nil
	end
	-- Generated metadata fits in this prefix. Longer headers still use the
	-- original delimiter search, without reading transcript bodies in the common case.
	local prefix = vim.api.nvim_buf_get_lines(state.transcript_buf, 0, 32, false)
	if prefix[1] ~= "---" then
		return nil
	end
	for index = 2, #prefix do
		if prefix[index] == "---" then return index end
	end
	local lines = vim.api.nvim_buf_get_lines(state.transcript_buf, #prefix, -1, false)
	for index, line in ipairs(lines) do
		if line == "---" then return #prefix + index end
	end
	return nil
end

function M.win_valid(ctx)
	local state = ctx.state
	state.transcript_win = buffer.find_window(state.transcript_buf, state.transcript_win)
	return state.transcript_win ~= nil
end

function M.is_focused(ctx)
	return buffer.window_matches(vim.api.nvim_get_current_win(), ctx.state.transcript_buf)
end

function M.preserve_view(ctx, callback)
	local buf = ctx.state.transcript_buf
	local views = {}
	for _, win in ipairs(vim.api.nvim_list_wins()) do
		if buffer.window_matches(win, buf) then
			views[win] = vim.api.nvim_win_call(win, vim.fn.winsaveview)
		end
	end
	callback()

	for win, view in pairs(views) do
		if buffer.window_matches(win, buf) then
			view.lnum = math.min(view.lnum, vim.api.nvim_buf_line_count(buf))
			vim.api.nvim_win_call(win, function()
				local header = vim.fn.foldclosed(view.lnum)
				if header ~= -1 and header ~= view.lnum then
					view.lnum, view.col, view.curswant = header, 0, 0
				end
				vim.api.nvim_win_set_cursor(win, { view.lnum, view.col })
				vim.fn.winrestview(view)
			end)
		end
	end
end

local function lines_equal(left, right)
	if #left ~= #right then
		return false
	end
	for index, line in ipairs(left) do
		if line ~= right[index] then
			return false
		end
	end
	return true
end

function M.update_metadata(ctx)
	local state = ctx.state
	if not ctx.buffer.valid(state.transcript_buf) then
		return
	end
	local end_line = M.metadata_end(ctx)
	local lines = M.metadata_lines(ctx)
	if end_line then
		local current = vim.api.nvim_buf_get_lines(state.transcript_buf, 0, end_line, false)
		if lines_equal(current, lines) then
			return
		end
	end
	local quote_cache = state.transcript_quote_cache
	local tick = vim.api.nvim_buf_get_changedtick(state.transcript_buf)
	M.preserve_view(ctx, function()
		ctx.buffer.set_modifiable(state.transcript_buf, true)
		if end_line then
			vim.api.nvim_buf_set_lines(state.transcript_buf, 0, end_line, false, lines)
		else
			vim.api.nvim_buf_set_lines(state.transcript_buf, 0, 0, false, lines)
		end
		ctx.buffer.set_modifiable(state.transcript_buf, false)
	end)
	-- Equal-height metadata replacements leave body decorations and folds intact.
	if end_line == #lines then
		local updated = vim.api.nvim_buf_get_changedtick(state.transcript_buf)
		if quote_cache and quote_cache.buf == state.transcript_buf and quote_cache.tick == tick then quote_cache.tick = updated end
		for _, win in ipairs(vim.api.nvim_list_wins()) do
			local folds = vim.w[win].pi_transcript_folds
			if buffer.window_matches(win, state.transcript_buf) and folds and folds.buf == state.transcript_buf and folds.tick == tick then
				folds.tick = updated
				vim.w[win].pi_transcript_folds = folds
			end
		end
	end
end

local function tool_summary_rows(state, preview)
	local rows = {}
	local function add(line, output_id, stats)
		local output = state.tool_outputs[output_id]
		rows[line] = {
			highlight = tool_output.summary_highlight(state, output_id),
			edit_stats = stats and output and output.name == "edit" or false,
		}
	end
	for _, item in ipairs(state.transcript_items or {}) do
		if item.kind == "activity" then
			rows[item.start_line] = { highlight = "PiActivityQuote", segments = item.segments,
				chevron = not preview and vim.fn.foldclosed(item.start_line) == -1
					and activity.open_icon or activity.closed_icon }
			if not preview then
				for _, child in ipairs(item.children) do
					if child.kind == "tool" then add(child.start_line, child.output_id, true) end
				end
			end
		end
	end
	return rows
end

local function apply_edit_stat_highlights(buf, line_index, line)
	local stats_start, _, add_count, remove_count = line:find("%+(%d+)/%-(%d+) · [^·]+$")
	if not stats_start then
		return
	end
	local add_start = stats_start
	local add_end = add_start + #add_count
	local remove_start = add_end + 2
	local remove_end = remove_start + #remove_count
	local _, block_separator_end = line:find(" · ", remove_end + 1, true)
	if not block_separator_end then
		return
	end
	local block_start = block_separator_end + 1
	vim.api.nvim_buf_set_extmark(buf, quote_ns, line_index - 1, add_start - 1, {
		end_col = add_end,
		hl_group = "PiEditAdd",
		priority = 325,
	})
	vim.api.nvim_buf_set_extmark(buf, quote_ns, line_index - 1, remove_start - 1, {
		end_col = remove_end,
		hl_group = "PiEditDelete",
		priority = 325,
	})
	vim.api.nvim_buf_set_extmark(buf, quote_ns, line_index - 1, block_start - 1, {
		end_col = #line,
		hl_group = "PiEditBlockCount",
		priority = 325,
	})
end

function M.apply_quote_highlights_to_buffer(buf, state, opts)
	if type(buf) ~= "number" or not vim.api.nvim_buf_is_valid(buf) then
		return
	end

	local tick = vim.api.nvim_buf_get_changedtick(buf)
	local preview = opts and opts.preview
	interactive_transcripts[buf] = not preview and state or nil
	local rows = {}
	if state then
		local win = not preview and buffer.find_window(buf, opts and opts.win or state.transcript_win)
		if win == vim.api.nvim_get_current_win() then
			rows = tool_summary_rows(state, false)
		elseif win then
			rows = vim.api.nvim_win_call(win, function() return tool_summary_rows(state, false) end)
		else
			rows = tool_summary_rows(state, true)
		end
	end
	local previous = state and state.transcript_quote_cache
	if previous and previous.buf == buf and previous.tick == tick
		and vim.deep_equal(previous.rows, rows) then return end
	vim.api.nvim_buf_clear_namespace(buf, quote_ns, 0, -1)
	local lines = vim.api.nvim_buf_get_lines(buf, 0, -1, false)
	for index, line in ipairs(lines) do
		local row = rows[index]
		local highlight = row and row.highlight
		if not highlight and line:find("> 󱌽 ", 1, true) == 1 then
			highlight = "PiThinkingQuote"
		elseif not highlight and line:find("> 󰗨 Session compacted here", 1, true) == 1 then
			highlight = "PiThinkingQuote"
		elseif not highlight and line:find("> 󰢱 Using skill:", 1, true) == 1 then
			highlight = "PiSkillQuote"
		end
		if highlight then
			vim.api.nvim_buf_set_extmark(buf, quote_ns, index - 1, 0, {
				end_col = #line,
				hl_group = highlight,
				priority = 250,
			})
			vim.api.nvim_buf_set_extmark(buf, quote_ns, index - 1, 0, {
				virt_text = { { "▋", "PiQuoteBar" } },
				virt_text_pos = "overlay",
				priority = 300,
			})
			if row and row.edit_stats then
				apply_edit_stat_highlights(buf, index, line)
			end
			if row and row.chevron then
				vim.api.nvim_buf_set_extmark(buf, quote_ns, index - 1, 2, {
					virt_text = { { row.chevron .. " ", highlight } },
					virt_text_pos = "inline",
					priority = 300,
				})
			end
			for _, segment in ipairs(row and row.segments or {}) do
				local first, last, group = unpack(segment)
				if group then
					vim.api.nvim_buf_set_extmark(buf, quote_ns, index - 1, first, {
						end_col = last,
						hl_group = group,
						priority = 325,
					})
				end
			end
			local failure_start = line:find("✗ failed", 1, true)
				or line:find("✗ exited ", 1, true)
				or line:find("✗ sandbox blocked", 1, true)
				or line:find("%d+ failed$")
			if failure_start then
				vim.api.nvim_buf_set_extmark(buf, quote_ns, index - 1, failure_start - 1, {
					end_col = #line,
					hl_group = "DiagnosticError",
					priority = 325,
				})
			end
		end
	end
	if state then state.transcript_quote_cache = { buf = buf, tick = tick, rows = rows } end
end

-- Native fold commands can leave the cursor in place, so CursorMoved is not
-- enough. SafeState runs after the complete command, before waiting for input.
vim.api.nvim_create_autocmd("SafeState", {
	callback = function()
		local win = vim.api.nvim_get_current_win()
		local buf = vim.api.nvim_win_get_buf(win)
		local state = interactive_transcripts[buf]
		if not state then return end
		local cursor = vim.api.nvim_win_get_cursor(win)
		local header = vim.fn.foldclosed(cursor[1])
		if header ~= -1 and header ~= cursor[1] then
			vim.api.nvim_win_set_cursor(win, { header, 0 })
		end
		M.apply_quote_highlights_to_buffer(buf, state, { win = win })
	end,
})
vim.api.nvim_create_autocmd("BufWipeout", {
	callback = function(event) interactive_transcripts[event.buf] = nil end,
})

function M.apply_quote_highlights(ctx)
	local state = ctx.state
	if not ctx.buffer.valid(state.transcript_buf) then
		return
	end
	M.apply_quote_highlights_to_buffer(state.transcript_buf, state)
end

function M.render(ctx)
	local state = ctx.state
	if state.frontend_visible == false then return end
	if not ctx.buffer.valid(state.transcript_buf) then
		return
	end
	if not M.win_valid(ctx) then
		return
	end

	if state.transcript_render_scheduled then return end
	state.transcript_render_scheduled = true
	vim.schedule(function()
		state.transcript_render_scheduled = false
		-- Coalesced requests may target a buffer recreated before this callback.
		local buf = state.transcript_buf
		if state.frontend_visible ~= false and ctx.buffer.valid(buf) and M.win_valid(ctx) then
			local pending = state.pending_transcript_scroll
			-- Check navigation before folds can change the saved viewport.
			if pending and (pending.buf ~= buf or not buffer.window_matches(pending.win, buf)
				or M.is_focused(ctx) or not vim.deep_equal(pending.view,
					vim.api.nvim_win_call(pending.win, vim.fn.winsaveview))) then
				state.pending_transcript_scroll = nil
				pending = nil
			end
			M.preserve_view(ctx, function()
				for _, win in ipairs(vim.api.nvim_list_wins()) do
					if buffer.window_matches(win, buf) then
						activity.apply_folds(state, win)
					end
				end
				markdown_render.render(buf, state.transcript_win, { latex = true, event = "PiNvim" })
				M.apply_quote_highlights(ctx)
			end)
			if pending and state.pending_transcript_scroll == pending then
				-- Folding is layout work, not user navigation. Keep the correction
				-- valid until the scheduled Markdown render finishes.
				pending.view = vim.api.nvim_win_call(pending.win, vim.fn.winsaveview)
			end
		end
	end)
end

local function align_bottom(buf, win)
	vim.api.nvim_win_set_cursor(win, { vim.api.nvim_buf_line_count(buf), 0 })
	-- Inside win_call, redraw paints the window's tab over the visible one.
	local visible = vim.api.nvim_win_get_tabpage(win) == vim.api.nvim_get_current_tabpage()
	vim.api.nvim_win_call(win, function()
		-- Reveal the end even when the last line wraps beyond the window.
		vim.cmd("noautocmd normal! $zb")
		-- Resolve wrapped-line skipcol while this window is current.
		if visible then vim.cmd("redraw") end
	end)
end

function M.is_at_bottom(ctx)
	if not M.win_valid(ctx) then return false end
	local win = ctx.state.transcript_win
	return vim.api.nvim_win_call(win, function()
		local view = vim.fn.winsaveview()
		local height = vim.api.nvim_win_get_height(win)
		local remaining = vim.api.nvim_win_text_height(win, {
			start_row = view.topline - 1, start_vcol = view.skipcol, max_height = height + 1,
		})
		return remaining.all + view.topfill <= height
	end)
end

function M.update_lines(ctx, lines)
	local buf = ctx.state.transcript_buf
	if not ctx.buffer.valid(buf) then return end
	local follow = not M.is_focused(ctx) and M.is_at_bottom(ctx)
	-- Metadata updates do not count as new transcript content.
	M.update_metadata(ctx)
	local tick = vim.api.nvim_buf_get_changedtick(buf)
	M.preserve_view(ctx, function() buffer.update_lines(buf, lines) end)
	if follow and vim.api.nvim_buf_get_changedtick(buf) ~= tick then
		M.scroll_to_bottom(ctx)
	end
end

function M.scroll_to_bottom_unless_focused(ctx)
	if not M.is_focused(ctx) then
		M.scroll_to_bottom(ctx)
	end
end

function M.finish_pending_scroll(ctx)
	local state = ctx.state
	if state.frontend_visible == false then return end
	local pending = state.pending_transcript_scroll
	-- Consume before moving the view: rendering caused by the scroll must not
	-- turn this one-shot alignment into a persistent auto-follow mode.
	state.pending_transcript_scroll = nil
	if pending and pending.buf == state.transcript_buf
		and buffer.window_matches(pending.win, pending.buf) and not M.is_focused(ctx) then
		local view = vim.api.nvim_win_call(pending.win, vim.fn.winsaveview)
		-- A render must not finish an old alignment after the user navigated.
		if vim.deep_equal(view, pending.view) then align_bottom(pending.buf, pending.win) end
	end
end

function M.scroll_to_bottom(ctx)
	local state = ctx.state
	if state.frontend_visible == false then return end
	if M.win_valid(ctx) and ctx.buffer.valid(state.transcript_buf) then
		align_bottom(state.transcript_buf, state.transcript_win)
		state.pending_transcript_scroll = {
			buf = state.transcript_buf, win = state.transcript_win,
			view = vim.api.nvim_win_call(state.transcript_win, vim.fn.winsaveview),
		}
	end
end

function M.apply_collected_transcript_items(ctx, items)
	ctx.state.transcript_items = items or {}
end

function M.transcript_item_at_line(ctx, line)
	return activity.item_at_line(ctx.state.transcript_items, line)
end

function M.open_item_under_cursor(ctx, resources)
	if require("pi-integration.utils.markdown-links").follow(nil, resources) then return end
	local item = M.transcript_item_at_line(ctx, vim.api.nvim_win_get_cursor(0)[1])
	if not item then return end
	local inspect = { state = ctx.state, ui = ctx.ui, resources = resources,
		window = { parent = vim.api.nvim_get_current_win() } }
	if item.kind == "activity" then activity.toggle(ctx, item); M.render(ctx)
	elseif item.kind == "tool" then tool_output.open_float(inspect, item.output_id)
	elseif item.kind == "thinking" then require("pi-integration.thinking-output").open_float(inspect, item.output_id)
	elseif item.kind == "compaction" then require("pi-integration.compaction-output").open_float(inspect, item)
	elseif item.kind == "skill" then require("pi-integration.skills").open_float(inspect, item.output_id) end
end

return M
