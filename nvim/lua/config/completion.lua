local cmp = require("blink.cmp")
cmp.build():pwait()
cmp.setup({
	cmdline = {
		enabled = false,
	},
	keymap = {
		["<C-space>"] = { "show", "show_documentation", "hide_documentation" },
		["<C-e>"] = { "hide", "fallback" },
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
		default = {
			"pi_commands",
			"pi_files",
			"lsp",
			"path",
			"snippets",
			"buffer",
		},
		providers = {
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
