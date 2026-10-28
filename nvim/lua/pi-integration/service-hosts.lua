local store = require("pi-integration.frontend-store")
local transport = require("pi-integration.service-connection")
local M = {}
local hosts, started, timer = {}, false, nil
local forgotten_explicit = {}
local reminder_checked = {}
local saved_request
local pending_deletions = {}
local opening = {}
local initial = { version = 1, hosts = {} }
local channel = vim.env.PI_CONSOLE_CHANNEL or "stable"
local function notify(message) require("pi-integration.logs").notify(tostring(message), vim.log.levels.WARN, { title = "Pi hosts" }) end
local function uid() return vim.fn.sha256(tostring(vim.uv.hrtime()) .. ":" .. vim.fn.getpid()) end
local function host_label(host)
	local endpoint = host.remote or host.service_remote or host.root or host.service_root
	return (host.alias or "Saved host") .. (endpoint and (" (" .. endpoint .. ")") or "")
end
local function session_title(row)
	return type(row.name) == "string" and row.name:match("%S") and row.name or "Untitled session"
end
local function session_label(host, session_id)
	for _, row in ipairs(host and host.rows or {}) do
		if row.id == session_id then return session_title(row) end
	end
	return "Conversation"
end
local function outcome_label(receipt)
	local lines = { receipt.status or "unknown" }
	if receipt.error then table.insert(lines, receipt.error.message) end
	local result = receipt.result or {}
	if result.archived ~= nil then table.insert(lines, result.archived and "Conversation archived" or "Conversation unarchived") end
	if result.deleted then table.insert(lines, "Conversation deleted") end
	if result.mode then table.insert(lines, "Mode: " .. result.mode) end
	if result.enabled ~= nil then table.insert(lines, result.enabled and "Enabled" or "Disabled") end
	if result.changed ~= nil then table.insert(lines, result.changed and "Changed" or "Unchanged") end
	return table.concat(lines, "\n")
end
local function target_key(target)
	if not target.remote and not target.root then return "local" end
	return "endpoint:" .. vim.fn.sha256(vim.json.encode({ target.remote or "", target.root or "" }))
end
local function identities()
	local data = store.load("host-identities", vim.empty_dict())
	assert(type(data) == "table", "Invalid saved host identities")
	for key, identity in pairs(data) do
		assert(type(key) == "string" and type(identity) == "string" and identity ~= "", "Invalid saved host identity")
	end
	return data
end
local function normalize(data)
	assert(type(data) == "table" and data.version == 1 and type(data.hosts) == "table" and vim.islist(data.hosts),
		"Invalid hosts file: " .. store.path("hosts", "config"))
	local saved, seen = identities(), {}
	for i, target in ipairs(data.hosts) do
		local prefix = "Invalid host entry " .. i .. ": "
		assert(type(target) == "table", prefix .. "expected a mapping")
		assert(target.remote == nil or type(target.remote) == "string" and target.remote:match("%S"), prefix .. "remote must be an HTTP origin")
		assert(target.root == nil or type(target.root) == "string" and target.root:sub(1, 1) == "/", prefix .. "root must be absolute")
		assert(not (target.remote and target.root), prefix .. "choose remote or root")
		assert(target.alias == nil or type(target.alias) == "string" and not target.alias:find("%c"), prefix .. "alias must be text")
		assert(target.enabled == nil or type(target.enabled) == "boolean", prefix .. "enabled must be boolean")
		assert(target.host_id == nil or type(target.host_id) == "string" and target.host_id ~= "", prefix .. "invalid legacy host_id")
		target.key = target_key(target)
		assert(not seen[target.key], prefix .. "duplicate endpoint")
		seen[target.key] = true
		target.alias = target.alias and target.alias:match("%S") and target.alias or target.remote or target.root or "localhost"
		target.host_id = saved[target.key] or target.host_id
	end
	return data, saved
end
local function config()
	return normalize(store.load("hosts", initial, "config"))
end
local function public_target(target)
	return { alias = target.alias, remote = target.remote, root = target.root, enabled = target.enabled }
end
local function update(callback)
	local ok, err = store.update("hosts", initial, function(data)
		normalize(data)
		-- Retain legacy pins before removing their fields from the YAML.
		local saved, err = store.update("host-identities", vim.empty_dict(), function(pins)
			for _, target in ipairs(data.hosts) do
				if target.host_id and not pins[target.key] then pins[target.key] = target.host_id end
			end
			return true
		end)
		if not saved then return nil, err end
		local answer, failure = callback(data)
		if not answer then return nil, failure end
		normalize(data)
		for i, target in ipairs(data.hosts) do data.hosts[i] = public_target(target) end
		return answer
	end, "config")
	if not ok then notify(err) end
	return ok
end
local function persist(target, previous_key)
	return update(function(data)
		local index
		for i, saved in ipairs(data.hosts) do
			if saved.key == (previous_key or target_key(target)) then index = i end
		end
		data.hosts[index or (#data.hosts + 1)] = vim.deepcopy(target)
		return true
	end)
end
local function save_identity(target, identity, replace)
	local key = target_key(target)
	local loaded, saved = pcall(identities)
	if not loaded then return nil, tostring(saved) end
	if saved[key] == identity then return true end
	return store.update("host-identities", vim.empty_dict(), function(data)
		local previous = data[key] or target.host_id
		if previous and previous ~= identity and not replace then
			return nil, "Endpoint service identity changed; confirm the replacement in Hosts before attaching"
		end
		data[key] = identity
		return true
	end)
end
local function flush_cache(host)
	if host.cache_dirty and (not host.cache_retry_at or vim.uv.hrtime() / 1e6 >= host.cache_retry_at) then
		local ok, err = store.update("discovery", vim.empty_dict(), function(data)
			data[host.host_id] = host.rows
			return true
		end)
		host.cache_dirty, host.cache_error = not ok, not ok and err or nil
		host.cache_retry_at = not ok and vim.uv.hrtime() / 1e6 + 1000 or nil
	end
	if host.pins_dirty and (not host.pins_retry_at or vim.uv.hrtime() / 1e6 >= host.pins_retry_at) then
		local ok, err = require("pi-integration.service-pins").refresh(host.host_id, host.rows, host_label(host))
		host.pins_dirty, host.pins_error = not ok, not ok and err or nil
		host.pins_retry_at = not ok and vim.uv.hrtime() / 1e6 + 1000 or nil
	end
end
local function cache(host, rows)
	host.rows, host.cache_dirty, host.pins_dirty = rows, true, true
	flush_cache(host)
end
local function stop(host)
	if host.connection then host.connection.close() end
	host.connection, host.connected, host.connecting, host.pending_identity = nil, false, false, nil
	local waiters = host.waiters or {}; host.waiters = nil
	for _, callback in ipairs(waiters) do callback(false) end
end
-- Discovery transport failure says nothing about the independent conversation bridge.
-- Only registry changes and deliberate host actions revoke that attachment.
local function detach_frontend(host, reason)
	local frontend = package.loaded["pi-integration.service-frontend"]
	if frontend and frontend.host_disabled then frontend.host_disabled(host.host_id, M.target(host), reason) end
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
			host.pending_identity = hello.hostId
			local delay = 100
			local function accept_hello()
				if host.connection ~= connection then return end
				local saved, err, code = save_identity(host, hello.hostId)
				if not saved then
					if code == "busy" then
						vim.defer_fn(accept_hello, delay)
						delay = math.min(1000, delay * 2)
						return
					end
					notify(err)
					host.error = err; host.retry_at = vim.uv.now() + 30000; stop(host); return
				end
				host.host_id, host.hello, host.connected, host.connecting = hello.hostId, hello, true, false
				host.pending_identity = nil
				host.target.host_id = hello.hostId
				host.attempts, host.retry_at = 0, nil
				local waiters = host.waiters or {}; host.waiters = nil
				for _, callback in ipairs(waiters) do callback(true) end
				if host.connection ~= connection then return end
				connection.request("sessions.subscribe", {}, function(ok, result)
					if host.connection ~= connection then return end
					if ok and result.hostId == host.host_id then
						cache(host, result.sessions)
						M.maybe_prompt_archive(host.host_id)
					else host.error = result.message or "Invalid session summaries"; host.retry_at = vim.uv.now() + 30000; stop(host) end
				end)
			end
			accept_hello()
		elseif record.type == "summaries" then
			if record.result.hostId == host.host_id and record.result.channel == channel then cache(host, record.result.sessions) end
		elseif record.type == "disconnected" then
			require("pi-integration.logs").add(vim.log.levels.WARN, "Discovery disconnected: " .. tostring(record.message),
				{ host = host_label(host), host_id = host.host_id, code = record.code,
					connection_id = record.connectionId or host.hello and host.hello.connectionId })
			host.error, host.attempts = record.message, (host.attempts or 0) + 1
			host.retry_at = vim.uv.now() + math.min(30000, 1000 * 2 ^ math.min(host.attempts - 1, 5))
			stop(host)
		end
	end)
	host.connection = connection
end
local function local_target()
	return { key = "local", alias = "localhost", enabled = true }
end
function M.refresh()
	local ok, data, saved = pcall(config)
	if not ok then notify(data); return end
	local desired = { local_target() }
	for _, target in ipairs(data.hosts) do
		if target.key == "local" then desired[1] = target else table.insert(desired, target) end
	end
	if desired[1].alias == "This machine" then
		desired[1] = vim.tbl_extend("force", desired[1], { alias = "localhost" })
	end
	local explicit
	if vim.env.PI_CONSOLE_SERVICE_REMOTE then
		explicit = { alias = "Unsaved host",
			remote = vim.env.PI_CONSOLE_SERVICE_REMOTE, host_id = vim.env.PI_CONSOLE_SERVICE_EXPECTED_HOST, enabled = true }
	elseif vim.env.PI_CONSOLE_SERVICE_ROOT then
		explicit = { alias = "Local profile", root = vim.env.PI_CONSOLE_SERVICE_ROOT, enabled = true }
	end
	if explicit then explicit.key = target_key(explicit) end
	if explicit and not forgotten_explicit[explicit.key] then
		local found = false
		for _, target in ipairs(desired) do
			if target.key == explicit.key or explicit.remote and target.remote == explicit.remote then found = true end
		end
		if not found then table.insert(desired, explicit) end
	end
	local retained = {}
	for _, target in ipairs(desired) do
		target.host_id = target.host_id or saved[target.key]
		local host = hosts[target.key]
		if host and not vim.deep_equal(host.target, target) then
			-- Another frontend may publish the same first pin while this hello
			-- waits for the store lock. That does not revoke an attachment.
			local same_identity = host.host_id == target.host_id
				or host.pending_identity and host.pending_identity == target.host_id
			if host.root == target.root and host.remote == target.remote and same_identity and host.target.enabled == target.enabled then
				host.alias, host.target = target.alias, vim.deepcopy(target)
				host.pins_dirty = true
			else
				if target.enabled == false or host.root ~= target.root or host.remote ~= target.remote or host.host_id ~= target.host_id then
					detach_frontend(host, "Host disabled or endpoint/identity configuration changed")
				end
				stop(host); host = nil
			end
		end
		if not host then
			host = vim.deepcopy(target); host.target = vim.deepcopy(target)
			local loaded, rows = pcall(store.load, "discovery", vim.empty_dict())
			host.rows = loaded and rows[target.host_id] or {}
			hosts[target.key] = host
		end
		retained[target.key] = true
		if target.enabled ~= false then connect(host) else stop(host) end
		if host.host_id then flush_cache(host) end
	end
	for key, host in pairs(hosts) do
		if not retained[key] then detach_frontend(host, "Host removed from configuration"); stop(host); hosts[key] = nil end
	end
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
	local tmux = require("pi-integration.backends.tmux")
	local attachments = tmux.available() and tmux.list() or {}
	local identities = vim.tbl_keys(owners); table.sort(identities)
	for _, identity in ipairs(identities) do
		local host = owners[identity]
		for _, row in ipairs(host.rows or {}) do
			if row.live then
				local id = vim.json.encode({ identity, row.id })
				local live = row.live or {}
				local focused, initial_group
				local frontend_keys = {}
				for _, pane in ipairs(attachments or {}) do
					if pane.host_id == identity and pane.session_id == row.id then
						table.insert(frontend_keys, "frontend:" .. vim.json.encode({ pane.id, pane.pid }))
						focused = math.max(focused or 0, pane.last_focused_at or 0)
						initial_group = initial_group or pane.initial_group
					end
				end
				local status = live.status or "Idle"
				local active_runs = {}
				for _, run in ipairs(host.connected and live.subagentRuns or {}) do
					if run.status == "running" then table.insert(active_runs, run) end
				end
				table.insert(entries, { id = id, host_id = identity, session_id = row.id, host_name = host_label(host),
					connected = host.connected == true, status = host.connected and status or "Unknown", frontend_keys = frontend_keys, initial_group = initial_group,
					title = session_title(row), cwd = row.cwd, directory = row.cwd,
					location = host.alias, controller = host.connected and live.controller or nil, activity = nil,
					workspace_cwd = row.live and row.live.cwd or row.cwd, last_focused_at = focused,
					subagent_runs = active_runs, subagents = #active_runs,
					access_mode = host.connected and live.accessMode or nil, integration_mode = host.connected and live.integrationMode or nil,
					notification_status = host.connected and (live.notificationsEnabled and "notify on" or "notify off") or nil,
					channel = channel, service_epoch = host.hello and host.hello.serviceEpoch,
					runtime_revision = row.live and row.live.runtimeRevision })
			end
		end
	end
	-- An empty frontend has a pane identity, never a fabricated owner session ID.
	for _, pane in ipairs(attachments or {}) do
		if pane.frontend_attachment and not pane.session_id then
			local host = owners[pane.host_id]
			local entry = vim.deepcopy(pane)
			entry.frontend_id = vim.json.encode({ pane.id, pane.pid })
			entry.id = "frontend:" .. entry.frontend_id
			entry.frontend_pane, entry.frontend_host_id = pane.id, pane.host_id
			entry.host_id, entry.session_id = nil, nil
			entry.host_name = host and host_label(host) or "Unconnected frontend"
			entry.location = host and host.alias or pane.location
			entry.directory, entry.is_new_session = pane.cwd, true
			table.insert(entries, entry)
		end
	end
	return entries
end
function M.expected_identity(target)
	local data, saved_identities = config()
	local identity = saved_identities[target_key({ remote = target.service_remote, root = target.service_root })]
	for _, saved in ipairs(data.hosts) do
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
	return { service_root = host.root, service_remote = host.remote, expected_host = host.host_id }
end
function M.open(entry, in_place)
	if entry.frontend_pane then return require("pi-integration.backends.tmux").focus(entry.frontend_pane) end
	local host = M.find(entry.host_id)
	if not host or not host.connected then return nil, "Host disconnected; cached rows cannot be attached or mutated" end
	local resume = entry.status == "Stopped"
	for _, row in ipairs(host.rows or {}) do
		if row.id == entry.session_id then
			if row.archived then notify("Conversation is archived on " .. host.alias .. "; explicitly unarchive it in :PiSessions before resuming."); return true end
			-- Picker rows can predate the overview's current live summary.
			if row.live then resume = false end
		end
	end
	local connection = host.connection
	local key = host.host_id .. "/" .. entry.session_id
	local intent = opening[key]
	if intent and intent.connection ~= connection then opening[key], intent = nil, nil end
	if intent and not intent.completed then return true end
	local function select(reopen)
		if not host.connected or host.connection ~= connection then notify("Host connection changed; select the session again"); return end
		local frontend = require("pi-integration.service-frontend")
		if in_place == nil then in_place = frontend.config.role == "conversation" end
		if in_place then frontend.select_owner(M.target(host), entry.session_id, resume); return end
		local tmux = require("pi-integration.backends.tmux")
		if not tmux.available() then notify("Opening a conversation from this view requires tmux"); return end
		local panes, err = tmux.list()
		if not panes then notify(err); return end
		for _, pane in ipairs(panes) do
			if pane.host_id == entry.host_id and pane.session_id == entry.session_id then
				if reopen then
					local reopened, reopen_error = tmux.reopen_frontend(pane)
					if not reopened then notify("Session resumed, but frontend reopening failed: " .. tostring(reopen_error)); return end
				end
				local ok, focus_error = tmux.focus(pane.id)
				if not ok then notify(focus_error) end
				return
			end
		end
		local opened, failure = tmux.launch_service(frontend.config.launcher, M.target(host), entry.session_id, nil, reopen and "reopen" or false)
		if not opened then notify(failure) end
	end
	local function resume_session()
		intent = { connection = connection }
		opening[key] = intent
		-- Durable ID/outcome handling stays on the overview connection. Its receipt
		-- confirms registration, not readiness: editor startup overlaps hydration.
		saved_request(host, { id = uid(), serviceEpoch = host.hello.serviceEpoch,
			operation = "host.resume", payload = { sessionId = entry.session_id } }, function(receipt)
			if receipt.status ~= "completed" then
				if opening[key] == intent then opening[key] = nil end
				return -- Unknown/failed work is inspected, never replayed by a new editor.
			end
			intent.completed = true
			select(true)
		end)
	end
	local frontend = require("pi-integration.service-frontend")
	local local_selection = in_place == true or in_place == nil and frontend.config.role == "conversation"
	if intent and intent.completed and not local_selection and entry.status == "Stopped" then
		if not require("pi-integration.backends.tmux").available() then return nil, "Opening a conversation from this view requires tmux" end
		if intent.checking then return true end
		intent.checking = true
		local epoch = host.hello.serviceEpoch
		-- Discovery can miss a worker's entire lifetime. A read issued after its
		-- registration receipt distinguishes a stopped worker from a stale row.
		connection.request("sessions", {}, function(ok, result)
			if opening[key] ~= intent or not host.connected or host.connection ~= connection
				or host.hello.serviceEpoch ~= epoch then return end
			intent.checking = nil
			if not ok then notify(result.message or "Session state unavailable; no resume was sent"); return end
			if result.serviceEpoch ~= epoch then return end
			for _, row in ipairs(result.sessions or {}) do
				if row.id == entry.session_id then
					if row.archived or row.deleted then notify("Session is archived or deleted; no resume was sent"); return end
					if row.live then select(true)
					else opening[key] = nil; resume_session() end
					return
				end
			end
			notify("Session no longer exists; no resume was sent")
		end)
	elseif resume and not local_selection and not intent then
		if not require("pi-integration.backends.tmux").available() then return nil, "Opening a conversation from this view requires tmux" end
		resume_session()
	else select(intent and intent.completed or false) end
	return true
end
saved_request = function(host, envelope, callback)
	local key = host.host_id .. "/" .. envelope.id
	-- Persist intent before delivery. Recovery only looks up this exact ID.
	local ok, err = store.update("saved-requests", vim.empty_dict(), function(data)
		for _, item in pairs(data) do
			if item.host_id == host.host_id and item.envelope.payload.sessionId == envelope.payload.sessionId
				and not item.reviewed and (not item.receipt or item.receipt.status == "accepted" or item.receipt.status == "unknown" or item.receipt.status == "uncertain") then
				return nil, "The original request may already have run. Inspect :PiSavedOperations before authorizing new work."
			end
		end
		data[key] = { envelope = envelope, host_id = host.host_id, target = M.target(host) }
		return true
	end)
	if not ok then
		notify("Saved-session request was not sent: " .. tostring(err))
		if callback then callback({ status = "not_sent", error = { message = tostring(err) } }) end
		return
	end
	local connection = host.connection
	connection.request("host.command", envelope, function(success, receipt)
		if success then
			local saved, failure = store.update("saved-requests", vim.empty_dict(), function(data)
				if data[key] then data[key].receipt = receipt end
				return true
			end)
			if not saved then notify("Could not save outcome; inspect :PiSavedOperations: " .. tostring(failure)) end
			notify(envelope.operation .. ": " .. receipt.status .. (receipt.error and ("\n" .. receipt.error.message) or ""))
			if callback then callback(receipt) end
		else
			notify("Saved-session request was not replayed. " .. tostring(receipt.message or "Disconnected") .. " Inspect :PiSavedOperations.")
			if callback then callback({ status = "unknown", error = { message = receipt.message or "Disconnected; inspect :PiSavedOperations" } }) end
		end
	end)
end
function M.saved_operations()
	M.start()
	local data = store.load("saved-requests", vim.empty_dict())
	local entries = vim.tbl_values(data)
	vim.ui.select(entries, { prompt = "Saved-session outcomes (status lookup only; never replay)", format_item = function(item)
		local host = M.find(item.host_id)
		return host_label(host or item.target or {}) .. " | " .. session_label(host, item.envelope.payload.sessionId)
			.. " | " .. item.envelope.operation .. " | " .. (item.receipt and item.receipt.status or "unknown")
	end }, function(item)
		if not item then return end
		local host = M.find(item.host_id)
		if not host or not host.connected then notify("Connect to that host before looking up its outcome"); return end
		host.connection.request("host.status", { serviceEpoch = item.envelope.serviceEpoch, commandId = item.envelope.id }, function(ok, receipt)
			if ok then
				store.update("saved-requests", vim.empty_dict(), function(records)
					local key = item.host_id .. "/" .. item.envelope.id
					if records[key] then records[key].receipt = receipt end
					return true
				end)
				require("pi-integration.logs").notify(item.envelope.operation .. ": " .. outcome_label(receipt), vim.log.levels.INFO, { title = "Saved-session outcome" })
				if receipt.status == "unknown" or receipt.status == "uncertain" then
					vim.ui.select({ "Allow a new saved-session request", "Keep protected" }, { prompt = "Original work may have partially or fully run. Inspect the session/workspace state on that host first. This does not replay it." }, function(choice)
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
local function saved_actions(host, rows, operation, archived, done)
	if #rows == 0 then if done then done() end; return end
	local connection, epoch = host.connection, host.hello.serviceEpoch
	local function current() return not connection.closed and host.connected and host.connection == connection and host.hello.serviceEpoch == epoch end
	local allowed, failures, succeeded = {}, {}, 0
	local background = false
	local function pending_key(row) return host.host_id .. "/" .. row.id end
	-- Deliberate disconnects discard transport callbacks. Settle locally without replay.
	local function watch(callback)
		local waiting = true
		local function complete(ok, result)
			if not waiting then return end
			waiting = false
			callback(ok, result)
		end
		local function check_connection()
			if not waiting then return end
			if not current() then complete(false, { message = "Host connection changed; inspect :PiSavedOperations for any sent request" })
			else vim.defer_fn(check_connection, 100) end
		end
		vim.defer_fn(check_connection, 100)
		return complete
	end
	local verb = operation == "host.archive" and (archived and "Archive" or "Unarchive") or "Delete"
	local function failed(row, message) table.insert(failures, session_title(row) .. ": " .. tostring(message)) end
	local function finish()
		require("pi-integration.logs").notify(verb .. ": " .. succeeded .. " completed, " .. #failures .. " skipped/failed"
			.. (#failures > 0 and ("\n" .. table.concat(failures, "\n")) or "")
			.. (background and #failures > 0 and "\nReopen the picker to refresh failed/skipped sessions; inspect :PiSavedOperations for uncertain outcomes." or ""),
			#failures > 0 and vim.log.levels.WARN or vim.log.levels.INFO, { title = "Pi sessions" })
		if not background and done then done() end
	end
	local function confirm()
		if not current() then
			for _, item in ipairs(allowed) do failed(item.row, "Host connection changed; not sent") end
			finish(); return
		end
		if #allowed == 0 then finish(); return end
		local lines = { verb .. " " .. #allowed .. " conversations (" .. #allowed .. " files) on " .. host_label(host) .. "?" }
		for _, item in ipairs(allowed) do
			table.insert(lines, session_title(item.row) .. (item.row.cwd and (" | " .. item.row.cwd) or ""))
			local preview = item.preview
			if operation == "host.delete" then
				table.insert(lines, preview.mode == "trash" and "Move to trash on this host" or "PERMANENT deletion")
				if #(preview.workspaces or {}) > 0 then
					table.insert(lines, "Remaining worktrees will be removed and unintegrated changes discarded; existing destination changes will not be reverted.")
					for _, workspace in ipairs(preview.workspaces) do
						table.insert(lines, "Workspace: " .. workspace.worktreePath .. (workspace.retained and "" or " (retry incomplete cleanup)"))
						table.insert(lines, "Recovery patch: " .. workspace.resultPatchPath)
					end
					table.insert(lines, "Recovery patches are prepared after confirmation. Ignored untracked files, including copied ignored files, are NOT in patches and will be removed with worktrees. Patches and workspace records are kept on this host.")
				end
			end
		end
		vim.ui.select({ verb, "Cancel" }, { prompt = table.concat(lines, "\n") }, function(choice)
			if choice ~= verb then if done then done() end; return end
			local ready = {}
			for _, item in ipairs(allowed) do
				if pending_deletions[pending_key(item.row)] then failed(item.row, "Deletion already pending")
				else table.insert(ready, item) end
			end
			allowed = ready
			if #allowed == 0 then finish(); return end
			background = operation == "host.delete"
			if background then
				for _, item in ipairs(allowed) do pending_deletions[pending_key(item.row)] = true end
			end
			local function send(index)
				local item = allowed[index]
				if not item then finish(); return end
				if not current() then
					for remaining = index, #allowed do
						pending_deletions[pending_key(allowed[remaining].row)] = nil
						failed(allowed[remaining].row, "Host connection changed; not sent")
					end
					finish(); return
				end
				local payload = { sessionId = item.row.id, expectedVersion = item.preview.version, confirmed = true }
				if operation == "host.archive" then payload.archived = archived else payload.mode = item.preview.mode end
				local complete = watch(function(ok, receipt)
					pending_deletions[pending_key(item.row)] = nil
					if ok and receipt.status == "completed" then succeeded = succeeded + 1
					else failed(item.row, ok and (receipt.status .. (receipt.error and (": " .. receipt.error.message) or "")) or receipt.message) end
					send(index + 1)
				end)
				saved_request(host, { id = uid(), serviceEpoch = epoch, operation = operation, payload = payload }, function(receipt)
					complete(true, receipt)
				end)
			end
			send(1)
			if background and done then done() end
		end)
	end
	local function preview(index)
		if not rows[index] then confirm(); return end
		if not current() then
			for _, item in ipairs(allowed) do failed(item.row, "Host connection changed; not sent") end
			for remaining = index, #rows do failed(rows[remaining], "Host connection changed; not sent") end
			finish(); return
		end
		local batch, ids = {}, {}
		local next_index = math.min(index + 128, #rows + 1)
		for position = index, next_index - 1 do
			local row = rows[position]
			if pending_deletions[pending_key(row)] then failed(row, "Deletion already pending")
			else table.insert(batch, row); table.insert(ids, row.id) end
		end
		if #batch == 0 then preview(next_index); return end
		local complete = watch(function(ok, result)
			local by_id = {}
			if ok and current() then
				for _, entry in ipairs(result.sessions or {}) do by_id[entry.sessionId] = entry end
			end
			for _, row in ipairs(batch) do
				local entry = by_id[row.id]
				local data = entry and entry.preview
				if not ok then failed(row, result.message)
				elseif not data then failed(row, entry and entry.error and entry.error.message or "Saved-session preview unavailable; select it again")
				elseif operation == "host.archive" and data.archiveBlocked then failed(row, "Linked workspace protects this session from archival")
				elseif operation == "host.archive" and data.archived == archived then failed(row, "Archive state already changed; select it again")
				else table.insert(allowed, { row = row, preview = data }) end
			end
			preview(next_index)
		end)
		connection.request("host.saved", { serviceEpoch = epoch, sessionIds = ids }, complete)
	end
	preview(1)
end
function M.history_picker(identity, opts)
	M.start()
	opts = opts or {}
	local matches_group, group_name
	if opts.group_id ~= nil then
		matches_group, group_name = require("pi-integration.session-organization").group_filter(opts.group_id)
		if not matches_group then notify(group_name); return end
	end
	local function pick(targets, all)
		if #targets == 0 then notify("No connected hosts; connect/retry in Hosts."); return end
		local rows, owners, pending = {}, {}, #targets
		local label = all and "all connected hosts" or host_label(targets[1])
		if group_name then label = label .. " · group: " .. group_name end
		local function reopen(overrides)
			local next_opts = vim.tbl_extend("force", opts, overrides or {}, { all_hosts = all })
			M.history_picker(not all and targets[1].host_id or nil, next_opts)
		end
		local function show()
			local protected = vim.deepcopy(pending_deletions)
			-- Completed receipts also override discovery snapshots captured before deletion.
			for _, item in pairs(store.load("saved-requests", vim.empty_dict())) do
				if item.envelope.operation == "host.delete" and (item.receipt and item.receipt.status == "completed"
					or not item.reviewed and (not item.receipt or item.receipt.status == "accepted" or item.receipt.status == "unknown" or item.receipt.status == "uncertain")) then
					protected[item.host_id .. "/" .. item.envelope.payload.sessionId] = true
				end
			end
			rows = vim.tbl_filter(function(row) return not protected[owners[row].host.host_id .. "/" .. row.id] end, rows)
			table.sort(rows, function(a, b)
				local left, right = a.lastActivityAt or a.createdAt or "", b.lastActivityAt or b.createdAt or ""
				if left ~= right then return left > right end
				if owners[a].host.host_id ~= owners[b].host.host_id then return owners[a].host.host_id < owners[b].host.host_id end
				return a.id < b.id
			end)
			local function mutate(chosen, operation)
				local groups, ordered = {}, {}
				for _, row in ipairs(chosen) do
					local owner = owners[row]
					if not groups[owner] then groups[owner] = {}; table.insert(ordered, owner) end
					table.insert(groups[owner], row)
				end
				local function next_host(index)
					local owner = ordered[index]
					if not owner then reopen(); return end
					if not owner.current() then
						notify(host_label(owner.host) .. ": host connection changed; selected sessions were skipped")
						next_host(index + 1); return
					end
					saved_actions(owner.host, groups[owner], operation, not opts.archived, function() next_host(index + 1) end)
				end
				if #ordered > 0 then next_host(1) end
			end
			require("pi-integration.history-picker").pick(label, rows, owners, function(row)
				local timestamp = tostring(row.lastActivityAt or row.createdAt or "Unknown time"):gsub("T", " "):gsub("%.%d+Z$", " UTC")
				return timestamp .. " | " .. (all and (owners[row].host.alias .. " | ") or "")
					.. session_title(row) .. (row.cwd and (" | " .. row.cwd) or "") .. " | " .. row.id .. " (" .. (row.live and row.live.status or "Stopped") .. ")"
			end, function(chosen, preview_opts)
				if #chosen == 0 then return end
				if not opts.archived then
					local function open()
						local in_place
						if #chosen > 1 then in_place = false end
						for _, row in ipairs(chosen) do
							local owner = owners[row]
							if owner.current() then
								local ok, err = M.open({ host_id = owner.host.host_id, session_id = row.id,
									status = row.live and "Idle" or "Stopped" }, in_place)
								if not ok then notify(err) end
							else notify(host_label(owner.host) .. ": host connection changed; session was not opened") end
						end
					end
					if #chosen == 1 then open(); return end
					local lines = { "Resume/open " .. #chosen .. " conversations on " .. label .. "? No work is replayed." }
					for _, row in ipairs(chosen) do
						table.insert(lines, host_label(owners[row].host) .. " | " .. session_title(row) .. (row.cwd and (" | " .. row.cwd) or ""))
					end
					vim.ui.select({ "Resume", "Cancel" }, { prompt = table.concat(lines, "\n") }, function(choice)
						if choice == "Resume" then open() end
					end)
					return
				end
				local select_opts = vim.tbl_extend("force", preview_opts, {
					prompt = "Archived conversations on " .. label .. ": " .. #chosen .. " selected",
				})
				vim.ui.select({ "Unarchive", "Delete" }, select_opts, function(action)
					if action then mutate(chosen, action == "Delete" and "host.delete" or "host.archive") end
				end)
			end, { archived = opts.archived, select_all = opts.select_all,
				on_archive = function(chosen) mutate(chosen, "host.archive") end,
				on_delete = function(chosen) mutate(chosen, "host.delete") end,
				on_toggle_view = function() reopen({ archived = not opts.archived, session_ids = false, select_all = false }) end })
		end
		local requests = {}
		for _, host in ipairs(targets) do
			local connection, epoch = host.connection, host.hello.serviceEpoch
			local function current() return not connection.closed and host.connected and host.connection == connection and host.hello.serviceEpoch == epoch end
			local owner = { host = host, connection = connection, epoch = epoch, current = current }
			local completed = false
			local function complete(ok, result)
				if completed then return end
				completed = true
				if not current() then notify(host_label(host) .. ": host connection changed; search results were skipped")
				elseif not ok then notify(host_label(host) .. ": " .. result.message)
				else
					for _, row in ipairs(result.sessions) do
						if not row.deleted and (row.archived == true) == (opts.archived == true) and (not opts.session_ids or opts.session_ids[row.id])
							and (not matches_group or matches_group(host.host_id, row.id)) then
							table.insert(rows, row); owners[row] = owner
						end
					end
				end
				pending = pending - 1
				if pending == 0 then show() end
			end
			table.insert(requests, function() if not current() then complete(false) end end)
			connection.request("sessions", {}, complete)
		end
		-- Deliberate disconnects discard transport callbacks; do not hold up other hosts.
		local function check_connections()
			if pending == 0 then return end
			for _, check in ipairs(requests) do check() end
			if pending > 0 then vim.defer_fn(check_connections, 100) end
		end
		if pending > 0 then vim.defer_fn(check_connections, 100) end
	end
	if opts.all_hosts then
		local connected, seen = {}, {}
		for _, host in pairs(hosts) do
			if host.connected and not seen[host.host_id] then
				seen[host.host_id] = true; table.insert(connected, host)
			end
		end
		table.sort(connected, function(a, b) return a.host_id < b.host_id end)
		pick(connected, true)
	elseif identity then
		local host = M.find(identity)
		if not host or not host.connected then notify("Current host unavailable; connect/retry in Hosts."); return end
		pick({ host }, false)
	else
		M.select_host(function(host) pick({ host }, false) end, function()
			M.history_picker(nil, vim.tbl_extend("force", opts, { all_hosts = true }))
		end)
	end
end
function M.maybe_prompt_archive(identity)
	local host = M.find(identity)
	if not host or not host.connected or reminder_checked[identity] then return end
	local ok, config = pcall(store.load, "config", {}, "config")
	if not ok then notify(config); return end
	if config == vim.NIL then config = {} end
	if type(config) ~= "table" then notify("Pi config must be a mapping"); return end
	local days = type(config["session-picker"]) == "table" and config["session-picker"]["archive-after-days"] or 180
	if type(days) ~= "number" or days <= 0 or days % 1 ~= 0 then notify("session-picker.archive-after-days must be a positive integer"); return end
	local loaded, reminders = pcall(store.load, "archive-reminders", vim.empty_dict())
	if not loaded then notify(reminders); return end
	local now = os.time()
	if type(reminders[identity]) == "number" and now - reminders[identity] < 30 * 86400 then reminder_checked[identity] = true; return end
	local connection, epoch = host.connection, host.hello.serviceEpoch
	connection.request("sessions", {}, function(success, result)
		if not host.connected or host.connection ~= connection or host.hello.serviceEpoch ~= epoch then return end
		if not success then notify(result.message); return end
		reminder_checked[identity] = true
		local cutoff, stale, count = os.date("!%Y-%m-%dT%H:%M:%S", now - days * 86400), {}, 0
		for _, row in ipairs(result.sessions) do
			local timestamp = row.lastActivityAt or row.createdAt
			if not row.deleted and not row.archived and not row.live and type(timestamp) == "string" and timestamp < cutoff then
				stale[row.id], count = true, count + 1
			end
		end
		if count == 0 then return end
		local should_prompt = false
		local saved, err = store.update("archive-reminders", vim.empty_dict(), function(data)
			-- Another frontend may have shown the reminder while this owner was queried.
			if type(data[identity]) ~= "number" or now - data[identity] >= 30 * 86400 then
				data[identity], should_prompt = now, true
			end
			return true
		end)
		if not saved then notify("Could not save archive reminder: " .. tostring(err)); return end
		if not should_prompt then return end
		vim.ui.select({ "Review sessions", "Not now" }, { prompt = "Review " .. count .. " sessions on " .. host_label(host) .. " inactive for over " .. days .. " days for archiving?" }, function(choice)
			if choice == "Review sessions" and host.connected and host.connection == connection and host.hello.serviceEpoch == epoch then
				M.history_picker(identity, { session_ids = stale, select_all = true })
			end
		end)
	end)
end
local function with_connected_host(host, callback)
	local function ready(connected)
		if not connected then notify("Host unavailable; connect/retry in Hosts."); return end
		callback(host)
	end
	if host.connecting then host.waiters = host.waiters or {}; table.insert(host.waiters, ready)
	else ready(host.connected) end
end
local function sorted_hosts()
	local choices = {}
	for _, host in pairs(hosts) do table.insert(choices, host) end
	table.sort(choices, function(a, b)
		if (a.key == "local") ~= (b.key == "local") then return a.key == "local" end
		return a.alias < b.alias
	end)
	return choices
end
function M.new_conversation(group_id)
	M.select_host(function(host)
		local connection = host.connection
		local epoch = host.hello.serviceEpoch
		local function current() return host.connected and host.connection == connection and host.hello.serviceEpoch == epoch end
		require("pi-integration.directory-history").owner_input({ label = host.alias, key = channel .. "/" .. host.host_id,
			current = current, request = function(query, callback)
				connection.request("host.directories", vim.tbl_extend("force", query, { serviceEpoch = epoch }), callback)
			end }, function(cwd)
			if not current() then return end
			local frontend = require("pi-integration.service-frontend")
			local opened, err = require("pi-integration.backends.tmux").launch_service(frontend.config.launcher, M.target(host), nil, cwd, nil, group_id)
			if not opened then notify(err) end
		end)
	end)
end
function M.new_in_project(entry, group_id)
	local host = M.find(entry.host_id or entry.frontend_host_id)
	if not host or not host.connected then return nil, "Host disconnected" end
	local cwd = entry.directory or entry.cwd
	if type(cwd) ~= "string" or cwd == "" then return nil, "Choose a directory on the selected host first" end
	local opened, err = require("pi-integration.backends.tmux").launch_service(
		require("pi-integration.service-frontend").config.launcher, M.target(host), nil, cwd, nil, group_id)
	return opened, err
end

local function save_management(host_id, envelope, receipt)
	return store.update("management", vim.empty_dict(), function(records)
		records[host_id .. "/" .. envelope.id] = { host_id = host_id, envelope = envelope, receipt = receipt }
		return true
	end)
end
function M.management_operations()
	local records = store.load("management", vim.empty_dict())
	vim.ui.select(vim.tbl_values(records), { prompt = "Management outcomes (status only; never replay)", format_item = function(item)
		local host = M.find(item.host_id)
		return host_label(host or {}) .. " | " .. session_label(host, item.envelope.sessionId) .. " | " .. item.envelope.operation .. " | " .. (item.receipt and item.receipt.status or "unknown")
	end }, function(item)
		if not item then return end
		local host = M.find(item.host_id)
		if not host or not host.connected then notify("Connect to that host before looking up its outcome"); return end
		host.connection.request("session.manage.status", { serviceEpoch = item.envelope.serviceEpoch,
			sessionId = item.envelope.sessionId, commandId = item.envelope.id }, function(ok, receipt)
			if not ok then notify(receipt.message); return end
			local saved, err = save_management(item.host_id, item.envelope, receipt)
			if not saved then notify(err) end
			require("pi-integration.logs").notify(item.envelope.operation .. ": " .. outcome_label(receipt), vim.log.levels.INFO, { title = "Management outcome" })
		end)
	end)
end
function M.manage(entry, action, argument)
	if not entry.session_id then
		if action ~= "kill" or not entry.frontend_pane then return nil, "Frontend has no session yet" end
		vim.ui.select({ "Close frontend", "Cancel" }, { prompt = "Close this unstarted frontend? Local drafts are preserved." }, function(choice)
			if choice ~= "Close frontend" then return end
			local closed, err = require("pi-integration.backends.tmux").close_frontend(entry)
			if not closed then notify(err) end
		end)
		return true
	end
	if entry.status == "Stopped" then return nil, "Session is stopped" end
	local host = M.find(entry.host_id)
	if not host or not host.connected then return nil, "Host disconnected; mutations disabled" end
	if not vim.tbl_contains(host.hello.capabilities or {}, "session.manage") then return nil, "Server does not support session management" end
	local operations = { cycle_access_mode = "access.cycle", set_access_mode = "access.set",
		cycle_integration_mode = "integration.cycle", set_integration_mode = "integration.set",
		toggle_notifications = "notifications.set", kill = "session.kill", interrupt = "turn.abort" }
	local operation = operations[action]
	if not operation then return nil, "Unsupported management action" end
	local frontend = require("pi-integration.service-frontend")
	local connection = host.connection
	local function send()
		if not host.connected or host.connection ~= connection or host.hello.serviceEpoch ~= entry.service_epoch then
			notify("Host changed; select the action again"); return
		end
		local payload
		if action == "cycle_access_mode" then payload = { modes = frontend.config.access_modes }
		elseif action == "cycle_integration_mode" then payload = { modes = frontend.config.integration_modes }
		elseif action == "set_access_mode" or action == "set_integration_mode" then payload = { mode = argument }
		elseif action == "toggle_notifications" then payload = { enabled = entry.notification_status ~= "notify on" }
		elseif action == "interrupt" then payload = {}
		else payload = { confirmed = true } end
		local envelope = { version = 1, id = uid(), sessionId = entry.session_id, serviceEpoch = entry.service_epoch,
			runtimeRevision = entry.runtime_revision, operation = operation, payload = payload }
		local saved, err = save_management(entry.host_id, envelope)
		if not saved then notify("Nothing sent: " .. tostring(err)); return end
		connection.request("session.manage", envelope, function(ok, receipt)
			if not ok then notify(tostring(receipt.message) .. " Inspect :PiManagement; nothing was replayed."); return end
			local stored, failure = save_management(entry.host_id, envelope, receipt)
			if not stored then notify(failure) end
			local attempts = 0
			local function inspect()
				if not host.connected or host.connection ~= connection then return end
				connection.request("session.manage.status", { serviceEpoch = envelope.serviceEpoch,
					sessionId = envelope.sessionId, commandId = envelope.id }, function(found, outcome)
					if not found then notify("Inspect :PiManagement for the request outcome"); return end
					local persisted, problem = save_management(entry.host_id, envelope, outcome)
					if not persisted then notify(problem) end
					attempts = attempts + 1
					if outcome.status == "accepted" and attempts < 30 then vim.defer_fn(inspect, 1000)
					else notify(operation .. ": " .. outcome.status .. (outcome.error and ("\n" .. outcome.error.message) or "")) end
				end)
			end
			if receipt.status == "accepted" then vim.defer_fn(inspect, 250)
			else notify(operation .. ": " .. receipt.status) end
		end)
	end
	if action == "kill" then
		local prompt = "Stop session and close its controller?"
		if entry.controller and not frontend.controls_session(entry) then
			prompt = 'Session "' .. entry.title .. '" on ' .. host.alias .. ' is controlled by '
				.. entry.controller.label .. '. Stop it and close that controller? Active work will be interrupted; history is preserved.'
		end
		vim.ui.select({ "Stop session", "Cancel" }, { prompt = prompt }, function(choice)
			if choice == "Stop session" then send() end
		end)
	else send() end
	return true
end

-- Confirm service identity before saving an endpoint.
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
		vim.ui.select({ "Save confirmed identity", "Cancel" }, { prompt = (changed and "REPLACEMENT service. Old pins remain separate. " or "") .. host_label(target) .. " / " .. hello.channel }, function(choice)
			if choice ~= "Save confirmed identity" then return end
			target.host_id, target.enabled = hello.hostId, true
			local saved, err = save_identity(target, hello.hostId, true)
			if not saved then notify(err); return end
			if persist(target, previous and previous.key) then M.refresh() end
		end)
	end)
end
local function edit(previous)
	local target = previous and vim.deepcopy(previous.target) or {}
	vim.ui.input({ prompt = "Host alias (optional): ", default = target.alias or "" }, function(alias)
		if not alias or alias:find("%c") then return end
		target.alias = vim.trim(alias)
		vim.ui.select({ "HTTP service", "Local service profile" }, { prompt = "Transport" }, function(kind)
			if not kind then return end
			vim.ui.input({ prompt = kind == "HTTP service" and "HTTP origin (http://hostname:port): " or "Absolute local service root: ", default = target.remote or target.root or "" }, function(endpoint)
				if not endpoint or endpoint == "" then return end
				if target.alias == "" then target.alias = endpoint end
				if kind == "Local service profile" then
					if endpoint:sub(1, 1) ~= "/" then notify("Local root must be absolute"); return end
					target.root, target.remote = endpoint, nil
					confirm_target(target, previous)
				else
					target.remote, target.root = endpoint, nil
					confirm_target(target, previous)
				end
			end)
		end)
	end)
end
local function pick_host(callback, on_all)
	M.start()
	local choices = sorted_hosts()
	if on_all then table.insert(choices, 1, { alias = "All hosts (connected)", all = true }) end
	table.insert(choices, { alias = "+ Add host", add = true })
	vim.ui.select(choices, { prompt = "Hosts", format_item = function(host)
		return host.alias
	end }, function(host)
		if not host then return end
		if host.all then on_all(); return end
		if host.add then edit(); return end
		callback(host)
	end)
end
function M.select_host(callback, on_all)
	pick_host(function(host) with_connected_host(host, callback) end, on_all)
end
local function restart_supported(host)
	return host.connected and vim.tbl_contains(host.hello.capabilities or {}, "service.restart")
end
local function restart_message(host, receipt)
	if not receipt or receipt == vim.NIL then return host.alias .. ": no saved restart outcome" end
	local message = host.alias .. ": server restart " .. receipt.status .. " (" .. receipt.id .. ")"
	if receipt.error then message = message .. "\n" .. receipt.error.message end
	if receipt.result then message = message .. "\nBuild: " .. receipt.result.buildId end
	return message
end
local restart_server
local function poll_restart(host, pending)
	if host.restart ~= pending then return end
	if hosts[host.key] ~= host or host.target.enabled == false then host.restart = nil; return end
	if vim.uv.hrtime() / 1e6 > pending.deadline then
		host.restart = nil
		notify(host.alias .. ": restart outcome unconfirmed. Use Last server restart or inspect service.log. Request " .. pending.id .. ". Restart was not replayed.")
		return
	end
	if host.connected and host.connection and pending.connection ~= host.connection then pending.reading = false end
	if host.connected and host.connection and not pending.reading then
		pending.reading, pending.connection = true, host.connection
		host.connection.request("service.restart.status", { serviceEpoch = pending.epoch, id = pending.id }, function(ok, receipt)
			pending.reading = false
			if host.restart ~= pending or not ok or not receipt or receipt == vim.NIL then return end
			if receipt.status == "failed" then
				host.restart = nil
				notify(restart_message(host, receipt))
				if receipt.error and receipt.error.code == "session_busy" and not pending.force then
					vim.ui.select({ "Force restart server", "Cancel" }, { prompt = host.alias .. ": interrupt owned work? History/workspaces kept; sessions stay stopped." }, function(choice)
						if choice == "Force restart server" then restart_server(host, true) end
					end)
				end
			elseif receipt.status == "completed" then
				if host.hello.serviceEpoch == receipt.result.serviceEpoch and host.hello.buildId == receipt.result.buildId then
					host.restart = nil
					notify(restart_message(host, receipt) .. "\nReconnect saved conversations explicitly; frontend restart remains separate.")
				else stop(host); host.retry_at = nil; M.refresh() end
			end
		end)
	elseif not host.connected then host.retry_at = nil; M.refresh() end
	vim.defer_fn(function() poll_restart(host, pending) end, 1000)
end
restart_server = function(host, force)
	if not restart_supported(host) then notify("Connect to a server supporting frontend restart first"); return end
	if host.restart then notify("A restart is pending. Use Last server restart; it will not be replayed."); return end
	local identity, epoch, connection = host.host_id, host.hello.serviceEpoch, host.connection
	local label = force and "Force restart server" or "Restart server"
	vim.ui.select({ label, "Cancel" }, { prompt = label .. " on " .. host_label(host) .. " [" .. channel .. "]? "
		.. (force and "Interrupts owned work." or "The server must be idle.") }, function(choice)
		if choice ~= label then return end
		if host.host_id ~= identity or host.connection ~= connection or host.hello.serviceEpoch ~= epoch then notify("Host connection changed; select restart again"); return end
		local pending = { id = uid(), epoch = epoch, force = force == true, deadline = vim.uv.hrtime() / 1e6 + 120000 }
		host.restart = pending
		connection.request("service.restart", { id = pending.id, serviceEpoch = epoch, hostId = identity, confirmed = true, force = pending.force }, function(ok, result)
			if not ok then
				if result.code and result.code ~= "disconnected" and result.code ~= "service_disconnected" then host.restart = nil end
				notify(result.message .. "\nRequest " .. pending.id .. ". Restart was not replayed.")
			end
		end)
		poll_restart(host, pending)
	end)
end
local function last_restart(host)
	if not restart_supported(host) then notify("Connect to a server supporting restart status first"); return end
	host.connection.request("service.restart.status", {}, function(ok, receipt)
		if not ok then notify(receipt.message); return end
		notify(restart_message(host, receipt))
	end)
end
function M.picker(on_attach)
	pick_host(function(host)
		local actions = { "Connect/retry", "Disconnect", "Restart server", "Last server restart", "Edit alias", "Edit / confirm identity", "Forget" }
		if on_attach then table.insert(actions, 1, "Attach current frontend") end
		vim.ui.select(actions, { prompt = host.alias }, function(action)
			if action == "Attach current frontend" then
				with_connected_host(host, on_attach)
			elseif action == "Connect/retry" then
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
							table.insert(data.hosts, public_target(target))
						end
					end
					return true
				end) then
					for _, source in pairs(hosts) do
						if source == host or host.host_id and source.host_id == host.host_id then
							detach_frontend(source, "Host explicitly disconnected"); stop(source)
						end
					end
					M.refresh()
				end
			elseif action == "Restart server" then restart_server(host, false)
			elseif action == "Last server restart" then last_restart(host)
			elseif action == "Edit alias" then
				vim.ui.input({ prompt = "Host alias: ", default = host.alias }, function(alias)
					if not alias or vim.trim(alias) == "" or alias:find("%c") then return end
					local target = vim.deepcopy(host.target); target.alias = vim.trim(alias)
					if persist(target) then M.refresh() end
				end)
			elseif action == "Edit / confirm identity" then edit(host)
			elseif action == "Forget" then
				if host.key == "local" then notify("Default local source can be disconnected, not forgotten"); return end
				vim.ui.select({ "Forget host", "Cancel" }, { prompt = "Disconnect and forget this host? Execution and organization are retained." }, function(choice)
					if choice ~= "Forget host" then return end
					if update(function(data)
						for i, saved in ipairs(data.hosts) do if saved.key == host.key then table.remove(data.hosts, i); break end end
						return true
					end) then
						forgotten_explicit[host.key] = true
						detach_frontend(host, "Host explicitly forgotten"); stop(host)
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
