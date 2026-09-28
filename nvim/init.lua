local source = debug.getinfo(1, "S").source:sub(2)
local config_root = vim.uv.fs_realpath(vim.fs.dirname(source)) or vim.fs.dirname(source)
local app_root = vim.fs.dirname(config_root)

vim.g.pi_console_root = app_root
vim.opt.runtimepath:prepend(config_root)

-- vim.pack reads only from stdpath("config"). Keep the isolated application
-- config synchronized with the lockfile distributed alongside this init.lua.
local packaged_lock = vim.fs.joinpath(config_root, "nvim-pack-lock.json")
local active_lock = vim.fs.joinpath(vim.fn.stdpath("config"), "nvim-pack-lock.json")
local packaged_lines = vim.fn.readfile(packaged_lock)
local active_lines = vim.fn.filereadable(active_lock) == 1 and vim.fn.readfile(active_lock) or {}
if not vim.deep_equal(packaged_lines, active_lines) then
	vim.fn.mkdir(vim.fs.dirname(active_lock), "p")
	local temporary_lock = active_lock .. "." .. vim.fn.getpid()
	vim.fn.writefile(packaged_lines, temporary_lock)
	local renamed, rename_error = vim.uv.fs_rename(temporary_lock, active_lock)
	assert(renamed, rename_error)
end
require("config.options")
require("config.autocmds")
require("config.plugins")
require("config.theme")
require("config.which-key")
require("config.fzf")
require("config.treesitter")
require("config.completion")
require("config.markdown")
require("config.pi")
require("config.oil")
require("config.keymaps")
require("config.commands")
