local fzf_opts = {
	default = {
		["--no-scrollbar"] = true,
		["--no-mouse"] = true,
		["--pointer"] = "> ",
	},
}

local fzf_keymap = {
	builtin = {
		["<C-f>"] = "preview-page-down",
		["<C-b>"] = "preview-page-up",
	},
	fzf = {
    ["ctrl-a"] = "toggle-all",
		["ctrl-d"] = "half-page-down",
		["ctrl-u"] = "half-page-up",
		["ctrl-f"] = "preview-page-down",
		["ctrl-b"] = "preview-page-up",
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
		border = { "", "-", "", "", "", "", "", "" },
		height = 1.0,
		width = 1.0,
		row = 1.0,
		col = 0,
		preview = {
			layout = "vertical",
			vertical = "up:60%",
			border = "none",
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

local function text_preview_item(text, filetype)
	local lines = vim.split(text, "\n", { plain = true })
	if #lines == 0 then
		lines = { "" }
	end

	local buf = vim.api.nvim_create_buf(false, true)
	vim.bo[buf].buftype = "nofile"
	vim.bo[buf].bufhidden = "wipe"
	vim.bo[buf].swapfile = false
	vim.bo[buf].filetype = filetype or "text"
	vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
	vim.bo[buf].modifiable = false

	return {
		buf = buf,
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

	local preview
	select_opts.preview_item = function()
		if not preview or not vim.api.nvim_buf_is_valid(preview.buf) then
			preview = text_preview_item(text, select_opts.preview_filetype)
		end
		return preview
	end
	return true
end

local fzf = require("fzf-lua")

fzf.register_ui_select(function(select_opts)
	local winopts = vim.deepcopy(fzf_winopts.default)
	local picker_fzf_opts = vim.deepcopy(fzf_opts.default)
	local has_prompt_preview = add_prompt_preview(select_opts)

	picker_fzf_opts["--wrap"] = "word"
	picker_fzf_opts["--wrap-sign"] = "    "
	picker_fzf_opts["--highlight-line"] = true
	picker_fzf_opts["--no-hscroll"] = true

	if has_prompt_preview then
		winopts.height = 0.85
		winopts.preview = {
			layout = "vertical",
			vertical = "up:40%",
			border = "none",
			wrap = true,
			winopts = {
				linebreak = true,
				breakindent = true,
			},
		}
	else
		winopts.height = 0.4
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
	local label = has_prompt_preview and (select_opts.prompt_label or "Select") or select_label(select_opts.prompt)
	winopts.title = " " .. label .. " "
	winopts.title_pos = "left"
	return {
		prompt = has_prompt_preview and "Choose > " or select_prompt(select_opts.prompt),
		winopts = winopts,
		fzf_opts = picker_fzf_opts,
		keymap = fzf_keymap,
		no_hide = select_opts.no_hide,
	}
end)

fzf.setup({
	fzf_colors = true,
	fzf_opts = fzf_opts.default,
	keymap = fzf_keymap,
	winopts = fzf_winopts.default,
})
