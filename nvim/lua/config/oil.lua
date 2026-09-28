vim.pack.add({ "https://github.com/stevearc/oil.nvim" })
require("oil").setup({
	keymaps = {
		["g?"] = { "actions.show_help", mode = "n" },
		["<CR>"] = "actions.select",
		-- turn these off because I use them for split navigation
		["<C-s>"] = false,
		["<C-h>"] = false,
		["<S-CR>"] = { "actions.select", opts = { vertical = true } },
		["<C-CR>"] = { "actions.select", opts = { horizontal = true } },
		["<C-t>"] = { "actions.select", opts = { tab = true } },
		["<C-p>"] = "actions.preview",
		["<C-c>"] = { "actions.close", mode = "n" },
		["<C-l>"] = false,
		-- e! does the same thing, so let's just remove it
		-- ["<C-l>"] = "actions.refresh",
		["-"] = { "actions.parent", mode = "n" },
		["_"] = { "actions.open_cwd", mode = "n" },
		["`"] = { "actions.cd", mode = "n" },
		["~"] = { "actions.cd", opts = { scope = "tab" }, mode = "n" },
		["gs"] = { "actions.change_sort", mode = "n" },
		["gx"] = "actions.open_external",
		["g."] = { "actions.toggle_hidden", mode = "n" },
		["g\\"] = { "actions.toggle_trash", mode = "n" },
	},
})

vim.keymap.set({ "n", "x" }, "-", "<cmd>Oil<cr>", { desc = "Open parent directory" })
