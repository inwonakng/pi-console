-- Attachments own UI/drafts only. Typed lifecycle requests execute on the owner.
local M = { config = {}, service_mode = true }
local layout = require("pi-integration.layout")
local messages = require("pi-integration.messages")
local transcript = require("pi-integration.transcript")
local state = require("pi-integration.state").new()
local session_id, attachment, snapshot, hello, grant, job
local authority
local callbacks, unresolved, offers, drafts = {}, {}, {}, {}
local outcomes = {}
local submission_status = {}
local pending_host, initial_attempted, resume_requested
local generation, counter, refresh_scheduled, refreshing, dirty = 0, 0, false, false, false
local selection = 0
local approval_win, approval_buf, approval_request, heartbeat
local recovery_id, backup_scheduled
local render, refresh, connect, attach
local side_buf

local function notify(text, level)
	vim.notify(text, level or vim.log.levels.INFO, { title = "pi-console service" })
end
local function valid(buf) return buf and vim.api.nvim_buf_is_valid(buf) end
local function text(buf)
	return valid(buf) and table.concat(vim.api.nvim_buf_get_lines(buf, 0, -1, false), "\n") or ""
end
local function uid()
	counter = counter + 1
	return vim.fn.sha256(tostring(vim.uv.hrtime()) .. ":" .. vim.fn.getpid() .. ":" .. counter)
end
local function unavailable(name)
	notify(name .. " is unavailable on this service path. No local/RPC fallback was executed.", vim.log.levels.WARN)
end
local function text_submission(operation)
	return operation == "prompt.submit" or operation == "shell.run" or operation == "steering.submit" or operation == "followUp.submit" or operation == "side.prompt"
end
local function close_approval()
	if approval_win and vim.api.nvim_win_is_valid(approval_win) then vim.api.nvim_win_close(approval_win, true) end
	approval_win, approval_request = nil, nil
end
local function current_controller()
	if authority then return authority.controller end
	return snapshot and snapshot.controller
end
local function current_revision() return authority and authority.revision or snapshot and snapshot.runtimeRevision end
local function observe_authority(value, full)
	if authority and value.serviceEpoch == authority.epoch and value.sequence < authority.sequence then return end
	local owner = full and value or value.owner
	local controller = current_controller()
	if owner then controller = owner.controller end
	authority = { epoch = value.serviceEpoch, sequence = value.sequence, revision = value.runtimeRevision, controller = controller }
end
local function control_current()
	local controller = current_controller()
	return job and attachment and grant and controller
		and controller.attachmentId == attachment and controller.grantId == grant.grantId
end
local function stamp()
	return { generation = generation, attachment = attachment, token = grant and grant.token,
		controller = current_controller() and current_controller().grantId, revision = current_revision(), session = session_id }
end
local function same_context(s)
	return snapshot and s.generation == generation and s.attachment == attachment
		and s.revision == current_revision() and s.session == session_id
end
local function current(s)
	return control_current() and same_context(s) and s.token == grant.token
end
local function outcome_current(outcome)
	if outcome.lifecycle or outcome.transition then
		local s = outcome.captured
		local attached = s.generation == generation and s.attachment == attachment and s.session == session_id
		return attached and (outcome.lifecycle or control_current() and s.token == grant.token)
	end
	return current(outcome.captured)
end
local function object_payload(payload)
	if not payload or next(payload) == nil then return vim.empty_dict() end
	return payload
end
local function request(method, payload, callback)
	if not job then notify("Disconnected. Use :PiReconnect; no mutation was retried.", vim.log.levels.WARN); return end
	local id = uid()
	callbacks[id] = callback or function() end
	vim.fn.chansend(job, vim.json.encode({ id = id, method = method, payload = object_payload(payload) }) .. "\n")
	return id
end
local function command(operation, payload, callback, captured, terminal)
	if not snapshot or not attachment then notify("Attach to a live session first."); return end
	if not hello or not vim.tbl_contains(hello.capabilities or {}, operation) then unavailable(operation); return end
	if captured and not current(captured) then notify("Stale editor/dialog; its text remains a local draft.", vim.log.levels.WARN); return end
	if not operation:match("^control%.") and not control_current() then notify("Viewer: use :PiControl or confirmed :PiTakeover first.", vim.log.levels.WARN); return end
	local envelope = { version = 1, id = uid(), sessionId = session_id, serviceEpoch = snapshot.serviceEpoch,
		runtimeRevision = current_revision(), operation = operation, payload = object_payload(payload) }
	if operation ~= "control.acquire" and operation ~= "control.takeover" then envelope.controlToken = grant and grant.token end
	unresolved[envelope.id] = envelope -- Diagnostic identity only, never replayed.
	if terminal then outcomes[envelope.id] = { callback = terminal, captured = captured or stamp(), lifecycle = operation == "session.kill", transition = operation == "history.navigate" } end
	request("command", envelope, function(ok, result)
		-- Only an acknowledgment or proven local non-delivery resolves this send.
		-- A failed request/status lookup alone never proves non-admission.
		if ok or result.delivery == "not_sent" then
			unresolved[envelope.id], submission_status[envelope.id] = nil, nil
		end
		if callback then callback(ok, result) end
		if not ok and result.delivery == "not_sent" then outcomes[envelope.id] = nil end
		if ok and result.status ~= "accepted" and outcomes[envelope.id] then
			local outcome = outcomes[envelope.id]; outcomes[envelope.id] = nil
			if outcome_current(outcome) then outcome.callback(result) end
		end
		refresh()
	end)
	return envelope.id
end
local function draft_buffer(name, contents, on_save, on_hide)
	local buf = layout.create_buffer(nil, name, "markdown", true)
	vim.bo[buf].buftype = "acwrite"
	vim.api.nvim_buf_set_lines(buf, 0, -1, false, vim.split(contents or "", "\n", { plain = true }))
	vim.bo[buf].modified = false
	drafts[buf] = name
	vim.api.nvim_create_autocmd("BufWriteCmd", { buffer = buf, callback = function()
		if on_save then on_save(buf) else notify("Recovered inspect-only draft: copy/review it explicitly before submitting.") end
	end })
	if on_hide then vim.api.nvim_create_autocmd({ "BufHidden", "BufWipeout" }, { buffer = buf, once = true, callback = on_hide }) end
	vim.cmd("botright split")
	vim.api.nvim_win_set_buf(0, buf)
	return buf
end
local function local_snapshot()
	local saved_drafts = {}
	for buf, name in pairs(drafts) do if valid(buf) then table.insert(saved_drafts, { name = name, text = text(buf) }) end end
	return { cwd = vim.fn.getcwd(), service_session = session_id, service_root = M.config.service_root,
		host = hello and hello.hostId, channel = hello and hello.channel, saved_at = os.date("!%Y-%m-%dT%H:%M:%SZ"),
		input_lines = valid(state.input_buf) and vim.api.nvim_buf_get_lines(state.input_buf, 0, -1, false) or { "" },
		unresolved = unresolved, submission_status = submission_status, pending_host = pending_host, initial_attempted = initial_attempted, drafts = saved_drafts }
end
local function backup()
	if not valid(state.input_buf) and next(drafts) == nil then return true end
	recovery_id = recovery_id or uid()
	local ok, err = pcall(require("pi-integration.service-drafts").save, recovery_id, local_snapshot())
	if not ok then notify("Could not preserve local drafts: " .. tostring(err), vim.log.levels.ERROR) end
	return ok
end
local function can_close_frontend()
	for _, buf in ipairs(vim.api.nvim_list_bufs()) do
		if vim.bo[buf].modified and buf ~= state.input_buf and buf ~= state.transcript_buf and not drafts[buf] then
			notify("Save unrelated modified buffers before closing/restarting the frontend."); return false
		end
	end
	return true
end
local function status_data(key)
	local raw = snapshot and snapshot.conversation.statuses[key]
	local ok, value = pcall(vim.json.decode, raw or "")
	return ok and value or nil
end
local ctx = { state = state, config = M.config, notices = { empty_session = "Send non-slash text after acquiring control." },
	buffer = { valid = valid, set_modifiable = function(buf, value) vim.bo[buf].modifiable = value end },
	session = { setup_keymaps = function() end }, transcript = { refresh_ui = function() end } }
local function metadata()
	local controller = current_controller()
	local pi_state = snapshot and snapshot.piState or {}
	local statuses = snapshot and snapshot.conversation.statuses or {}
	local model = pi_state.model
	local submissions = {}
	for id, envelope in pairs(unresolved) do
		if text_submission(envelope.operation) and envelope.sessionId == session_id then
			table.insert(submissions, id .. " (" .. (submission_status[id] or "outcome unknown") .. ")")
		end
	end
	return { "# Pi — local service", "", "Channel: " .. tostring(hello and hello.channel or vim.env.PI_CONSOLE_CHANNEL or "stable")
		.. " | " .. (job and "connected" or "disconnected") .. " | " .. (control_current() and "CONTROLLER" or "VIEWER"),
		"Host: " .. tostring(hello and hello.hostId or "—"), "Service build: " .. tostring(hello and hello.buildId or "—"),
		"Session: " .. tostring(session_id or "—") .. " | " .. tostring(snapshot and snapshot.phase or "unattached") .. " | " .. tostring(pi_state.sessionName or ""),
		"Owner cwd: " .. tostring(snapshot and snapshot.interactions.runtime and snapshot.interactions.runtime.cwd or "—"),
		"Control: " .. tostring(controller and controller.label or "unclaimed"),
		"Model: " .. tostring(model and (model.provider .. "/" .. model.id) or "—") .. " | Thinking: " .. tostring(pi_state.thinkingLevel or "—"),
		tostring(statuses["pi-access-mode"] or "Mode: —") .. " | " .. tostring(statuses["pi-integration-mode"] or "Integration: —") .. " | " .. tostring(statuses["pi-notifications"] or ""),
		"Pending requests: " .. tostring(snapshot and #snapshot.interactions.pending or 0) .. " (:PiPending)",
		"Shared queue: " .. tostring(snapshot and #snapshot.acceptedQueue.items or 0) .. " (:PiQueue)",
		"Protected submissions (:PiSubmissions; not unsent drafts): " .. (#submissions > 0 and table.concat(submissions, ", ") or "none"),
		"Effects: inspect-only (:PiOffers). Shell ! / !! executes on the owner, never frontend cwd.",
		"Execution: " .. tostring(snapshot and vim.inspect(snapshot.conversation.execution) or "—"),
		"Native queues (not editable application queue): " .. tostring(snapshot and vim.inspect(snapshot.conversation.queue) or "—"),
		(snapshot and snapshot.error) and ("Error: " .. snapshot.error) or "", "" }
end
ctx.transcript.metadata_lines = metadata
render = function()
	if not valid(state.transcript_buf) then return end
	local conversation = snapshot and snapshot.conversation
	state.access_mode = conversation and (conversation.statuses["pi-access-mode"] or ""):match("^Mode: (%w+)$")
	layout.update_input_sidebar(ctx)
	local visible = vim.deepcopy(conversation and conversation.messages or {})
	if conversation then
		if conversation.partialAssistant then table.insert(visible, conversation.partialAssistant.message) end
		for _, tool in ipairs(conversation.tools or {}) do
			if tool.state == "running" then
				table.insert(visible, vim.tbl_extend("force", tool, { role = "tool_execution_start" }))
				if tool.partialResult then table.insert(visible, vim.tbl_extend("force", tool, { role = "tool_execution_update" })) end
			end
		end
	end
	require("pi-integration.tool-output").reset(state)
	require("pi-integration.thinking-output").reset(state)
	require("pi-integration.skills").reset(state)
	local lines, items = messages.collect_message_lines(ctx, visible)
	if conversation then
		for _, work in ipairs(conversation.work or {}) do
			if work.kind == "bash" then
				vim.list_extend(lines, { "", "## Bash (owner) — " .. work.state, work.text,
					work.result and ("Exit: " .. tostring(work.result.exitCode) .. (work.result.cancelled and " (cancelled)" or "")) or "",
					work.omittedOutputBytes and ("Omitted stream bytes: " .. work.omittedOutputBytes) or "", "", work.output or "" })
			end
		end
		for _, receipt in ipairs(snapshot.commands or {}) do
			if receipt.operation ~= "prompt.submit" and not receipt.operation:match("^control%.") and not receipt.operation:match("^queue%.") then
				vim.list_extend(lines, { "", "Command " .. receipt.id .. " " .. receipt.operation .. ": " .. receipt.status,
					receipt.error and receipt.error.message or "",
					receipt.result and (receipt.result.status or receipt.result.lifecycle or receipt.result.disposition or receipt.result.mode or "") or "" })
			end
		end
		for _, item in ipairs(snapshot.acceptedQueue.items) do
			vim.list_extend(lines, { "", "### Queue " .. item.id .. " — " .. item.status .. " r" .. item.revision,
				item.text, item.error and item.error.message or "" })
		end
	end
	if valid(side_buf) then
		local side = status_data("pi-side")
		local side_lines = { "# Side conversation on owner", "", "Local draft: :PiSidePrompt. :PiSideNew resets; :PiSideAbort stops.", "" }
		if side then
			table.insert(side_lines, side.running and "Working" or "Idle")
			for _, message in ipairs(side.messages or {}) do
				table.insert(side_lines, "## " .. tostring(message.role))
				if type(message.content) == "string" then vim.list_extend(side_lines, vim.split(message.content, "\n", { plain = true }))
				else for _, block in ipairs(message.content or {}) do
					vim.list_extend(side_lines, vim.split(block.text or block.thinking or vim.inspect(block), "\n", { plain = true }))
				end end
			end
			if side.partialMessage then
				for _, block in ipairs(side.partialMessage.content or {}) do vim.list_extend(side_lines, vim.split(block.text or block.thinking or "", "\n", { plain = true })) end
			end
			if side.error then table.insert(side_lines, side.error) end
		end
		layout.set_buffer_lines(ctx, side_buf, side_lines, false)
	end
	-- Every replacement is a pure render; never invoke legacy event/effect handlers.
	local split = {}
	for _, line in ipairs(lines) do vim.list_extend(split, vim.split(line, "\n", { plain = true })) end
	transcript.preserve_view(ctx, function() layout.set_buffer_lines(ctx, state.transcript_buf, split, false) end)
	transcript.apply_collected_transcript_items(ctx, items)
	if state.transcript_win and vim.api.nvim_win_is_valid(state.transcript_win) then
		vim.wo[state.transcript_win].statusline = " Pi service " .. (control_current() and "CONTROLLER" or "VIEWER") .. " %="
	end
end
local function apply_snapshot(value)
	if value.sessionId ~= session_id then return end
	observe_authority(value, true)
	if not snapshot or value.serviceEpoch ~= snapshot.serviceEpoch or value.sequence >= snapshot.sequence then snapshot = value end
	if grant and not control_current() then grant = nil; close_approval() end
	if approval_request then
		local live = false
		for _, item in ipairs(snapshot.interactions.pending) do if item.request.id == approval_request and not item.submitted then live = true end end
		if not live then close_approval() end
	end
	render()
end
refresh = function()
	dirty = true
	if refreshing or refresh_scheduled or not attachment or not job then return end
	refresh_scheduled = true
	local gen = generation
	vim.defer_fn(function()
		refresh_scheduled = false
		if gen ~= generation or not attachment or not job then return end
		dirty, refreshing = false, true
		local target, selected = attachment, session_id
		request("snapshot", {}, function(ok, value)
			refreshing = false
			if ok and gen == generation and target == attachment and selected == session_id then apply_snapshot(value) end
			if dirty then refresh() end
		end)
	end, 100)
end
local function disconnected()
	generation = generation + 1
	job, attachment, grant, authority = nil, nil, nil, nil
	callbacks, outcomes = {}, {}
	refreshing, refresh_scheduled, dirty = false, false, false
	close_approval()
	render()
end
attach = function(id)
	if not job then return end
	selection = selection + 1
	local gen, selected = generation, selection
	request("attach", { sessionId = id, label = "Neovim " .. vim.fn.getpid() }, function(ok, value)
		if not ok or gen ~= generation or selected ~= selection then return end
		close_approval()
		session_id, attachment, grant, snapshot, authority = id, value.attachmentId, nil, nil, nil
		apply_snapshot(value.snapshot)
		-- Never acquire/reacquire control on attach/reconnect.
		local lookups = {}
		for command_id, envelope in pairs(unresolved) do
			if envelope.sessionId == id then table.insert(lookups, { id = command_id, epoch = envelope.serviceEpoch }) end
		end
		local attached, next_lookup = attachment, 0
		local function lookup_next()
			if gen ~= generation or attached ~= attachment then return end
			next_lookup = next_lookup + 1
			local lookup = lookups[next_lookup]
			if not lookup then return end
			request("command.status", { serviceEpoch = lookup.epoch, commandId = lookup.id }, function(found, receipt)
				if gen ~= generation or attached ~= attachment then return end
				if found and unresolved[lookup.id] then
					submission_status[lookup.id] = receipt.status
					notify("Command " .. lookup.id .. ": " .. receipt.status .. "; draft retained, not replayed. Review via :PiSubmissions.")
					render()
				end
				lookup_next()
			end)
		end
		-- Stay well below the 32-request bridge/IPC limit, reserving room for
		-- snapshots, ordinary UI requests and controller heartbeats.
		for _ = 1, 4 do lookup_next() end
	end)
end
local function host_operation(operation, payload)
	if not hello then notify("Connect to the service first."); return end
	if pending_host then notify("Host request " .. pending_host.id .. " is unresolved. Inspect :PiHostRequest; it was not replayed."); return end
	local captured = stamp()
	local envelope = { id = uid(), serviceEpoch = hello.serviceEpoch, operation = operation, payload = payload }
	pending_host = envelope
	request("host.command", envelope, function(ok, receipt)
		if ok and pending_host == envelope then
			pending_host = nil
			if receipt.result then
				if captured.generation == generation and captured.attachment == attachment and captured.session == session_id then attach(receipt.result.sessionId)
				else notify("Host request completed for " .. receipt.result.sessionId .. "; current view was not changed.") end
			end
		end
	end)
end
local function recover_host()
	if not pending_host then return false end
	local envelope, captured = pending_host, stamp()
	request("host.status", { serviceEpoch = envelope.serviceEpoch, commandId = envelope.id }, function(ok, receipt)
		if pending_host ~= envelope then return end
		if ok and receipt.result then
			pending_host = nil
			if captured.generation == generation and captured.attachment == attachment and captured.session == session_id then attach(receipt.result.sessionId) end
		else notify("Host request outcome unresolved. Inspect its ID before explicitly creating/resuming; no replay occurred.", vim.log.levels.WARN) end
	end)
	return true
end
connect = function()
	if job then notify("Already connected."); return end
	generation = generation + 1
	local gen = generation
	local args = { "node", vim.fs.joinpath(vim.g.pi_console_root, "server", "dist", "bridge.js"), "--channel", vim.env.PI_CONSOLE_CHANNEL or "stable" }
	if M.config.service_root and M.config.service_root ~= "" then vim.list_extend(args, { "--root", M.config.service_root }) end
	local partial = ""
	local function record(value)
		if gen ~= generation then return end
		if value.type == "hello" then
			hello = value.result
			if recover_host() then return end
			if session_id then
				if resume_requested then resume_requested = false; host_operation("host.resume", { sessionId = session_id })
				else attach(session_id) end
			elseif not initial_attempted then
				initial_attempted = true; host_operation("host.create", { cwd = vim.fn.getcwd() })
			end
		elseif value.type == "response" then
			local callback = callbacks[value.id]; callbacks[value.id] = nil
			if value.success == false then notify(value.error.code .. ": " .. value.error.message, vim.log.levels.WARN) end
			if callback then callback(value.success, value.success and value.result or value.error) end
		elseif value.type == "update" then
			if value.update.sessionId ~= session_id then return end
			local old_revision = current_revision()
			observe_authority(value.update, false)
			if old_revision ~= current_revision() then close_approval() end
			local receipt = value.update.command
			if receipt and unresolved[receipt.id] then submission_status[receipt.id] = receipt.status end
			if receipt and receipt.status ~= "accepted" and outcomes[receipt.id] then
				local outcome = outcomes[receipt.id]; outcomes[receipt.id] = nil
				if outcome_current(outcome) then outcome.callback(receipt) end
			end
			if value.update.owner then
				-- Revoke local callbacks immediately, not after the coalesced read.
				if grant and (not value.update.owner.controller or value.update.owner.controller.grantId ~= grant.grantId) then grant = nil; close_approval() end
			end
			if value.update.effect then
				table.insert(offers, value.update)
				if #offers > 128 then table.remove(offers, 1) end
			end
			refresh()
		elseif value.type == "disconnected" then disconnected() end
	end
	local started = vim.fn.jobstart(args, {
		stdin = "pipe",
		on_stdout = function(_, chunks)
			if gen ~= generation then return end
			for i, chunk in ipairs(chunks) do
				partial = partial .. chunk
				if #partial > 80 * 1024 * 1024 then notify("Bridge frame too large"); M.detach(); return end
				if i < #chunks then
					local line = partial
					partial = ""
					if line ~= "" then
						local ok, value = pcall(vim.json.decode, line)
						if not ok then notify("Invalid bridge frame"); M.detach(); return end
						local handled, err = xpcall(function() record(value) end, debug.traceback)
						if not handled then notify("Service UI error: " .. tostring(err), vim.log.levels.ERROR); M.detach(); return end
					end
				end
			end
		end,
		on_stderr = function(_, chunks) if gen == generation then for _, line in ipairs(chunks) do if line ~= "" then notify(line, vim.log.levels.WARN) end end end end,
		on_exit = function() if gen == generation then disconnected() end end,
	})
	if started <= 0 then notify("Could not start Node bridge"); disconnected(); return end
	job = started
end

function M.detach()
	local old = job
	disconnected()
	if old then vim.fn.jobstop(old) end -- Only the relay, never a Pi worker.
end
function M.reconnect() M.detach(); connect() end
function M.take_control(takeover)
	local captured = stamp()
	local function acquire()
		if not same_context(captured) or takeover and captured.controller ~= (current_controller() and current_controller().grantId) then
			notify("Attachment/controller changed; request control again for this session."); return
		end
		command(takeover and "control.takeover" or "control.acquire", takeover and { confirmed = true } or {}, function(ok)
			if ok then request("grant", {}, function(found, value)
				if found and same_context(captured) and value ~= vim.NIL then grant = value; refresh() end
			end) end
		end)
	end
	if takeover then vim.ui.select({ "Cancel", "Take over" }, { prompt = "Replace the current controller? Accepted work continues." }, function(choice) if choice == "Take over" then acquire() end end)
	else acquire() end
end
function M.submit_prompt()
	local original = text(state.input_buf)
	if vim.trim(original) == "" then return end
	if original:match("^%s*/") then unavailable("Freeform slash commands; use typed controls"); return end
	local trimmed = vim.trim(original)
	local excluded = trimmed:sub(1, 2) == "!!"
	local operation = trimmed:sub(1, 1) == "!" and "shell.run" or "prompt.submit"
	local payload = operation == "shell.run" and { command = trimmed:sub(excluded and 3 or 2), excludeFromContext = excluded } or { text = original }
	for id, envelope in pairs(unresolved) do
		if (envelope.operation == "prompt.submit" or envelope.operation == "shell.run") and envelope.sessionId == session_id
			and vim.trim(envelope.payload.text or envelope.payload.command) == vim.trim(payload.text or payload.command) then
			notify("Submission " .. id .. " may already be accepted. Review :PiSubmissions before sending this text again.", vim.log.levels.WARN)
			return
		end
	end
	local captured = stamp()
	command(operation, payload, function(ok)
		if ok and same_context(captured) and text(state.input_buf) == original then layout.set_buffer_lines(ctx, state.input_buf, { "" }, true) end
	end)
end
function M.show_host_request()
	if not pending_host then notify("No unresolved host request."); return end
	local envelope = pending_host
	request("host.status", { serviceEpoch = envelope.serviceEpoch, commandId = envelope.id }, function(ok, receipt)
		draft_buffer("pi://host-request/" .. uid(), vim.inspect({ command = envelope, outcome = receipt }))
		vim.ui.select({ "Keep protected", "Allow a new host request" }, { prompt = "Existing request may already have created/resumed a session; review its identity first." }, function(choice)
			if choice == "Allow a new host request" and pending_host == envelope then pending_host = nil end
		end)
	end)
end
function M.show_operations()
	if not snapshot then return end
	local choices, seen = {}, {}
	for _, receipt in ipairs(snapshot.commands or {}) do table.insert(choices, receipt); seen[receipt.id] = true end
	for id, envelope in pairs(unresolved) do
		if envelope.sessionId == session_id and not seen[id] then table.insert(choices, { id = id, serviceEpoch = envelope.serviceEpoch, operation = envelope.operation, status = "unknown" }) end
	end
	local captured = stamp()
	vim.ui.select(choices, { prompt = "Owner operation receipts (inspect only; never replayed)", format_item = function(receipt) return receipt.id .. " " .. receipt.operation .. " " .. receipt.status end }, function(receipt)
		if not receipt or not same_context(captured) then return end
		request("command.status", { serviceEpoch = receipt.serviceEpoch, commandId = receipt.id }, function(ok, result)
			if same_context(captured) then draft_buffer("pi://operation/" .. uid(), vim.inspect(ok and result or { unavailable = result })) end
		end)
	end)
end
function M.show_submissions()
	local choices = {}
	for id, envelope in pairs(unresolved) do
		if text_submission(envelope.operation) and envelope.sessionId == session_id then table.insert(choices, id) end
	end
	vim.ui.select(choices, { prompt = "Protected submission IDs (never replayed)", format_item = function(id) return id .. " — " .. (submission_status[id] or "outcome unknown") end }, function(id)
		local envelope = id and unresolved[id]
		if not envelope then return end
		request("command.status", { serviceEpoch = envelope.serviceEpoch, commandId = id }, function(ok, receipt)
			if ok then submission_status[id] = receipt.status end
			draft_buffer("pi://submission-review/" .. uid(), vim.inspect({ command = envelope, outcome = receipt }))
			render()
			vim.ui.select({ "Keep protected", "Allow a new submission" }, { prompt = "This text may already have executed. Allowing a new submission can duplicate work." }, function(choice)
				if choice == "Allow a new submission" then unresolved[id] = nil; submission_status[id] = nil; render() end
			end)
		end)
	end)
end
function M.abort() command("turn.abort", {}) end
function M.rename_session()
	local captured = stamp()
	vim.ui.input({ prompt = "Session name: " }, function(title) if title then command("session.rename", { title = title }, nil, captured) end end)
end
function M.pick_queue()
	if not snapshot then return end
	local captured = stamp()
	vim.ui.select(snapshot.acceptedQueue.items, { prompt = "Shared accepted queue", format_item = function(item) return item.status .. " r" .. item.revision .. " " .. item.text end }, function(item)
		if not item or not same_context(captured) then return end
		vim.ui.select({ "Edit", "Remove", "Inspect" }, { prompt = item.id }, function(action)
			if action == "Remove" then command("queue.remove", { itemId = item.id, expectedRevision = item.revision }, nil, captured)
			elseif action == "Edit" then
				command("queue.reserve", { itemId = item.id, expectedRevision = item.revision }, function(ok, receipt)
					if not ok then return end
					local reservation_id = receipt.result and receipt.result.reservationId
					local expected_revision = item.revision
					-- Only this editor's acknowledged edit advances its revision;
					-- snapshots must not authorize saving over another edit/dispatch.
					draft_buffer("pi://queue-draft/" .. uid(), item.text, function(buf)
						local submitted = text(buf)
						command("queue.edit", { itemId = item.id, expectedRevision = expected_revision, text = submitted }, function(saved, edit_receipt)
							if saved and edit_receipt.result and edit_receipt.result.queueItemId == item.id then
								expected_revision = edit_receipt.result.queueItemRevision
								if valid(buf) and text(buf) == submitted then vim.bo[buf].modified = false end
							end
						end, captured)
					end, function()
						if reservation_id and current(captured) then command("queue.release", { reservationId = reservation_id }, nil, captured) end
					end)
				end, captured)
			elseif action == "Inspect" then draft_buffer("pi://queue-inspect/" .. uid(), vim.inspect(item)) end
		end)
	end)
end
local function pending(id)
	for _, item in ipairs(snapshot and snapshot.interactions.pending or {}) do if item.request.id == id and not item.submitted then return item end end
end
local function preview_lines(value, lines, key)
	if type(value) == "table" then
		for k, v in pairs(value) do preview_lines(v, lines, (key and (key .. ".") or "") .. tostring(k)) end
	else
		local decoded = type(value) == "string" and select(2, pcall(vim.json.decode, value))
		if type(decoded) == "table" then preview_lines(decoded, lines, key)
		else
			table.insert(lines, "### " .. (key or "Request"))
			vim.list_extend(lines, vim.split(tostring(value), "\n", { plain = true }))
			table.insert(lines, "")
		end
	end
end
function M.restore_pending_action()
	if not snapshot then return end
	local choices, captured = snapshot.interactions.pending, stamp()
	vim.ui.select(choices, { prompt = "Pending owner requests (viewer can inspect)", format_item = function(item) return item.request.method .. " " .. item.request.id end }, function(item)
		if not item or not same_context(captured) then return end
		close_approval()
		local request_data = item.request
		local lines = { "# Owner request " .. request_data.id, "", "Closing this window does not answer or cancel.", "" }
		preview_lines(item, lines)
		local options = request_data.method == "confirm" and { "Allow", "Deny" } or request_data.options or {}
		local option_lines = {}
		if control_current() then
			if request_data.method == "input" or request_data.method == "editor" then options = { "Edit answer draft" } end
			for index, option in ipairs(options) do
				option_lines[#lines + 1] = index; table.insert(lines, "[" .. index .. "] " .. option)
			end
			option_lines[#lines + 1] = "cancel"; table.insert(lines, "[cancel] Explicitly cancel request")
		else table.insert(lines, "VIEWER: :PiControl / :PiTakeover is required to answer.") end
		approval_request = request_data.id
		approval_buf = layout.create_buffer(nil, "pi://approval/" .. uid(), "markdown", false)
		layout.set_buffer_lines(ctx, approval_buf, lines, false)
		approval_win = vim.api.nvim_open_win(approval_buf, true, { relative = "editor", style = "minimal", border = "rounded", width = math.max(1, math.min(100, vim.o.columns - 4)), height = math.max(1, math.min(30, vim.o.lines - 4)), row = 1, col = 1 })
		local function answer(answer_value, cancel)
			local live = pending(request_data.id)
			if not current(captured) or not live then notify("Request or controller changed; no reply sent."); return end
			local seconds, micros = vim.uv.gettimeofday()
			if live.tag and live.tag.deadline and seconds * 1000 + micros / 1000 >= live.tag.deadline then notify("Request deadline expired"); return end
			command(cancel and "interaction.cancel" or "interaction.respond", cancel and { requestId = request_data.id } or { requestId = request_data.id, answer = answer_value }, nil, captured)
			close_approval()
		end
		vim.keymap.set("n", "<CR>", function()
			local choice = option_lines[vim.api.nvim_win_get_cursor(0)[1]]
			if not choice then return end
			if choice == "cancel" then answer(nil, true)
			elseif request_data.method == "confirm" then answer({ confirmed = choice == 1 })
			elseif request_data.method == "input" or request_data.method == "editor" then
				close_approval()
				draft_buffer("pi://answer-draft/" .. uid(), request_data.prefill or "", function(buf) answer({ value = text(buf) }) end)
			else answer({ value = options[choice] }) end
		end, { buffer = approval_buf })
		vim.keymap.set("n", "q", close_approval, { buffer = approval_buf })
	end)
end
function M.show_offers()
	vim.ui.select(offers, { prompt = "Inspect-only offers (never applied)", format_item = function(update) return update.effect.data.type .. " " .. update.effect.id end }, function(update)
		if not update or not control_current() then return end
		local captured = stamp()
		request("effect.inspect", { controlToken = grant.token, update = update }, function(ok, effect)
			if ok and current(captured) and effect ~= vim.NIL then draft_buffer("pi://effect-offer/" .. uid(), effect.text or vim.inspect(effect)) end
		end)
	end)
end
function M.pick_session()
	local captured = stamp()
	request("sessions", {}, function(ok, result)
		if not ok or not same_context(captured) then return end
		vim.ui.select(result.sessions, { prompt = "Service sessions", format_item = function(item) return item.id .. " " .. (item.name or item.cwd) .. " (" .. item.state .. ")" end }, function(item)
			if not item or not same_context(captured) then return end
			if item.state == "open" then attach(item.id)
			else vim.ui.select({ "Cancel", "Resume" }, { prompt = "Explicitly resume saved conversation? No queued work is replayed." }, function(choice) if choice == "Resume" and same_context(captured) then host_operation("host.resume", { sessionId = item.id }) end end) end
		end)
	end)
end
function M.new_session()
	local runtime = snapshot and snapshot.interactions.runtime
	if not runtime then notify("Attach to choose an owner directory first."); return end
	host_operation("host.create", { cwd = runtime.cwd })
end
function M.change_cwd()
	local captured = stamp()
	vim.ui.input({ prompt = "New conversation directory on owner (absolute): " }, function(cwd)
		if cwd and current(captured) then host_operation("host.create", { cwd = cwd }) end
	end)
end
local function lifecycle(operation, label)
	local captured = stamp()
	vim.ui.select({ "Cancel", label }, { prompt = label .. " on owner? Active work is interrupted; history/workspaces and recovery text remain." }, function(choice)
		if choice ~= label then return end
		command(operation, { confirmed = true }, nil, captured, function(receipt)
			if receipt.status == "completed" and operation == "session.kill" then
				local preserved = backup()
				M.detach()
				if preserved and can_close_frontend() then vim.cmd("qall!") end
			end
		end)
	end)
end
function M.restart() lifecycle("session.restart", "Restart session") end
function M.kill_session()
	if can_close_frontend() then lifecycle("session.kill", "Kill session and close") end
end
function M.new_session_window() unavailable("New frontend window shortcut; launch --service --attach explicitly") end
local function owner_read(kind, callback, captured)
	captured = captured or stamp()
	if not snapshot then return end
	request("session.read", { kind = kind, runtimeRevision = captured.revision }, function(ok, result)
		if ok and same_context(captured) then callback(result.data, captured) end
	end)
end
local function pick_setting(operation, values, label)
	local captured = stamp()
	vim.ui.select(values, { prompt = label .. " (owner)" }, function(value)
		if value then command(operation, { mode = value }, nil, captured) end
	end)
end
function M.set_access_mode(mode) command("access.set", { mode = mode }) end
function M.pick_access_mode() pick_setting("access.set", M.config.access_modes or { "readonly", "ask", "edit", "full" }, "Access mode") end
function M.cycle_access_mode() command("access.cycle", { modes = M.config.access_modes or { "readonly", "ask", "edit", "full" } }) end
function M.set_integration_mode(mode) command("integration.set", { mode = mode }) end
function M.pick_integration_mode() pick_setting("integration.set", M.config.integration_modes or { "ask", "allowed" }, "Integration mode") end
function M.cycle_integration_mode() command("integration.cycle", { modes = M.config.integration_modes or { "ask", "allowed" } }) end
function M.pick_model()
	owner_read("models", function(data, captured)
		vim.ui.select(data.models, { prompt = "Owner model", format_item = function(model) return model.provider .. "/" .. model.id end }, function(model)
			if model then command("model.set", { provider = model.provider, modelId = model.id }, nil, captured) end
		end)
	end)
end
function M.pick_thinking()
	owner_read("thinking", function(data, captured)
		vim.ui.select(data.levels, { prompt = "Owner thinking level" }, function(level)
			if level then command("thinking.set", { level = level }, nil, captured) end
		end)
	end)
end
local function native_draft(operation)
	local captured, accepted_text = stamp(), nil
	draft_buffer("pi://" .. operation .. "/" .. uid(), "", function(buf)
		local submitted = text(buf)
		if submitted == accepted_text then notify("This text was already accepted; edit it explicitly before sending new work."); return end
		for id, envelope in pairs(unresolved) do
			if envelope.operation == operation and envelope.sessionId == captured.session and envelope.payload.text == submitted then
				notify("Submission " .. id .. " may already be accepted; inspect :PiSubmissions."); return
			end
		end
		command(operation, { text = submitted }, function(ok)
			if ok then accepted_text = submitted end
			if ok and valid(buf) and text(buf) == submitted then vim.bo[buf].modified = false end
		end, captured)
	end)
end
function M.steer() native_draft("steering.submit") end
function M.follow_up() native_draft("followUp.submit") end
function M.side_prompt() native_draft("side.prompt") end
function M.toggle_side()
	if not valid(side_buf) then side_buf = draft_buffer("pi://side-owner/" .. uid(), "") end
	vim.bo[side_buf].buftype = "nofile"
	render()
end
function M.new_side()
	local captured = stamp()
	vim.ui.select({ "Cancel", "New side conversation" }, { prompt = "Stop and replace the side conversation on owner?" }, function(choice)
		if choice == "New side conversation" then command("side.reset", {}, nil, captured) end
	end)
end
function M.abort_side() command("side.abort", {}) end
function M.pick_spawn()
	local data, captured = status_data("pi-spawn-runs"), stamp()
	vim.ui.select(data and data.runs or {}, { prompt = "Owner subagents", format_item = function(run) return run.runId .. " " .. run.status end }, function(run)
		if not run or not same_context(captured) then return end
		vim.ui.select({ "Inspect", "Join", "Stop" }, { prompt = run.runId }, function(action)
			if action == "Inspect" then draft_buffer("pi://owner-spawn/" .. uid(), vim.inspect(run))
			elseif action == "Join" or action == "Stop" then command(action == "Join" and "spawn.join" or "spawn.stop", { id = run.runId }, nil, captured) end
		end)
	end)
end
function M.toggle_notifications()
	local enabled = snapshot and snapshot.conversation.statuses["pi-notifications"] ~= "notify on"
	command("notifications.set", { enabled = enabled == true })
end
function M.retitle() command("title.generate", {}) end
function M.pick_workspace()
	local captured = stamp()
	vim.ui.select({ "Inspect state", "Enter", "Integrate and return", "Discard" }, { prompt = "Workspace on owner (confirmation remains owner-side)" }, function(action)
		if action == "Inspect state" then draft_buffer("pi://owner-workspace/" .. uid(), vim.inspect(snapshot and snapshot.workspace))
		elseif action == "Enter" then
			vim.ui.input({ prompt = "Ignored paths to include (comma separated; blank for none): " }, function(value)
				if value == nil then return end
				local paths = {}; for path in value:gmatch("[^,]+") do table.insert(paths, vim.trim(path)) end
				command("workspace.enter", #paths > 0 and { ignoredFiles = paths } or {}, nil, captured)
			end)
		elseif action == "Integrate and return" or action == "Discard" then
			command(action == "Discard" and "workspace.discard" or "workspace.integrate", {}, nil, captured)
		end
	end)
end
function M.show_workspace_diff()
	notify("Editable workspace review is the excluded resource-parity slice; no owner path was opened locally.", vim.log.levels.WARN)
end
function M.show_usage()
	local function inspect() owner_read("stats", function(data)
		draft_buffer("pi://owner-usage/" .. uid(), vim.inspect({ session = data, codex = status_data("pi-codex-usage") }))
	end) end
	if control_current() then command("usage.refresh", {}, nil, stamp(), inspect) else inspect() end
end
function M.show_tree()
	owner_read("entries", function(data, captured)
		vim.ui.select(data.entries, { prompt = "Owner history (all branches)", format_item = function(entry)
			return entry.id .. " " .. entry.type .. " " .. (entry.message and entry.message.role or entry.customType or "")
		end }, function(entry)
			if not entry or not same_context(captured) then return end
			vim.ui.select({ "Inspect", "Jump", "Jump with summary", "Clone through entry", "Delete subtree", "Fork before user message" }, { prompt = entry.id }, function(action)
				if action == "Inspect" then draft_buffer("pi://owner-entry/" .. uid(), vim.inspect(entry))
				elseif action == "Jump" or action == "Jump with summary" then
					command("history.navigate", { entryId = entry.id, summarize = action == "Jump with summary" }, nil, captured, function(receipt)
						if receipt.status == "completed" and receipt.result and receipt.result.editorText ~= nil then
							draft_buffer("pi://history-draft/" .. uid(), receipt.result.editorText)
						end
					end)
				elseif action == "Clone through entry" or action == "Fork before user message" then
					command(action == "Clone through entry" and "history.clone" or "history.fork", { entryId = entry.id }, nil, captured, function(receipt)
						if receipt.status == "completed" and receipt.result and receipt.result.sessionId then
							if receipt.result.editorText ~= nil then draft_buffer("pi://fork-draft/" .. uid(), receipt.result.editorText) end
							host_operation("host.resume", { sessionId = receipt.result.sessionId })
						end
					end)
				elseif action == "Delete subtree" then command("history.delete", { entryId = entry.id }, nil, captured) end
			end)
		end)
	end)
end
function M.pick_command()
	local captured = stamp()
	vim.ui.select({ "Compact", "Abort retry", "Abort shell", "Steer", "Follow up", "Steering delivery", "Follow-up delivery", "Auto compaction", "Auto retry", "History" }, { prompt = "Typed owner operations" }, function(choice)
		if not current(captured) then notify("Controller/context changed; select again."); return end
		if choice == "Compact" then vim.ui.input({ prompt = "Compaction instructions: " }, function(value) if value then command("compaction.run", { instructions = value }, nil, captured) end end)
		elseif choice == "Abort retry" then command("retry.abort", {}, nil, captured)
		elseif choice == "Abort shell" then command("shell.abort", {}, nil, captured)
		elseif choice == "Steer" then M.steer()
		elseif choice == "Follow up" then M.follow_up()
		elseif choice == "History" then M.show_tree()
		elseif choice == "Steering delivery" or choice == "Follow-up delivery" then
			vim.ui.select({ "all", "one-at-a-time" }, { prompt = choice }, function(mode) if mode then command(choice == "Steering delivery" and "steering.mode" or "followUp.mode", { mode = mode }, nil, captured) end end)
		elseif choice == "Auto compaction" or choice == "Auto retry" then
			vim.ui.select({ "Enabled", "Disabled" }, { prompt = choice }, function(value) if value then command(choice == "Auto compaction" and "compaction.auto" or "retry.auto", { enabled = value == "Enabled" }, nil, captured) end end)
		end
	end)
end
function M.refresh_messages() refresh() end
function M.show_input() layout.show_input(ctx) end
function M.show_transcript() layout.show_transcript(ctx) end
function M.show_help()
	draft_buffer("pi://service-help/" .. uid(), "# Local service attachment\n\n:PiControl / :PiTakeover / :PiRelease\n:PiPending (inspect; Enter explicitly answers; closing never cancels)\n:PiQueue (shared editable queue; :write saves; pauses expire after 30s)\n:PiFollowUp / steering shortcut (separate native queues)\n:PiWorkspace (owner enter/integrate/discard, with existing confirmations)\n:PiSidePrompt / :PiSideNew / :PiSideAbort\n:PiRetitle / :PiOperations (typed outcomes and recovery text)\n:PiSubmissions / :PiHostRequest (uncertain IDs; never replayed)\n:PiOffers / :PiDrafts (inspect-only)\n:PiDetach / :PiReconnect\n:PiKill (kill session and close; preserves local drafts)\n:PiConsoleRestart is frontend-only. The restart shortcut restarts the owner session.\n\n<C-CR> submits text or ! / !! shell on OWNER; <Esc><Esc> aborts.\nSettings/model/thinking/history and the command picker use typed owner operations.\nFreeform slash commands and excluded resource/overview actions never use a local or raw RPC fallback.\nService stop/restart remains separate: pi-console server stop/restart [--force].")
end
function M.open_transcript_item()
	local item = transcript.transcript_item_at_line(ctx, vim.api.nvim_win_get_cursor(0)[1])
	if not item then unavailable("Owner file/navigation links"); return end
	if item.kind == "tool_group" then require("pi-integration.tool-groups").toggle(ctx, item); render()
	elseif item.kind == "tool" then
		local output = state.tool_outputs[item.output_id]
		if not output then notify("Recorded tool output unavailable."); return end
		-- Never use the legacy viewer: fullOutputPath, spawn artifacts and
		-- workspace review are owner resources, not frontend-local paths.
		draft_buffer("pi://recorded-tool/" .. uid(), "# Recorded owner tool output\n\nOwner file/artifact/review actions are unavailable in B3.\n\n" .. (output.text or ""))
	elseif item.kind == "thinking" then require("pi-integration.thinking-output").open_float({ state = state, ui = { notify = notify }, window = { parent = state.transcript_win } }, item.output_id)
	else unavailable("This transcript action") end
end
function M.show_drafts()
	local ok, values = pcall(require("pi-integration.service-drafts").list)
	if not ok then notify(tostring(values), vim.log.levels.ERROR); return end
	vim.ui.select(values, { prompt = "Local draft recovery (inspect only; never replayed)", format_item = function(item)
		return tostring(item.value.saved_at) .. " " .. tostring(item.value.channel) .. " " .. tostring(item.value.service_session)
	end }, function(item)
		if item then
			local value = item.value
			draft_buffer("pi://recovered/" .. uid(), table.concat(value.input_lines or {}, "\n"))
			for _, draft in ipairs(value.drafts or {}) do draft_buffer("pi://recovered/" .. uid(), draft.text) end
			if next(value.unresolved or {}) or value.pending_host then draft_buffer("pi://recovery-status/" .. uid(), vim.inspect({ unresolved = value.unresolved, pending_host = value.pending_host })) end
		end
	end)
end
function M.restart_console()
	local path = M.config.restart_file
	if not path or path == "" then notify("Launch through pi-console to relaunch the frontend."); return end
	if not can_close_frontend() then return end
	local value = local_snapshot()
	local ok, err = pcall(function()
		assert(vim.fn.writefile({ vim.json.encode(value) }, path) == 0, "Could not write restart handoff")
		-- Only our preserved draft buffers may be discarded by this relaunch.
		vim.cmd("qall!")
	end)
	if not ok then vim.fn.delete(path); notify(tostring(err), vim.log.levels.ERROR) end
end
function M.follow_markdown_link() unavailable("Owner file/navigation links"); return true end
function M.restore_status_footer() end
function M.get_commands(callback) callback({}) end
function M.on_transcript_rendered() end
function M.maybe_prompt_session_archive() end
function M.setup(config)
	M.config = vim.tbl_extend("force", config or {}, { service_root = vim.env.PI_CONSOLE_SERVICE_ROOT })
	ctx.config = M.config
end
function M.open(_, restore)
	if restore then
		session_id, pending_host = restore.service_session, restore.pending_host
		unresolved, initial_attempted = restore.unresolved or {}, restore.initial_attempted
		submission_status = restore.submission_status or {}
		M.config.service_root = restore.service_root or M.config.service_root
	else session_id, resume_requested = vim.env.PI_CONSOLE_SERVICE_SESSION, vim.env.PI_CONSOLE_SERVICE_RESUME == "1" end
	ctx.session.setup_keymaps = function()
		local actions = setmetatable({ open_transcript_item = M.open_transcript_item }, { __index = M })
		require("pi-integration.keymaps").setup({ state = state, actions = actions, buffer = ctx.buffer,
			ui = { notify = notify }, transcript = { open_item_under_cursor = M.open_transcript_item }, service_mode = true })
	end
	layout.open(ctx)
	if restore then
		layout.set_buffer_lines(ctx, state.input_buf, restore.input_lines or { "" }, true)
		for _, draft in ipairs(restore.drafts or {}) do draft_buffer(draft.name, draft.text) end
	end
	for name, fn in pairs({ PiControl = function() M.take_control(false) end, PiTakeover = function() M.take_control(true) end,
		PiRelease = function() command("control.release", {}) end, PiPending = M.restore_pending_action, PiQueue = M.pick_queue,
		PiOffers = M.show_offers, PiDrafts = M.show_drafts, PiSubmissions = M.show_submissions, PiDetach = M.detach, PiReconnect = M.reconnect,
		PiFollowUp = M.follow_up, PiSidePrompt = M.side_prompt, PiSideNew = M.new_side, PiSideAbort = M.abort_side,
		PiWorkspace = M.pick_workspace, PiKill = M.kill_session, PiRetitle = M.retitle, PiOperations = M.show_operations, PiHostRequest = M.show_host_request }) do
		vim.api.nvim_create_user_command(name, fn, {})
	end
	vim.api.nvim_create_autocmd({ "TextChanged", "TextChangedI", "BufWritePost" }, { callback = function(event)
		if event.buf ~= state.input_buf and not drafts[event.buf] then return end
		if backup_scheduled then return end
		backup_scheduled = true
		vim.defer_fn(function() backup_scheduled = false; backup() end, 500)
	end })
	heartbeat = vim.uv.new_timer()
	heartbeat:start(5000, 5000, vim.schedule_wrap(function()
		if control_current() then
			local captured = stamp()
			request("heartbeat", { controlToken = grant.token }, function(ok)
				if not ok and current(captured) then grant = nil; close_approval(); render() end
			end)
		end
	end))
	connect()
end
for _, name in ipairs({ "show_logs", "restore_session_transcript",
	"start", "refresh_session_stats", "fail_pending_prompts", "flush_queued_prompts", "finish_loading_if_ready" }) do
	M[name] = function() unavailable(name) end
end
vim.api.nvim_create_autocmd("VimLeavePre", { callback = function()
	if heartbeat then heartbeat:stop(); heartbeat:close(); heartbeat = nil end
	backup()
	M.detach()
end })
return M
