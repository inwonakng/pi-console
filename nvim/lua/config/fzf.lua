local fzf_opts = {
	default = {
		["--no-scrollbar"] = true,
		["--pointer"] = "> ",
		["--gap"] = 0,
		["--info"] = "inline-right",
	},
}

local fzf_keymap = {
	builtin = {
		-- Pickers are never hidden or resumed.
		["<C-z>"] = false,
		["<M-Esc>"] = false,
		["<C-f>"] = "preview-page-down",
		["<C-b>"] = "preview-page-up",
	},
	fzf = {
		["ctrl-a"] = "toggle-all",
		["ctrl-d"] = "half-page-down",
		["ctrl-u"] = "half-page-up",
		["ctrl-f"] = "preview-page-down",
		["ctrl-b"] = "preview-page-up",
		["ctrl-z"] = "abort",
		["ctrl-l"] = "clear-multi",
	},
}

local function disable_picker_clicks(event)
	-- Keep clicks from leaving terminal-input mode; leave wheel scrolling alone.
	for _, key in ipairs({ "<LeftMouse>", "<LeftDrag>", "<LeftRelease>", "<2-LeftMouse>", "<3-LeftMouse>", "<4-LeftMouse>" }) do
		vim.keymap.set("t", key, "<Nop>", { buffer = event.bufnr, nowait = true })
	end
end

local fzf_winopts = {
	default = {
		on_create = disable_picker_clicks,
		border = "none",
		title = false,
		height = 1.0,
		width = 1.0,
		row = 1.0,
		col = 0,
		preview = {
			layout = "vertical",
			vertical = "up:60%",
			border = "none",
			title = false,
			winopts = {
				cursorline = false,
			},
		},
	},
}

local function select_label(prompt)
	local label = vim.trim(prompt or "Select")
	label = vim.trim(label:gsub("%s*[>:]%s*$", ""))
	return label ~= "" and label or "Select"
end

local function select_prompt(prompt)
	return select_label(prompt) .. " > "
end

local function preview_rows(text, width)
	local buf = vim.api.nvim_create_buf(false, true)
	vim.bo[buf].bufhidden = "wipe"
	vim.api.nvim_buf_set_lines(buf, 0, -1, false, vim.split(text, "\n", { plain = true }))
	local win = vim.api.nvim_open_win(buf, false, {
		relative = "editor",
		row = 0,
		col = 0,
		width = width,
		height = 1,
		style = "minimal",
		hide = true,
		noautocmd = true,
	})
	vim.wo[win].wrap = true
	vim.wo[win].linebreak = true
	vim.wo[win].breakindent = true
	local rows = vim.api.nvim_win_text_height(win, { start_row = 0, end_row = -1 }).all
	vim.api.nvim_win_close(win, true)
	return rows
end

local preview_ns = vim.api.nvim_create_namespace("PiSelectPreview")
vim.api.nvim_set_hl(0, "PiSelectTitle", { bold = true, default = true })

local function highlight_approval_preview(buf, header, padding, filetype)
	for i, field in ipairs(header) do
		local row = padding + i - 1
		local key, value = field[1] .. ":", field[2]
		vim.api.nvim_buf_set_extmark(buf, preview_ns, row, 0, {
			end_col = #key,
			hl_group = "PiApprovalKey",
		})
		vim.api.nvim_buf_set_extmark(buf, preview_ns, row, #key + 1, {
			end_col = #key + 1 + #value,
			hl_group = "PiApprovalValue",
		})
	end
	-- Keep the buffer plain text so fzf-lua/FileType cannot highlight the header
	-- as shell/JSON/diff. Include the normal Vim syntax only in the body region.
	vim.api.nvim_buf_call(buf, function()
		vim.cmd("syntax clear")
		vim.b[buf].current_syntax = nil
		if
			type(filetype) == "string"
			and filetype ~= "text"
			and filetype:match("^[%w_]+$")
			and #vim.fn.globpath(vim.o.runtimepath, "syntax/" .. filetype .. ".vim", false, true) > 0
		then
			vim.cmd("syntax include @PiApprovalBody syntax/" .. filetype .. ".vim")
			local start = padding + #header + 2
			vim.cmd(
				"syntax region PiApprovalBody start=/\\%" .. start .. "l/ end=/\\%$/ contains=@PiApprovalBody keepend"
			)
			vim.cmd("syntax sync fromstart")
		end
		vim.b[buf].current_syntax = "pi_approval"
	end)
end

local function set_preview_text(buf, text, padding, header, filetype, title, highlight)
	local lines = {}
	for _ = 1, padding do
		lines[#lines + 1] = ""
	end
	vim.list_extend(lines, vim.split(text, "\n", { plain = true }))
	vim.bo[buf].modifiable = true
	vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
	vim.bo[buf].modifiable = false
	vim.api.nvim_buf_clear_namespace(buf, preview_ns, 0, -1)
	local title_lines = title and vim.split(title, "\n", { plain = true }) or {}
	if header then
		highlight_approval_preview(buf, header, padding + (title and #title_lines + 1 or 0), filetype)
	end
	for i, line in ipairs(title_lines) do
		vim.api.nvim_buf_set_extmark(buf, preview_ns, padding + i - 1, 0, {
			end_col = #line,
			hl_group = "PiSelectTitle",
		})
	end
	if highlight then
		highlight(buf)
	end
end

local function text_preview_item(text, filetype, padding, header, title, highlight)
	local buf = vim.api.nvim_create_buf(false, true)
	vim.bo[buf].buftype = "nofile"
	vim.bo[buf].bufhidden = "wipe"
	vim.bo[buf].swapfile = false
	vim.bo[buf].filetype = header and "text" or filetype or "text"
	set_preview_text(buf, text, padding, header, filetype, title, highlight)

	return {
		buf = buf,
		-- Anchor at the padded first row so fzf-lua does not scroll padding away.
		pos = { 1, 1 },
	}
end

local function prompt_needs_preview(prompt)
	if type(prompt) ~= "string" or prompt == "" then
		return false
	end
	return prompt:find("\n", 1, true) ~= nil or vim.fn.strdisplaywidth(prompt) > math.max(1, vim.o.columns - 8)
end

local function add_prompt_preview(select_opts)
	if select_opts.previewer or type(select_opts.preview_item) == "function" then
		return true
	end

	local source = select_opts.preview_text
	if type(source) ~= "string" and type(source) ~= "function" then
		source = prompt_needs_preview(select_opts.prompt) and select_opts.prompt or nil
	end
	if not source then
		return false
	end

	local header, title = select_opts.preview_header, select_opts.preview_title
	local prefix = title or ""
	if header then
		local lines = {}
		for _, field in ipairs(header) do
			lines[#lines + 1] = field[1] .. ": " .. field[2]
		end
		prefix = prefix .. (prefix ~= "" and "\n\n" or "") .. table.concat(lines, "\n")
	end
	local preview, preview_padding, preview_text
	select_opts.pi_preview_text = function(item)
		local text = type(source) == "function" and source(item) or source
		return prefix .. (prefix ~= "" and text ~= "" and "\n\n" or "") .. text
	end
	select_opts.preview_item = function(item)
		local text = select_opts.pi_preview_text(item)
		local padding = 0
		local win = require("fzf-lua").win.__SELF()
		if not select_opts.pi_input_win and win and win:validate_preview() then
			local height = vim.api.nvim_win_get_height(win.preview_winid)
			local width = vim.api.nvim_win_get_width(win.preview_winid)
			padding = math.max(0, math.floor((height - preview_rows(text, width)) / 2))
		end
		if not preview or not vim.api.nvim_buf_is_valid(preview.buf) then
			preview = text_preview_item(text, select_opts.preview_filetype, padding, header, title, select_opts.preview_highlight)
		elseif padding ~= preview_padding or text ~= preview_text then
			set_preview_text(preview.buf, text, padding, header, select_opts.preview_filetype, title, select_opts.preview_highlight)
		end
		preview_padding, preview_text = padding, text
		return preview
	end
	return true
end

local fzf = require("fzf-lua")

-- Match fzf's word wrapping, including its narrower continuation rows.
local function option_rows(text, width)
	text = require("fzf-lua.utils").strip_ansi_coloring(text)
	local rows = 0
	for _, line in ipairs(vim.split(text, "\n", { plain = true })) do
		local continuation = false
		while true do
			rows = rows + 1
			local cols = math.max(1, width - (continuation and 4 or 0))
			if vim.fn.strdisplaywidth(line) <= cols then
				break
			end
			local fit, word_break = 0, 0
			for i = 1, vim.fn.strchars(line) do
				local prefix = vim.fn.strcharpart(line, 0, i)
				if vim.fn.strdisplaywidth(prefix) > cols then
					break
				end
				fit = i
				if prefix:match("[ \t]$") then
					word_break = i
				end
			end
			line = vim.fn.strcharpart(line, math.max(1, word_break > 0 and word_break or fit))
			continuation = true
		end
	end
	return rows
end

-- Ordinary preview pickers cover the screen. RPC pickers use the input pane.
local function size_select_picker(select_opts, items, winopts)
	local input_win = select_opts.pi_input_win
	local embedded = input_win and vim.api.nvim_win_is_valid(input_win)
	local available = embedded and vim.api.nvim_win_get_height(input_win) or math.max(1, vim.o.lines - vim.o.cmdheight)
	local width = embedded and vim.api.nvim_win_get_width(input_win) or vim.o.columns
	local rows = 0
	local num_width = math.max(1, math.ceil(math.log10(math.max(1, #items))))
	for i, item in ipairs(items) do
		local label = select_opts.format_item and select_opts.format_item(item) or tostring(item)
		local entry = string.format("%" .. num_width .. "d. %s", i, label)
		-- fzf reserves two columns for the pointer and one for the marker.
		rows = rows + option_rows(entry, math.max(1, width - 3))
	end
	if embedded then
		local preview_rows_needed = 0
		if select_opts.pi_preview_text then
			for _, item in ipairs(items) do
				preview_rows_needed = math.max(preview_rows_needed, preview_rows(select_opts.pi_preview_text(item), width))
			end
		end
		local preview_height = preview_rows_needed > 0 and math.min(10, math.max(2, preview_rows_needed)) or 0
		local transcript_win = select_opts.pi_transcript_win
		if transcript_win and vim.api.nvim_win_is_valid(transcript_win) then
			local input_pos = vim.api.nvim_win_get_position(input_win)
			local transcript_pos = vim.api.nvim_win_get_position(transcript_win)
			-- Only resize vertically stacked panes; preserve side-by-side geometry.
			if input_pos[2] == transcript_pos[2] and width == vim.api.nvim_win_get_width(transcript_win) then
				local total = available + vim.api.nvim_win_get_height(transcript_win)
				local height = math.min(math.max(3, math.floor(total * 0.5)), rows + 2 + preview_height)
				if select_opts.pi_resize_input then select_opts.pi_resize_input(math.max(3, height))
				else vim.api.nvim_win_set_height(input_win, math.max(3, height)) end
				available = vim.api.nvim_win_get_height(input_win)
			end
		end
		local options_height = math.min(rows + 2, math.max(3, available - preview_height))
		local preview = math.min(preview_height, available - options_height)
		winopts.preview.hidden = preview_rows_needed == 0 or preview < 2
		if not winopts.preview.hidden then winopts.preview.vertical = "up:" .. preview end
		return
	end
	local chrome = 2 -- search/prompt plus separator; count is inline with the prompt
	local limit = math.min(available, math.max(chrome + 1, math.floor(available * 0.6)))
	local options_height = math.min(limit, math.max(1, rows) + chrome)
	local preview = available - options_height
	winopts.row = 1.0 -- options always end at the bottom, without trailing space
	if (select_opts.previewer or type(select_opts.preview_item) == "function") and preview >= 2 then
		winopts.height = 1.0
		-- An absolute size of 1 means 100% to fzf-lua; use at least two rows.
		winopts.preview.vertical = "up:" .. preview
		winopts.preview.hidden = false
		if select_opts.pi_select_layout == "compact" then
			winopts.preview.winopts.number = false
		end
	else
		winopts.height = options_height
		winopts.preview.hidden = true
	end
end

local function update_select_layout(win)
	if not win or not win._o._ui_select then
		return
	end
	size_select_picker(win._o._ui_select, win._o._items, win._o.winopts)
	local hidden = win._o.winopts.preview.hidden
	if hidden ~= win.preview_hidden then
		win.preview_hidden = hidden
		if hidden then
			win:close_preview(true)
		elseif not win:hidden() then
			win:redraw_preview()
		end
	end
end

-- Run before fzf-lua's resize handler so its absolute preview size still fits.
-- The pinned fzf-lua provider retains these items/options on the live picker.
vim.api.nvim_create_autocmd("VimResized", {
	group = vim.api.nvim_create_augroup("PiSelectPicker", { clear = true }),
	callback = function()
		update_select_layout(fzf.win.__SELF())
	end,
})

fzf.register_ui_select(function(select_opts, items)
	local winopts = vim.deepcopy(fzf_winopts.default)
	local picker_fzf_opts = vim.deepcopy(fzf_opts.default)
	local has_prompt_preview = add_prompt_preview(select_opts)
	local picker_keymap = vim.deepcopy(fzf_keymap)

	picker_fzf_opts["--wrap"] = "word"
	picker_fzf_opts["--wrap-sign"] = "    "
	picker_fzf_opts["--highlight-line"] = true
	picker_fzf_opts["--no-hscroll"] = true
	picker_fzf_opts["--tabstop"] = vim.o.tabstop

	if has_prompt_preview then
		winopts.preview = {
			layout = "vertical",
			vertical = "up:40%",
			border = "none",
			title = false,
			wrap = true,
			winopts = {
				linebreak = true,
				breakindent = true,
				cursorline = false,
			},
		}
	end
	if select_opts.pi_input_win then
		-- Reuse this window, including a modified draft, without :enew or a new split.
		winopts.split = function() end
		winopts.preview.winopts.number = false
		picker_keymap.fzf["esc"] = "ignore"
		picker_keymap.fzf["ctrl-c"] = "ignore"
		picker_keymap.fzf["ctrl-z"] = "ignore"
	else
		size_select_picker(select_opts, items, winopts)
	end
	winopts.on_create = function(event)
		if not select_opts.pi_input_win then disable_picker_clicks(event) end
		-- Reused fzf windows inherit the previous picker's preview visibility.
		-- Restore this select's layout before fzf-lua renders its preview.
		local win = fzf.win.__SELF()
		update_select_layout(win)
		if win then win:redraw() end
		if type(select_opts.on_create) == "function" then
			select_opts.on_create(event)
		end
	end
	if type(select_opts.on_close) == "function" then
		winopts.on_close = select_opts.on_close
	end
	return {
		prompt = has_prompt_preview and not winopts.preview.hidden and "Choose > " or select_prompt(select_opts.prompt),
		winopts = winopts,
		fzf_opts = picker_fzf_opts,
		keymap = picker_keymap,
		previewer = select_opts.previewer,
		pi_request_id = select_opts.pi_request_id,
		pi_on_failure = select_opts.pi_on_failure,
		pi_select_layout = select_opts.pi_select_layout,
	}
end)

-- Guard both vim.ui.select and direct providers (including the session picker).
-- Check before replacing fzf-lua's singleton so a pending RPC dialog survives.
local pending_picker = require("pi-integration.pending-picker")
local ui_select = vim.ui.select
vim.ui.select = function(items, opts, on_choice)
	if not pending_picker.can_open(opts.pi_request_id) then
		on_choice(nil)
		return
	end
	return ui_select(items, opts, on_choice)
end
local core = require("fzf-lua.core")
local run_fzf = core.fzf
core.fzf = function(contents, opts)
	if not pending_picker.can_open(opts and opts.pi_request_id) then
		return nil, nil
	end
	local selected, code = run_fzf(contents, opts)
	-- A killed/failed fzf process does not dispatch vim.ui.select's callback.
	if not selected and opts and opts.pi_on_failure then opts.pi_on_failure() end
	return selected, code
end

fzf.setup({
	-- Disable hide-on-cancel/accept and replay for every provider, including
	-- session history and pending RPC dialogs.
	defaults = { no_hide = true, no_resume = true },
	fzf_colors = true,
	fzf_opts = fzf_opts.default,
	keymap = fzf_keymap,
	winopts = fzf_winopts.default,
})
