local extras_dev = vim.fn.expand("~/.local/share/nvim-dev/nvim-extras")
if vim.fn.isdirectory(extras_dev) == 1 then
	vim.opt.runtimepath:prepend(extras_dev)
else
	vim.pack.add({ "https://github.com/inwonakng/nvim-extras" })
end

vim.pack.add({ "https://github.com/saghen/blink.lib" })

vim.pack.add({
	{ src = "https://github.com/catppuccin/nvim", name = "catppuccin" },
	"https://github.com/ibhagwan/fzf-lua",
	"https://github.com/MeanderingProgrammer/render-markdown.nvim",
	"https://github.com/nvim-treesitter/nvim-treesitter",
	"https://github.com/folke/which-key.nvim",
	"https://github.com/saghen/blink.cmp",
})
