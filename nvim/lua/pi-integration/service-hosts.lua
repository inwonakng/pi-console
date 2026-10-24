local store = require("pi-integration.frontend-store")
local transport = require("pi-integration.service-connection")
local M = {}
local hosts, started, timer = {}, false, nil
local forgotten_explicit = {}
local completion_states = {}
local reminder_checked = {}
local saved_request
local initial = { version = 1, hosts = {} }
local channel = vim.env.PI_CONSOLE_CHANNEL or "stable"
local function notify(message) require("pi-integration.logs").notify(tostring(message), vim.log.levels.WARN, { title = "Pi hosts" }) end
local function uid() return vim.fn.sha256(tostring(vim.uv.hrtime()) .. ":" .. vim.fn.getpid()) end
local function host_label(host)
	local endpoint = host.remote or host.service_remote or host.root or host.service_root
	return (host.alias or "Saved host") .. (endpoint and (" (" .. endpoint .. ")") or "")
end
local function connection_status(host)
	if host.connected then return "Connected" end
	if host.target.enabled == false then return "Disconnected" end
	return host.connecting and "Connecting" or "Unreachable"
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
	local ok, err = store.update("host-identities", vim.empty_dict(), function(data)
		local key = target_key(target)
		local previous = data[key] or target.host_id
		if previous and previous ~= identity and not replace then
			return nil, "Endpoint service identity changed; confirm the replacement in Hosts before attaching"
		end
		data[key] = identity
		return true
	end)
	if not ok then notify(err) end
	return ok, err
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
			local saved, err = save_identity(host, hello.hostId)
			if not saved then host.error = err; host.retry_at = vim.uv.now() + 30000; stop(host); return end
			host.host_id, host.hello, host.connected, host.connecting = hello.hostId, hello, true, false
			host.target.host_id = hello.hostId
			host.attempts, host.retry_at = 0, nil
			local waiters = host.waiters or {}; host.waiters = nil
			for _, callback in ipairs(waiters) do callback(true) end
			connection.request("sessions.subscribe", {}, function(ok, result)
				if host.connection ~= connection then return end
				if ok and result.hostId == host.host_id then
					cache(host, result.sessions)
					M.maybe_prompt_archive(host.host_id)
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
			if host.root == target.root and host.remote == target.remote and host.host_id == target.host_id and host.target.enabled == target.enabled then
				host.alias, host.target = target.alias, vim.deepcopy(target)
				host.pins_dirty = true
			else stop(host); host = nil end
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
	local owners, entries, next_completions = {}, {}, {}
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
			if row.state == "open" then
				local id = vim.json.encode({ identity, row.id })
				local live = row.live or {}
				local epoch = host.hello and host.hello.serviceEpoch
				local completion = live.completionSeq or 0
				local focused, pane_baseline, pane_viewed
				local frontend_keys = {}
				for _, pane in ipairs(attachments or {}) do
					if pane.host_id == identity and pane.session_id == row.id then
						table.insert(frontend_keys, "frontend:" .. vim.json.encode({ pane.id, pane.pid }))
						focused = math.max(focused or 0, pane.last_focused_at or 0)
						if pane.status ~= "Unresponsive" and pane.service_epoch == epoch
							and pane.runtime_revision == live.runtimeRevision and type(pane.seen_seq) == "number" then
							-- An unfocused attachment's initial history baseline is not a read acknowledgement.
							pane_baseline = math.min(pane_baseline or pane.seen_seq, pane.seen_seq)
							if type(pane.viewed_seq) == "number" then pane_viewed = math.max(pane_viewed or 0, pane.viewed_seq) end
						end
					end
				end
				local previous = completion_states[id]
				local seen = previous and previous.epoch == epoch and previous.revision == live.runtimeRevision
					and previous.seen or pane_baseline or completion
				seen = math.max(seen, pane_viewed or 0)
				next_completions[id] = { epoch = epoch, revision = live.runtimeRevision, seen = seen }
				local status = live.status or "Idle"
				if status == "Idle" and live.turnOutcome == "completed" and completion > seen then status = "Done" end
				table.insert(entries, { id = id, host_id = identity, session_id = row.id, host_name = host_label(host),
					connected = host.connected == true, status = host.connected and status or connection_status(host), frontend_keys = frontend_keys,
					title = session_title(row), cwd = row.cwd, directory = row.cwd,
					location = host.alias, controller = row.live and row.live.controller, activity = nil,
					workspace_cwd = row.live and row.live.cwd or row.cwd, last_focused_at = focused,
					subagent_runs = live.subagentRuns or {}, subagents = #(live.subagentRuns or {}),
					access_mode = row.live and row.live.accessMode, integration_mode = row.live and row.live.integrationMode,
					notification_status = row.live and row.live.notificationsEnabled and "notify on" or "notify off",
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
	completion_states = next_completions
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
	for _, row in ipairs(host.rows or {}) do
		if row.id == entry.session_id and row.archived then notify("Conversation is archived on " .. host.alias .. "; explicitly unarchive it in :PiSessions before resuming."); return true end
	end
	local connection = host.connection
	local function select(resume)
		if not host.connected or host.connection ~= connection then notify("Owner connection changed; select the session again"); return end
		local frontend = require("pi-integration.service-frontend")
		if in_place == nil then in_place = frontend.config.role == "conversation" end
		if in_place then frontend.select_owner(M.target(host), entry.session_id, resume); return end
		local tmux = require("pi-integration.backends.tmux")
		if not tmux.available() then notify("Opening a conversation from this view requires tmux"); return end
		local panes, err = tmux.list()
		if not panes then notify(err); return end
		for _, pane in ipairs(panes) do
			if pane.host_id == entry.host_id and pane.session_id == entry.session_id then
				if resume then
					-- Focusing a stopped attachment does not authorize an owner resume.
					saved_request(host, { id = uid(), serviceEpoch = host.hello.serviceEpoch,
						operation = "host.resume", payload = { sessionId = entry.session_id } }, function(receipt)
						if receipt.status ~= "completed" or not host.connected or host.connection ~= connection then return end
						local ok, focus_error = tmux.focus(pane.id)
						if not ok then notify(focus_error) end
					end)
				else
					local ok, focus_error = tmux.focus(pane.id)
					if not ok then notify(focus_error) end
				end
				return
			end
		end
		local opened, failure = tmux.launch_service(frontend.config.launcher, M.target(host), entry.session_id, nil, resume)
		if not opened then notify(failure) end
	end
	if entry.status == "Not Open" then
		vim.ui.select({ "Resume", "Cancel" }, { prompt = "Resume stopped session on " .. host.alias .. "? No work is replayed." }, function(choice) if choice == "Resume" then select(true) end end)
	else select(false) end
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
		if not host or not host.connected then notify("Connect to that owner before looking up its outcome"); return end
		host.connection.request("host.status", { serviceEpoch = item.envelope.serviceEpoch, commandId = item.envelope.id }, function(ok, receipt)
			if ok then
				store.update("saved-requests", vim.empty_dict(), function(records)
					local key = item.host_id .. "/" .. item.envelope.id
					if records[key] then records[key].receipt = receipt end
					return true
				end)
				require("pi-integration.logs").notify(item.envelope.operation .. ": " .. outcome_label(receipt), vim.log.levels.INFO, { title = "Saved-session outcome" })
				if receipt.status == "unknown" or receipt.status == "uncertain" then
					vim.ui.select({ "Allow a new saved-session request", "Keep protected" }, { prompt = "Original work may have partially or fully run. Inspect owner session/workspace state first. This does not replay it." }, function(choice)
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
	if #rows == 0 then return end
	local connection, epoch = host.connection, host.hello.serviceEpoch
	local function current() return host.connected and host.connection == connection and host.hello.serviceEpoch == epoch end
	local allowed, failures, succeeded = {}, {}, 0
	local verb = operation == "host.archive" and (archived and "Archive" or "Unarchive") or "Delete"
	local function failed(row, message) table.insert(failures, session_title(row) .. ": " .. tostring(message)) end
	local function finish()
		require("pi-integration.logs").notify(verb .. ": " .. succeeded .. " completed, " .. #failures .. " skipped/failed"
			.. (#failures > 0 and ("\n" .. table.concat(failures, "\n")) or ""),
			#failures > 0 and vim.log.levels.WARN or vim.log.levels.INFO, { title = "Pi sessions" })
		if done and current() then done() end
	end
	local function confirm()
		if not current() then
			for _, item in ipairs(allowed) do failed(item.row, "Owner changed; not sent") end
			finish(); return
		end
		if #allowed == 0 then finish(); return end
		local lines = { verb .. " " .. #allowed .. " conversations (" .. #allowed .. " files) on " .. host_label(host) .. "?" }
		for _, item in ipairs(allowed) do
			table.insert(lines, session_title(item.row) .. (item.row.cwd and (" | " .. item.row.cwd) or ""))
			local preview = item.preview
			if operation == "host.delete" then
				table.insert(lines, preview.mode == "trash" and "Move to owner trash" or "PERMANENT deletion")
				if #(preview.workspaces or {}) > 0 then
					table.insert(lines, "Remaining worktrees will be removed and unintegrated changes discarded; existing destination changes will not be reverted.")
					for _, workspace in ipairs(preview.workspaces) do
						table.insert(lines, "Workspace: " .. workspace.worktreePath .. (workspace.retained and "" or " (retry incomplete cleanup)"))
						table.insert(lines, "Recovery patch: " .. workspace.resultPatchPath)
					end
					table.insert(lines, "Recovery patches are prepared after confirmation. Ignored untracked files, including copied ignored files, are NOT in patches and will be removed with worktrees. Patches and workspace records are kept on the owner.")
				end
			end
		end
		vim.ui.select({ verb, "Cancel" }, { prompt = table.concat(lines, "\n") }, function(choice)
			if choice ~= verb then if done and current() then done() end; return end
			local function send(index)
				local item = allowed[index]
				if not item then finish(); return end
				if not current() then
					for remaining = index, #allowed do failed(allowed[remaining].row, "Owner changed; not sent") end
					finish(); return
				end
				local payload = { sessionId = item.row.id, expectedVersion = item.preview.version, confirmed = true }
				if operation == "host.archive" then payload.archived = archived else payload.mode = item.preview.mode end
				saved_request(host, { id = uid(), serviceEpoch = epoch, operation = operation, payload = payload }, function(receipt)
					if receipt.status == "completed" then succeeded = succeeded + 1
					else failed(item.row, receipt.status .. (receipt.error and (": " .. receipt.error.message) or "")) end
					send(index + 1)
				end)
			end
			send(1)
		end)
	end
	local function preview(index)
		local row = rows[index]
		if not row then confirm(); return end
		if not current() then
			for _, item in ipairs(allowed) do failed(item.row, "Owner changed; not sent") end
			for remaining = index, #rows do failed(rows[remaining], "Owner changed; not sent") end
			finish(); return
		end
		connection.request("host.saved", { serviceEpoch = epoch, sessionId = row.id }, function(ok, result)
			if not ok then failed(row, result.message)
			elseif operation == "host.archive" and result.archiveBlocked then failed(row, "Linked workspace protects this session from archival")
			elseif operation == "host.archive" and result.archived == archived then failed(row, "Archive state already changed; select it again")
			else table.insert(allowed, { row = row, preview = result }) end
			preview(index + 1)
		end)
	end
	preview(1)
end
function M.history_picker(identity, opts)
	M.start()
	opts = opts or {}
	local function pick(host)
		if not host or not host.connected then return end
		local connection, epoch = host.connection, host.hello.serviceEpoch
		local function current() return host.connected and host.connection == connection and host.hello.serviceEpoch == epoch end
		connection.request("sessions", {}, function(ok, result)
			if not current() then return end
			if not ok then notify(result.message); return end
			local rows = {}
			for _, row in ipairs(result.sessions) do
				if not row.deleted and (row.archived == true) == (opts.archived == true) and (not opts.session_ids or opts.session_ids[row.id]) then
					table.insert(rows, row)
				end
			end
			local function reopen() M.history_picker(host.host_id, opts) end
			local function mutate(chosen, operation) saved_actions(host, chosen, operation, not opts.archived, reopen) end
			require("pi-integration.history-picker").pick(host, rows, function(row)
				local timestamp = tostring(row.lastActivityAt or row.createdAt or "Unknown time"):gsub("T", " "):gsub("%.%d+Z$", " UTC")
				return timestamp .. " | " .. session_title(row) .. (row.cwd and (" | " .. row.cwd) or "") .. " (" .. row.state .. ")"
			end, function(row)
				if row.state == "open" and not row.archived then
					M.open({ host_id = host.host_id, session_id = row.id, status = "Idle" }); return
				end
				local actions = row.archived and { "Unarchive", "Delete" } or { "Resume", "Archive", "Delete" }
				vim.ui.select(actions, { prompt = "Saved conversation on " .. host_label(host) .. ": " .. session_title(row) }, function(action)
					if not action or not current() then return end
					if action == "Resume" then M.open({ host_id = host.host_id, session_id = row.id, status = "Not Open" })
					else mutate({ row }, action == "Delete" and "host.delete" or "host.archive") end
				end)
			end, { archived = opts.archived, select_all = opts.select_all,
				on_archive = function(chosen) mutate(chosen, "host.archive") end,
				on_delete = function(chosen) mutate(chosen, "host.delete") end,
				on_toggle_view = function() M.history_picker(host.host_id, { archived = not opts.archived }) end })
		end)
	end
	if identity then
		local host = M.find(identity)
		if not host or not host.connected then notify("Current host unavailable; connect/retry in Hosts."); return end
		pick(host)
	else M.select_host(pick) end
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
			if not row.deleted and not row.archived and row.state ~= "open" and type(timestamp) == "string" and timestamp < cutoff then
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
function M.select_host(callback)
	M.start()
	local choices = {}
	for _, host in pairs(hosts) do table.insert(choices, host) end
	table.sort(choices, function(a, b) return a.alias < b.alias end)
	vim.ui.select(choices, { prompt = "Host", format_item = function(host)
		return host_label(host) .. " | " .. connection_status(host)
	end }, function(host)
		if not host then return end
		with_connected_host(host, callback)
	end)
end
function M.new_conversation()
	M.select_host(function(host)
		local connection = host.connection
		local epoch = host.hello.serviceEpoch
		local function current() return host.connected and host.connection == connection and host.hello.serviceEpoch == epoch end
		require("pi-integration.directory-history").owner_input({ label = host_label(host), key = channel .. "/" .. host.host_id,
			current = current, request = function(query, callback)
				connection.request("host.directories", vim.tbl_extend("force", query, { serviceEpoch = epoch }), callback)
			end }, function(cwd)
			if not current() then return end
			local frontend = require("pi-integration.service-frontend")
			local opened, err = require("pi-integration.backends.tmux").launch_service(frontend.config.launcher, M.target(host), nil, cwd)
			if not opened then notify(err) end
		end)
	end)
end
function M.new_in_project(entry)
	local host = M.find(entry.host_id or entry.frontend_host_id)
	if not host or not host.connected then return nil, "Host disconnected" end
	local cwd = entry.directory or entry.cwd
	if type(cwd) ~= "string" or cwd == "" then return nil, "Choose an owner directory in this frontend first" end
	local opened, err = require("pi-integration.backends.tmux").launch_service(
		require("pi-integration.service-frontend").config.launcher, M.target(host), nil, cwd)
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
	if not entry.session_id then return nil, "Frontend has no owner session yet" end
	local host = M.find(entry.host_id)
	if not host or not host.connected then return nil, "Host disconnected; mutations disabled" end
	if not vim.tbl_contains(host.hello.capabilities or {}, "session.manage") then return nil, "Server does not support session management" end
	local operations = { cycle_access_mode = "access.cycle", set_access_mode = "access.set",
		cycle_integration_mode = "integration.cycle", set_integration_mode = "integration.set",
		toggle_notifications = "notifications.set", kill = "session.kill" }
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
		vim.ui.select({ "Kill session", "Cancel" }, { prompt = "Kill " .. entry.title .. " on " .. host.alias .. "? Active work is interrupted; history/workspaces remain." }, function(choice)
			if choice == "Kill session" then send() end
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
			if save_identity(target, hello.hostId, true) and persist(target, previous and previous.key) then M.refresh() end
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
			vim.ui.input({ prompt = kind == "HTTP service" and "HTTP origin (http://hostname:8443): " or "Absolute local service root: ", default = target.remote or target.root or "" }, function(endpoint)
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
function M.picker(on_attach)
	M.start()
	local choices = {}
	for _, host in pairs(hosts) do table.insert(choices, host) end
	table.sort(choices, function(a, b)
		if (a.key == "local") ~= (b.key == "local") then return a.key == "local" end
		return a.alias < b.alias
	end)
	table.insert(choices, { alias = "+ Add host", add = true })
	vim.ui.select(choices, { prompt = "Hosts", format_item = function(host)
		return host.alias
	end }, function(host)
		if not host then return end
		if host.add then edit(); return end
		local actions = { "Connect/retry", "Disconnect", "Edit alias", "Edit / confirm identity", "Forget" }
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
					for _, source in pairs(hosts) do if source == host or host.host_id and source.host_id == host.host_id then stop(source, true) end end
					M.refresh()
				end
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
						stop(host, true)
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
