local app_root = assert(vim.g.pi_console_root, "pi-console root was not initialized")
local role = vim.env.PI_CONSOLE_SIDEBAR == "1" and "sidebar"
	or vim.env.PI_CONSOLE_OVERVIEW == "1" and "overview" or "conversation"
local restart_file = vim.env.PI_CONSOLE_RESTART_FILE
vim.env.PI_CONSOLE_OVERVIEW = nil
vim.env.PI_CONSOLE_SIDEBAR = nil
vim.env.PI_CONSOLE_RESTART_FILE = nil
local restore
local restore_file = restart_file and (restart_file .. ".restore")
if restore_file and vim.fn.filereadable(restore_file) == 1 then
	restore = vim.json.decode(table.concat(vim.fn.readfile(restore_file), "\n"))
	assert(vim.fn.delete(restore_file) == 0, "Could not consume frontend restart state")
	vim.api.nvim_set_current_dir(restore.cwd)
end
vim.g.pi_overview = role ~= "conversation"
local integration = require("pi-integration")
integration.setup({ role = role, show_thinking = true,
	launcher = vim.fs.joinpath(app_root, "bin", "pi-console"), restart_file = restart_file })
-- Build the layout after VimEnter finishes restoring the startup window.
vim.api.nvim_create_autocmd("VimEnter", { once = true, callback = vim.schedule_wrap(function() integration.open(restore) end) })
