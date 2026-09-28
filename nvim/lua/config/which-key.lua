local which_key = require("which-key")

which_key.setup({})
which_key.add({
	{ "<leader><tab>", group = "tabs" },
	{ "<leader>b", group = "buffers" },
	{ "<leader>p", group = "pi" },
	{ "<leader>u", group = "ui" },
	{ "<leader>w", group = "windows" },
	{ "<leader>y", group = "yank" },
})
