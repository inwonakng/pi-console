local source = debug.getinfo(1, "S").source:sub(2)
local config_root = vim.uv.fs_realpath(vim.fs.dirname(source)) or vim.fs.dirname(source)
local app_root = vim.fs.dirname(config_root)

vim.g.pi_console_root = app_root
vim.opt.runtimepath:prepend(config_root)
require("pi-integration.build-info") -- Capture the launch identity before loading plugins.

-- vim.pack has no separate lockfile path: it uses vim.fn.stdpath("config").
-- Redirect that Lua lookup without changing XDG_CONFIG_HOME, which user settings
-- and child processes still need. Leave plugin data and session state in place.
local stdpath = vim.fn.stdpath
local cache_home = vim.env.XDG_CACHE_HOME
if not cache_home or cache_home == "" then cache_home = vim.fs.joinpath(vim.fn.expand("~"), ".cache") end
local generated_config = vim.fs.joinpath(cache_home, "pi-console", "nvim", vim.env.NVIM_APPNAME or "nvim")
vim.fn.stdpath = function(kind)
	if kind == "config" then return generated_config end
	return stdpath(kind)
end

-- Keep the generated lockfile synchronized with the bundled copy.
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
require("config.keymaps")
require("config.commands")
