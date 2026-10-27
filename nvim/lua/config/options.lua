vim.g.mapleader = " "
vim.g.maplocalleader = " "

vim.opt.mouse = "a"
vim.opt.number = false
vim.opt.laststatus = 2
vim.opt.wrap = true
vim.opt.linebreak = true
vim.opt.breakindent = true
vim.opt.termguicolors = true
vim.opt.splitbelow = true
vim.opt.splitright = true
vim.opt.hidden = true
vim.opt.ignorecase = true

vim.schedule(function()
	local ssh_connection = vim.env.SSH_CONNECTION or ""
	if vim.env.TMUX and vim.env.TMUX ~= "" then
		-- Use the latest attachment, rather than the shell's stale SSH environment.
		local connection = vim.fn.system({ "tmux", "show-environment", "SSH_CONNECTION" })
		if vim.v.shell_error == 0 then
			ssh_connection = connection:match("^SSH_CONNECTION=([^\r\n]*)") or ""
		end
	end
	vim.opt.clipboard = ssh_connection ~= "" and "" or "unnamedplus"
end)
