local cmp = require("blink.cmp")

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
				name = "Owner directories",
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
				opts = {
					get_cwd = function(_)
						return vim.fn.getcwd()
					end,
				},
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
