local map = vim.keymap.set

-- window manipulation
map("n", "<leader>qq", "<cmd>qa<cr>", { desc = "Quit" })
map("n", "<leader>wd", "<cmd>q<cr>", { desc = "Close Window" })
map("n", "<leader>\\", "<cmd>vsplit<cr>", { desc = "Vertical split" })
map("n", "<leader>-", "<cmd>split<cr>", { desc = "Horizontal split" })
map("n", "<leader>w", "<C-w>", { desc = "Window commands" })
map("n", "<C-h>", "<C-w><C-h>", { desc = "Move focus to the left window" })
map("n", "<C-l>", "<C-w><C-l>", { desc = "Move focus to the right window" })
map("n", "<C-j>", "<C-w><C-j>", { desc = "Move focus to the lower window" })
map("n", "<C-k>", "<C-w><C-k>", { desc = "Move focus to the upper window" })
map("n", "<Esc>", "<cmd>nohlsearch<CR>")

-- Conversation-only actions must not start an agent in the overview.
if not vim.g.pi_overview then
	map("n", "<leader>pi", function()
		require("pi-integration").show_input()
	end, { desc = "Pi input" })
	map("n", "<leader>pt", function()
		require("pi-integration").show_transcript()
	end, { desc = "Pi transcript" })
end

-- tab manipulation
map("n", "<leader><tab>]", "<cmd>tabnext<cr>", { desc = "Next tab" })
map("n", "<leader><tab>[", "<cmd>tabprev<cr>", { desc = "Previous tab" })
for i = 1, 9 do
	map("n", "<leader><tab>" .. i, ("<cmd>tabnext %d<cr>"):format(i), { desc = "Go to tab " .. i })
end
map("n", "<leader><tab><tab>", "<cmd>tabnew<cr>", { desc = "New tab" })
map("n", "<leader><tab><cr>", "<cmd>tab sp<cr>", { desc = "Open in new tab" })
map("n", "<leader><tab>o", "<cmd>tabonly<cr>", { desc = "Close other tabs" })
map("n", "<leader><tab>d", "<cmd>tabclose<cr>", { desc = "Close tab" })
map("n", "<leader><tab>,", "<cmd>silent! tabmove -1<cr>", { desc = "Move tab left" })
map("n", "<leader><tab>.", "<cmd>silent! tabmove +1<cr>", { desc = "Move tab right" })

-- indentation with >> and <<
map("v", "<", "<gv")
map("v", ">", ">gv")

-- nice trick to kill all hidden buffers.
map("n", "<leader>bo", function()
	local bufs = vim.api.nvim_list_bufs()
	local non_hidden_buffer = {}
	for _, win in ipairs(vim.api.nvim_list_wins()) do
		non_hidden_buffer[vim.api.nvim_win_get_buf(win)] = true
	end
	local failed = {}
	for _, i in ipairs(bufs) do
		if non_hidden_buffer[i] == nil then
			local ok, err = pcall(vim.api.nvim_buf_delete, i, {})
			if not ok then
				local name = vim.api.nvim_buf_get_name(i)
				table.insert(failed, name ~= "" and name or ("[buf " .. i .. "]"))
			end
		end
	end
	if #failed > 0 then
		vim.notify("Could not close:\n" .. table.concat(failed, "\n"), vim.log.levels.WARN)
	end
end, { desc = "delete hidden buffers" })

-- some nice UI controls.
map("n", "<leader>uw", "<cmd>set wrap!<CR>", { desc = "Toggle wrap" })
map("n", "<leader>us", "<cmd>set spell!<CR>", { desc = "Toggle spell check" })
map("n", "<leader>un", "<cmd>set relativenumber!<CR>", { desc = "Toggle number" })

-- let j and k move up and down lines that have been wrapped
map({ "n", "v" }, "j", function()
	return vim.v.count == 0 and "gj" or "j"
end, { expr = true, noremap = true })

map({ "n", "v" }, "k", function()
	return vim.v.count == 0 and "gk" or "k"
end, { expr = true, noremap = true })

-- Yank file path
map("n", "<leader>yP", ":YankFilePath<CR>", { noremap = true, silent = true })
map("n", "<leader>yp", ":YankRelativeFilePath<CR>", { noremap = true, silent = true })
map("n", "<leader>yT", ":YankThisAbsoluteLocation<CR>", { noremap = true, silent = true })
map("n", "<leader>yt", ":YankThisLocation<CR>", { noremap = true, silent = true })
map("x", "<leader>yT", ":YankThisAbsoluteLocation<CR>", { noremap = true, silent = true })
map("x", "<leader>yt", ":YankThisLocation<CR>", { noremap = true, silent = true })

-- Window modes (resize / move)
local win_modes = require("utils.window-modes")
map("n", "<leader>wr", win_modes.enter_resize, { desc = "Window: resize mode" })
map("n", "<leader>wm", win_modes.enter_move, { desc = "Window: move mode" })

