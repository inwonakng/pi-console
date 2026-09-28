vim.api.nvim_create_autocmd({ "BufWinEnter", "VimResized", "WinResized" }, {
	callback = function()
		for _, win in ipairs(vim.api.nvim_list_wins()) do
			local buf = vim.api.nvim_win_get_buf(win)
			if vim.api.nvim_buf_get_name(buf):match("pi://input$") then
				vim.api.nvim_set_option_value("wrap", true, { win = win })
				vim.api.nvim_set_option_value("linebreak", true, { win = win })
				vim.api.nvim_set_option_value("breakindent", true, { win = win })
			end
		end
	end,
})

-- Highlight when yanking (copying) text
vim.api.nvim_create_autocmd("TextYankPost", {
	desc = "Highlight when yanking (copying) text",
	group = vim.api.nvim_create_augroup("highlight-yank", { clear = true }),
	callback = function()
		local highlight_yank = vim.hl.hl_op or vim.hl.on_yank
		highlight_yank()
	end,
})
