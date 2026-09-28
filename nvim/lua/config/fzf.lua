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

local fzf = require("fzf-lua")

fzf.register_ui_select(function(select_opts)
	local winopts = vim.deepcopy(fzf_winopts.default)
	if select_opts.kind == "pi_approval" then
		winopts.height = 0.85
		winopts.preview = {
			layout = "vertical",
			vertical = "up:78%",
			border = "none",
			wrap = true,
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
	winopts.title = " " .. select_label(select_opts.prompt) .. " "
	winopts.title_pos = "left"
	return {
		prompt = select_prompt(select_opts.prompt),
		winopts = winopts,
		fzf_opts = fzf_opts.default,
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
