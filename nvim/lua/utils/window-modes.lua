local M = {}

local active_mode
local mode_keys = { "h", "j", "k", "l", "<Esc>", "q" }
local augroup = vim.api.nvim_create_augroup("WindowModes", { clear = true })

local function echo_mode(mode)
	if mode == "normal" then
		vim.cmd('echo ""')
	else
		vim.cmd('echo "-- ' .. mode:upper() .. ' MODE -- (hjkl: ' .. mode .. ', q/ESC: exit)"')
	end
end

local function clear_mode_keys()
	local owner = active_mode
	if not owner then
		return
	end
	active_mode = nil
	vim.api.nvim_clear_autocmds({ group = augroup })
	if vim.api.nvim_buf_is_valid(owner.buf) then
		vim.api.nvim_buf_call(owner.buf, function()
			for _, key in ipairs(mode_keys) do
				local mapping = vim.fn.maparg(key, "n", false, true)
				if mapping.buffer == 1 and mapping.callback == owner.callbacks[key] then
					vim.keymap.del("n", key, { buffer = owner.buf })
					if owner.originals[key] then
						vim.fn.mapset("n", false, owner.originals[key])
					end
				end
			end
		end)
	end
	echo_mode("normal")
	vim.cmd("redrawstatus")
end

local function enter_mode(mode, keymaps)
	if active_mode and active_mode.name == mode then
		clear_mode_keys()
		return
	end

	clear_mode_keys()
	local owner = {
		name = mode,
		buf = vim.api.nvim_get_current_buf(),
		originals = {},
		callbacks = keymaps,
	}
	for _, key in ipairs(mode_keys) do
		local mapping = vim.fn.maparg(key, "n", false, true)
		if mapping.buffer == 1 then
			owner.originals[key] = mapping
		end
	end
	active_mode = owner
	echo_mode(mode)
	vim.cmd("redrawstatus")

	local exit = function()
		if active_mode == owner then
			clear_mode_keys()
		end
	end
	keymaps["<Esc>"] = exit
	keymaps.q = exit
	local opts = { buffer = owner.buf, noremap = true, silent = true }
	for key, action in pairs(keymaps) do
		vim.keymap.set("n", key, action, opts)
	end

	vim.api.nvim_create_autocmd({ "WinLeave", "BufLeave", "BufWipeout" }, {
		group = augroup,
		buffer = owner.buf,
		callback = exit,
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
	return active_mode and active_mode.name or "normal"
end

return M
