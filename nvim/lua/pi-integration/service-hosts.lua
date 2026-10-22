local store = require("pi-integration.frontend-store")
local transport = require("pi-integration.service-connection")
local M = {}
local hosts, started, timer = {}, false, nil
local forgotten_explicit = {}
local initial = { version = 1, hosts = {} }
local channel = vim.env.PI_CONSOLE_CHANNEL or "stable"
local function notify(message) vim.notify(tostring(message), vim.log.levels.WARN, { title = "Pi hosts" }) end
local function uid() return vim.fn.sha256(tostring(vim.uv.hrtime()) .. ":" .. vim.fn.getpid()) end
local function config()
	local data = store.load("hosts", initial, "config")
	assert(data.version == 1 and type(data.hosts) == "table", "Invalid saved hosts")
	return data
end
local function update(callback)
	local ok, err = store.update("hosts", initial, callback, "config")
	if not ok then notify(err) end
	return ok
end
local function persist(target)
	return update(function(data)
		local index
		for i, saved in ipairs(data.hosts) do if saved.key == target.key then index = i end end
		data.hosts[index or (#data.hosts + 1)] = vim.deepcopy(target)
		return true
	end)
end
local function save_local_identity(host)
	if host.remote or host.saved_identity or not host.host_id then return end
	local target = vim.deepcopy(host.target); target.host_id = host.host_id
	host.saved_identity = persist(target) == true
end
local function cache(host, rows)
	host.rows = rows
	local ok, err = store.update("discovery", vim.empty_dict(), function(data)
		data[host.host_id] = rows
		return true
	end)
	host.cache_dirty, host.cache_error = not ok, not ok and err or nil
end
local function stop(host, force)
	local was_connected = host.connected
	if host.connection then host.connection.close() end
	host.connection, host.connected, host.connecting = nil, false, false
	local waiters = host.waiters or {}; host.waiters = nil
	for _, callback in ipairs(waiters) do callback(false) end
	-- Fence an attachment immediately, including local controller callbacks.
	local frontend = package.loaded["pi-integration.service-frontend"]
	if (was_connected or force) and frontend and frontend.host_disconnected then frontend.host_disconnected(host.host_id, M.target(host)) end
end
local function connect(host)
	if host.connection or host.connecting or host.retry_at and vim.uv.now() < host.retry_at then return end
	host.connecting, host.error = true, nil
	local connection
	connection = transport.open(host, function(record)
		if host.connection ~= connection then return end
		if record.type == "hello" then
			local hello = record.result
			if hello.channel ~= channel or not vim.tbl_contains(hello.capabilities or {}, "sessions.subscribe") then
				host.error = "Incompatible discovery protocol/channel"; host.retry_at = vim.uv.now() + 30000; stop(host); return
			end
			host.host_id, host.hello, host.connected, host.connecting = hello.hostId, hello, true, false
			host.attempts, host.retry_at = 0, nil
			local waiters = host.waiters or {}; host.waiters = nil
			for _, callback in ipairs(waiters) do callback(true) end
			save_local_identity(host)
			connection.request("sessions.subscribe", {}, function(ok, result)
				if host.connection ~= connection then return end
				if ok and result.hostId == host.host_id then cache(host, result.sessions)
				else host.error = result.message or "Invalid owner summaries"; host.retry_at = vim.uv.now() + 30000; stop(host) end
			end)
		elseif record.type == "summaries" then
			if record.result.hostId == host.host_id and record.result.channel == channel then cache(host, record.result.sessions) end
		elseif record.type == "disconnected" then
			host.error, host.attempts = record.message, (host.attempts or 0) + 1
			host.retry_at = vim.uv.now() + math.min(30000, 1000 * 2 ^ math.min(host.attempts - 1, 5))
			stop(host)
		end
	end)
	host.connection = connection
end
local function local_target()
	return { key = "local", alias = "This machine", enabled = true }
end
function M.refresh()
	local ok, data = pcall(config)
	if not ok then notify(data); return end
	local desired = { local_target() }
	for _, target in ipairs(data.hosts) do
		if target.key == "local" then desired[1] = target else table.insert(desired, target) end
	end
	local explicit
	if vim.env.PI_CONSOLE_SERVICE_REMOTE then
		explicit = { key = "explicit:" .. vim.fn.sha256(vim.env.PI_CONSOLE_SERVICE_REMOTE), alias = "Explicit remote",
			remote = vim.env.PI_CONSOLE_SERVICE_REMOTE, credential_file = vim.env.PI_CONSOLE_SERVICE_CREDENTIAL_FILE,
			ca_file = vim.env.PI_CONSOLE_SERVICE_CA_FILE, enabled = true }
	elseif vim.env.PI_CONSOLE_SERVICE_ROOT then
		explicit = { key = "profile:" .. vim.fn.sha256(vim.env.PI_CONSOLE_SERVICE_ROOT), alias = "Local profile", root = vim.env.PI_CONSOLE_SERVICE_ROOT, enabled = true }
	end
	if explicit and not forgotten_explicit[explicit.key] then
		local found = false
		for _, target in ipairs(desired) do if target.key == explicit.key then found = true end end
		if not found then table.insert(desired, explicit) end
	end
	local retained = {}
	for _, target in ipairs(desired) do
		local host = hosts[target.key]
		if host and not vim.deep_equal(host.target, target) then
			if host.root == target.root and host.remote == target.remote and host.credential_file == target.credential_file
				and host.ca_file == target.ca_file and host.host_id == target.host_id and host.target.enabled == target.enabled then
				host.alias, host.target, host.saved_identity = target.alias, vim.deepcopy(target), true
			else stop(host); host = nil end
		end
		if not host then
			host = vim.deepcopy(target); host.target = vim.deepcopy(target); host.saved_identity = target.host_id ~= nil
			local loaded, rows = pcall(store.load, "discovery", vim.empty_dict())
			host.rows = loaded and rows[target.host_id] or {}
			hosts[target.key] = host
		end
		retained[target.key] = true
		if target.enabled ~= false then connect(host) else stop(host) end
		if host.cache_dirty and host.host_id then cache(host, host.rows) end
		if host.connected then save_local_identity(host) end
	end
	for key, host in pairs(hosts) do if not retained[key] then stop(host); hosts[key] = nil end end
end
function M.start()
	if started then return end
	started = true
	M.refresh()
	timer = vim.uv.new_timer()
	timer:start(1000, 1000, vim.schedule_wrap(M.refresh))
end
function M.find(identity)
	local fallback
	for _, host in pairs(hosts) do
		if host.host_id == identity then
			if host.connected then return host end
			if not fallback or fallback.target.enabled == false and host.target.enabled ~= false then fallback = host end
		end
	end
	return fallback
end
function M.list()
	M.start()
	local owners, entries = {}, {}
	local ordered = vim.tbl_keys(hosts); table.sort(ordered)
	for _, key in ipairs(ordered) do
		local host = hosts[key]
		if host.host_id and (not owners[host.host_id] or host.connected and not owners[host.host_id].connected) then owners[host.host_id] = host end
	end
	local identities = vim.tbl_keys(owners); table.sort(identities)
	for _, identity in ipairs(identities) do
		local host = owners[identity]
		for _, row in ipairs(host.rows or {}) do
			if row.state == "open" then
				local id = vim.json.encode({ identity, row.id })
				table.insert(entries, { id = id, host_id = identity, session_id = row.id, host_name = host.alias,
					connected = host.connected == true, status = host.connected and (row.live and row.live.status or "Idle") or "Disconnected",
					title = row.name or row.cwd or row.id, cwd = row.cwd, directory = row.cwd,
					location = host.alias, controller = row.live and row.live.controller, activity = nil,
					channel = channel, service_epoch = host.hello and host.hello.serviceEpoch,
					runtime_revision = row.live and row.live.runtimeRevision })
			end
		end
	end
	return entries
end
function M.expected_identity(target)
	local identity
	for _, saved in ipairs(config().hosts) do
		local matches = target.service_remote and saved.remote == target.service_remote
			or not target.service_remote and not saved.remote and saved.root == target.service_root
		if matches and saved.host_id then
			assert(not identity or identity == saved.host_id, "Endpoint has conflicting saved identities; confirm it in Hosts")
			identity = saved.host_id
		end
	end
	return identity
end
function M.target(host)
	return { service_root = host.root, service_remote = host.remote, credential_file = host.credential_file,
		ca_file = host.ca_file, expected_host = host.host_id }
end
function M.open(entry)
	local host = M.find(entry.host_id)
	if not host or not host.connected then return nil, "Host disconnected; cached rows cannot be attached or mutated" end
	for _, row in ipairs(host.rows or {}) do
		if row.id == entry.session_id and row.archived then notify("Conversation is archived on " .. host.alias .. "; explicitly unarchive it in :PiSessions before resuming."); return true end
	end
	local connection = host.connection
	local function select(resume)
		if not host.connected or host.connection ~= connection then notify("Owner connection changed; select the session again"); return end
		require("pi-integration.service-frontend").select_owner(M.target(host), entry.session_id, resume)
	end
	if entry.status == "Not Open" then
		vim.ui.select({ "Cancel", "Resume" }, { prompt = "Resume stopped session on " .. host.alias .. "? No work is replayed." }, function(choice) if choice == "Resume" then select(true) end end)
	else select(false) end
	return true
end
local function saved_request(host, envelope, callback)
	local key = host.host_id .. "/" .. envelope.id
	-- Persist intent before delivery. Recovery only looks up this exact ID.
	local ok, err = store.update("saved-requests", vim.empty_dict(), function(data)
		for _, item in pairs(data) do
			if item.host_id == host.host_id and item.envelope.payload.sessionId == envelope.payload.sessionId
				and not item.reviewed and (not item.receipt or item.receipt.status == "accepted" or item.receipt.status == "unknown" or item.receipt.status == "uncertain") then
				return nil, "Original request " .. item.envelope.id .. " may already have run. Inspect :PiSavedOperations before authorizing new work."
			end
		end
		data[key] = { envelope = envelope, host_id = host.host_id, target = M.target(host) }
		return true
	end)
	if not ok then notify("Saved-session request was not sent: " .. tostring(err)); return end
	local connection = host.connection
	connection.request("host.command", envelope, function(success, receipt)
		if success then
			local saved, failure = store.update("saved-requests", vim.empty_dict(), function(data)
				if data[key] then data[key].receipt = receipt end
				return true
			end)
			if not saved then notify("Could not save outcome; inspect original ID " .. envelope.id .. ": " .. tostring(failure)) end
			notify(envelope.operation .. ": " .. receipt.status .. (receipt.error and ("\n" .. receipt.error.message) or ""))
			if callback and host.connected and host.connection == connection then callback(receipt) end
		else
			notify("Saved-session request " .. envelope.id .. " was not replayed. " .. tostring(receipt.message or "Disconnected") .. " Inspect :PiSavedOperations.")
		end
	end)
end
function M.saved_operations()
	M.start()
	local data = store.load("saved-requests", vim.empty_dict())
	local entries = vim.tbl_values(data)
	vim.ui.select(entries, { prompt = "Saved-session outcomes (status lookup only; never replay)", format_item = function(item)
		return item.host_id .. " " .. item.envelope.operation .. " " .. item.envelope.id .. " " .. (item.receipt and item.receipt.status or "unknown")
	end }, function(item)
		if not item then return end
		local host = M.find(item.host_id)
		if not host or not host.connected then notify("Connect to that owner before looking up its original ID"); return end
		host.connection.request("host.status", { serviceEpoch = item.envelope.serviceEpoch, commandId = item.envelope.id }, function(ok, receipt)
			if ok then
				store.update("saved-requests", vim.empty_dict(), function(records)
					local key = item.host_id .. "/" .. item.envelope.id
					if records[key] then records[key].receipt = receipt end
					return true
				end)
				vim.notify(vim.inspect(receipt), vim.log.levels.INFO, { title = "Original saved-session outcome" })
				if receipt.status == "unknown" or receipt.status == "uncertain" then
					vim.ui.select({ "Keep protected", "Allow a new saved-session request" }, { prompt = "Original work may have partially or fully run. Inspect owner session/workspace state first. This does not replay it." }, function(choice)
						if choice ~= "Allow a new saved-session request" then return end
						local saved, err = store.update("saved-requests", vim.empty_dict(), function(records)
							local entry = records[item.host_id .. "/" .. item.envelope.id]
							if entry then entry.reviewed = true end
							return true
						end)
						if not saved then notify(err) end
					end)
				end
			else notify(receipt.message or "Status unavailable; nothing replayed") end
		end)
	end)
end
local function saved_action(host, row, operation)
	local connection, epoch = host.connection, host.hello.serviceEpoch
	local function current() return host.connected and host.connection == connection and host.hello.serviceEpoch == epoch end
	connection.request("host.saved", { serviceEpoch = epoch, sessionId = row.id }, function(ok, preview)
		if not current() then return end
		if not ok then notify(preview.message); return end
		local verb = operation == "host.archive" and (preview.archived and "Unarchive" or "Archive")
			or (preview.mode == "trash" and "Move to owner trash" or "Permanently delete")
		local lines = { verb .. " conversation (1 file) on " .. host.alias .. "?", row.name or row.cwd or row.id, row.id }
		if operation == "host.delete" and #(preview.workspaces or {}) > 0 then
			table.insert(lines, "Remaining worktrees will be removed and unintegrated changes discarded; existing destination changes will not be reverted.")
			for _, workspace in ipairs(preview.workspaces) do
				table.insert(lines, workspace.label .. ": " .. workspace.worktreePath .. (workspace.retained and "" or " (retry incomplete cleanup)"))
				table.insert(lines, "Recovery patch: " .. workspace.resultPatchPath)
			end
			table.insert(lines, "Recovery patches are prepared after confirmation. Ignored untracked files, including copied ignored files, are NOT in patches and will be removed with worktrees. Patches and workspace records are kept on the owner.")
		end
		vim.ui.select({ "Cancel", verb }, { prompt = table.concat(lines, "\n") }, function(choice)
			if choice ~= verb then return end
			if not current() then notify("Owner connection changed while confirming; select the conversation again"); return end
			local payload = { sessionId = row.id, expectedVersion = preview.version, confirmed = true }
			if operation == "host.archive" then payload.archived = not preview.archived else payload.mode = preview.mode end
			saved_request(host, { id = uid(), serviceEpoch = epoch, operation = operation, payload = payload })
		end)
	end)
end
function M.history_picker()
	M.start()
	local choices = {}
	for _, host in pairs(hosts) do if host.connected then table.insert(choices, host) end end
	vim.ui.select(choices, { prompt = "History owner", format_item = function(host) return host.alias .. " [" .. host.host_id .. "]" end }, function(host)
		if not host or not host.connected then return end
		local connection = host.connection
		connection.request("sessions", {}, function(ok, result)
			if not ok or not host.connected or host.connection ~= connection then return end
			vim.ui.select(result.sessions, { prompt = "History on " .. host.alias, format_item = function(row) return (row.name or row.cwd) .. " [" .. row.id .. "] (" .. row.state .. (row.archived and ", archived" or "") .. ")" end }, function(row)
				if not row or not host.connected or host.connection ~= connection then return end
				if row.state == "open" then
					M.open({ host_id = host.host_id, session_id = row.id, status = "Idle" }); return
				end
				local actions = row.archived and { "Unarchive", "Delete" } or { "Resume", "Archive", "Delete" }
				vim.ui.select(actions, { prompt = "Saved conversation on " .. host.alias .. ": " .. (row.name or row.id) }, function(action)
					if not action or not host.connected or host.connection ~= connection then return end
					if action == "Resume" then M.open({ host_id = host.host_id, session_id = row.id, status = "Not Open" })
					else saved_action(host, row, action == "Delete" and "host.delete" or "host.archive") end
				end)
			end)
		end)
	end)
end
function M.new_conversation()
	M.start()
	local choices = {}
	for _, host in pairs(hosts) do table.insert(choices, host) end
	table.sort(choices, function(a, b) return a.alias < b.alias end)
	vim.ui.select(choices, { prompt = "New conversation owner", format_item = function(host)
		return host.alias .. " [" .. (host.host_id or "connecting") .. "] " .. (host.connected and "Connected" or host.connecting and "Connecting" or "Disconnected")
	end }, function(host)
		if not host then return end
		local function choose_directory(ready)
			if not ready then notify("Owner unavailable; connect/retry in Hosts. Nothing created."); return end
			local connection = host.connection
			local epoch = host.hello.serviceEpoch
			local function current() return host.connected and host.connection == connection and host.hello.serviceEpoch == epoch end
			require("pi-integration.directory-history").owner_input({ label = host.alias .. " [" .. host.host_id .. "]", key = channel .. "/" .. host.host_id,
				current = current, request = function(query, callback)
					connection.request("host.directories", vim.tbl_extend("force", query, { serviceEpoch = epoch }), callback)
				end }, function(cwd)
				if current() then require("pi-integration.service-frontend").select_owner(M.target(host), nil, false, cwd) end
			end)
		end
		if host.connecting then host.waiters = host.waiters or {}; table.insert(host.waiters, choose_directory)
		else choose_directory(host.connected) end
	end)
end
-- Import a D1 out-of-band device credential only after TLS + identity validation.
local function confirm_target(target, previous)
	local probe = vim.deepcopy(target); probe.host_id = nil
	local connection
	connection = transport.open(probe, function(record)
		if record.type == "disconnected" then notify(record.message); return end
		if record.type ~= "hello" then return end
		connection.close()
		local hello = record.result
		if hello.channel ~= channel then notify("Channel mismatch; host was not saved"); return end
		local changed = previous and previous.host_id ~= hello.hostId
		vim.ui.select({ "Cancel", "Save confirmed identity" }, { prompt = (changed and "REPLACEMENT service. Old pins remain separate. " or "") .. target.alias .. " = " .. hello.hostId .. " / " .. hello.channel }, function(choice)
			if choice ~= "Save confirmed identity" then return end
			target.host_id, target.enabled = hello.hostId, true
			if target.remote then
				local directory = vim.fs.joinpath(store.root("config"), "credentials")
				local ok, err = pcall(function()
					store.prepare(directory)
					local destination = vim.fs.joinpath(directory, uid() .. ".json")
					assert(vim.uv.fs_copyfile(target.credential_file, destination, 1))
					assert(vim.uv.fs_chmod(destination, 384))
					local copied, device = pcall(vim.json.decode, table.concat(vim.fn.readfile(destination), "\n"))
					if not copied or device.hostId ~= hello.hostId or device.channel ~= hello.channel or device.deviceId ~= hello.deviceId then
						vim.uv.fs_unlink(destination); error("Credential changed during confirmation; host was not saved")
					end
					target.credential_file = destination
				end)
				if not ok then notify(err); return end
			end
			if persist(target) then
				if previous and previous.credential_file and previous.credential_file ~= target.credential_file
					and vim.fs.dirname(previous.credential_file) == vim.fs.joinpath(store.root("config"), "credentials") then vim.uv.fs_unlink(previous.credential_file) end
				M.refresh()
			end
		end)
	end)
end
local function edit(previous)
	local target = previous and vim.deepcopy(previous.target) or { key = uid() }
	vim.ui.input({ prompt = "Host alias: ", default = target.alias or "" }, function(alias)
		if not alias or vim.trim(alias) == "" or alias:find("%c") then return end
		target.alias = vim.trim(alias)
		vim.ui.select({ "HTTPS service", "Local service profile" }, { prompt = "Transport" }, function(kind)
			if not kind then return end
			vim.ui.input({ prompt = kind == "HTTPS service" and "HTTPS origin: " or "Absolute local service root: ", default = target.remote or target.root or "" }, function(endpoint)
				if not endpoint or endpoint == "" then return end
				if kind == "Local service profile" then
					if endpoint:sub(1, 1) ~= "/" then notify("Local root must be absolute"); return end
					target.root, target.remote, target.credential_file, target.ca_file = endpoint, nil, nil, nil
					confirm_target(target, previous)
				else
					target.remote, target.root = endpoint, nil
					vim.ui.input({ prompt = "D1 device credential file (issued on owner; transferred privately): ", default = target.credential_file or "", completion = "file" }, function(file)
						if not file or file == "" then return end
						target.credential_file = vim.fn.fnamemodify(vim.fn.expand(file), ":p")
						vim.ui.input({ prompt = "CA file (blank = system trust): ", default = target.ca_file or "", completion = "file" }, function(ca)
							if ca == nil then return end
							target.ca_file = ca ~= "" and vim.fn.fnamemodify(vim.fn.expand(ca), ":p") or nil
							confirm_target(target, previous)
						end)
					end)
				end
			end)
		end)
	end)
end
function M.picker()
	M.start()
	local choices = {}
	for _, host in pairs(hosts) do table.insert(choices, host) end
	table.sort(choices, function(a, b) return a.alias < b.alias end)
	table.insert(choices, { alias = "+ Add host", add = true })
	vim.ui.select(choices, { prompt = "Hosts", format_item = function(host)
		return host.add and host.alias or host.alias .. " | " .. (host.remote or host.root or "Local service") .. " | " .. (host.connected and "Connected" or host.connecting and "Connecting" or "Disconnected") .. (host.error and " | " .. host.error or "")
	end }, function(host)
		if not host then return end
		if host.add then edit(); return end
		vim.ui.select({ "Connect/retry", "Disconnect", "Edit alias", "Edit / confirm identity", "Forget" }, { prompt = host.alias }, function(action)
			if action == "Connect/retry" then
				local target = vim.deepcopy(host.target); target.enabled = true
				if persist(target) then stop(host); host.retry_at, host.attempts = nil, 0; M.refresh() end
			elseif action == "Disconnect" then
				if update(function(data)
					local saved_keys = {}
					for _, target in ipairs(data.hosts) do
						saved_keys[target.key] = true
						if target.key == host.key or host.host_id and target.host_id == host.host_id then target.enabled = false end
					end
					for _, source in pairs(hosts) do
						if (source == host or host.host_id and source.host_id == host.host_id) and not saved_keys[source.key] then
							local target = vim.deepcopy(source.target); target.host_id, target.enabled = source.host_id, false
							table.insert(data.hosts, target)
						end
					end
					return true
				end) then
					for _, source in pairs(hosts) do if source == host or host.host_id and source.host_id == host.host_id then stop(source, true) end end
					M.refresh()
				end
			elseif action == "Edit alias" then
				if not host.target.host_id then notify("Confirm this service in Edit / confirm identity before saving it"); return end
				vim.ui.input({ prompt = "Host alias: ", default = host.alias }, function(alias)
					if not alias or vim.trim(alias) == "" or alias:find("%c") then return end
					local target = vim.deepcopy(host.target); target.alias = vim.trim(alias)
					if persist(target) then M.refresh() end
				end)
			elseif action == "Edit / confirm identity" then edit(host)
			elseif action == "Forget" then
				if host.key == "local" then notify("Default local source can be disconnected, not forgotten"); return end
				vim.ui.select({ "Cancel", "Forget local host and credential" }, { prompt = "Execution continues; no devices are revoked. Organization is retained." }, function(choice)
					if choice ~= "Forget local host and credential" then return end
					if update(function(data)
						for i, saved in ipairs(data.hosts) do if saved.key == host.key then table.remove(data.hosts, i); break end end
						return true
					end) then
						forgotten_explicit[host.key] = true
						stop(host, true)
						if host.credential_file and vim.fs.dirname(host.credential_file) == vim.fs.joinpath(store.root("config"), "credentials") then vim.uv.fs_unlink(host.credential_file) end
						M.refresh()
					end
				end)
			end
		end)
	end)
end
vim.api.nvim_create_autocmd("VimLeavePre", { callback = function()
	if timer then timer:stop(); timer:close(); timer = nil end
	for _, host in pairs(hosts) do if host.connection then host.connection.close() end end
end })
return M
