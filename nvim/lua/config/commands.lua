local build_info = require("pi-integration.build-info")

vim.api.nvim_create_user_command("PiConsoleVersion", function()
	local build = build_info.snapshot()
	vim.api.nvim_echo({ { "Startup build: " .. build_info.detail_text(build)
		.. "\nInstallation: " .. (build.app_root ~= "" and build.app_root or "unknown") } }, true, {})
end, { desc = "Show the running pi-console startup build and installation path" })

local function set_clipboard(text)
	vim.fn.setreg("+", text)
	print(text)
end

local function file_path(relative)
	do
		local buf = vim.api.nvim_get_current_buf()
		local resource = require("pi-integration.service-resources").for_buffer(buf)
		local review_path = vim.b[buf].pi_review_path
		if resource or review_path or vim.b[buf].pi_review_host or vim.api.nvim_buf_get_name(buf):match("^pi://") then
			local path = resource and resource.path or review_path
			if type(path) ~= "string" or path == "" then
				require("pi-integration.logs").notify("This buffer has no source path to copy.", vim.log.levels.WARN, { title = "pi-console" })
				return nil
			end
			return path
		end
	end
	local path = vim.fn.expand("%:p")
	if relative then path = vim.fn.fnamemodify(path, ":." .. vim.fn.getcwd() .. ":~:.") end
	return path
end

vim.api.nvim_create_user_command("YankFilePath", function()
	local path = file_path(false)
	if path then set_clipboard(path) end
end, {})

vim.api.nvim_create_user_command("PackUpdate", function()
	vim.pack.update()
end, {})

vim.api.nvim_create_user_command("YankRelativeFilePath", function()
	local path = file_path(true)
	if path then set_clipboard(path) end
end, {})

local function yank_location(opts)
	local path = file_path(not opts.absolute)
	if not path then return end

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
	require("pi-integration").change_cwd(opts.args ~= "" and opts.args or nil)
end, { nargs = "?", desc = "Start a new conversation in a directory on the selected host" })

vim.api.nvim_create_user_command("PiRestart", function()
	require("pi-integration").restart()
end, { desc = "Restart Pi" })

vim.api.nvim_create_user_command("PiConsoleRestart", function()
	require("pi-integration").restart_console()
end, { desc = "Restart frontend" })

vim.api.nvim_create_user_command("PiSteer", function(opts)
	local text
	if opts.range > 0 then
		text = table.concat(vim.api.nvim_buf_get_lines(0, opts.line1 - 1, opts.line2, false), "\n")
	end
	require("pi-integration").steer(text)
end, { range = true, desc = "Steer the active run, optionally using selected lines" })

vim.api.nvim_create_user_command("PiSide", function()
	require("pi-integration").toggle_side()
end, { desc = "Toggle the side conversation" })

vim.api.nvim_create_user_command("PiSideNew", function()
	require("pi-integration").new_side()
end, { desc = "Start a new side conversation with fresh main context" })

vim.api.nvim_create_user_command("PiSideAbort", function()
	require("pi-integration").abort_side()
end, { desc = "Abort only the side conversation" })

vim.api.nvim_create_user_command("PiLogs", function()
	require("pi-integration").show_logs()
end, { desc = "Show pi-console client log" })

vim.api.nvim_create_user_command("PiUsage", function()
	require("pi-integration").show_usage()
end, { desc = "Show OpenAI Codex usage limits" })
