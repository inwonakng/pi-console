-- Lifecycle hooks also refresh windows whose last frontend was killed, so no
-- surviving Neovim publisher is needed to remove stale pane icons.
local root = vim.fs.dirname(vim.fs.dirname(vim.fs.dirname(debug.getinfo(1, "S").source:sub(2))))
vim.opt.runtimepath:prepend(root .. "/nvim")
local socket = assert(arg[1], "Missing tmux socket")
local function run(args, raw)
	local result = vim.system(vim.list_extend({ "tmux", "-S", socket }, args), { text = true }):wait(2000)
	if result.code ~= 0 then return nil, vim.trim(result.stderr or "") end
	return raw and result.stdout or vim.trim(result.stdout or "")
end
local windows, err = run({ "list-windows", "-a", "-F", "#{window_id}\t#{@pi_console_tab}" })
if not windows then error(err) end
local seen = {}
for line in windows:gmatch("[^\n]+") do
	local window = line:match("^(@%d+)\t.+$")
	if window and not seen[window] then
		seen[window] = true
		local refreshed, refresh_err = require("pi-integration.backends.tmux-tabs").refresh(window, run)
		if not refreshed then
			-- A concurrent kill-window can legitimately remove the target.
			local exists = run({ "display-message", "-p", "-t", window, "#{window_id}" })
			if exists == window then error(refresh_err) end
		end
	end
end
