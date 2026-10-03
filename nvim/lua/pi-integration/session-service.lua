local json = require("pi-integration.utils.json")

local M = {}
local worker
local next_id = 0
local exiting = false

local function respond(request, result)
	vim.schedule(function()
		request.callback(result)
	end)
end

local function fail(service, message)
	if worker ~= service then
		return
	end
	worker = nil
	vim.fn.jobstop(service.job)
	-- Also clean up synchronously on VimLeavePre, when scheduled exit callbacks
	-- may never run. jobstop terminates the process before its state is removed.
	vim.fn.jobwait({ service.job })
	vim.fn.delete(service.agent_dir, "rf")
	if service.active then
		respond(service.active, { success = false, error = message })
	end
	for _, request in ipairs(service.queue) do
		respond(request, { success = false, error = message })
	end
	service.active, service.queue = nil, {}
end

local function send(service, command)
	local ok, written = pcall(vim.fn.chansend, service.job, json.encode(command) .. "\n")
	if not ok or written == 0 then
		fail(service, "Session workspace service RPC write failed; session files were kept.")
		return false
	end
	return true
end

local function pump(service)
	if worker ~= service or not service.ready or service.active or #service.queue == 0 then
		return
	end
	service.active = table.remove(service.queue, 1)
	send(service, {
		type = "prompt",
		id = service.active.id,
		message = "/pi-session-workspaces " .. json.encode(service.active.payload),
	})
end

local function handle(service, event)
	local active = service.active
	if event.type == "extension_error" then
		fail(service, event.error or "Session workspace service extension failed.")
	elseif event.type == "response" and event.id == "commands" then
		local found = false
		for _, command in ipairs((event.data or {}).commands or {}) do
			found = found or command.name == "pi-session-workspaces"
		end
		if not event.success or not found then
			fail(service, event.error or "Could not load session workspace command.")
			return
		end
		service.ready = true
		pump(service)
	elseif event.type == "extension_ui_request" and event.method == "confirm" then
		local ids = json.decode(event.message or "")
		local confirmed = false
		if active and event.title == "Remove prepared session workspaces?" and type(ids) == "table"
			and vim.deep_equal(ids, active.payload.workspaceIds) and active.authorize_remove then
			local ok, approved = pcall(active.authorize_remove)
			if not ok then
				fail(service, "Could not authorize workspace removal: " .. tostring(approved))
				return
			end
			confirmed = approved == true
		end
		send(service, { type = "extension_ui_response", id = event.id, confirmed = confirmed })
	elseif active and event.type == "extension_ui_request" and event.statusKey == "pi-session-workspaces" then
		active.result = json.decode_object(event.statusText)
	elseif active and event.type == "response" and event.id == active.id then
		-- Wait for the command response, not just its status event, before sending
		-- another prompt. Pi has finished the handler at this boundary.
		service.active = nil
		respond(active, event.success and active.result or {
			success = false,
			error = event.error or "Workspace command returned no result; session files were kept.",
		})
		pump(service)
	end
end

local function start(binary, workspace_root)
	local agent_dir = vim.fn.tempname()
	if vim.fn.mkdir(agent_dir, "p") ~= 1 then
		return nil, "Could not create session service directory."
	end
	local service = { agent_dir = agent_dir, queue = {}, pending = "", stderr = {} }
	local ok, job = pcall(vim.fn.jobstart, {
		binary, "--mode", "rpc", "--no-session", "--no-extensions", "--no-tools",
		"-e", vim.g.pi_console_root .. "/pi/scripts/session-workspaces.ts",
	}, {
		-- No credentials, saved conversations, or runtime publishing. Only the
		-- workspace store is shared with conversational agents.
		env = { PI_CODING_AGENT_DIR = agent_dir, PI_WORKSPACE_ROOT = workspace_root },
		on_stdout = function(_, data)
			vim.schedule(function()
				if worker ~= service then
					return
				end
				service.pending = service.pending .. table.concat(data, "\n")
				while service.pending:find("\n", 1, true) do
					local line, rest = service.pending:match("^(.-)\n(.*)$")
					service.pending = rest
					if line ~= "" then
						local event = json.decode_object(line)
						if not event then
							fail(service, "Invalid JSON from session workspace service.")
							return
						end
						handle(service, event)
					end
					if worker ~= service then
						return
					end
				end
			end)
		end,
		on_stderr = function(_, data)
			for _, line in ipairs(data) do
				if line ~= "" then
					table.insert(service.stderr, line)
					if #service.stderr > 20 then
						table.remove(service.stderr, 1)
					end
				end
			end
		end,
		on_exit = function(_, code)
			vim.schedule(function()
				fail(service, "Session workspace service exited (" .. code .. "); session files were kept. "
					.. table.concat(service.stderr, "\n"))
			end)
		end,
	})
	if not ok or job <= 0 then
		vim.fn.delete(agent_dir, "rf")
		return nil, ok and "Could not start session workspace service. Is Pi on PATH?" or tostring(job)
	end
	service.job = job
	worker = service
	if not send(service, { type = "get_commands", id = "commands" }) then
		return nil, "Could not initialize session workspace service RPC."
	end
	return service
end

function M.request(binary, workspace_root, payload, callback, authorize_remove)
	next_id = next_id + 1
	local request = {
		id = "session-service-" .. next_id,
		payload = payload,
		callback = callback,
		authorize_remove = authorize_remove,
	}
	if exiting then
		respond(request, { success = false, error = "Session workspace service is shutting down." })
		return
	end
	if not worker then
		local service, err = start(binary, workspace_root)
		if not service then
			respond(request, { success = false, error = err })
			return
		end
	end
	table.insert(worker.queue, request)
	pump(worker)
end

function M.stop()
	exiting = true
	local service = worker
	if not service then
		return
	end
	fail(service, "Session workspace service is shutting down.")
end

vim.api.nvim_create_autocmd("VimLeavePre", { callback = M.stop })

return M
