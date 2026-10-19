-- tmux captures the client at the key binding, while the reserved PTY trigger
-- delays selection until all terminal input preceding Enter has been consumed.
local M = {}
local callbacks, queue, actions = {}, {}, {}
local next_action = 0
local current_client
local awaiting_context = false
local installed = false
local publication
local registration
local pane = vim.env.TMUX_PANE
local option = "@pi_console_input"

local function tmux(args)
	local output = vim.fn.system(vim.list_extend({ "tmux" }, args))
	if vim.v.shell_error ~= 0 then error(vim.trim(output)) end
	return vim.trim(output)
end

local function clear()
	if publication and tmux({ "show-options", "-pqv", "-t", pane, option }) == publication then
		tmux({ "set-option", "-pu", "-t", pane, option })
	end
	publication = nil
end

local function sync_registration()
	if not registration then return end
	local active = callbacks[vim.api.nvim_get_current_buf()] and vim.fn.mode(1) == "n"
	-- Intercept only the list itself. Ordinary buffers and editing modes keep
	-- the user's native tmux Enter binding, including raw getchar() commands.
	if active and not publication then
		tmux({ "set-option", "-p", "-t", pane, option, registration })
		publication = registration
	elseif not active then
		clear()
	end
end

local function trigger()
	-- The PTY trigger must arrive before RPC: a pending normal-mode count
	-- can defer non-fast RPC until another key arrives. Waiting here processes
	-- that RPC without reordering the movement keys ahead of this trigger.
	awaiting_context = true
	vim.wait(2000, function() return #queue > 0 end, 10)
	awaiting_context = false
	local context = table.remove(queue, 1)
	if not context then return "<Ignore>" end
	local buf = vim.api.nvim_get_current_buf()
	if callbacks[buf] and vim.fn.mode(1) == "n" then
		next_action = next_action + 1
		actions[next_action] = { context = context, buffer = buf }
		return "<Cmd>lua require('pi-integration.backends.tmux-input').dispatch(" .. next_action .. ")<CR>"
	end
	-- An expression mapping expands to Enter in place: unlike feedkeys from
	-- a callback, it preserves pending counts and operators (3<CR>, d<CR>).
	return "<CR>"
end

function M.dispatch(id)
	local action = actions[id]
	actions[id] = nil
	if not action then return end
	local callback = callbacks[vim.api.nvim_get_current_buf()]
	if callback and action.buffer == vim.api.nvim_get_current_buf() and vim.fn.mode(1) == "n" then
		local previous = current_client
		current_client = action.context
		local ok, err = xpcall(callback, debug.traceback)
		current_client = previous
		if not ok then vim.notify(err, vim.log.levels.ERROR, { title = "Pi Enter" }) end
	end
end

function M.client()
	return current_client
end

-- Called only over the pane's RPC endpoint. Do not select a row here: movement
-- keys may already be waiting in the PTY even when RPC is processed first.
function M.enqueue(event)
	local context = event.context
	if event.owner ~= vim.uv.os_getpid() or type(context) ~= "table"
		or context.pane ~= pane or type(context.name) ~= "string" or context.name == ""
		or type(context.pid) ~= "number" or context.pid <= 0 or context.pid ~= math.floor(context.pid)
		or not registration or not awaiting_context or #queue > 0 then
		return 0
	end
	table.insert(queue, context)
	return 1
end

function M.register(buf, callback)
	callbacks[buf] = callback
	if not pane or not vim.env.TMUX then return end
	local ok, err = pcall(function()
		if not installed then
			-- Legacy xterm encoding reports Ctrl-Shift-F12 as F48; extended
			-- key protocols can preserve the modifiers instead.
			for _, key in ipairs({ "<F48>", "<C-S-F12>" }) do
				vim.keymap.set({ "n", "i", "v", "s", "o", "c", "t" }, key, trigger, { silent = true, expr = true, remap = true })
			end
			vim.api.nvim_create_autocmd("VimLeavePre", { callback = clear })
			vim.api.nvim_create_autocmd({ "BufEnter", "ModeChanged" }, {
				callback = function()
					local synced, sync_err = pcall(sync_registration)
					if not synced then vim.notify(sync_err, vim.log.levels.WARN, { title = "Pi Enter" }) end
				end,
			})
			installed = true
		end
		if not registration then
			local socket = vim.env.TMUX:match("^(.*),%d+,%d+$")
			local script = vim.g.pi_console_root .. "/tmux/scripts/client-enter.mjs"
			local output = vim.fn.system({ "node", script, "--install", socket })
			if vim.v.shell_error ~= 0 then error(vim.trim(output)) end
			local server = vim.v.servername
			if server == "" then server = vim.fn.serverstart() end
			registration = vim.json.encode({ server = server, program = vim.v.progpath, pid = vim.uv.os_getpid() })
		end
		sync_registration()
	end)
	if not ok then vim.notify(tostring(err), vim.log.levels.WARN, { title = "Pi Enter" }) end
	vim.api.nvim_create_autocmd("BufWipeout", {
		buffer = buf,
		once = true,
		callback = function()
			callbacks[buf] = nil
			if not next(callbacks) then clear() end
		end,
	})
end

return M
