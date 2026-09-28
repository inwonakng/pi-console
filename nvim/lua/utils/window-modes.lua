local M = {}

local current_mode = "normal"
local augroup = vim.api.nvim_create_augroup("WindowModes", { clear = true })

local function echo_mode(mode)
	if mode == "normal" then
		vim.cmd('echo ""')
	else
		vim.cmd('echo "-- ' .. mode:upper() .. ' MODE -- (hjkl: ' .. mode .. ', q/ESC: exit)"')
	end
end

local function clear_mode_keys()
	vim.api.nvim_clear_autocmds({ group = augroup })
	for _, key in ipairs({ "h", "j", "k", "l", "<Esc>", "q" }) do
		pcall(vim.keymap.del, "n", key, { buffer = 0 })
	end
	current_mode = "normal"
	echo_mode("normal")
	vim.cmd("redrawstatus")
end

local function enter_mode(mode, keymaps)
	if current_mode == mode then
		clear_mode_keys()
		return
	end

	clear_mode_keys()
	current_mode = mode
	echo_mode(mode)
	vim.cmd("redrawstatus")

	local opts = { buffer = 0, noremap = true, silent = true }
	local exit = function()
		clear_mode_keys()
	end

	for key, action in pairs(keymaps) do
		vim.keymap.set("n", key, action, opts)
	end
	vim.keymap.set("n", "<Esc>", exit, opts)
	vim.keymap.set("n", "q", exit, opts)

	vim.api.nvim_create_autocmd({ "WinLeave", "BufLeave" }, {
		group = augroup,
		once = true,
		callback = function()
			clear_mode_keys()
		end,
	})
end

function M.enter_resize()
	enter_mode("resize", {
		h = function()
			vim.cmd("vertical resize -2")
		end,
		l = function()
			vim.cmd("vertical resize +2")
		end,
		k = function()
			vim.cmd("resize -2")
		end,
		j = function()
			vim.cmd("resize +2")
		end,
	})
end

local function move_window(direction)
	vim.cmd("wincmd " .. direction)
	require("pi-integration").restore_status_footer()
end

function M.enter_move()
	enter_mode("move", {
		-- wincmd H/J/K/L moves the window but keeps focus in it,
		-- so WinLeave does not fire and buffer-local keymaps stay valid.
		h = function()
			move_window("H")
		end,
		j = function()
			move_window("J")
		end,
		k = function()
			move_window("K")
		end,
		l = function()
			move_window("L")
		end,
	})
end

function M.get_mode()
	return current_mode
end

return M
