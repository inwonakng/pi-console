local fzf_opts = {
	default = {
		["--no-scrollbar"] = true,
		["--no-mouse"] = true,
		["--pointer"] = "> ",
		["--gap"] = 0,
		["--info"] = "inline-right",
	},
}

local fzf_keymap = {
	builtin = {
		-- Only pending Pi dialogs may hide, via their own buffer mappings.
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
	},
}

local saved_mouse

local function disable_mouse_for_fzf()
	if saved_mouse == nil then
		saved_mouse = vim.o.mouse
		vim.o.mouse = ""
	end
end

local function restore_mouse_after_fzf()
	if saved_mouse ~= nil then
		vim.o.mouse = saved_mouse
		saved_mouse = nil
	end
end

local fzf_winopts = {
	default = {
		on_create = disable_mouse_for_fzf,
		on_close = restore_mouse_after_fzf,
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

local approval_ns = vim.api.nvim_create_namespace("PiApprovalPreview")

local function highlight_approval_preview(buf, header, padding, filetype)
	vim.api.nvim_buf_clear_namespace(buf, approval_ns, 0, -1)
	for i, field in ipairs(header) do
		local row = padding + i - 1
		local key, value = field[1] .. ":", field[2]
		vim.api.nvim_buf_set_extmark(buf, approval_ns, row, 0, {
			end_col = #key,
			hl_group = "PiApprovalKey",
		})
		vim.api.nvim_buf_set_extmark(buf, approval_ns, row, #key + 1, {
			end_col = #key + 1 + #value,
			hl_group = "PiApprovalValue",
		})
	end
	-- Keep the buffer plain text so fzf-lua/FileType cannot highlight the header
	-- as shell/JSON/diff. Include the normal Vim syntax only in the body region.
	vim.api.nvim_buf_call(buf, function()
		vim.cmd("syntax clear")
		vim.b[buf].current_syntax = nil
		if type(filetype) == "string" and filetype ~= "text" and filetype:match("^[%w_]+$")
			and #vim.fn.globpath(vim.o.runtimepath, "syntax/" .. filetype .. ".vim", false, true) > 0 then
			vim.cmd("syntax include @PiApprovalBody syntax/" .. filetype .. ".vim")
			local start = padding + #header + 2
			vim.cmd("syntax region PiApprovalBody start=/\\%" .. start .. "l/ end=/\\%$/ contains=@PiApprovalBody keepend")
			vim.cmd("syntax sync fromstart")
		end
		vim.b[buf].current_syntax = "pi_approval"
	end)
end

local function set_preview_text(buf, text, padding, header, filetype)
	local lines = {}
	for _ = 1, padding do
		lines[#lines + 1] = ""
	end
	vim.list_extend(lines, vim.split(text, "\n", { plain = true }))
	vim.bo[buf].modifiable = true
	vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
	vim.bo[buf].modifiable = false
	if header then
		highlight_approval_preview(buf, header, padding, filetype)
	end
end

local function text_preview_item(text, filetype, padding, header)
	local buf = vim.api.nvim_create_buf(false, true)
	vim.bo[buf].buftype = "nofile"
	vim.bo[buf].bufhidden = "wipe"
	vim.bo[buf].swapfile = false
	vim.bo[buf].filetype = header and "text" or filetype or "text"
	set_preview_text(buf, text, padding, header, filetype)

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
	if type(select_opts.preview_item) == "function" then
		return true
	end

	local text = type(select_opts.preview_text) == "string" and select_opts.preview_text or nil
	if not text and prompt_needs_preview(select_opts.prompt) then
		text = select_opts.prompt
	end
	if not text then
		return false
	end

	local header = select_opts.preview_header
	if header then
		local lines = {}
		for _, field in ipairs(header) do
			lines[#lines + 1] = field[1] .. ": " .. field[2]
		end
		text = table.concat(lines, "\n") .. (text ~= "" and ("\n\n" .. text) or "")
	end
	select_opts.preview_text = text
	local preview, preview_padding
	select_opts.preview_item = function()
		local padding = 0
		if select_opts.pi_select_layout == "compact" then
			local win = require("fzf-lua").win.__SELF()
			if win and win:validate_preview() then
				local height = vim.api.nvim_win_get_height(win.preview_winid)
				local width = vim.api.nvim_win_get_width(win.preview_winid)
				padding = math.max(0, math.floor((height - preview_rows(text, width)) / 2))
			end
		end
		if not preview or not vim.api.nvim_buf_is_valid(preview.buf) then
			preview = text_preview_item(text, select_opts.preview_filetype, padding, header)
		elseif padding ~= preview_padding then
			set_preview_text(preview.buf, text, padding, header, select_opts.preview_filetype)
		end
		preview_padding = padding
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

-- Preview pickers cover the screen; plain lists fit their content up to 60%.
local function size_select_picker(select_opts, items, winopts)
	local available = math.max(1, vim.o.lines - vim.o.cmdheight)
	local rows = 0
	local num_width = math.max(1, math.ceil(math.log10(math.max(1, #items))))
	for i, item in ipairs(items) do
		local label = select_opts.format_item and select_opts.format_item(item) or tostring(item)
		local entry = string.format("%" .. num_width .. "d. %s", i, label)
		-- fzf reserves two columns for the pointer and one for the marker.
		rows = rows + option_rows(entry, math.max(1, vim.o.columns - 3))
	end
	local chrome = 2 -- search/prompt plus separator; count is inline with the prompt
	local limit = math.min(available, math.max(chrome + 1, math.floor(available * 0.6)))
	local options_height = math.min(limit, math.max(1, rows) + chrome)
	local preview = available - options_height
	winopts.row = 1.0 -- options always end at the bottom, without trailing space
	if type(select_opts.preview_item) == "function" and preview >= 2 then
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

-- Run before fzf-lua's resize handler so its absolute preview size still fits.
-- The pinned fzf-lua provider retains these items/options on the live picker.
vim.api.nvim_create_autocmd("VimResized", {
	group = vim.api.nvim_create_augroup("PiSelectPicker", { clear = true }),
	callback = function()
		local win = fzf.win.__SELF()
		if win and win._o._ui_select then
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
	size_select_picker(select_opts, items, winopts)
	if type(select_opts.on_create) == "function" then
		winopts.on_create = function(event)
			disable_mouse_for_fzf()
			select_opts.on_create(event)
		end
	end
	if type(select_opts.on_close) == "function" then
		local default_on_close = winopts.on_close
		winopts.on_close = function(...)
			if default_on_close then
				default_on_close(...)
			end
			select_opts.on_close(...)
		end
	end
	return {
		prompt = has_prompt_preview and not winopts.preview.hidden and "Choose > " or select_prompt(select_opts.prompt),
		winopts = winopts,
		fzf_opts = picker_fzf_opts,
		keymap = picker_keymap,
		pi_request_id = select_opts.pi_request_id,
		pi_select_layout = select_opts.pi_select_layout,
	}
end)

-- Guard both vim.ui.select and direct providers (including the session picker).
-- Check before replacing fzf-lua's singleton so a hidden RPC dialog survives.
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
	return run_fzf(contents, opts)
end

fzf.setup({
	-- Disable hide-on-cancel/accept and replay for every provider, including
	-- session history. Pending RPC dialogs explicitly hide/unhide the live UI.
	defaults = { no_hide = true, no_resume = true },
	fzf_colors = true,
	fzf_opts = fzf_opts.default,
	keymap = fzf_keymap,
	winopts = fzf_winopts.default,
})
