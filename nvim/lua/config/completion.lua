local cmp = require("blink.cmp")

local default_label_highlight = require("blink.cmp.config").completion.menu.draw.components.label.highlight
local label_max_width = 60

local function label_text(ctx)
	local text = ctx.label .. ctx.label_detail
	local is_path = ctx.kind == "File" or ctx.kind == "Folder" or ctx.source_id == "path"
		or (ctx.source_id == "cmdline" and ctx.label:find("/", 1, true) ~= nil)
	if not is_path or vim.api.nvim_strwidth(text) <= label_max_width then
		return text, 0
	end

	local tail = ""
	for index = vim.fn.strchars(text, true) - 1, 0, -1 do
		local candidate = vim.fn.strcharpart(text, index, 1, true) .. tail
		if vim.api.nvim_strwidth("…" .. candidate) > label_max_width then break end
		tail = candidate
	end
	return "…" .. tail, #text - #tail
end

local function label_highlight(ctx)
	local highlights = default_label_highlight(ctx)
	local _, removed = label_text(ctx)
	if removed == 0 then return highlights end

	local shifted = { { 0, #"…", group = ctx.deprecated and "BlinkCmpLabelDeprecated" or "BlinkCmpLabel" } }
	for _, highlight in ipairs(highlights) do
		if highlight[2] > removed then
			highlight[1] = math.max(0, highlight[1] - removed) + #"…"
			highlight[2] = highlight[2] - removed + #"…"
			table.insert(shifted, highlight)
		end
	end
	return shifted
end

local function is_owner_directory_prompt()
	return require("pi-integration.directory-history").completion_context() ~= nil
end

local function is_directory_prompt()
	return is_owner_directory_prompt() or (vim.fn.getcmdtype() == "@" and vim.fn.getcmdcompltype() == "dir")
end

cmp.build():pwait()
cmp.setup({
	term = { enabled = false },
	cmdline = {
		enabled = true,
		keymap = {
			["<CR>"] = { function(cmp) if is_owner_directory_prompt() then return cmp.accept() end end, "fallback" },
			["<C-o>"] = { function(cmp) return require("pi-integration.directory-history").browse_input(cmp) end, "fallback" },
		},
		sources = {
			default = function()
				if is_owner_directory_prompt() then return { "pi_directories" } end
				if is_directory_prompt() or vim.fn.getcmdtype() == ":" then
					return { "cmdline" }
				end
				return {}
			end,
		},
		completion = {
			list = { selection = {
				preselect = function() return not is_owner_directory_prompt() end,
				auto_insert = function() return not is_owner_directory_prompt() end,
			} },
			menu = {
				auto_show = is_directory_prompt,
			},
		},
	},
	keymap = {
		["<C-space>"] = { "show", "show_documentation", "hide_documentation" },
		["<Esc>"] = {
			function(cmp)
				cmp.cancel()
				return false
			end,
			"fallback",
		},
		["<C-e>"] = { "cancel", "fallback" },
		["<CR>"] = { "accept", "fallback" },
		["<Tab>"] = { "snippet_forward", "fallback" },
		["<S-Tab>"] = { "snippet_backward", "fallback" },
		["<Up>"] = { "select_prev", "fallback" },
		["<Down>"] = { "select_next", "fallback" },
		["<C-p>"] = { "select_prev", "fallback" },
		["<C-n>"] = { "select_next", "fallback" },
		["<C-b>"] = { "scroll_documentation_up", "fallback" },
		["<C-f>"] = { "scroll_documentation_down", "fallback" },
		["<C-k>"] = { "show_signature", "hide_signature", "fallback" },
	},
	appearance = {
		use_nvim_cmp_as_default = true,
		nerd_font_variant = "mono",
	},
	completion = {
		menu = {
			draw = {
				components = {
					label = {
						width = { max = label_max_width },
						text = label_text,
						highlight = label_highlight,
					},
				},
			},
		},
		list = { selection = {
			preselect = function() return not is_owner_directory_prompt() end,
			auto_insert = function() return not is_owner_directory_prompt() end,
		} },
		documentation = {
			auto_show = true,
			auto_show_delay_ms = 500,
		},
	},
	sources = {
		default = function()
			if is_owner_directory_prompt() then return { "pi_directories" } end
			if vim.api.nvim_buf_get_name(0) == "pi://input" then
				return { "pi_commands", "pi_zotero", "pi_files", "buffer" }
			end
			return { "pi_zotero", "pi_files", "lsp", "path", "snippets", "buffer" }
		end,
		providers = {
			pi_commands = {
				name = "Pi commands",
				module = "pi-integration.completion",
				score_offset = 100,
			},
			cmdline = { enabled = function() return not is_owner_directory_prompt() end },
			pi_directories = {
				name = "Directories",
				module = "pi-integration.directory-completion",
				timeout_ms = 5000,
			},
			pi_zotero = {
				name = "Zotero",
				module = "pi-integration.zotero-completion",
				score_offset = 100,
				timeout_ms = 3500,
			},
			pi_files = {
				name = "Pi files",
				module = "pi-integration.file-completion",
				score_offset = 90,
				timeout_ms = 5000,
			},
			path = {
				opts = {
					get_cwd = function(_)
						return vim.fn.getcwd()
					end,
				},
			},
		},
	},
})
-- else
-- 	vim.notify("blink.cmp unavailable; completion disabled", vim.log.levels.WARN)
-- end
