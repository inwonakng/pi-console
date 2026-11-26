-- Paired side-conversation splits. Ownership and submissions stay in the frontend.
local floats = require("pi-integration.floats")
local buffer = require("pi-integration.utils.buffer")
local markdown = require("pi-integration.markdown-render")
local messages = require("pi-integration.messages")
local transcript = require("pi-integration.transcript")
local M = {}
local render_state, render_cache = { show_nested_tools = false }, {}
local function render_context()
	return { state = render_state, buffer = buffer,
		ui = { notify = function(...) require("pi-integration.logs").notify(...) end },
		notices = { empty_session = "Send a message to begin." },
		transcript = { metadata_lines = function() return {} end } }
end
local transcript_win, input_win, return_win, sizes
local transcript_view, input_view, displayed_buf, displayed_input_buf, picker_height
local right_sizes, bottom_sizes = {}, {}
local help_state = {}
local activity, activity_timer
local working_frames = require("pi-integration.status-icons").working_frames
local activity_interval_ms = 250
local window_group = vim.api.nvim_create_augroup("PiSideWindows", { clear = true })
local winhl = table.concat({
	"Normal:PiSideNormal", "NormalNC:PiSideNormal", "EndOfBuffer:PiSideNormal", "SignColumn:PiSideNormal",
	"Folded:PiSideNormal", "WinBar:PiSideTitle", "WinBarNC:PiSideTitle",
}, ",")

local function valid(win) return win and vim.api.nvim_win_is_valid(win) end

local function in_current_tab(win)
	return valid(win) and vim.api.nvim_win_get_tabpage(win) == vim.api.nvim_get_current_tabpage()
end

function M.visible() return in_current_tab(transcript_win) and in_current_tab(input_win) end
function M.input_window() return valid(input_win) and input_win or nil end
function M.transcript_window() return valid(transcript_win) and transcript_win or nil end
function M.contains_window(win) return win ~= nil and (win == transcript_win or win == input_win) end

function M.set_title(title)
	if not valid(transcript_win) then return end
	local label = type(title) == "string" and title ~= "" and title:gsub("[%c]", " "):gsub("%%", "%%%%") or "Chat"
	vim.wo[transcript_win].winbar = " Side · " .. label .. " · <leader>? keys"
end

-- The input pane's bottom row shows side work while it runs.
function M.input_statusline()
	if not activity then return "%#PiSideNormal#%=" end
	local tick = math.floor(vim.uv.hrtime() / (activity_interval_ms * 1000000))
	local frame = working_frames[(tick % #working_frames) + 1]
	return "%#PiSideActivity# " .. frame .. " %#PiSideTitle#" .. activity:gsub("%%", "%%%%") .. "%#PiSideNormal#%="
end

function M.set_activity(label)
	label = type(label) == "string" and label ~= "" and label:gsub("[%c]", " ") or nil
	if label == activity then return end
	activity = label
	if activity and not activity_timer then
		activity_timer = vim.uv.new_timer()
		activity_timer:start(activity_interval_ms, activity_interval_ms, vim.schedule_wrap(function()
			if activity and valid(input_win) then vim.api.nvim__redraw({ win = input_win, statusline = true }) end
		end))
	elseif not activity and activity_timer then
		activity_timer:stop(); activity_timer:close(); activity_timer = nil
	end
	if valid(input_win) then vim.api.nvim__redraw({ win = input_win, statusline = true }) end
end

function M.adjust_input_height(amount)
	if not valid(transcript_win) or not valid(input_win) or amount == 0 then return end
	-- Resize the boundary between the two side panes, never the footer or main input.
	local min_height = math.max(1, vim.o.winminheight)
	local transcript_min = min_height + (vim.wo[transcript_win].winbar ~= "" and 1 or 0)
	local input_min = min_height + (vim.wo[input_win].winbar ~= "" and 1 or 0)
	amount = math.min(amount, math.max(0, vim.api.nvim_win_get_height(transcript_win) - transcript_min))
	amount = math.max(amount, -math.max(0, vim.api.nvim_win_get_height(input_win) - input_min))
	vim.api.nvim_win_call(transcript_win, function() vim.fn.win_move_statusline(transcript_win, -amount) end)
end

function M.resize_input(height)
	if not valid(input_win) then return end
	local current = vim.api.nvim_win_get_height(input_win)
	if height then
		picker_height = picker_height or current
		M.adjust_input_height(math.max(height, picker_height) - current)
	elseif picker_height then
		M.adjust_input_height(picker_height - current)
		picker_height = nil
	end
end

local function picker_owns_input()
	return require("pi-integration.pending-picker").owns_window(input_win)
end

local function close_pair(closing_win)
	local focus_return = M.contains_window(vim.api.nvim_get_current_win()) and in_current_tab(return_win)
	local windows = { input_win, transcript_win }
	vim.api.nvim_clear_autocmds({ group = window_group, event = "WinClosed" })
	input_win, transcript_win, picker_height = nil, nil, nil
	local function close_windows()
		for index = 1, 2 do
			local win = windows[index]
			floats.close_descendants(win)
			if win ~= closing_win and valid(win) then vim.api.nvim_win_close(win, true) end
		end
	end
	if closing_win then
		-- Let :q or :tabclose finish before closing the other pane.
		vim.schedule(close_windows)
	else
		close_windows()
		if focus_return then vim.api.nvim_set_current_win(return_win) end
	end
end

function M.hide(force, closing_win)
	if not force and picker_owns_input() then return false end
	if valid(input_win) then
		sizes.input = picker_height or vim.api.nvim_win_get_height(input_win)
		if vim.api.nvim_win_get_buf(input_win) == displayed_input_buf then
			input_view = vim.api.nvim_win_call(input_win, vim.fn.winsaveview)
		end
	end
	if valid(transcript_win) then
		if sizes == right_sizes then sizes.width = vim.api.nvim_win_get_width(transcript_win)
		elseif valid(input_win) then
			-- Keep the full pair's size, excluding any temporary picker expansion.
			sizes.height = vim.api.nvim_win_get_height(transcript_win) + vim.api.nvim_win_get_height(input_win)
		end
		transcript_view = vim.api.nvim_win_call(transcript_win, vim.fn.winsaveview)
	end
	close_pair(closing_win)
	return true
end

vim.api.nvim_create_autocmd("QuitPre", { group = window_group, callback = function()
	if M.contains_window(vim.api.nvim_get_current_win()) and picker_owns_input() then
		error("Resolve the pending Pi action first.")
	end
end })

local function open_pair(transcript_buf, input_buf, state)
	local input_height = sizes.input or 5
	local config = { style = "minimal" }
	if sizes == right_sizes then
		config.split, config.win = "right", -1
		config.width = math.min(sizes.width or math.max(60, math.floor(vim.o.columns * 0.4)), vim.o.columns - 2)
	else
		local footer = state and state.status_win
		config.split, config.win = "below", -1
		if in_current_tab(footer) then config.split, config.win = "above", footer end
		-- The split between transcript and input consumes one row.
		config.height = (sizes.height or math.max(input_height + 3, math.floor(vim.o.lines * 0.4))) + 1
	end
	local main_input = state and state.input_win
	local main_height = in_current_tab(main_input) and vim.api.nvim_win_get_height(main_input)
	transcript_win = vim.api.nvim_open_win(transcript_buf, false, config)
	if state then require("pi-integration.statusline").restore_bars(state) end
	if main_height and vim.api.nvim_win_get_height(main_input) ~= main_height then
		vim.api.nvim_win_set_height(main_input, main_height)
	end
	M.set_title()
	local available = vim.api.nvim_win_get_height(transcript_win)
	local height = math.max(1, math.min(input_height, available - math.max(1, vim.o.winminheight) - 1))
	input_win = vim.api.nvim_open_win(input_buf, true, { split = "below", win = transcript_win, height = height, style = "minimal" })
end

function M.open(transcript_buf, input_buf, resources, state)
	if M.visible() and displayed_buf == transcript_buf then
		vim.api.nvim_set_current_win(input_win)
		return true
	end
	if (valid(transcript_win) or valid(input_win)) and not M.hide() then return false end
	return_win = vim.api.nvim_get_current_win()
	if displayed_buf ~= transcript_buf then
		input_view, transcript_view = nil, nil
		render_state, render_cache = { show_nested_tools = false }, {}
	end
	displayed_buf, displayed_input_buf = transcript_buf, input_buf
	sizes = vim.o.columns >= 110 and right_sizes or bottom_sizes
	local ok, err = pcall(open_pair, transcript_buf, input_buf, state)
	if not ok then
		close_pair()
		require("pi-integration.logs").notify("Could not open side chat: " .. tostring(err), vim.log.levels.WARN)
		return false
	end
	render_state.transcript_buf, render_state.transcript_win = transcript_buf, transcript_win
	vim.keymap.set("n", "<CR>", function()
		transcript.open_item_under_cursor(render_context(), resources)
	end, { buffer = transcript_buf, desc = "Follow link, toggle activity or open output" })
	vim.wo[input_win].winbar = ""
	vim.wo[input_win].winfixheight = true
	for _, win in ipairs({ transcript_win, input_win }) do
		vim.wo[win].wrap, vim.wo[win].linebreak, vim.wo[win].conceallevel = true, true, 2
		vim.wo[win].winhl = winhl
		vim.wo[win].fillchars = win == transcript_win and "stl:─,stlnc:─,eob: " or "stl: ,stlnc: ,eob: "
		vim.wo[win].statusline = win == transcript_win and "%#PiSideBorder#%="
			or "%!v:lua.require'pi-integration.side'.input_statusline()"
		vim.api.nvim_create_autocmd("WinClosed", {
			group = window_group, pattern = tostring(win), once = true,
			callback = function() M.hide(true, win) end,
		})
	end
	for _, buf in ipairs({ transcript_buf, input_buf }) do
		vim.keymap.set("n", "<leader>?", function()
			require("pi-integration.help").toggle_window(help_state, {
				name = "pi://side-help", title = "Side conversation keys", parent = vim.api.nvim_get_current_win(),
				lines = {
					"# Side conversation keys", "",
					"- `<C-CR>` or `<C-s>` sends from the input (normal or insert mode).",
					"- `<C-h/j/k/l>` or `<C-w>h/j/k/l` moves between windows normally.",
					"- `<leader>wr` enters resize mode; `h/l` resize width, `j/k` resize height.",
					"- `<CR>` in the transcript follows a link, toggles an activity, or opens output.",
					"- `q` / `<leader>ps` / `:q` hides both windows, preserving the draft and conversation.",
					"- `<leader>s` / `:PiSides` picks a side chat; Ctrl-x in the picker deletes it.",
					"- `<leader>pn` / `:PiSideNew` starts a new side chat, keeping this chat (normal mode).",
					"- Switching or creating a chat asks before aborting a running side chat.",
					"- `:PiSideAbort` stops only side work.",
					"- Pending questions/approvals use the side input pane and stay visible until answered or cancelled (Ctrl-q).",
					"- `q` / `<Esc>` closes this help; `<Esc>` keeps native behavior in the side windows.",
				},
			})
		end, { buffer = buf, desc = "Side conversation help" })
		vim.keymap.set("n", "<leader>ps", M.hide, { buffer = buf, desc = "Hide side conversation" })
		vim.keymap.set("n", "q", M.hide, { buffer = buf, silent = true, desc = "Hide side conversation" })
	end
	if input_view then vim.api.nvim_win_call(input_win, function() vim.fn.winrestview(input_view) end) end
	if transcript_view then vim.api.nvim_win_call(transcript_win, function() vim.fn.winrestview(transcript_view) end) end
	transcript.render(render_context())
	markdown.render(input_buf, input_win)
	return true
end

function M.render(buf, visible, tools, conversation_id)
	if render_state.conversation_id ~= conversation_id then
		render_state = { show_nested_tools = false, transcript_win = transcript_win, conversation_id = conversation_id }
		render_cache = {}
	end
	render_state.transcript_buf = buf
	local ctx = render_context()
	local lines, items = messages.collect_message_lines(ctx, visible, tools, render_cache)
	local split = {}
	for _, line in ipairs(lines) do
		vim.list_extend(split, vim.split(line, "\n", { plain = true }))
	end
	lines = split
	transcript.apply_collected_transcript_items(ctx, items)
	local preserve = vim.api.nvim_get_current_win() == transcript_win
		or vim.deep_equal(vim.api.nvim_buf_get_lines(buf, 0, -1, false), lines)
	local view = valid(transcript_win) and vim.api.nvim_win_call(transcript_win, vim.fn.winsaveview)
	buffer.update_lines(buf, lines)
	if valid(transcript_win) then
		vim.api.nvim_win_call(transcript_win, function()
			if preserve and view then vim.fn.winrestview(view)
			else
				vim.api.nvim_win_set_cursor(transcript_win, { math.max(1, #lines), 0 })
				vim.cmd("normal! zb")
			end
		end)
		transcript.render(ctx)
	end
end

return M
