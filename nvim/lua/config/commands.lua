local function set_clipboard(text)
	vim.fn.setreg("+", text)
	print(text)
end

vim.api.nvim_create_user_command("YankFilePath", function()
	set_clipboard(vim.fn.expand("%:p"))
end, {})

vim.api.nvim_create_user_command("YankRelativeFilePath", function()
	local full_path = vim.fn.expand("%:p")
	local relative_path = vim.fn.fnamemodify(full_path, ":." .. vim.fn.getcwd() .. ":~:.")
	set_clipboard(relative_path)
end, {})

local function yank_location(opts)
	local path = vim.fn.expand("%:p")
	if not opts.absolute then
		path = vim.fn.fnamemodify(path, ":." .. vim.fn.getcwd() .. ":~:.")
	end

	local location = path .. ":" .. opts.line1
	if opts.line2 ~= opts.line1 then
		location = location .. "-" .. opts.line2
	end
	set_clipboard(location)
end

vim.api.nvim_create_user_command("YankThisLocation", function(opts)
	yank_location({
		absolute = false,
		line1 = opts.line1,
		line2 = opts.line2,
	})
end, { range = true })

vim.api.nvim_create_user_command("YankThisAbsoluteLocation", function(opts)
	yank_location({
		absolute = true,
		line1 = opts.line1,
		line2 = opts.line2,
	})
end, { range = true })

if vim.g.pi_overview then
	return
end

vim.api.nvim_create_user_command("PiCommand", function()
	require("pi-integration").pick_command()
end, { desc = "Pick a Pi slash command/template/skill" })

vim.api.nvim_create_user_command("PiCd", function(opts)
	require("pi-integration").change_cwd(opts.args)
end, { nargs = "?", complete = "dir", desc = "Change CWD before the first Pi message" })

vim.api.nvim_create_user_command("PiRestart", function()
	require("pi-integration").restart()
end, { desc = "Restart Pi" })

vim.api.nvim_create_user_command("PiConsoleRestart", function()
	require("pi-integration").restart_console()
end, { desc = "Restart pi-console and Pi" })

vim.api.nvim_create_user_command("PiLogs", function()
	require("pi-integration").show_logs()
end, { desc = "Show pi-console runtime logs" })

vim.api.nvim_create_user_command("PiUsage", function()
	require("pi-integration").show_usage()
end, { desc = "Show OpenAI Codex usage limits" })
