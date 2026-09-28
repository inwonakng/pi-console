vim.g.mapleader = " "
vim.g.maplocalleader = " "

vim.opt.number = false
vim.opt.laststatus = 2
vim.opt.wrap = true
vim.opt.linebreak = true
vim.opt.breakindent = true
vim.opt.termguicolors = true
vim.opt.splitbelow = true
vim.opt.splitright = true
vim.opt.hidden = true

vim.schedule(function()
	vim.opt.clipboard = "unnamedplus"
end)
