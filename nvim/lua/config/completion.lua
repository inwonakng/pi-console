local cmp = require("blink.cmp")

local function is_directory_prompt()
	return vim.fn.getcmdtype() == "@" and vim.fn.getcmdcompltype() == "dir"
end

cmp.build():pwait()
cmp.setup({
	term = { enabled = false },
	cmdline = {
		enabled = true,
		sources = {
			default = function()
				if is_directory_prompt() or vim.fn.getcmdtype() == ":" then
					return { "cmdline" }
				end
				return {}
			end,
		},
		completion = {
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
		documentation = {
			auto_show = true,
			auto_show_delay_ms = 500,
		},
	},
	sources = {
		default = function()
			if vim.api.nvim_buf_get_name(0) == "pi://input" then
				local col = vim.api.nvim_win_get_cursor(0)[2]
				if require("pi-integration.zotero-completion").owns(vim.api.nvim_get_current_line(), col) then
					return { "pi_zotero" }
				end
			end
			return { "pi_zotero", "pi_commands", "pi_files", "lsp", "path", "snippets", "buffer" }
		end,
		providers = {
			pi_zotero = {
				name = "Zotero",
				module = "pi-integration.zotero-completion",
				score_offset = 100,
				timeout_ms = 3500,
			},
			pi_commands = {
				name = "Pi",
				module = "pi-integration.completion",
				score_offset = 100,
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
