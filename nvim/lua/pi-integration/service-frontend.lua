-- Attachments own UI/drafts only. Typed lifecycle requests execute on the owner.
local M = { config = { access_modes = { "readonly", "ask", "edit", "full" },
	integration_modes = { "ask", "allowed" } }, service_mode = true }
local layout = require("pi-integration.layout")
local messages = require("pi-integration.messages")
local transcript = require("pi-integration.transcript")
local statusline = require("pi-integration.statusline")
local buffer = require("pi-integration.utils.buffer")
local state = require("pi-integration.state").new()
local resources = require("pi-integration.service-resources")
state.show_nested_tools = true
local session_id, attachment, snapshot, hello, grant, job
local authority
local callbacks, unresolved, offers, drafts = {}, {}, {}, {}
local outcomes = {}
local submission_status = {}
local pending_host, pending_host_select, initial_attempted, resume_requested
local generation, counter, refresh_scheduled, refreshing, dirty = 0, 0, false, false, false
local selection = 0
local approval_win, approval_buf, approval_request, heartbeat
local recovery_id, backup_scheduled
local render, refresh, connect, attach
local side_buf
local owner_states, create_requested = {}, nil
local conversation_tab, picker_tab
local selection_ready, invocation_cwd, new_control_selection
local function publish_attachment()
	local tmux = require("pi-integration.backends.tmux")
	if not tmux.available() or not session_id then return end
	local name = snapshot and snapshot.piState and snapshot.piState.sessionName or session_id or "Unattached"
	local identity = M.config.expected_host or "unknown"
	local status = "Loading"
	if not job then status = "Disconnected"
	elseif snapshot then
		local pending = false
		for _, item in ipairs(snapshot.interactions.pending) do if not item.submitted then pending = true end end
		status = snapshot.error and "Error" or pending and "Waiting"
			or snapshot.piState and snapshot.piState.isCompacting and "Compacting"
			or snapshot.conversation.execution.running and "Working" or snapshot.phase == "ready" and "Idle" or "Loading"
	end
	tmux.publish({ version = 1, frontend_attachment = true, host_id = identity, session_id = session_id,
		pid = vim.uv.os_getpid(), updated = os.time(), cwd = vim.fn.getcwd(),
		title = "[" .. identity:sub(1, 8) .. "] " .. name,
		status = status })
end
local function owner_key() return M.config.expected_host or M.config.service_remote or M.config.service_root or "local" end

local function notify(text, level)
	local lines = vim.split(tostring(text), "\n", { plain = true })
	local message = table.remove(lines, 1)
	table.insert(state.logs, { timestamp = os.date("%Y-%m-%d %H:%M:%S"), level = level == vim.log.levels.ERROR and "error" or level == vim.log.levels.WARN and "warn" or "info", message = message, details = table.concat(lines, "\n") })
	while #state.logs > 1000 do table.remove(state.logs, 1) end
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
	if authority and (authority.controller and authority.controller.grantId) ~= (controller and controller.grantId) then offers = {} end
	if not authority or authority.epoch ~= value.serviceEpoch or authority.revision ~= value.runtimeRevision then resources.invalidate() end
	authority = { epoch = value.serviceEpoch, sequence = value.sequence, revision = value.runtimeRevision, controller = controller }
end
local function control_current()
	local controller = current_controller()
	return job and attachment and grant and controller
		and controller.attachmentId == attachment and controller.grantId == grant.grantId
end
local function stamp()
	return { generation = generation, attachment = attachment, token = grant and grant.token, epoch = snapshot and snapshot.serviceEpoch,
		controller = current_controller() and current_controller().grantId, revision = current_revision(), session = session_id, selection = selection }
end
local function same_selection(s)
	return s.generation == generation and s.selection == selection and s.attachment == attachment and s.session == session_id
end
local function same_context(s)
	return snapshot and same_selection(s) and s.revision == current_revision()
end
local function current(s)
	return control_current() and same_context(s) and s.token == grant.token
end
local function outcome_current(outcome, receipt)
	if outcome.lifecycle or outcome.transition then
		local s = outcome.captured
		return same_selection(s) and (outcome.lifecycle or control_current() and s.token == grant.token
			and receipt.result and receipt.result.contextRevision == current_revision())
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
local function resource_options()
	return { request = request, stamp = stamp, current = function(s) return job and attachment and same_context(s) end, notify = notify, state = state,
		label = tostring(hello and hello.hostId or owner_key()) .. "/" .. tostring(hello and hello.channel or ""),
		key = table.concat({ tostring(hello and hello.hostId or owner_key()), tostring(hello and hello.channel or ""),
			tostring(snapshot and snapshot.serviceEpoch), tostring(session_id), tostring(current_revision()),
			tostring(snapshot and snapshot.interactions.runtime and snapshot.interactions.runtime.cwd) }, "/") }
end
local open_workspace_review
local function owner_resources()
	local resource = resources.new(resource_options())
	resource.review = function(id, pinned) open_workspace_review(id, pinned) end
	return resource
end
local function desktop_notification(intent, captured)
	local label = "[" .. tostring(hello.hostId):sub(1, 8) .. "] " .. intent.title
	notify(label .. "\n" .. intent.message)
	-- Executables, icon paths and sound/timeout settings belong to this frontend.
	local alerter = vim.env.ALERTER or "alerter"
	local args
	if vim.fn.executable(alerter) == 1 then
		args = { alerter, "--title", label, "--message", intent.message, "--group", "pi-console-" .. session_id }
		local completed = intent.title == "Pi finished"
		local sound = vim.env[completed and "PI_COMPLETION_SOUND" or "PI_PERMISSION_SOUND"] or vim.env.PI_NOTIFICATION_SOUND
		if sound == nil then sound = completed and "Glass" or "Ping" end
		sound = vim.trim(sound)
		if sound ~= "" and not vim.tbl_contains({ "0", "false", "no", "none", "off", "silent" }, sound:lower()) then vim.list_extend(args, { "--sound", sound }) end
		local timeout = vim.env[completed and "PI_COMPLETION_NOTIFICATION_TIMEOUT" or "PI_PERMISSION_NOTIFICATION_TIMEOUT"] or vim.env.PI_NOTIFICATION_TIMEOUT
		local seconds
		if timeout == nil or vim.trim(timeout) == "" then seconds = completed and 8 or 15 else seconds = tonumber(timeout) end
		if seconds and seconds > 0 and seconds < math.huge then vim.list_extend(args, { "--timeout", tostring(seconds) }) end
		local icon = vim.env.PI_NOTIFICATION_ICON or vim.g.pi_console_root .. "/pi/assets/pi-logo.png"
		if vim.fn.filereadable(icon) == 1 then vim.list_extend(args, { "--app-icon", icon }) end
	elseif vim.fn.executable("notify-send") == 1 then
		args = { "notify-send", "--app-name=pi-console", "--", label, intent.message }
	end
	if not args then return end
	local ok, err = pcall(vim.system, args, {}, function(result)
		if result.code ~= 0 then vim.schedule(function() if current(captured) then notify("Frontend desktop notifier failed: " .. tostring(result.stderr), vim.log.levels.WARN) end end) end
	end)
	if not ok then notify("Could not launch frontend desktop notifier: " .. tostring(err), vim.log.levels.WARN) end
end
function M.complete_files(prefix, callback)
	if not job or not snapshot or not attachment then callback({ entries = {} }); return end
	resources.complete(resource_options(), prefix, callback)
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
		if (ok and (not operation:match("^workspace%.review%.") or result.status == "completed" or result.status == "failed")) or result.delivery == "not_sent" then
			unresolved[envelope.id], submission_status[envelope.id] = nil, nil
		end
		if callback then callback(ok, result) end
		if not ok and result.delivery == "not_sent" then outcomes[envelope.id] = nil end
		if ok and result.status ~= "accepted" and outcomes[envelope.id] then
			local outcome = outcomes[envelope.id]; outcomes[envelope.id] = nil
			if outcome_current(outcome, result) then outcome.callback(result) end
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
local function recovered_draft(draft)
	local buf = draft_buffer(draft.name or ("pi://recovered/" .. uid()), draft.text)
	if draft.endofline ~= nil then vim.bo[buf].endofline, vim.bo[buf].fixendofline = draft.endofline, false end
	vim.b[buf].pi_review_command_id, vim.b[buf].pi_review_command_epoch = draft.review_command_id, draft.review_command_epoch
	vim.b[buf].pi_review_host, vim.b[buf].pi_review_session, vim.b[buf].pi_review_channel = draft.review_host, draft.review_session, draft.review_channel
	if draft.review_command_id and draft.review_command_epoch then
		vim.keymap.set("n", "gS", function()
			if not draft.review_host or not draft.review_session or session_id ~= draft.review_session or not hello
				or hello.hostId ~= draft.review_host or hello.channel ~= draft.review_channel then
				notify("Attach to review save owner " .. tostring(draft.review_host) .. " / session " .. tostring(draft.review_session) .. " before status lookup."); return
			end
			request("command.status", { serviceEpoch = draft.review_command_epoch, commandId = draft.review_command_id }, function(ok, result)
				if ok then draft_buffer("pi://review-save-receipt/" .. uid(), vim.inspect(result)) else notify(result.message or "Save status unavailable; original identity retained.") end
			end)
		end, { buffer = buf, desc = "Inspect recovered original review save" })
	end
	return buf
end
local function local_snapshot()
	local saved_drafts = {}
	for buf, name in pairs(drafts) do if valid(buf) then table.insert(saved_drafts, { name = name, text = text(buf), endofline = vim.bo[buf].endofline, review_command_id = vim.b[buf].pi_review_command_id, review_command_epoch = vim.b[buf].pi_review_command_epoch,
			review_host = vim.b[buf].pi_review_host, review_session = vim.b[buf].pi_review_session, review_channel = vim.b[buf].pi_review_channel }) end end
	return { cwd = vim.fn.getcwd(), service_session = session_id, service_root = M.config.service_root,
		service_remote = M.config.service_remote, credential_file = M.config.credential_file, ca_file = M.config.ca_file,
		expected_host = M.config.expected_host, owner_states = owner_states,
		view = vim.api.nvim_get_current_tabpage() == conversation_tab and "conversation" or (M.config.start_view or "overview"),
		host = hello and hello.hostId, channel = hello and hello.channel, saved_at = os.date("!%Y-%m-%dT%H:%M:%SZ"),
		input_lines = valid(state.input_buf) and vim.api.nvim_buf_get_lines(state.input_buf, 0, -1, false) or { "" },
		unresolved = unresolved, submission_status = submission_status, pending_host = pending_host, pending_host_select = pending_host_select,
		initial_attempted = initial_attempted, drafts = saved_drafts }
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
local ctx = { state = state, config = M.config, service_mode = true,
	notices = { empty_session = "Send non-slash text after acquiring control." },
	buffer = { valid = valid, set_modifiable = function(buf, value) vim.bo[buf].modifiable = value end },
	session = { setup_keymaps = function() end }, transcript = {} }
ctx.transcript.win_valid = function()
	state.transcript_win = buffer.find_window(state.transcript_buf, state.transcript_win)
	return state.transcript_win ~= nil
end
ctx.transcript.refresh_ui = function() statusline.update(ctx) end
local function update_footer_state()
	local conversation = snapshot and snapshot.conversation
	local statuses = conversation and conversation.statuses or {}
	local pi_state = snapshot and snapshot.piState or {}
	local execution = conversation and conversation.execution or {}
	state.access_mode = (statuses["pi-access-mode"] or ""):match("^Mode: (%w+)$")
	state.integration_mode = (statuses["pi-integration-mode"] or ""):match("^Integration: (%w+)$")
	state.notification_status = statuses["pi-notifications"]
	state.workspace = snapshot and snapshot.workspace
	state.provider = pi_state.model and pi_state.model.provider
	state.model_id = pi_state.model and pi_state.model.id
	state.thinking_level = pi_state.thinkingLevel
	state.session_stats = conversation and conversation.stats
	state.codex_usage = status_data("pi-codex-usage")
	local spawns = status_data("pi-spawn-runs")
	state.spawn_running_count = spawns and spawns.running or 0
	state.is_loading = job ~= nil and (not snapshot or snapshot.phase == "initializing")
	state.is_agent_running = job ~= nil and (execution.running == true or pi_state.isCompacting == true)
	state.is_streaming = job ~= nil and pi_state.isStreaming == true
	state.is_retrying = job ~= nil and execution.retry and execution.retry.type == "auto_retry_start" or false
	state.activity_label = pi_state.isCompacting and "compacting" or "work"
	state.pending_user_messages = snapshot and snapshot.acceptedQueue.items or {}
	state.pending_ui_requests, state.active_ui_request_id = {}, nil
	for _, item in ipairs(snapshot and snapshot.interactions.pending or {}) do
		if not item.submitted then
			local id = item.request.id
			state.pending_ui_requests[id] = { label = item.request.method, hidden = approval_request ~= id }
			state.active_ui_request_id = id
			break
		end
	end
end
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
	return { "# Pi — " .. (M.config.service_remote and "remote TLS service" or "local service"),
		"Endpoint: " .. tostring(hello and hello.remoteEndpoint or M.config.service_remote or M.config.service_root or "local IPC"), "", "Channel: " .. tostring(hello and hello.channel or vim.env.PI_CONSOLE_CHANNEL or "stable")
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
		"Live effects target this controller/context; editor text opens a separate draft (:PiOffers). Shell ! / !! executes on the owner.",
		"Execution: " .. tostring(snapshot and vim.inspect(snapshot.conversation.execution) or "—"),
		"Native queues (not editable application queue): " .. tostring(snapshot and vim.inspect(snapshot.conversation.queue) or "—"),
		(snapshot and snapshot.error) and ("Error: " .. snapshot.error) or "", "" }
end
ctx.transcript.metadata_lines = function()
	local lines = {}
	for _, line in ipairs(metadata()) do vim.list_extend(lines, vim.split(line, "\n", { plain = true })) end
	return lines
end
render = function()
	publish_attachment()
	if not valid(state.transcript_buf) then return end
	local conversation = snapshot and snapshot.conversation
	update_footer_state()
	layout.update_input_sidebar(ctx)
	local visible = vim.deepcopy(conversation and conversation.messages or {})
	if conversation then
		if conversation.partialAssistant then table.insert(visible, conversation.partialAssistant.message) end
		local represented = {}
		for _, message in ipairs(visible) do if message.toolCallId then represented[message.toolCallId] = true end end
		for _, tool in ipairs(conversation.tools or {}) do
			if not represented[tool.toolCallId] then
				table.insert(visible, vim.tbl_extend("force", tool, { role = "tool_execution_start" }))
				if tool.result then table.insert(visible, vim.tbl_extend("force", tool, { role = "tool_execution_end" }))
				elseif tool.partialResult then table.insert(visible, vim.tbl_extend("force", tool, { role = "tool_execution_update" })) end
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
	require("pi-integration.tool-groups").apply_folds(state, state.transcript_win)
	statusline.update(ctx)
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
	if new_control_selection then
		local runtime = snapshot.interactions.runtime
		if not same_selection(new_control_selection) or current_controller() or snapshot.error then
			new_control_selection = nil
		elseif runtime and runtime.active and snapshot.piState and snapshot.piState.sessionId == runtime.sessionId
			and snapshot.piState.sessionFile == runtime.sessionFile then
			-- New allocates before Pi initializes. Send the first acquire only when
			-- its managed identity is available, including startup approvals.
			new_control_selection = nil
			M.take_control(false)
		end
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
	offers = {}
	resources.invalidate()
	generation = generation + 1
	job, attachment, grant, authority = nil, nil, nil, nil
	callbacks, outcomes, selection_ready, new_control_selection = {}, {}, nil, nil
	refreshing, refresh_scheduled, dirty = false, false, false
	close_approval()
	render()
end
attach = function(id, acquire_control)
	if not job then return end
	offers = {}
	if pending_host then pending_host_select = false end
	resources.invalidate()
	selection = selection + 1
	local gen, selected = generation, selection
	request("attach", { sessionId = id, label = "Neovim " .. vim.fn.getpid() }, function(ok, value)
		if not ok or gen ~= generation or selected ~= selection then return end
		close_approval()
		session_id, attachment, grant, snapshot, authority = id, value.attachmentId, nil, nil, nil
		-- Only an explicitly completed New may acquire; attach/reconnect stays a viewer.
		if acquire_control then new_control_selection = stamp() end
		apply_snapshot(value.snapshot)
		local ready = selection_ready; selection_ready = nil
		if ready then ready() end
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
	if not hello or not job then notify("Connect to the service first; no host request was sent."); return end
	if pending_host then notify("Host request " .. pending_host.id .. " is unresolved. Inspect :PiHostRequest; it was not replayed."); return end
	local captured = stamp()
	local envelope = { id = uid(), serviceEpoch = hello.serviceEpoch, operation = operation, payload = payload }
	pending_host, pending_host_select = envelope, true
	request("host.command", envelope, function(ok, receipt)
		if ok and pending_host == envelope then
			pending_host, pending_host_select = nil, nil
			if receipt.result then
				if same_selection(captured) then attach(receipt.result.sessionId, operation == "host.create")
				else notify("Host request completed for " .. receipt.result.sessionId .. "; current view was not changed.") end
			elseif receipt.error then notify("Host request " .. receipt.status .. ": " .. receipt.error.message, vim.log.levels.WARN) end
		end
	end)
end
local function recover_host()
	if not pending_host then return false end
	local envelope, captured = pending_host, stamp()
	request("host.status", { serviceEpoch = envelope.serviceEpoch, commandId = envelope.id }, function(ok, receipt)
		if pending_host ~= envelope then return end
		local select_result = pending_host_select == true
		if ok and receipt.result then
			pending_host, pending_host_select = nil, nil
			if select_result and same_selection(captured) then attach(receipt.result.sessionId) end
		else notify("Host request outcome unresolved. Inspect its ID before explicitly creating/resuming; no replay occurred.", vim.log.levels.WARN) end
		-- Recovery can resolve an ID after another selection, never revive its
		-- original right to select. Reattach the user's selected view instead.
		if not select_result and same_selection(captured) and not attachment and session_id then attach(session_id) end
	end)
	return true
end
connect = function()
	if not M.config.expected_host then
		local ok, identity = pcall(require("pi-integration.service-hosts").expected_identity, M.config)
		if not ok then notify(identity); return end
		M.config.expected_host = identity
	end
	local source = M.config.expected_host and require("pi-integration.service-hosts").find(M.config.expected_host)
	if source and source.target.enabled == false then notify("Host is disconnected. Enable it in :PiHosts before attaching."); return end
	if job then notify("Already connected."); return end
	generation = generation + 1
	local gen = generation
	local args = { "node", vim.fs.joinpath(vim.g.pi_console_root, "server", "dist", "bridge.js"), "--channel", vim.env.PI_CONSOLE_CHANNEL or "stable" }
	if M.config.service_remote then
		vim.list_extend(args, { "--remote", M.config.service_remote, "--credential-file", M.config.credential_file })
		if M.config.ca_file then vim.list_extend(args, { "--ca-file", M.config.ca_file }) end
	elseif M.config.service_root and M.config.service_root ~= "" then vim.list_extend(args, { "--root", M.config.service_root }) end
	if M.config.expected_host then vim.list_extend(args, { "--expected-host", M.config.expected_host }) end
	local partial = ""
	local function record(value)
		if gen ~= generation then return end
		if value.type == "hello" then
			local result = value.result
			if type(result) ~= "table" or result.version ~= 1 or result.channel ~= (vim.env.PI_CONSOLE_CHANNEL or "stable")
				or type(result.hostId) ~= "string" or type(result.capabilities) ~= "table"
				or not vim.tbl_contains(result.capabilities, "snapshot") or not vim.tbl_contains(result.capabilities, "updates")
				or (M.config.service_remote and result.transport ~= "wss") then
				notify("Incompatible service handshake; no fallback.", vim.log.levels.ERROR); M.detach(); return
			end
			if M.config.expected_host and result.hostId ~= M.config.expected_host then
				notify("Owner identity changed; confirm in Hosts before selecting."); M.detach(); return
			end
			hello = result
			M.config.expected_host = result.hostId
			render()
			if recover_host() then return end
			if create_requested then
				local cwd = create_requested; create_requested = nil
				host_operation("host.create", { cwd = cwd })
			elseif session_id then
				if resume_requested then resume_requested = false; host_operation("host.resume", { sessionId = session_id })
				else attach(session_id) end
			elseif not initial_attempted then
				initial_attempted = true
				if M.config.service_remote then M.pick_session()
				else host_operation("host.create", { cwd = invocation_cwd }) end
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
			if receipt and unresolved[receipt.id] then
				submission_status[receipt.id] = receipt.status
				if receipt.operation:match("^workspace%.review%.") and (receipt.status == "completed" or receipt.status == "failed") then unresolved[receipt.id], submission_status[receipt.id] = nil, nil end
			end
			if receipt and receipt.status ~= "accepted" and outcomes[receipt.id] then
				local outcome = outcomes[receipt.id]; outcomes[receipt.id] = nil
				if outcome_current(outcome, receipt) then outcome.callback(receipt) end
			end
			if value.update.owner then
				-- Revoke local callbacks immediately, not after the coalesced read.
				if grant and (not value.update.owner.controller or value.update.owner.controller.grantId ~= grant.grantId) then grant = nil; close_approval() end
			end
			if value.update.effect then
				local update, captured = value.update, stamp()
				local recipient = update.effect.recipient
				if control_current() and update.runtimeRevision == current_revision() and recipient.attachmentId == attachment and recipient.grantId == grant.grantId then
					table.insert(offers, update)
					if #offers > 128 then table.remove(offers, 1) end
					-- Live delivery only. Revalidate on the owner after the async hop,
					-- then recheck the local selection/grant before any UI effect.
					request("effect.inspect", { controlToken = grant.token, update = update }, function(ok, effect)
						if not ok or not current(captured) or effect == vim.NIL then return end
						if effect.type == "notification" then
							notify(effect.message, effect.level == "error" and vim.log.levels.ERROR or effect.level == "warning" and vim.log.levels.WARN or vim.log.levels.INFO)
						elseif effect.type == "editor_text" then
							-- A separate recoverable draft never replaces unsent local input.
							local buf = draft_buffer("pi://owner-editor-draft/" .. update.effect.id, effect.text)
							owner_resources().bind(buf)
						elseif effect.type == "extension_signal" and effect.key == "pi-desktop-notification" then
							local decoded, intent = pcall(vim.json.decode, effect.value or "")
							if not decoded or type(intent) ~= "table" or type(intent.title) ~= "string" or type(intent.message) ~= "string"
								or #intent.title > 256 or #intent.message > 4096 then return end
							desktop_notification(intent, captured)
						elseif effect.type == "extension_signal" and effect.key == "pi-spawn-notification" then
							local decoded, intent = pcall(vim.json.decode, effect.value or "")
							if decoded and type(intent) == "table" and type(intent.message) == "string" and #intent.message <= 4096 then
								notify(intent.message, intent.level == "error" and vim.log.levels.ERROR or intent.level == "warning" and vim.log.levels.WARN or vim.log.levels.INFO)
							end
						elseif effect.type == "extension_signal" and effect.key == "pi-history-changed" then refresh() end
					end)
				end
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
function M.host_disconnected(identity, target)
	local source = identity and require("pi-integration.service-hosts").find(identity)
	local endpoint_match = not identity and target and target.service_remote == M.config.service_remote and target.service_root == M.config.service_root
	if endpoint_match or identity and M.config.expected_host == identity and not (source and source.connected) then M.detach() end
end
function M.select_owner(target, id, resume, cwd, on_ready)
	local switching = target.expected_host ~= M.config.expected_host or id ~= session_id or cwd ~= nil or resume
		or target.service_root ~= M.config.service_root or target.service_remote ~= M.config.service_remote
		or target.credential_file ~= M.config.credential_file or target.ca_file ~= M.config.ca_file
	if switching then
		if not backup() then return end
		-- The old selection's input must remain recoverable after new autosaves.
		recovery_id = nil
		owner_states[owner_key()] = { unresolved = unresolved, submission_status = submission_status,
			pending_host = pending_host, pending_host_select = false }
		M.detach()
		M.config.service_root, M.config.service_remote = target.service_root, target.service_remote
		M.config.credential_file, M.config.ca_file, M.config.expected_host = target.credential_file, target.ca_file, target.expected_host
		local saved = owner_states[owner_key()] or {}
		unresolved, submission_status = saved.unresolved or {}, saved.submission_status or {}
		pending_host, pending_host_select = saved.pending_host, false
		if cwd and pending_host then notify("Owner has an unresolved create/resume. Inspect :PiHostRequest; no new request was sent."); cwd = nil end
		session_id, resume_requested, create_requested = id, resume, cwd
		snapshot, hello, initial_attempted = nil, nil, true
		selection = selection + 1
		if valid(state.input_buf) then layout.set_buffer_lines(ctx, state.input_buf, { "" }, true) end
	end
	selection_ready = on_ready
	if conversation_tab and vim.api.nvim_tabpage_is_valid(conversation_tab) then
		vim.api.nvim_set_current_tabpage(conversation_tab)
	else
		vim.cmd("tabnew")
		conversation_tab = vim.api.nvim_get_current_tabpage()
	end
	layout.open(ctx)
	render()
	if not job then connect()
	elseif id and not attachment then attach(id)
	elseif selection_ready then
		local ready = selection_ready; selection_ready = nil; ready()
	end
end
function M.pick_hosts() require("pi-integration.service-hosts").picker() end
function M.show_overview()
	if picker_tab and vim.api.nvim_tabpage_is_valid(picker_tab) then vim.api.nvim_set_current_tabpage(picker_tab); return end
	vim.cmd("tabnew")
	picker_tab = vim.api.nvim_get_current_tabpage()
	require("pi-integration.overview").open(M.config)
end
local function acquire_control(takeover, captured, on_control)
	if not same_context(captured) or captured.controller ~= (current_controller() and current_controller().grantId) then
		notify("Attachment/controller changed; request control again for this session."); return
	end
	command(takeover and "control.takeover" or "control.acquire", takeover and { confirmed = true } or {}, function(ok)
		if not ok or not same_context(captured) then return end
		request("grant", {}, function(found, value)
			if not found or not same_context(captured) or value == vim.NIL then return end
			grant = value
			request("snapshot", {}, function(synced, value_snapshot)
				if not synced or not same_context(captured) then return end
				apply_snapshot(value_snapshot)
				if not same_context(captured) then notify("Session runtime changed; select the action again."); return end
				if on_control and control_current() then on_control() end
			end)
		end)
	end)
end
function M.take_control(takeover)
	local captured = stamp()
	if takeover then vim.ui.select({ "Cancel", "Take over" }, { prompt = "Replace the current controller? Accepted work continues." }, function(choice)
		if choice == "Take over" then acquire_control(true, captured) end
	end)
	else acquire_control(false, captured) end
end
-- Overview actions attach locally, then ask explicitly for authority. Every
-- deferred choice stays bound to this selection, runtime and observed controller.
function M.overview_control(entry, action, argument)
	local host = require("pi-integration.service-hosts").find(entry.host_id)
	if not host or not host.connected then return nil, "Host disconnected; mutations disabled" end
	local supported = { cycle_access_mode = true, set_access_mode = true, cycle_integration_mode = true,
		set_integration_mode = true, toggle_notifications = true, kill = true }
	if not supported[action] then return nil, "Unsupported overview action" end
	local connection = host.connection
	local function ready()
		local controller = current_controller()
		if host.connection ~= connection or not host.connected or M.config.expected_host ~= entry.host_id
			or session_id ~= entry.session_id or not snapshot or snapshot.serviceEpoch ~= entry.service_epoch
			or current_revision() ~= entry.runtime_revision
			or (controller and controller.grantId) ~= (entry.controller and entry.controller.grantId) then
			notify("Session/runtime/controller changed; select the action again."); return
		end
		local captured = stamp()
		local function execute()
			if not control_current() then return end
			local authorized = stamp()
			local operation, payload
			if action == "cycle_access_mode" then operation, payload = "access.cycle", { modes = M.config.access_modes }
			elseif action == "set_access_mode" then operation, payload = "access.set", { mode = argument }
			elseif action == "cycle_integration_mode" then operation, payload = "integration.cycle", { modes = M.config.integration_modes }
			elseif action == "set_integration_mode" then operation, payload = "integration.set", { mode = argument }
			elseif action == "toggle_notifications" then
				operation, payload = "notifications.set", { enabled = snapshot.conversation.statuses["pi-notifications"] ~= "notify on" }
			elseif action == "kill" then
				vim.ui.select({ "Cancel", "Kill session" }, { prompt = "Kill session on " .. host.alias .. "? Active work is interrupted; history/workspaces remain." }, function(choice)
					if choice == "Kill session" then command("session.kill", { confirmed = true }, nil, authorized, function(receipt)
						if receipt.status == "completed" then M.show_overview() end
					end) end
				end)
				return
			end
			command(operation, payload, nil, authorized)
		end
		if control_current() then execute(); return end
		local choice = controller and "Take over" or "Acquire control"
		vim.ui.select({ "Cancel", choice }, { prompt = choice .. " for this session on " .. host.alias .. " before " .. action .. "? Accepted work continues." }, function(selected)
			if selected ~= choice then return end
			if host.connection ~= connection or not host.connected or not same_context(captured)
				or captured.controller ~= (current_controller() and current_controller().grantId) then
				notify("Attachment/controller changed; select the action again."); return
			end
			-- This choice is the explicit takeover confirmation, not a silent steal.
			acquire_control(controller ~= nil, captured, execute)
		end)
	end
	M.select_owner(require("pi-integration.service-hosts").target(host), entry.session_id, false, nil, ready)
	return true
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
			if choice == "Allow a new host request" and pending_host == envelope then pending_host, pending_host_select = nil, nil end
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
			local decoded_ok, description = pcall(vim.json.decode, request_data.title or "")
			local review_id = not cancel and answer_value and answer_value.value == "Review / modify"
				and decoded_ok and type(description) == "table" and description.kind == "pi_compact_select"
				and description.preview_kind == "workspace_summary" and snapshot.workspace and snapshot.workspace.id
			command(cancel and "interaction.cancel" or "interaction.respond", cancel and { requestId = request_data.id } or { requestId = request_data.id, answer = answer_value }, function(ok)
				if ok and review_id and same_context(captured) then open_workspace_review(review_id) end
			end, captured)
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
function M.pick_session() require("pi-integration.service-hosts").history_picker() end
function M.new_session() require("pi-integration.service-hosts").new_conversation() end
function M.change_cwd() M.new_session() end
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
function M.new_session_window() M.new_session() end
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
local function native_draft(operation, initial)
	local captured, accepted_text = stamp(), nil
	local buf = draft_buffer("pi://" .. operation .. "/" .. uid(), initial or "", function(buf)
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
	owner_resources().bind(buf)
end
function M.steer(initial)
	if not snapshot or not snapshot.conversation.execution.running then notify("Steering requires an active turn."); return end
	native_draft("steering.submit", initial)
end
function M.follow_up() native_draft("followUp.submit") end
function M.side_prompt() native_draft("side.prompt") end
function M.toggle_side()
	if not valid(side_buf) then side_buf = draft_buffer("pi://side-owner/" .. uid(), "")
	elseif vim.fn.bufwinid(side_buf) == -1 then
		vim.cmd("botright split")
		vim.api.nvim_win_set_buf(0, side_buf)
	else vim.api.nvim_set_current_win(vim.fn.bufwinid(side_buf)) end
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
		vim.ui.select({ "Artifacts", "Inspect", "Join", "Stop" }, { prompt = run.runId }, function(action)
			if not same_context(captured) then return end
			if action == "Artifacts" then require("pi-integration.spawn-artifacts").pick_run({ state = state, ui = { notify = notify }, resources = owner_resources() }, run, function() end)
			elseif action == "Inspect" then draft_buffer("pi://owner-spawn/" .. uid(), vim.inspect(run))
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
open_workspace_review = function(workspace_id, pinned)
	require("pi-integration.service-review").open({ resource = owner_resources(), owner = hello and hello.hostId, channel = hello and hello.channel,
		request = request, stamp = stamp,
		current = function(s) return job and attachment and same_context(s) end,
		control_stamp = stamp, command = command, draft = draft_buffer, notify = notify }, workspace_id, pinned)
end
function M.show_workspace_diff() open_workspace_review() end
function M.pick_workspace_reviews()
	local captured = stamp()
	request("resource.read", { kind = "workspaceReviews", runtimeRevision = captured.revision }, function(ok, result)
		if not job or not same_context(captured) then return end
		if not ok then notify(result.message or "Owner workspace reviews unavailable"); return end
		vim.ui.select(result.data.entries or {}, { prompt = "Owner workspace reviews", format_item = function(item) return tostring(item.label or item.id) .. " (" .. tostring(item.lifecycle) .. ")" end }, function(item)
			if item and same_context(captured) then open_workspace_review(item.id) end
		end)
	end)
end
function M.show_usage()
	local function inspect() owner_read("stats", function(data)
		draft_buffer("pi://owner-usage/" .. uid(), vim.inspect({ session = data, codex = status_data("pi-codex-usage") }))
	end) end
	if control_current() then command("usage.refresh", {}, nil, stamp(), inspect) else inspect() end
end
function M.show_tree()
	local captured = stamp()
	vim.ui.select({ "Transcript (all branches)", "Tree actions" }, { prompt = "Owner history" }, function(choice)
		if not same_context(captured) then return end
		if choice == "Transcript (all branches)" then M.show_owner_transcript()
		elseif choice == "Tree actions" then M.show_tree_actions() end
	end)
end
function M.show_tree_actions()
	owner_read("entries", function(data, captured)
		vim.ui.select(data.entries, { prompt = "Owner history (all branches)", format_item = function(entry)
			return entry.id .. " " .. entry.type .. " " .. (entry.message and entry.message.role or entry.customType or "")
		end }, function(entry)
			if not entry or not same_context(captured) then return end
			vim.ui.select({ "Inspect", "Jump", "Jump with summary", "Clone through entry", "Delete subtree", "Fork before user message" }, { prompt = entry.id }, function(action)
				if not same_context(captured) then return end
				if action == "Inspect" then
					require("pi-integration.spawn-transcript").open({ state = state, ui = { notify = notify }, window = { parent = state.transcript_win }, resources = owner_resources() }, nil,
						"Owner history entry " .. entry.id, { kind = "history" }, vim.json.encode(entry))
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
	draft_buffer("pi://service-help/" .. uid(), "# Local service attachment\n\n:PiControl / :PiTakeover / :PiRelease\n:PiPending (inspect; Enter explicitly answers; closing never cancels)\n:PiQueue (shared editable queue; :write saves; pauses expire after 30s)\n:PiFollowUp / steering shortcut (separate native queues)\n:PiWorkspace (owner enter/integrate/discard, with existing confirmations)\n:PiWorkspaceReview / :PiWorkspaceReviews (owner diffs; summary S/U stage/unstage all; file s/u index actions, X confirmed baseline restore; all mutations require control; gO inspects owner content, gS original command)\n:PiSidePrompt / :PiSideNew / :PiSideAbort\n:PiRetitle / :PiOperations (typed outcomes and recovery text)\n:PiSubmissions / :PiHostRequest (uncertain IDs; never replayed)\n:PiSessions (owner archive/unarchive/delete, with workspace warnings)\n:PiSavedOperations (original saved-session IDs; status only)\n:PiOffers / :PiDrafts (inspect-only)\n:PiDetach / :PiReconnect\n:PiKill (kill session and close; preserves local drafts)\n:PiConsoleRestart is frontend-only. The restart shortcut restarts the owner session.\n\n<C-CR> submits text or ! / !! shell on OWNER; <Esc><Esc> aborts.\nSettings/model/thinking/history and the command picker use typed owner operations.\n:PiHosts / <leader>ph: saved owners, connect/retry/disconnect/edit/forget.\n:PiOverview / <leader>po: combined overview, groups and pins.\n:PiNew: choose owner and browse its directories.\n:PiTranscript: managed owner history (all branches, read-only).\nTranscript Enter inspects owner thinking/tools/skills/artifacts and file links; @ completion uses owner cwd.\nPaged text: n next / p first / r reload. Skill f reads the current owner file.\nFreeform slash commands and excluded resource actions never use a local or raw RPC fallback.\nService stop/restart remains separate: pi-console server stop/restart [--force].")
end
function M.open_transcript_item()
	local resource = owner_resources()
	if require("pi-integration.utils.markdown-links").follow(nil, resource) then return end
	local item = transcript.transcript_item_at_line(ctx, vim.api.nvim_win_get_cursor(0)[1])
	if not item then return end
	local inspect_ctx = { state = state, ui = { notify = notify }, window = { parent = state.transcript_win }, resources = resource }
	if item.kind == "tool_group" then require("pi-integration.tool-groups").toggle(ctx, item); render()
	elseif item.kind == "tool" then require("pi-integration.tool-output").open_float(inspect_ctx, item.output_id)
	elseif item.kind == "thinking" then require("pi-integration.thinking-output").open_float(inspect_ctx, item.output_id)
	elseif item.kind == "compaction" then require("pi-integration.compaction-output").open_float(inspect_ctx, item)
	elseif item.kind == "skill" then require("pi-integration.skills").open_float(inspect_ctx, item.output_id)
	else unavailable("This transcript action") end
end
function M.show_owner_transcript()
	require("pi-integration.spawn-transcript").open({ state = state, ui = { notify = notify }, window = { parent = state.transcript_win }, resources = owner_resources() }, nil, "Owner history (all branches)", { kind = "history" })
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
			for _, draft in ipairs(value.drafts or {}) do
				draft = vim.tbl_extend("force", draft, { name = "pi://recovered/" .. uid() })
				recovered_draft(draft)
			end
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
function M.follow_markdown_link()
	local buf = vim.api.nvim_get_current_buf()
	local owner = resources.for_buffer(buf)
	local resource = owner and owner.resource or (buf == state.transcript_buf or buf == state.input_buf or buf == side_buf) and owner_resources() or nil
	return require("pi-integration.utils.markdown-links").follow(nil, resource)
end
function M.show_logs() require("pi-integration.logs").show(ctx) end
function M.restore_status_footer() statusline.update(ctx) end
function M.get_commands(callback) callback({}) end
function M.on_transcript_rendered() end
function M.maybe_prompt_session_archive() end
function M.setup(config)
	M.config = vim.tbl_extend("force", M.config, config or {}, { service_root = vim.env.PI_CONSOLE_SERVICE_ROOT,
		service_remote = vim.env.PI_CONSOLE_SERVICE_REMOTE, credential_file = vim.env.PI_CONSOLE_SERVICE_CREDENTIAL_FILE,
		ca_file = vim.env.PI_CONSOLE_SERVICE_CA_FILE })
	assert(not M.config.service_remote or (M.config.credential_file and not M.config.service_root), "Remote attachment requires a credential file and no local root")
	assert(not M.config.service_remote or (M.config.service_remote:match("^https://[^/?#@%s]+/?$")
		and not M.config.service_remote:find("[%c]")), "Remote endpoint must be an HTTPS origin without credentials, path, query or fragment")
	ctx.config = M.config
end
function M.open(_, restore)
	invocation_cwd = vim.fn.getcwd()
	if restore then
		M.config.start_view = restore.view ~= "conversation" and restore.view or nil
		assert(restore.expected_host or (restore.service_remote == M.config.service_remote and restore.credential_file == M.config.credential_file
			and restore.ca_file == M.config.ca_file), "Restart target differs from explicit attachment; refusing to restore execution identities")
		if restore.expected_host then
			M.config.service_remote, M.config.credential_file, M.config.ca_file = restore.service_remote, restore.credential_file, restore.ca_file
		end
		session_id, pending_host = restore.service_session, restore.pending_host
		pending_host_select = restore.pending_host_select == true
		unresolved, initial_attempted = restore.unresolved or {}, restore.initial_attempted
		submission_status = restore.submission_status or {}
		if restore.expected_host then M.config.service_root = restore.service_root
		else M.config.service_root = restore.service_root or M.config.service_root end
		M.config.expected_host = restore.expected_host
		owner_states = restore.owner_states or {}
	else session_id, resume_requested = vim.env.PI_CONSOLE_SERVICE_SESSION, vim.env.PI_CONSOLE_SERVICE_RESUME == "1" end
	ctx.session.setup_keymaps = function()
		local actions = setmetatable({ open_transcript_item = M.open_transcript_item }, { __index = M })
		require("pi-integration.keymaps").setup({ state = state, actions = actions, buffer = ctx.buffer,
			ui = { notify = notify }, transcript = { open_item_under_cursor = M.open_transcript_item }, service_mode = true })
	end
	statusline.setup(ctx)
	if restore or not M.config.start_view then
		conversation_tab = vim.api.nvim_get_current_tabpage()
		layout.open(ctx)
	end
	if restore then
		layout.set_buffer_lines(ctx, state.input_buf, restore.input_lines or { "" }, true)
		for _, draft in ipairs(restore.drafts or {}) do recovered_draft(draft) end
	end
	for name, fn in pairs({ PiControl = function() M.take_control(false) end, PiTakeover = function() M.take_control(true) end,
		PiRelease = function() command("control.release", {}) end, PiPending = M.restore_pending_action, PiQueue = M.pick_queue,
		PiOffers = M.show_offers, PiDrafts = M.show_drafts, PiSubmissions = M.show_submissions, PiDetach = M.detach, PiReconnect = M.reconnect,
		PiFollowUp = M.follow_up, PiSidePrompt = M.side_prompt, PiSideNew = M.new_side, PiSideAbort = M.abort_side,
		PiSavedOperations = require("pi-integration.service-hosts").saved_operations,
		PiHosts = M.pick_hosts, PiOverview = M.show_overview, PiSessions = M.pick_session, PiNew = M.new_session, PiTranscript = M.show_owner_transcript,
		PiWorkspaceReview = M.show_workspace_diff, PiWorkspaceReviews = M.pick_workspace_reviews,
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
		publish_attachment()
		if control_current() then
			local captured = stamp()
			request("heartbeat", { controlToken = grant.token }, function(ok)
				if not ok and current(captured) then grant = nil; close_approval(); render() end
			end)
		end
	end))
	local tmux = require("pi-integration.backends.tmux")
	if tmux.available() then tmux.mark_service_frontend() end
	publish_attachment()
	require("pi-integration.service-hosts").start()
	if M.config.start_view then
		if restore then vim.cmd("tabnew") end
		picker_tab = vim.api.nvim_get_current_tabpage()
		require("pi-integration." .. M.config.start_view).open(M.config)
		if restore and session_id then connect() end
	-- The launcher retains --new across frontend restarts. A restored owner
	-- selection or unresolved host request takes precedence over that startup flag.
	elseif vim.env.PI_CONSOLE_SERVICE_NEW == "1" and not (restore and (session_id or pending_host)) then
		vim.env.PI_CONSOLE_SERVICE_NEW = nil
		M.new_session()
	else connect() end
end
for _, name in ipairs({ "restore_session_transcript",
	"start", "refresh_session_stats", "fail_pending_prompts", "flush_queued_prompts", "finish_loading_if_ready" }) do
	M[name] = function() unavailable(name) end
end
vim.api.nvim_create_autocmd("VimLeavePre", { callback = function()
	if heartbeat then heartbeat:stop(); heartbeat:close(); heartbeat = nil end
	backup()
	M.detach()
	local tmux = require("pi-integration.backends.tmux")
	if tmux.available() then tmux.clear() end
end })
return M
