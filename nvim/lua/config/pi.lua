local app_root = assert(vim.g.pi_console_root, "pi-console root was not initialized")
local agent_dir = vim.env.PI_CODING_AGENT_DIR
local settings_dir = agent_dir or vim.fs.joinpath(vim.fn.expand("~"), ".pi", "agent")

local function archive_after_days()
	local ok, lines = pcall(vim.fn.readfile, vim.fs.joinpath(settings_dir, "pi-console-config.yaml"))
	if not ok then
		return nil
	end

	local section_indent
	for _, line in ipairs(lines) do
		local content = line:gsub("#.*$", ""):gsub("%s+$", "")
		local indent = #(content:match("^(%s*)") or "")
		if not section_indent then
			if content:match("^session%-picker:%s*$") then
				section_indent = indent
			end
		elseif content ~= "" and indent <= section_indent then
			break
		elseif indent > section_indent then
			local value = content:match("^%s+archive%-after%-days:%s*(.-)%s*$")
			if value then
				local days = tonumber(value)
				if days and days > 0 and days == math.floor(days) then
					return days
				end
				vim.notify(
					"session-picker.archive-after-days must be a positive integer; using the default",
					vim.log.levels.WARN,
					{ title = "pi-console" }
				)
				return nil
			end
		end
	end
	return nil
end

local overview = vim.env.PI_CONSOLE_OVERVIEW == "1"
local session_file = vim.env.PI_CONSOLE_SESSION
local restart_file = vim.env.PI_CONSOLE_RESTART_FILE
-- Startup choices must not leak into tools or subsequently launched editors.
vim.env.PI_CONSOLE_OVERVIEW = nil
vim.env.PI_CONSOLE_SESSION = nil
vim.env.PI_CONSOLE_RESTART_FILE = nil
local restart_state
local restore_file = restart_file and (restart_file .. ".restore")
if restore_file and vim.fn.filereadable(restore_file) == 1 then
	local lines = vim.fn.readfile(restore_file)
	assert(vim.fn.delete(restore_file) == 0, "Could not consume pi-console restart state")
	restart_state = vim.json.decode(table.concat(lines, "\n"))
	vim.api.nvim_set_current_dir(restart_state.cwd)
	session_file = restart_state.session_file
end
local integration = require("pi-integration")
vim.g.pi_overview = overview
local config = vim.tbl_deep_extend("force", integration.config, {
	binary = vim.env.PI_BINARY or "pi",
	agent_dir = agent_dir,
	provider = vim.env.PI_PROVIDER,
	model = vim.env.PI_MODEL,
	session_dir = vim.env.PI_SESSION_DIR,
	archive_after_days = archive_after_days(),
	show_thinking = true,
	launcher = vim.fs.joinpath(app_root, "bin", "pi-console"),
	restart_file = restart_file,
})

if not overview then
	integration.setup(config)
end

vim.api.nvim_create_autocmd("VimEnter", {
	once = true,
	callback = function()
		if overview then
			require("pi-integration.overview").open(config)
		else
			integration.open(session_file, restart_state)
		end
	end,
})
