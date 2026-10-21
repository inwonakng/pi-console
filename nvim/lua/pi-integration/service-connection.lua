-- One bridge per owner connection; no execution replay or owner startup.
local M = {}
function M.open(target, event)
	local connection = { pending = {}, sequence = 0 }
	local args = { "node", vim.fs.joinpath(vim.g.pi_console_root, "server/dist/bridge.js"), "--channel", vim.env.PI_CONSOLE_CHANNEL or "stable" }
	if target.remote then
		vim.list_extend(args, { "--remote", target.remote, "--credential-file", target.credential_file })
		if target.ca_file then vim.list_extend(args, { "--ca-file", target.ca_file }) end
	elseif target.root then vim.list_extend(args, { "--root", target.root }) end
	if target.host_id then vim.list_extend(args, { "--expected-host", target.host_id }) end
	local partial, errors = "", {}
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
		connection.pending[id] = callback or function() end
		local ok, sent = pcall(vim.fn.chansend, connection.job, vim.json.encode({ id = id, method = method, payload = payload and next(payload) ~= nil and payload or vim.empty_dict() }) .. "\n")
		if not ok or sent == 0 then fail("Bridge write failed") end
	end
	connection.job = vim.fn.jobstart(args, {
		on_stdout = function(_, chunks)
			if connection.closed then return end
			for i, chunk in ipairs(chunks) do
				partial = partial .. chunk
				if #partial > 80 * 1024 * 1024 then fail("Discovery frame too large"); return end
				if i < #chunks then
					local line = partial; partial = ""
					if line ~= "" then
						local ok, value = pcall(vim.json.decode, line)
						if not ok then fail("Invalid discovery frame"); return end
						if value.type == "response" then
							local callback = connection.pending[value.id]; connection.pending[value.id] = nil
							if callback then callback(value.success, value.success and value.result or value.error) end
						else event(value) end
					end
				end
			end
		end,
		on_stderr = function(_, chunks) for _, line in ipairs(chunks) do if line ~= "" then table.insert(errors, line) end end end,
		on_exit = function() fail(table.concat(errors, "\n") ~= "" and table.concat(errors, "\n") or "Service disconnected") end,
	})
	if connection.job <= 0 then vim.schedule(function() fail("Could not start discovery bridge") end) end
	return connection
end
return M
