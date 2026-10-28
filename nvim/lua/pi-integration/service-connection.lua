-- One bridge per owner connection; no execution replay or owner startup.
local M = {}
function M.open(target, event)
	local connection = { pending = {}, sequence = 0 }
	local args = { "node", vim.fs.joinpath(vim.g.pi_console_root, "server/dist/bridge.js"), "--channel", vim.env.PI_CONSOLE_CHANNEL or "stable" }
	if target.remote then
		vim.list_extend(args, { "--remote", target.remote })
	elseif target.root then vim.list_extend(args, { "--root", target.root }) end
	if target.host_id then vim.list_extend(args, { "--expected-host", target.host_id }) end
	local errors = {}
	local function fail(message)
		if connection.closed then return end
		connection.closed = true
		if connection.job then vim.fn.jobstop(connection.job) end
		for _, callback in pairs(connection.pending) do callback(false, { message = message }) end
		connection.pending = {}
		event({ type = "disconnected", message = message })
	end
	function connection.close()
		if connection.closed then return end
		connection.closed = true
		if connection.job then vim.fn.jobstop(connection.job) end
		connection.pending = {}
	end
	function connection.request(method, payload, callback)
		if connection.closed then if callback then callback(false, { message = "Disconnected" }) end; return end
		connection.sequence = connection.sequence + 1
		local id = "discovery-" .. connection.sequence
		local done = callback or function() end
		connection.pending[id] = function(ok, result)
			if ok then require("pi-integration.service-snapshot").load(result, connection.request, done)
			else done(false, result) end
		end
		local ok, sent = pcall(vim.fn.chansend, connection.job, vim.json.encode({ id = id, method = method, payload = payload and next(payload) ~= nil and payload or vim.empty_dict() }) .. "\n")
		if not ok or sent == 0 then fail("Bridge write failed") end
	end
	local consume = require("pi-integration.service-frames").new(function(value)
		if value.type == "response" then
			local callback = connection.pending[value.id]; connection.pending[value.id] = nil
			if callback then callback(value.success, value.success and value.result or value.error) end
		else event(value) end
		return not connection.closed
	end, fail)
	connection.job = vim.fn.jobstart(args, {
		on_stdout = function(_, chunks)
			if not connection.closed then consume(chunks) end
		end,
		on_stderr = function(_, chunks) for _, line in ipairs(chunks) do if line ~= "" then table.insert(errors, line) end end end,
		on_exit = function() fail(table.concat(errors, "\n") ~= "" and table.concat(errors, "\n") or "Service disconnected") end,
	})
	if connection.job <= 0 then vim.schedule(function() fail("Could not start discovery bridge") end) end
	return connection
end
return M
