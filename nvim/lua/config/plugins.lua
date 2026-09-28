local extras_root = vim.env.NVIM_EXTRAS_PATH
if extras_root and extras_root ~= "" then
	extras_root = vim.fs.normalize(vim.fn.expand(extras_root))
	if vim.fn.isdirectory(extras_root) == 0 then
		error("NVIM_EXTRAS_PATH is not a directory: " .. extras_root)
	end
	vim.opt.runtimepath:prepend(extras_root)
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
