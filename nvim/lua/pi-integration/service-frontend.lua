-- Attachments own UI/drafts only. Typed lifecycle requests execute on the owner.
local M = { config = { access_modes = { "readonly", "ask", "edit", "full" },
	integration_modes = { "ask", "allowed" } } }
local tree = require("pi-integration.tree")
local layout = require("pi-integration.layout")
local messages = require("pi-integration.messages")
local transcript = require("pi-integration.transcript")
local statusline = require("pi-integration.statusline")
local buffer = require("pi-integration.utils.buffer")
local state = require("pi-integration.state").new()
local resources = require("pi-integration.service-resources")
local pending_picker = require("pi-integration.pending-picker")
local feedback_ui = require("pi-integration.service-feedback")
local feedback = {}
state.show_nested_tools = true
local session_id, attachment, snapshot, hello, grant, job
local authority
local session_status, session_error, recovery_requested
local callbacks, unresolved, offers, drafts = {}, {}, {}, {}
local outcomes = {}
local submission_status = {}
local pending_host, pending_host_select, resume_requested
local generation, counter, refresh_scheduled, refreshing, dirty = 0, 0, false, false, false
local selection = 0
local approval_win, approval_request, heartbeat
local approval_context, pending_context
local pending_seen, pending_replies = {}, {}
local ctx, sync_pending
local recovery_id, backup_scheduled, restarting_frontend
local render, refresh, connect, attach, recover_selection, tree_ctx, advance_start, host_options, backup
local side_buf
local owner_states, pending_settings = {}, {}
local selected_cwd, starting, new_control_selection, startup_options
local frontend_focused = false
local function status_data(key)
	local raw = snapshot and snapshot.conversation.statuses[key]
	local ok, value = pcall(vim.json.decode, raw or "")
	return ok and value or nil
end
local function publish_attachment()
	local tmux = require("pi-integration.backends.tmux")
	if M.config.role ~= "conversation" or not tmux.available() then return end
	if frontend_focused then state.seen_seq = state.completion_seq end
	local pi_state = snapshot and snapshot.piState or {}
	local name = pi_state.sessionName ~= "" and pi_state.sessionName or "New Session"
	local label = status_data("pi-session-label")
	local slug = type(label) == "table" and label.sessionFile == pi_state.sessionFile and label.title == pi_state.sessionName
		and type(label.slug) == "string" and label.slug ~= "" and label.slug or "new-session"
	local identity = M.config.expected_host or "unknown"
	local status = "Loading"
	if not session_id then status = starting and "Starting" or "Unstarted"
	elseif not job then status = "Disconnected"
	elseif not attachment then status = hello and (session_status or "Unattached") or "Connecting"
	elseif snapshot and snapshot.phase == "stopped" then status = "Stopped"
	elseif snapshot and snapshot.phase == "failed" then status = "Error"
	elseif snapshot and snapshot.phase == "stopping" then status = "Stopping"
	elseif snapshot then
		local pending = false
		for _, item in ipairs(snapshot.interactions.pending) do if not item.submitted then pending = true end end
		status = snapshot.error and "Error" or pending and "Waiting"
			or snapshot.piState and snapshot.piState.isCompacting and "Compacting"
			or snapshot.conversation.execution.running and "Working"
			or snapshot.phase == "ready" and (state.completion_seq > state.seen_seq and "Done" or "Idle") or "Loading"
	end
	tmux.publish({ version = 1, frontend_attachment = true, host_id = identity, session_id = session_id,
		pid = vim.uv.os_getpid(), updated = os.time(), cwd = vim.fn.getcwd(),
		title = name, slug = slug,
		status = status, last_focused_at = state.last_focused_at })
end
local function owner_key() return M.config.expected_host or M.config.service_remote or M.config.service_root or "local" end
local function owner_label(identity, remote, root)
	local host = identity and require("pi-integration.service-hosts").find(identity)
	return host and host.alias or remote or root or "Local owner"
end
local function current_owner_label()
	return owner_label(M.config.expected_host, M.config.service_remote, M.config.service_root)
end

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
local scratch_sequence = 0
local function scratch_name(kind)
	scratch_sequence = scratch_sequence + 1
	return "pi://" .. kind .. "/" .. scratch_sequence
end
local function preview(value)
	return (tostring(value or ""):gsub("%s+", " ")):sub(1, 100)
end
local function fields(lines, data, names)
	if type(data) ~= "table" then return end
	for _, field in ipairs(names) do
		local value = data[field[1]]
		if value ~= nil and value ~= vim.NIL then
			table.insert(lines, "## " .. field[2])
			vim.list_extend(lines, vim.split(tostring(value), "\n", { plain = true }))
			table.insert(lines, "")
		end
	end
end
local function operation_label(receipt)
	local envelope = unresolved[receipt.id]
	local payload = envelope and envelope.payload or {}
	local label = tostring(receipt.operation or "Operation") .. " - " .. tostring(receipt.status or "outcome unknown")
	local detail = payload.text or payload.command or payload.title or payload.path or payload.cwd
	return detail and (label .. ": " .. preview(detail)) or label
end
local function operation_summary(envelope, receipt)
	local lines = { "# Owner operation", "", "Inspect only. Work is never replayed automatically.", "" }
	fields(lines, envelope, { { "operation", "Operation" } })
	fields(lines, envelope and envelope.payload, {
		{ "text", "Submitted text" }, { "command", "Shell command" }, { "title", "Session name" },
		{ "cwd", "Directory" }, { "path", "Path" }, { "instructions", "Instructions" },
		{ "mode", "Mode" }, { "provider", "Provider" }, { "modelId", "Model" },
		{ "level", "Thinking level" }, { "enabled", "Enabled" }, { "excludeFromContext", "Excluded from context" },
	})
	local payload = envelope and envelope.payload
	fields(lines, payload and payload.answer, { { "value", "Answer" }, { "confirmed", "Confirmed" } })
	for _, path in ipairs(payload and payload.ignoredFiles or {}) do table.insert(lines, "Included ignored path: " .. path) end
	fields(lines, receipt, { { "operation", "Operation" }, { "status", "Outcome" }, { "message", "Status unavailable" } })
	fields(lines, receipt and receipt.error, { { "code", "Error" }, { "message", "Details" } })
	local result = receipt and receipt.result
	fields(lines, result, {
		{ "title", "Session name" }, { "status", "Result" }, { "disposition", "Disposition" },
		{ "delivery", "Delivery" }, { "mode", "Mode" }, { "enabled", "Enabled" },
		{ "changed", "Changed" }, { "lifecycle", "Workspace status" }, { "integration", "Integration" },
		{ "exitCode", "Exit code" }, { "cancelled", "Cancelled" }, { "idle", "Idle" },
		{ "resourcePath", "File" }, { "submittedText", "Submitted text" },
		{ "queueItemText", "Queue text" }, { "editorText", "Recovered editor text" },
	})
	if result and result.sessionId then table.insert(lines, "Session available on owner; select it in :PiSessions.") end
	if result and result.resourceId then table.insert(lines, "Owner file version saved.") end
	for _, kind in ipairs({ "steering", "followUp" }) do
		for _, value in ipairs(result and result.cleared and result.cleared[kind] or {}) do
			fields(lines, { text = value }, { { "text", "Cleared " .. kind .. " text" } })
		end
	end
	fields(lines, result and result.reviewRecovery, {
		{ "path", "Restore recovery path" }, { "existed", "Previously existed" },
		{ "mode", "Original file mode" }, { "encoding", "Recovery encoding" }, { "content", "Original file contents" },
	})
	if receipt and receipt.recoveryAvailable then table.insert(lines, "Full recovery text is available through the original operation lookup.") end
	if not receipt then table.insert(lines, "Outcome unknown; original request remains protected.") end
	return table.concat(lines, "\n")
end
local function queue_summary(item)
	local lines = { "# Accepted queue item", "" }
	fields(lines, item, { { "status", "Status" }, { "revision", "Revision" }, { "text", "Text" } })
	fields(lines, item.error, { { "message", "Error" } })
	return table.concat(lines, "\n")
end
local function run_label(run)
	return tostring(run.agent ~= vim.NIL and run.agent or run.role ~= vim.NIL and run.role or "Subagent")
		.. " - " .. tostring(run.status) .. " - " .. tostring(run.startedAt or "") .. ": " .. preview(run.prompt)
end
local function unavailable(name)
	notify(name .. " is unavailable on this service path. No local/RPC fallback was executed.", vim.log.levels.WARN)
end
local function text_submission(operation)
	return operation == "prompt.submit" or operation == "shell.run" or operation == "steering.submit" or operation == "followUp.submit" or operation == "side.prompt"
end
local function fail_start(message)
	if not starting then return end
	if starting.entry then
		starting.entry.status, starting.entry.error = "Not sent", message
	end
	starting = nil
	notify(message)
	if render then render() end
end
local function close_approval()
	approval_request, approval_context = nil, nil
	if ctx then pending_picker.clear(ctx, false) end
	if approval_win and vim.api.nvim_win_is_valid(approval_win) then vim.api.nvim_win_close(approval_win, true) end
	approval_win = nil
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
	if not authority or authority.epoch ~= value.serviceEpoch or authority.revision ~= value.runtimeRevision then
		resources.invalidate()
		if authority then tree.close(tree_ctx) end
	end
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
	-- Delete completion only triggers a fresh read, never a mutation or editor effect.
	if outcome.history_refresh then return same_selection(outcome.captured) end
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
		label = current_owner_label() .. "/" .. tostring(hello and hello.channel or ""),
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
	local label = "[" .. current_owner_label() .. "] " .. intent.title
	notify(intent.title)
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
local function command(operation, payload, callback, captured, terminal, submission)
	if not snapshot or not attachment then notify("Attach to a live session first."); return end
	if not hello or not vim.tbl_contains(hello.capabilities or {}, operation) then unavailable(operation); return end
	if captured and not current(captured) then notify("Stale editor/dialog; its text remains a local draft.", vim.log.levels.WARN); return end
	if not operation:match("^control%.") and not control_current() then notify("Viewer: use :PiControl first.", vim.log.levels.WARN); return end
	local envelope = { version = 1, id = uid(), sessionId = session_id, serviceEpoch = snapshot.serviceEpoch,
		runtimeRevision = current_revision(), operation = operation, payload = object_payload(payload) }
	if operation ~= "control.acquire" and operation ~= "control.takeover" then envelope.controlToken = grant and grant.token end
	unresolved[envelope.id] = envelope -- Diagnostic identity only, never replayed.
	if terminal then outcomes[envelope.id] = { callback = terminal, captured = captured or stamp(), lifecycle = operation == "session.kill", transition = operation == "history.navigate", history_refresh = operation == "history.delete" } end
	if feedback_ui.tracks(operation) then
		local entry = submission and submission.entry
		local input_buf = submission and submission.input_buf
		entry = entry or feedback_ui.add(feedback, envelope.id, operation, envelope.payload, session_id,
			snapshot.serviceEpoch, current_revision())
		entry.id, entry.sessionId, entry.serviceEpoch, entry.runtimeRevision = envelope.id, session_id, snapshot.serviceEpoch, current_revision()
		entry.status, entry.sent = "Sending", true
		local keys = snapshot.conversation.messageKeys or {}
		entry.timeline = (#keys > 0 or #snapshot.conversation.messages == 0)
			and { afterMessage = keys[#keys] or vim.NIL } or nil
		if valid(input_buf) then
			layout.set_buffer_lines(ctx, input_buf, { "" }, true)
			vim.bo[input_buf].modified = false
		end
		render()
		transcript.scroll_to_bottom_unless_focused(ctx)
		vim.cmd("redraw")
		if not backup() then
			entry.status, entry.error, entry.sent = "Not sent", "Local recovery could not be saved. No command was sent.", false
			unresolved[envelope.id], outcomes[envelope.id] = nil, nil
			render()
			return
		end
	end
	request("command", envelope, function(ok, result)
		feedback_ui.receipt(feedback, envelope.id, ok, result)
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
		render()
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
	local buf = draft_buffer(scratch_name("recovered"), draft.text)
	if draft.endofline ~= nil then vim.bo[buf].endofline, vim.bo[buf].fixendofline = draft.endofline, false end
	vim.b[buf].pi_review_command_id, vim.b[buf].pi_review_command_epoch = draft.review_command_id, draft.review_command_epoch
	vim.b[buf].pi_review_host, vim.b[buf].pi_review_session, vim.b[buf].pi_review_channel = draft.review_host, draft.review_session, draft.review_channel
	if draft.review_command_id and draft.review_command_epoch then
		vim.keymap.set("n", "gS", function()
			if not draft.review_host or not draft.review_session or session_id ~= draft.review_session or not hello
				or hello.hostId ~= draft.review_host or hello.channel ~= draft.review_channel then
				notify("Attach to the original review session on " .. owner_label(draft.review_host) .. " before status lookup."); return
			end
			request("command.status", { serviceEpoch = draft.review_command_epoch, commandId = draft.review_command_id }, function(ok, result)
				if ok then draft_buffer(scratch_name("review-save-receipt"), operation_summary(nil, result)) else notify(result.message or "Save status unavailable; original identity retained.") end
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
		service_remote = M.config.service_remote,
		expected_host = M.config.expected_host, owner_states = owner_states,
		selected_cwd = selected_cwd, pending_settings = pending_settings, feedback = feedback,
		role = M.config.role,
		host = hello and hello.hostId, channel = hello and hello.channel, saved_at = os.date("!%Y-%m-%dT%H:%M:%SZ"),
		input_lines = valid(state.input_buf) and vim.api.nvim_buf_get_lines(state.input_buf, 0, -1, false) or { "" },
		unresolved = unresolved, submission_status = submission_status, pending_host = pending_host, pending_host_select = pending_host_select,
		drafts = saved_drafts }
end
backup = function()
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
ctx = { state = state, config = M.config,
	ui = { notify = notify }, logs = { add = function(_, message, details) notify(message .. ": " .. tostring(details), vim.log.levels.ERROR) end },
	notices = { empty_session = "Send a message to begin. This session will be saved after the first response." },
	buffer = { valid = valid, set_modifiable = function(buf, value) vim.bo[buf].modifiable = value end },
	session = { setup_keymaps = function() end }, transcript = {} }
ctx.transcript.win_valid = function()
	state.transcript_win = buffer.find_window(state.transcript_buf, state.transcript_win)
	return state.transcript_win ~= nil
end
ctx.transcript.refresh_ui = function()
	if approval_request and not state.pending_ui_requests[approval_request] then
		approval_request, approval_context = nil, nil
	end
	statusline.update(ctx)
	transcript.render(ctx)
	if sync_pending then vim.schedule(sync_pending) end
end
local function update_status_state()
	local defaults = not session_id and startup_options and startup_options.defaults or {}
	local conversation = snapshot and snapshot.conversation
	local statuses = conversation and conversation.statuses or {}
	local pi_state = snapshot and snapshot.piState or {}
	local execution = conversation and conversation.execution or {}
	state.session_name = pi_state.sessionName ~= "" and pi_state.sessionName or nil
	state.session_id = session_id
	state.session_cwd = snapshot and snapshot.interactions.runtime and snapshot.interactions.runtime.cwd or selected_cwd
	state.host_name = current_owner_label()
	state.connection_status = job and (hello and "connected" or "connecting") or "disconnected"
	local terminal = snapshot and (snapshot.phase == "stopped" or snapshot.phase == "failed") and snapshot.phase
	state.client_status = attachment and (terminal and ("session " .. terminal) or control_current() and "active" or "view only")
		or (session_id and ("session " .. (session_status or "unattached")) or starting and "starting" or "unstarted")
	state.access_mode = (statuses["pi-access-mode"] or ""):match("^Mode: (%w+)$") or defaults.accessMode
	state.integration_mode = (statuses["pi-integration-mode"] or ""):match("^Integration: (%w+)$") or defaults.integrationMode
	state.notification_status = statuses["pi-notifications"]
	if not state.notification_status and defaults.notificationsEnabled ~= nil then
		state.notification_status = defaults.notificationsEnabled and "notify on" or "notify off"
	end
	state.workspace = snapshot and snapshot.workspace or (not session_id and { localCheckout = true, cwd = selected_cwd } or nil)
	local model = pi_state.model or defaults.model
	state.provider = model and model.provider
	state.model_id = model and model.id
	state.thinking_level = pi_state.thinkingLevel or defaults.thinkingLevel
	state.model_status = not session_id and (defaults.modelStatus or (not startup_options and "loading" or nil)) or nil
	local context_window = defaults.contextWindow
	if pending_settings["access.set"] then state.access_mode = pending_settings["access.set"].mode end
	if pending_settings["integration.set"] then state.integration_mode = pending_settings["integration.set"].mode end
	if pending_settings["notifications.set"] then state.notification_status = pending_settings["notifications.set"].enabled and "notify on" or "notify off" end
	if pending_settings["model.set"] then
		local pending = pending_settings["model.set"]
		if pending.provider ~= state.provider or pending.modelId ~= state.model_id then state.thinking_level = nil end
		state.provider, state.model_id = pending.provider, pending.modelId
		state.model_status = nil
		context_window = nil
		for _, option in ipairs(startup_options and startup_options.models or {}) do
			if option.provider == pending.provider and option.id == pending.modelId then
				context_window = option.contextWindow
				break
			end
		end
	end
	if pending_settings["thinking.set"] then state.thinking_level = pending_settings["thinking.set"].level end
	state.session_stats = conversation and conversation.stats
	if not session_id then
		state.session_stats = { tokens = { input = 0, output = 0 }, cost = 0,
			contextUsage = { tokens = 0, contextWindow = context_window or vim.NIL } }
	end
	state.codex_usage = status_data("pi-codex-usage")
	local spawns = status_data("pi-spawn-runs")
	state.spawn_running_count = spawns and spawns.running or 0
	state.is_loading = job ~= nil and (not hello or session_status == "checking" or session_status == "attaching"
		or session_status == "restoring" or attachment ~= nil and snapshot and snapshot.phase == "initializing")
	state.is_agent_running = attachment ~= nil and (execution.running == true or pi_state.isCompacting == true)
	state.is_streaming = attachment ~= nil and pi_state.isStreaming == true
	state.is_retrying = attachment ~= nil and execution.retry and execution.retry.type == "auto_retry_start" or false
	state.activity_label = pi_state.isCompacting and "compacting" or "work"
	state.pending_user_messages = snapshot and snapshot.acceptedQueue.items or {}
	local previous = state.pending_ui_requests
	state.pending_ui_requests, state.active_ui_request_id = {}, nil
	for _, item in ipairs(snapshot and snapshot.interactions.pending or {}) do
		if not item.submitted and not pending_replies[item.request.id] then
			local id = item.request.id
			state.pending_ui_requests[id] = previous[id] or { label = item.request.method, hidden = true }
			state.active_ui_request_id = state.active_ui_request_id or id
		end
	end
	if approval_request and state.pending_ui_requests[approval_request] then state.active_ui_request_id = approval_request end
end
ctx.transcript.metadata_lines = function() return transcript.metadata_lines(ctx) end
render = function()
	if not valid(state.transcript_buf) then return end
	local conversation = snapshot and snapshot.conversation
	update_status_state()
	layout.update_input_sidebar(ctx)
	local visible = feedback_ui.timeline_messages(feedback, session_id, snapshot)
	require("pi-integration.tool-output").reset(state)
	require("pi-integration.thinking-output").reset(state)
	require("pi-integration.skills").reset(state)
	local lines, items = messages.collect_message_lines(ctx, visible, conversation and conversation.tools)
	if snapshot and snapshot.error then
		messages.append_error(lines, snapshot.error, true)
	end
	if not attachment and session_error then messages.append_error(lines, session_error, true) end
	if valid(side_buf) then
		local side = status_data("pi-side")
		local side_lines = { "# Side conversation on owner", "", "Local draft: :PiSidePrompt. :PiSideNew resets; :PiSideAbort stops.", "" }
		if side then
			table.insert(side_lines, side.running and "Working" or "Idle")
			for _, message in ipairs(side.messages or {}) do
				table.insert(side_lines, "## " .. tostring(message.role))
				if type(message.content) == "string" then vim.list_extend(side_lines, vim.split(message.content, "\n", { plain = true }))
				else for _, block in ipairs(message.content or {}) do
					local content = block.text or block.thinking
					if not content and block.type == "toolCall" then
						content = "Tool: " .. tostring(block.name) .. "\n" .. vim.json.encode(block.arguments or {})
					end
					vim.list_extend(side_lines, vim.split(content or ("[" .. tostring(block.type or "Content") .. "]"), "\n", { plain = true }))
				end end
				if message.errorMessage or message.stopReason == "error" or message.stopReason == "aborted" then
					messages.append_error(side_lines,
						message.errorMessage or (message.stopReason == "aborted" and "Response aborted." or "Model request failed."),
						true, message.stopReason == "aborted" and "Aborted" or "Error")
				end
			end
			if side.partialMessage then
				for _, block in ipairs(side.partialMessage.content or {}) do vim.list_extend(side_lines, vim.split(block.text or block.thinking or "", "\n", { plain = true })) end
			end
			if side.error then messages.append_error(side_lines, side.error, true) end
		end
		layout.set_buffer_lines(ctx, side_buf, side_lines, false)
	end
	-- Every snapshot is a pure render; never invoke legacy event/effect handlers.
	local split = {}
	for _, line in ipairs(lines) do vim.list_extend(split, vim.split(line, "\n", { plain = true })) end
	transcript.preserve_view(ctx, function() buffer.update_lines(state.transcript_buf, split) end)
	transcript.apply_collected_transcript_items(ctx, items)
	transcript.render(ctx)
	transcript.scroll_to_bottom_unless_focused(ctx)
	statusline.update(ctx)
	publish_attachment()
	if sync_pending then vim.schedule(sync_pending) end
end
local function apply_snapshot(value)
	if value.sessionId ~= session_id then return end
	observe_authority(value, true)
	local previous = snapshot
	if not snapshot or value.serviceEpoch ~= snapshot.serviceEpoch or value.sequence >= snapshot.sequence then snapshot = value end
	local same_runtime = previous and previous.serviceEpoch == snapshot.serviceEpoch
		and previous.runtimeRevision == snapshot.runtimeRevision
	state.completion_seq = snapshot.conversation.execution.completionSeq or 0
	if not same_runtime then
		state.pending_transcript_scroll = nil
		-- Existing history on attach/reconnect or a replacement runtime is already seen.
		state.seen_seq = state.completion_seq
	end
	if grant and not control_current() then grant = nil; close_approval() end
	if approval_request then
		local live = false
		for _, item in ipairs(snapshot.interactions.pending) do if item.request.id == approval_request and not item.submitted then live = true end end
		if not live then close_approval() end
	end
	feedback_ui.reconcile(feedback, snapshot)
	render()
	if new_control_selection then
		local runtime = snapshot.interactions.runtime
		if not same_selection(new_control_selection) or current_controller() or snapshot.error then
			new_control_selection = nil
		elseif runtime and runtime.active and snapshot.piState and snapshot.piState.sessionId == runtime.sessionId
			and snapshot.piState.sessionFile == runtime.sessionFile then
			-- New allocates before Pi initializes. Send the first acquire only when
			-- its managed identity is available, including startup approvals.
			new_control_selection = nil
			M.take_control()
		end
	end
	-- History may arrive after the initial attachment snapshot.
	local initial_history = snapshot.conversation.hydrated and (not previous or not previous.conversation.hydrated)
	if initial_history or same_runtime and previous.conversation.execution.running and not snapshot.conversation.execution.running then
		transcript.scroll_to_bottom_unless_focused(ctx)
	end
	tree.update(tree_ctx)
	if advance_start then advance_start() end
end
refresh = function()
	dirty = true
	if refreshing or refresh_scheduled or not attachment or not job then return end
	refresh_scheduled = true
	local gen = generation
	vim.schedule(function()
		if gen ~= generation then return end
		refresh_scheduled = false
		if not attachment or not job then return end
		dirty, refreshing = false, true
		local target, selected = attachment, session_id
		request("snapshot", {}, function(ok, value)
			refreshing = false
			if ok and gen == generation and target == attachment and selected == session_id then apply_snapshot(value) end
			if dirty then refresh() end
		end)
	end)
end
local function disconnected()
	tree.close(tree_ctx)
	offers = {}
	resources.invalidate()
	generation = generation + 1
	job, attachment, grant, authority, hello, startup_options = nil, nil, nil, nil, nil, nil
	session_status, session_error = "unattached", nil
	feedback_ui.interrupt(feedback)
	callbacks, outcomes, new_control_selection, starting = {}, {}, nil, nil
	refreshing, refresh_scheduled, dirty = false, false, false
	close_approval()
	render()
end
attach = function(id, acquire_control)
	if not job then return end
	tree.close(tree_ctx)
	offers = {}
	if pending_host then pending_host_select = false end
	resources.invalidate()
	selection = selection + 1
	local gen, selected = generation, selection
	session_status, session_error = "attaching", nil
	render()
	request("attach", { sessionId = id, label = "Neovim " .. vim.fn.getpid() }, function(ok, value)
		if gen ~= generation or selected ~= selection then return end
		if not ok then
			fail_start("Startup attachment failed; submitted text remains in :PiDrafts.")
			session_status, session_error = "unavailable", value.message .. " Use :PiReconnect to retry or :PiSessions to explicitly reopen."
			render()
			return
		end
		session_status, session_error = nil, nil
		close_approval()
		session_id, attachment, grant, snapshot, authority = id, value.attachmentId, nil, nil, nil
		-- Only an explicitly completed New may acquire; attach/reconnect stays a viewer.
		if acquire_control then new_control_selection = stamp() end
		apply_snapshot(value.snapshot)
		local lookups, seen = {}, {}
		for command_id, envelope in pairs(unresolved) do
			if envelope.sessionId == id then
				table.insert(lookups, { id = command_id, epoch = envelope.serviceEpoch })
				seen[command_id] = true
			end
		end
		-- Completed receipts can fall outside the snapshot's recent-command
		-- window. Recover every retained send by its original identity, even
		-- when its admission acknowledgment already cleared `unresolved`.
		for _, entry in ipairs(feedback) do
			if entry.sessionId == id and entry.sent and not seen[entry.id] then
				table.insert(lookups, { id = entry.id, epoch = entry.serviceEpoch })
				seen[entry.id] = true
			end
		end
		local attached, next_lookup = attachment, 0
		local function lookup_next()
			if gen ~= generation or attached ~= attachment then return end
			next_lookup = next_lookup + 1
			local lookup = lookups[next_lookup]
			if not lookup then return end
			request("command.status", { serviceEpoch = lookup.epoch, commandId = lookup.id }, function(found, receipt)
				if gen ~= generation or attached ~= attachment then return end
				if found then
					feedback_ui.receipt(feedback, lookup.id, true, receipt, true)
					if unresolved[lookup.id] then
						submission_status[lookup.id] = receipt.status
						notify(operation_label(receipt) .. "; draft retained, not replayed. Review via :PiSubmissions.")
					end
					render()
					refresh()
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
	if pending_host then notify("Host request is unresolved. Inspect :PiHostRequest; it was not replayed."); return end
	local captured = stamp()
	local envelope = { id = uid(), serviceEpoch = hello.serviceEpoch, operation = operation, payload = payload }
	pending_host, pending_host_select = envelope, true
	if starting and starting.entry then starting.entry.hostRequest = envelope.id end
	session_status, session_error = "restoring", nil
	render()
	vim.cmd("redraw")
	if not backup() then
		pending_host, pending_host_select = nil, nil
		session_status, session_error = "unavailable", "Startup was not sent because local recovery could not be saved."
		fail_start(session_error)
		render()
		return
	end
	request("host.command", envelope, function(ok, receipt)
		if not ok and pending_host == envelope then
			fail_start("Startup did not complete; submitted text remains in :PiDrafts. Inspect :PiHostRequest before retrying.")
			if receipt.delivery == "not_sent" then pending_host, pending_host_select = nil, nil end
			if same_selection(captured) then
				session_status = "unavailable"
				session_error = receipt.delivery == "not_sent" and "Host request was not sent. Submit again to retry."
					or "Host request outcome unresolved. Inspect :PiHostRequest before retrying."
				render()
			end
			return
		end
		if ok and pending_host == envelope then
			pending_host, pending_host_select = nil, nil
			if receipt.result then
				if same_selection(captured) then
					session_id = receipt.result.sessionId
					feedback_ui.bind(feedback, envelope.id, session_id)
					backup()
					attach(session_id, operation == "host.create")
				else notify("Host request completed; select the session in :PiSessions. Current view was not changed.") end
			elseif receipt.error then
				fail_start("Startup failed; submitted text remains in :PiDrafts.")
				notify("Host request " .. receipt.status .. ": " .. receipt.error.message, vim.log.levels.WARN)
				if same_selection(captured) then
					session_status, session_error = "unavailable", receipt.error.message .. " Use :PiReconnect to retry or :PiSessions to explicitly reopen."
					render()
				end
			end
		end
	end)
end
recover_selection = function(allow_restore)
	local captured = stamp()
	session_status, session_error = "checking", nil
	render()
	request("sessions", {}, function(ok, value)
		if not same_selection(captured) then return end
		if not ok then
			session_status, session_error = "unavailable", value.message .. " Use :PiReconnect to retry."
		else
			local row
			for _, entry in ipairs(value.sessions or {}) do if entry.id == session_id then row = entry; break end end
			if row and not row.archived and not row.deleted then
				if row.state == "open" then attach(session_id); return end
				if row.state == "suspended" and allow_restore and vim.tbl_contains(hello.capabilities, "host.recover") then
					host_operation("host.recover", { sessionId = session_id }); return
				end
			end
			session_status = not row and "unavailable" or row.archived and "archived" or row.deleted and "deleted" or row.state
			session_error = "Session " .. session_status .. ". Use :PiSessions to inspect or explicitly reopen it."
		end
		render()
	end)
end
local function recover_host(allow_restore)
	if not pending_host then return false end
	local envelope, captured = pending_host, stamp()
	request("host.status", { serviceEpoch = envelope.serviceEpoch, commandId = envelope.id }, function(ok, receipt)
		if pending_host ~= envelope then return end
		local select_result = pending_host_select == true
		if ok and receipt.result then
			pending_host, pending_host_select = nil, nil
			if select_result and same_selection(captured) then
				session_id = receipt.result.sessionId
				feedback_ui.bind(feedback, envelope.id, session_id)
				recover_selection(allow_restore)
			end
		else
			notify("Host request outcome unresolved. Inspect :PiHostRequest before explicitly creating/resuming; no replay occurred.", vim.log.levels.WARN)
			if same_selection(captured) then
				session_status, session_error = "unavailable", "Host request outcome unresolved. Inspect :PiHostRequest; no work was replayed."
				render()
			end
		end
		-- Recovery can resolve an ID after another selection, never revive its
		-- original right to select. Reattach the user's selected view instead.
		if not select_result and same_selection(captured) and not attachment and session_id then
			recover_selection(allow_restore and pending_host == nil)
		end
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
		vim.list_extend(args, { "--remote", M.config.service_remote })
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
				or (M.config.service_remote and result.transport ~= "ws") then
				notify("Incompatible service handshake; no fallback.", vim.log.levels.ERROR); M.detach(); return
			end
			if M.config.expected_host and result.hostId ~= M.config.expected_host then
				notify("Owner identity changed; confirm in Hosts before selecting."); M.detach(); return
			end
			hello = result
			M.config.expected_host = result.hostId
			if not session_id then host_options() end
			render()
			local restore = recovery_requested; recovery_requested = false
			if recover_host(restore) then return end
			if session_id then
				if resume_requested then resume_requested = false; host_operation("host.resume", { sessionId = session_id })
				else recover_selection(restore) end
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
			if receipt then
				feedback_ui.receipt(feedback, receipt.id, true, receipt)
				render()
			end
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
							local buf = draft_buffer(scratch_name("owner-editor-draft"), effect.text)
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
function M.reconnect() M.detach(); recovery_requested = true; connect() end
function M.host_disconnected(identity, target)
	local source = identity and require("pi-integration.service-hosts").find(identity)
	local endpoint_match = target and target.service_remote == M.config.service_remote and target.service_root == M.config.service_root
		and (not identity or M.config.expected_host == identity)
	if endpoint_match or identity and M.config.expected_host == identity and not (source and source.connected) then M.detach() end
end
function M.select_owner(target, id, resume, cwd)
	assert(M.config.role == "conversation", "Only conversation frontends can select an owner")
	local host_changed = target.expected_host ~= M.config.expected_host or target.service_root ~= M.config.service_root
		or target.service_remote ~= M.config.service_remote
	local settings = not host_changed and not session_id and not id and pending_settings or {}
	local switching = host_changed or id ~= session_id or cwd ~= nil or resume
		or target.service_root ~= M.config.service_root or target.service_remote ~= M.config.service_remote
	if switching then
		if not backup() then return end
		state.pending_transcript_scroll = nil
		-- The old selection's input must remain recoverable after new autosaves.
		recovery_id = nil
		owner_states[owner_key()] = { unresolved = unresolved, submission_status = submission_status, feedback = feedback,
			pending_host = pending_host, pending_host_select = false }
		M.detach()
		M.config.service_root, M.config.service_remote = target.service_root, target.service_remote
		M.config.expected_host = target.expected_host
		local saved = owner_states[owner_key()] or {}
		unresolved, submission_status, feedback = saved.unresolved or {}, saved.submission_status or {}, saved.feedback or {}
		pending_host, pending_host_select = saved.pending_host, false
		session_id, resume_requested, selected_cwd, recovery_requested = id, resume, cwd, false
		snapshot, hello, pending_settings = nil, nil, settings
		selection = selection + 1
		if id and valid(state.input_buf) then layout.set_buffer_lines(ctx, state.input_buf, { "" }, true) end
	end
	layout.open(ctx)
	render()
	if switching then
		for _, win in ipairs(vim.api.nvim_list_wins()) do
			if buffer.window_matches(win, state.transcript_buf) then
				vim.api.nvim_win_call(win, function()
					vim.fn.winrestview({ lnum = 1, col = 0, curswant = 0, topline = 1, topfill = 0, leftcol = 0, skipcol = 0 })
				end)
			end
		end
	end
	if not job then connect()
	elseif id and not attachment then attach(id)
	end
end
function M.pick_hosts()
	local hosts = require("pi-integration.service-hosts")
	if M.config.role ~= "conversation" then hosts.picker(); return end
	local captured = stamp()
	hosts.picker(function(host)
		if not same_selection(captured) then return end
		local target = hosts.target(host)
		if target.expected_host ~= M.config.expected_host or target.service_root ~= M.config.service_root
			or target.service_remote ~= M.config.service_remote then M.select_owner(target) end
	end)
end
local function acquire_control(takeover, captured)
	if not same_context(captured) or captured.controller ~= (current_controller() and current_controller().grantId) then
		notify("Attachment/controller changed; request control again for this session."); return
	end
	command(takeover and "control.takeover" or "control.acquire", takeover and { confirmed = true } or {}, function(ok)
		if not ok or not same_context(captured) then fail_start("Startup control was not acquired; submitted text remains in :PiDrafts."); return end
		request("grant", {}, function(found, value)
			if not found or not same_context(captured) or value == vim.NIL then fail_start("Startup control was not acquired; submitted text remains in :PiDrafts."); return end
			grant = value
			request("snapshot", {}, function(synced, value_snapshot)
				if not synced or not same_context(captured) then fail_start("Startup synchronization failed; submitted text remains in :PiDrafts."); return end
				apply_snapshot(value_snapshot)
				if not same_context(captured) then notify("Session runtime changed; select the action again."); return end
			end)
		end)
	end)
end
function M.take_control()
	if not job or not snapshot or not attachment then notify("Attach to a live session first."); return end
	if control_current() then return end
	local captured = stamp()
	local controller = current_controller()
	if controller then
		vim.ui.select({ "Cancel", "Take over" }, { prompt = "Take control from " .. controller.label .. "? Accepted work continues." }, function(choice)
			if choice == "Take over" then acquire_control(true, captured) end
		end)
	else acquire_control(false, captured) end
end
local function submit_input(original, entry)
	for id, envelope in pairs(unresolved) do
		if envelope.operation == "prompt.submit" and envelope.sessionId == session_id
			and vim.trim(envelope.payload.text) == vim.trim(original) then
			notify("This submission may already be accepted. Review :PiSubmissions before sending this text again.", vim.log.levels.WARN)
			if entry then
				entry.status, entry.error = "Not sent", "An earlier submission of this text is protected. Review :PiSubmissions before resending."
				render()
			end
			return
		end
	end
	local id = command("prompt.submit", { text = original }, nil, nil, nil, { entry = entry, input_buf = not entry and state.input_buf or nil })
	if entry and not id then
		entry.status, entry.error = "Not sent", "Submission could not proceed; text remains in :PiDrafts."
		render()
	end
end
advance_start = function()
	local start = starting
	if not start or not snapshot then return end
	if snapshot.error or snapshot.phase == "failed" or snapshot.phase == "stopped" then
		fail_start("Startup failed; submitted text and unapplied settings remain local in :PiDrafts."); return
	end
	if start.context and not current(start.context) then
		fail_start("Startup context changed; submitted text remains in :PiDrafts. Review the session before resending."); return
	end
	if not control_current() then
		local controller = current_controller()
		if controller and controller.attachmentId ~= attachment then
			fail_start("Startup lost control; submitted text remains in :PiDrafts. Use :PiControl before resending.")
		end
		return
	end
	if start.busy or snapshot.phase ~= "ready" then return end
	start.context = stamp()
	for _, operation in ipairs({ "access.set", "integration.set", "notifications.set", "model.set", "thinking.set" }) do
		local payload = pending_settings[operation]
		if payload then
			start.busy = true
			local function failed()
				if starting == start then fail_start("Startup settings did not complete; submitted text remains in :PiDrafts. Inspect :PiOperations before retrying.") end
			end
			local id = command(operation, payload, function(ok) if not ok then failed() end end, start.context, function(receipt)
				if starting ~= start then return end
				if receipt.status ~= "completed" then failed(); return end
				pending_settings[operation] = nil
				start.busy = false
				advance_start()
			end)
			if not id then failed() end
			return
		end
	end
	starting = nil
	submit_input(start.input, start.entry)
	render()
end
function M.submit_prompt()
	local original = text(state.input_buf)
	local trimmed = vim.trim(original)
	if trimmed == "" then return end
	if starting then notify("Session startup is already pending; input remains local."); return end
	if not session_id then
		if not hello or not job then notify("Connect to a host before submitting."); return end
		if not selected_cwd then notify("Choose a directory with :PiCd before submitting."); return end
		if pending_host then notify("Host request unresolved; inspect :PiHostRequest before submitting."); return end
	elseif next(pending_settings) then
		if not control_current() then notify("Use :PiControl before applying pending settings and submitting."); return end
	else submit_input(original); return end
	local entry = feedback_ui.add(feedback, uid(), "prompt.submit", { text = original }, session_id, hello.serviceEpoch, current_revision())
	entry.status = "Starting session"
	starting = { input = original, entry = entry }
	layout.set_buffer_lines(ctx, state.input_buf, { "" }, true)
	vim.bo[state.input_buf].modified = false
	render()
	transcript.scroll_to_bottom_unless_focused(ctx)
	vim.cmd("redraw")
	if not backup() then fail_start("Startup was not sent because local recovery could not be saved."); return end
	if not session_id then host_operation("host.create", { cwd = selected_cwd }) else advance_start() end
end
function M.show_host_request()
	if not pending_host then notify("No unresolved host request."); return end
	local envelope = pending_host
	request("host.status", { serviceEpoch = envelope.serviceEpoch, commandId = envelope.id }, function(ok, receipt)
		draft_buffer(scratch_name("host-request"), operation_summary(envelope, receipt))
		vim.ui.select({ "Keep protected", "Allow a new host request" }, { prompt = "Existing request may already have created/resumed a session; review its outcome first." }, function(choice)
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
	vim.ui.select(choices, { prompt = "Owner operation receipts (inspect only; never replayed)", format_item = operation_label }, function(receipt)
		if not receipt or not same_context(captured) then return end
		request("command.status", { serviceEpoch = receipt.serviceEpoch, commandId = receipt.id }, function(ok, result)
			if same_context(captured) then draft_buffer(scratch_name("operation"), operation_summary(unresolved[receipt.id], result)) end
		end)
	end)
end
function M.show_submissions()
	local choices = {}
	for id, envelope in pairs(unresolved) do
		if text_submission(envelope.operation) and envelope.sessionId == session_id then table.insert(choices, id) end
	end
	vim.ui.select(choices, { prompt = "Protected submissions (never replayed)", format_item = function(id)
		local envelope = unresolved[id]
		return operation_label({ id = id, operation = envelope.operation, status = submission_status[id] })
	end }, function(id)
		local envelope = id and unresolved[id]
		if not envelope then return end
		request("command.status", { serviceEpoch = envelope.serviceEpoch, commandId = id }, function(ok, receipt)
			if ok then
				submission_status[id] = receipt.status
				feedback_ui.receipt(feedback, id, true, receipt, true)
			end
			draft_buffer(scratch_name("submission-review"), operation_summary(envelope, receipt))
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
	local choices = vim.deepcopy(snapshot.acceptedQueue.items)
	for _, queue in ipairs({ { "steering", "Steering" }, { "followUp", "Follow-up" } }) do
		for _, value in ipairs(snapshot.conversation.queue[queue[1]] or {}) do
			table.insert(choices, { kind = queue[2], text = value })
		end
	end
	vim.ui.select(choices, { prompt = "Queued messages", format_item = function(item)
		return (item.kind or item.status) .. ": " .. preview(item.text)
	end }, function(item)
		if not item or not same_context(captured) then return end
		if item.kind then
			draft_buffer(scratch_name("queue-inspect"), "# " .. item.kind .. " (queued)\n\n" .. item.text)
			return
		end
		vim.ui.select({ "Edit", "Remove", "Inspect" }, { prompt = item.status .. ": " .. preview(item.text) }, function(action)
			if action == "Remove" then command("queue.remove", { itemId = item.id, expectedRevision = item.revision }, nil, captured)
			elseif action == "Edit" then
				command("queue.reserve", { itemId = item.id, expectedRevision = item.revision }, function(ok, receipt)
					if not ok then return end
					local reservation_id = receipt.result and receipt.result.reservationId
					local expected_revision = item.revision
					-- Only this editor's acknowledged edit advances its revision;
					-- snapshots must not authorize saving over another edit/dispatch.
					draft_buffer(scratch_name("queue-draft"), item.text, function(buf)
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
			elseif action == "Inspect" then draft_buffer(scratch_name("queue-inspect"), queue_summary(item)) end
		end)
	end)
end
local function pending(id)
	for _, item in ipairs(snapshot and snapshot.interactions.pending or {}) do if item.request.id == id and not item.submitted then return item end end
end
local function dialog_description(value)
	local ok, data = pcall(vim.json.decode, value or "")
	if not ok or type(data) ~= "table" then return end
	if data.kind == "pi_service_dialog" or data.kind == "pi_side_dialog" then
		return dialog_description(data.title) or { title = data.title }
	end
	if data.kind == "pi_input" or data.kind == "pi_confirmation" or data.kind == "pi_compact_select"
		or data.kind == "pi_approval_preview" then return data end
end
local function request_label(item)
	local request_data = item.request
	local data = dialog_description(request_data.title)
	local title = data and (data.prompt or data.request or data.summary or data.title) or request_data.title
	return request_data.method .. " - " .. (item.submitted and "answered" or "pending") .. ": " .. preview(title)
end
local function dialog_preview(value, lines, label)
	local data = dialog_description(value)
	if not data then fields(lines, { text = value }, { { "text", label } }); return end
	fields(lines, data, { { "title", "Title" }, { "prompt", "Prompt" }, { "tool", "Tool" },
		{ "request", "Request" }, { "summary", "Summary" }, { "path", "Access scope" },
		{ "directory", "Command directory" }, { "mode", "Mode" }, { "preview", "Preview" } })
	for choice, contents in pairs(data.previews or {}) do
		fields(lines, { text = contents }, { { "text", tostring(choice) } })
	end
end
local function effect_summary(effect)
	local lines = { "# Owner offer", "" }
	fields(lines, effect, { { "type", "Type" }, { "text", "Editor text" }, { "message", "Message" }, { "level", "Level" }, { "key", "Signal" } })
	if effect.type == "extension_signal" then
		if effect.key == "pi-desktop-notification" or effect.key == "pi-spawn-notification" then
			local ok, data = pcall(vim.json.decode, effect.value or "")
			if ok then fields(lines, data, { { "title", "Title" }, { "message", "Message" }, { "level", "Level" } }) end
		elseif effect.key ~= "pi-history-changed" then fields(lines, effect, { { "value", "Value" } }) end
	end
	return table.concat(lines, "\n")
end
local function dialog_current(captured)
	return current(captured) and captured.epoch == snapshot.serviceEpoch
		and (not authority or captured.epoch == authority.epoch)
end
local function dialogs_ready()
	return control_current() and snapshot.runtimeRevision == current_revision()
		and (not authority or snapshot.serviceEpoch == authority.epoch)
end
local function open_pending(item)
	if not dialogs_ready() or item.submitted or pending_replies[item.request.id] then return end
	if not pending_context or not dialog_current(pending_context) then
		pending_context, pending_seen, pending_replies = stamp(), {}, {}
	end
	local request_data, captured = item.request, stamp()
	local id = request_data.id
	local seconds, micros = vim.uv.gettimeofday()
	local remaining = item.tag and item.tag.deadline and item.tag.deadline - (seconds * 1000 + micros / 1000)
	pending_seen[id] = true
	if remaining and remaining <= 0 then return end
	local function answer(response)
		local live = pending(id)
		if not dialog_current(captured) or not live or pending_replies[id] then notify("Request or controller changed; no reply sent."); return end
		local now_seconds, now_micros = vim.uv.gettimeofday()
		if live.tag and live.tag.deadline and now_seconds * 1000 + now_micros / 1000 >= live.tag.deadline then notify("Request deadline expired"); return end
		local cancel = response.cancelled == true
		local decoded_ok, description = pcall(vim.json.decode, request_data.title or "")
		local review_id = not cancel and response.value == "Review / modify"
			and decoded_ok and type(description) == "table" and description.kind == "pi_compact_select"
			and description.preview_kind == "workspace_summary" and snapshot.workspace and snapshot.workspace.id
		pending_replies[id] = true -- Never replay an answer while its outcome is uncertain.
		local sent = command(cancel and "interaction.cancel" or "interaction.respond", cancel and { requestId = id }
			or { requestId = id, answer = response }, function(ok, result)
				if not ok and result.delivery == "not_sent" and dialog_current(captured) then pending_replies[id] = nil end
				if ok and review_id and dialog_current(captured) then open_workspace_review(review_id) end
			end, captured)
		if not sent then pending_replies[id] = nil end
	end
	close_approval()
	approval_request, approval_context = id, captured
	state.pending_ui_requests[id] = { label = request_data.method, hidden = false, resumable = true,
		dismiss_on_close = true, on_cancel = function() answer({ cancelled = true }) end,
		expires = remaining and (vim.uv.now() + remaining) or nil }
	state.active_ui_request_id = id
	local input_buf = require("pi-integration.events").open_dialog(ctx, request_data, answer)
	if valid(input_buf) then
		local name = scratch_name("answer-draft")
		drafts[input_buf] = name
		vim.api.nvim_create_autocmd("BufWipeout", { buffer = input_buf, once = true, callback = function()
			-- The editor wipes on close, including timeout/revocation. Preserve
			-- unsaved text as an inspect-only draft before that happens.
			local contents = text(input_buf)
			drafts[input_buf] = nil
			if contents ~= "" then
				local saved = layout.create_buffer(nil, name, "markdown", true)
				vim.api.nvim_buf_set_lines(saved, 0, -1, false, vim.split(contents, "\n", { plain = true }))
				drafts[saved] = name
			end
			backup()
		end })
	end
end
sync_pending = function()
	if approval_context and (not dialog_current(approval_context) or not pending(approval_request)) then close_approval() end
	if not dialogs_ready() then pending_context = nil; return end
	if not pending_context or not dialog_current(pending_context) then
		pending_context, pending_seen, pending_replies = stamp(), {}, {}
	end
	if approval_request then return end
	for _, item in ipairs(snapshot.interactions.pending) do
		if not item.submitted and not pending_seen[item.request.id] and not pending_replies[item.request.id] then
			open_pending(item)
			if approval_request then return end
		end
	end
end
function M.restore_pending_action()
	if not snapshot then return end
	if control_current() then
		if not dialogs_ready() then notify("Waiting for the current owner snapshot."); refresh(); return end
		if approval_request then
			pending_picker.restore(ctx)
			return
		end
		for _, item in ipairs(snapshot.interactions.pending) do
			if not item.submitted and not pending_replies[item.request.id] then open_pending(item); return end
		end
		notify("No unanswered owner requests.")
		return
	end
	local choices, captured = snapshot.interactions.pending, stamp()
	vim.ui.select(choices, { prompt = "Pending owner requests (viewer can inspect)", format_item = request_label }, function(item)
		if not item or not same_context(captured) then return end
		close_approval()
		local lines = { "# " .. request_label(item), "", "VIEWER: :PiControl is required to answer.", "" }
		dialog_preview(item.request.title, lines, "Title")
		dialog_preview(item.request.message, lines, "Message")
		fields(lines, item.request, { { "prefill", "Initial text" }, { "placeholder", "Placeholder" } })
		for _, option in ipairs(item.request.options or {}) do table.insert(lines, "- " .. option) end
		if item.tag and item.tag.deadline then table.insert(lines, "Deadline: " .. os.date("%Y-%m-%d %H:%M:%S", math.floor(item.tag.deadline / 1000))) end
		local approval_buf = layout.create_buffer(nil, scratch_name("approval"), "markdown", false)
		layout.set_buffer_lines(ctx, approval_buf, lines, false)
		approval_win = vim.api.nvim_open_win(approval_buf, true, { relative = "editor", style = "minimal", border = "rounded", width = math.max(1, math.min(100, vim.o.columns - 4)), height = math.max(1, math.min(30, vim.o.lines - 4)), row = 1, col = 1 })
		vim.keymap.set("n", "q", close_approval, { buffer = approval_buf })
	end)
end
function M.show_offers()
	vim.ui.select(offers, { prompt = "Inspect-only offers (never applied)", format_item = function(update)
		local effect = update.effect.data
		return effect.type .. ": " .. preview(effect.text or effect.message or effect.key)
	end }, function(update)
		if not update or not control_current() then return end
		local captured = stamp()
		request("effect.inspect", { controlToken = grant.token, update = update }, function(ok, effect)
			if ok and current(captured) and effect ~= vim.NIL then draft_buffer(scratch_name("effect-offer"), effect_summary(effect)) end
		end)
	end)
end
function M.pick_session()
	if M.config.role == "conversation" and not M.config.expected_host then notify("Connect to a host before choosing its sessions."); return end
	require("pi-integration.service-hosts").history_picker(M.config.role == "conversation" and M.config.expected_host or nil)
end
function M.new_session()
	if M.config.role ~= "conversation" then return require("pi-integration.service-hosts").new_conversation() end
	local cwd = snapshot and snapshot.workspace and snapshot.workspace.cwd or state.session_cwd or selected_cwd
	if not cwd then notify("Choose a directory with :PiCd first."); return end
	M.select_owner(M.config, nil, false, cwd)
end
function M.change_cwd()
	if not hello or not job then notify("Connect to a host before choosing its directory."); return end
	local captured, epoch = stamp(), hello.serviceEpoch
	require("pi-integration.directory-history").owner_input({ label = current_owner_label(),
		key = (vim.env.PI_CONSOLE_CHANNEL or "stable") .. "/" .. hello.hostId,
		current = function() return hello and hello.serviceEpoch == epoch and same_selection(captured) end,
		request = function(query, callback)
			request("host.directories", vim.tbl_extend("force", query, { serviceEpoch = epoch }), callback)
		end }, function(cwd)
		if hello and hello.serviceEpoch == epoch and same_selection(captured) then M.select_owner(M.config, nil, false, cwd) end
	end)
end
local function lifecycle(operation, label, prompt)
	local captured = stamp()
	vim.ui.select({ "Cancel", label }, { prompt = prompt or label .. " on owner? Active work is interrupted; history/workspaces and recovery text remain." }, function(choice)
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
	if can_close_frontend() then
		lifecycle("session.kill", "Kill conversation and close", "Stop this conversation? Active work will be interrupted. History is preserved.")
	end
end
function M.new_session_window()
	local cwd = snapshot and snapshot.workspace and snapshot.workspace.cwd or state.session_cwd or selected_cwd
	if not cwd then notify("Choose a directory with :PiCd first."); return end
	local opened, err = require("pi-integration.backends.tmux").launch_service(M.config.launcher, M.config, nil, cwd)
	if not opened then notify(err) end
end
local function owner_read(kind, callback, captured)
	captured = captured or stamp()
	if not snapshot then return end
	request("session.read", { kind = kind, runtimeRevision = captured.revision }, function(ok, result)
		if ok and same_context(captured) then callback(result.data, captured) end
	end)
end
local function setting(operation, payload, captured)
	if starting then notify("Wait for session startup before changing settings."); return end
	if not session_id or next(pending_settings) then
		if captured and not same_selection(captured) then return end
		pending_settings[operation] = payload
		if operation == "model.set" then pending_settings["thinking.set"] = nil end
		render()
		vim.cmd("redraw")
		backup()
	else command(operation, payload, nil, captured) end
end
local function pick_setting(operation, values, label)
	local captured = stamp()
	vim.ui.select(values, { prompt = label .. (session_id and " (owner)" or " (pending)") }, function(value)
		if value then setting(operation, { mode = value }, captured) end
	end)
end
local function cycle_setting(operation, values, value)
	if session_id and not next(pending_settings) then
		command(operation:gsub("%.set$", ".cycle"), { modes = values }); return
	end
	local index = 0
	for i, mode in ipairs(values) do if mode == value then index = i; break end end
	setting(operation, { mode = values[index % #values + 1] })
end
function M.set_access_mode(mode) setting("access.set", { mode = mode }) end
function M.pick_access_mode() pick_setting("access.set", M.config.access_modes or { "readonly", "ask", "edit", "full" }, "Access mode") end
function M.cycle_access_mode() cycle_setting("access.set", M.config.access_modes, state.access_mode) end
function M.set_integration_mode(mode) setting("integration.set", { mode = mode }) end
function M.pick_integration_mode() pick_setting("integration.set", M.config.integration_modes or { "ask", "allowed" }, "Integration mode") end
function M.cycle_integration_mode() cycle_setting("integration.set", M.config.integration_modes, state.integration_mode) end
host_options = function(callback)
	if not hello or not job then notify("Connect to a host to read its model options."); return end
	if not vim.tbl_contains(hello.capabilities or {}, "host.options") then unavailable("Pre-start model options"); return end
	local captured, cwd = stamp(), selected_cwd
	request("host.options", { serviceEpoch = hello.serviceEpoch, cwd = cwd }, function(ok, data)
		if not same_selection(captured) or cwd ~= selected_cwd then return end
		if not ok then
			if not startup_options then startup_options = { defaults = { modelStatus = "unavailable" }, models = {} } end
			render()
			return
		end
		startup_options = data
		render()
		if callback then callback(data, captured) end
	end)
end
function M.pick_model()
	local read = not session_id and host_options or function(callback) owner_read("models", callback) end
	read(function(data, captured)
		if #data.models == 0 then notify("Pi found no available models on this host.", vim.log.levels.WARN); return end
		vim.ui.select(data.models, { prompt = "Owner model", format_item = function(model) return model.provider .. "/" .. model.id end }, function(model)
			if model then setting("model.set", { provider = model.provider, modelId = model.id }, captured) end
		end)
	end)
end
function M.pick_thinking()
	if not session_id then
		host_options(function(data, captured)
			local pending = pending_settings["model.set"]
			local model = pending and { provider = pending.provider, id = pending.modelId } or (data.defaults or {}).model
			if not model then notify("Choose a model before its pending thinking level."); return end
			for _, option in ipairs(data.models) do
				if option.provider == model.provider and option.id == model.id then
					vim.ui.select(option.thinkingLevels, { prompt = "Pending thinking level" }, function(level)
						if level and pending_settings["model.set"] == pending then setting("thinking.set", { level = level }, captured) end
					end)
					return
				end
			end
			notify("Thinking options are unavailable until this model's provider loads.")
		end)
		return
	end
	owner_read("thinking", function(data, captured)
		vim.ui.select(data.levels, { prompt = "Owner thinking level" }, function(level)
			if level then setting("thinking.set", { level = level }, captured) end
		end)
	end)
end
local function native_draft(operation, initial)
	local captured = stamp()
	local buf = draft_buffer(scratch_name(operation), initial or "", function(buf)
		local submitted = text(buf)
		if vim.trim(submitted) == "" then return end
		for id, envelope in pairs(unresolved) do
			if envelope.operation == operation and envelope.sessionId == captured.session and envelope.payload.text == submitted then
				notify("This submission may already be accepted; inspect :PiSubmissions."); return
			end
		end
		command(operation, { text = submitted }, nil, captured, nil, { input_buf = buf })
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
	if not valid(side_buf) then side_buf = draft_buffer(scratch_name("side-owner"), "")
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
	vim.ui.select(data and data.runs or {}, { prompt = "Owner subagents", format_item = run_label }, function(run)
		if not run or not same_context(captured) then return end
		vim.ui.select({ "Artifacts", "Inspect", "Join", "Stop" }, { prompt = run_label(run) }, function(action)
			if not same_context(captured) then return end
			if action == "Artifacts" then require("pi-integration.spawn-artifacts").pick_run({ state = state, ui = { notify = notify }, resources = owner_resources() }, run, function() end)
			elseif action == "Inspect" then
				local lines = { "# Owner subagent", "" }
				fields(lines, run, { { "agent", "Agent" }, { "role", "Role" }, { "status", "Status" },
					{ "prompt", "Task" }, { "startedAt", "Started" }, { "completedAt", "Completed" },
					{ "accessMode", "Access mode" }, { "isolation", "Isolation" }, { "mode", "Interaction mode" },
					{ "error", "Error" }, { "cleanupError", "Cleanup error" }, { "progress", "Progress" },
					{ "joined", "Joined" }, { "joinRequested", "Join requested" }, { "integration", "Integration" },
					{ "integrationReason", "Integration details" }, { "agentSource", "Agent source" }, { "agentProfilePath", "Agent profile" },
					{ "parentSessionFile", "Parent session file" }, { "runDir", "Artifacts directory" }, { "statusPath", "Status file" },
					{ "briefPath", "Brief" }, { "resultPath", "Result" }, { "transcriptPath", "Transcript" },
					{ "agentPromptPath", "Agent prompt" }, { "worktreePath", "Worktree" }, { "patchPath", "Recovery patch" } })
				fields(lines, run.integrationBlock, { { "integration", "Integration blocked" }, { "reason", "Reason" } })
				for _, path in ipairs(run.changedFiles or {}) do table.insert(lines, "Changed: " .. path) end
				for _, path in ipairs(run.unpreservedFiles or {}) do table.insert(lines, "Not preserved: " .. path) end
				draft_buffer(scratch_name("owner-spawn"), table.concat(lines, "\n"))
			elseif action == "Join" or action == "Stop" then command(action == "Join" and "spawn.join" or "spawn.stop", { id = run.runId }, nil, captured) end
		end)
	end)
end
function M.toggle_notifications()
	setting("notifications.set", { enabled = state.notification_status ~= "notify on" })
end
function M.retitle() command("title.generate", {}) end
function M.pick_workspace()
	local captured = stamp()
	vim.ui.select({ "Inspect state", "Enter", "Integrate and return", "Discard" }, { prompt = "Workspace on owner (confirmation remains owner-side)" }, function(action)
		if action == "Inspect state" then
			local lines = { "# Owner workspace", "" }
			fields(lines, snapshot and snapshot.workspace, { { "kind", "Kind" }, { "lifecycle", "Status" },
				{ "branch", "Branch" }, { "cwd", "Current directory" }, { "path", "Workspace path" },
				{ "directory", "Destination directory" }, { "project", "Project" },
				{ "localCheckout", "Local checkout" }, { "transitionPending", "Transition pending" } })
			draft_buffer(scratch_name("owner-workspace"), table.concat(lines, "\n"))
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
		vim.ui.select(result.data.entries or {}, { prompt = "Owner workspace reviews", format_item = function(item)
			local label = item.label
			if not label or label == item.id or label == "task-" .. item.id:sub(-8) then label = "Task workspace" end
			return label .. " (" .. tostring(item.lifecycle) .. ")"
		end }, function(item)
			if item and same_context(captured) then open_workspace_review(item.id) end
		end)
	end)
end
function M.show_usage()
	local function inspect() owner_read("stats", function(data)
		local lines = { "# Owner usage", "" }
		fields(lines, data, { { "userMessages", "User messages" }, { "assistantMessages", "Assistant messages" },
			{ "toolCalls", "Tool calls" }, { "toolResults", "Tool results" }, { "totalMessages", "Total messages" },
			{ "sessionFile", "Session file" }, { "cost", "Cost" } })
		fields(lines, data.tokens, { { "input", "Input tokens" }, { "output", "Output tokens" },
			{ "cacheRead", "Cache read tokens" }, { "cacheWrite", "Cache write tokens" }, { "total", "Total tokens" } })
		fields(lines, data.contextUsage, { { "tokens", "Context tokens" }, { "contextWindow", "Context window" }, { "percent", "Context used (%)" } })
		local usage = status_data("pi-codex-usage")
		fields(lines, usage, { { "stale", "Codex usage stale" }, { "error", "Codex usage error" } })
		if usage and usage.updatedAt then table.insert(lines, "Codex updated: " .. os.date("%Y-%m-%d %H:%M:%S", usage.updatedAt)) end
		for _, window in ipairs({ { "fiveHour", "Five-hour" }, { "weekly", "Weekly" } }) do
			local value = usage and usage.windows and usage.windows[window[1]]
			if value then
				fields(lines, value, { { "usedPercent", window[2] .. " used (%)" } })
				if value.resetsAt then table.insert(lines, window[2] .. " resets: " .. os.date("%Y-%m-%d %H:%M:%S", value.resetsAt)) end
			end
		end
		draft_buffer(scratch_name("owner-usage"), table.concat(lines, "\n"))
	end) end
	if control_current() then command("usage.refresh", {}, nil, stamp(), inspect) else inspect() end
end
local function history_command(operation, payload, captured, completed)
	command(operation, payload, function(ok, result)
		if not ok and same_selection(captured) then notify(result.message or "History operation unavailable", vim.log.levels.WARN) end
	end, captured, function(receipt)
		if receipt.status == "completed" then completed(receipt.result or {})
		else notify(receipt.error and receipt.error.message or "History operation did not complete; inspect :PiOperations.", vim.log.levels.WARN) end
	end)
end
tree_ctx = {
	state = state, config = M.config, ui = { notify = notify },
	buffer = { valid = valid, create = function(name, ft, editable) return layout.create_buffer(nil, name, ft, editable) end,
		set_lines = function(buf, lines, editable) layout.set_buffer_lines(ctx, buf, lines, editable) end },
	messages = { extract_text = require("pi-integration.utils.message").extract_text },
}
tree_ctx.tree = {
	read = function(done)
		if not job or not attachment or not snapshot then
			notify("Connect and attach to a live session to view its history.", vim.log.levels.WARN)
			done(nil); return
		end
		local captured = stamp()
		request("session.read", { kind = "entries", runtimeRevision = captured.revision }, function(ok, result)
			if not job or not same_context(captured) then done(nil); return end
			if not ok then notify(result.message or "Owner history unavailable", vim.log.levels.WARN); done(nil); return end
			done(result.data, captured)
		end)
	end,
	writable = function(captured) return captured and current(captured) end,
	can_mutate = function(captured, action)
		if not control_current() then notify("Viewer: use :PiControl first.", vim.log.levels.WARN); return false end
		if not captured or not current(captured) then notify("History context changed; refresh the tree before changing history.", vim.log.levels.WARN); return false end
		if not require("pi-integration.utils.guard").if_history_change_allowed(tree_ctx, "changing history") then return false end
		if action == "clone" and not require("pi-integration.backends.tmux").available() then
			notify("Opening a clone in a new window requires tmux.", vim.log.levels.WARN); return false
		end
		return true
	end,
	jump = function(id, summarize, captured)
		history_command("history.navigate", { entryId = id, summarize = summarize }, captured, function(result)
			if result.editorText ~= nil and valid(state.input_buf) then
				layout.set_buffer_lines(ctx, state.input_buf, vim.split(result.editorText, "\n", { plain = true }), true)
			end
		end)
	end,
	clone = function(id, captured)
		history_command("history.clone", { entryId = id }, captured, function(result)
			if not result.sessionId then return end
			local opened, err = require("pi-integration.backends.tmux").launch_service(M.config.launcher, M.config, result.sessionId, nil, true)
			if not opened then notify((err or "Could not open clone") .. "\nClone saved on owner; select it in :PiSessions.", vim.log.levels.ERROR) end
		end)
	end,
	delete = function(id, captured, position)
		history_command("history.delete", { entryId = id }, captured, function()
			tree.show(tree_ctx, position)
		end)
	end,
}
function M.show_tree()
	tree.show(tree_ctx)
end
function M.command_context_current(captured)
	return captured and job and attachment and same_context(captured) and captured.epoch == snapshot.serviceEpoch
end
-- Read the attached runtime every time; no host/session command list is reused.
function M.get_commands(callback)
	if not job or not attachment or not snapshot then
		callback({}, "Attach to a live session to discover its slash commands.")
		return
	end
	local captured = stamp()
	captured.token, captured.controller = nil, nil -- Completion metadata is read-only.
	request("session.read", { kind = "commands", runtimeRevision = captured.revision }, function(ok, result)
		if not M.command_context_current(captured) then
			callback({})
			return
		end
		if not ok then callback({}, result.message or "Could not read owner commands"); return end
		callback(result.data.commands or {}, nil, captured)
	end)
end
function M.pick_command()
	M.get_commands(function(commands, err, captured)
		if err then notify(err, vim.log.levels.WARN); return end
		if not captured then return end
		if #commands == 0 then notify("No slash commands returned by the attached runtime."); return end
		table.sort(commands, function(a, b) return a.name < b.name end)
		vim.ui.select(commands, {
			prompt = "Pi command (" .. current_owner_label() .. ")",
			format_item = function(item)
				return "/" .. item.name .. " [" .. item.source .. "]"
					.. (item.description and item.description ~= "" and " - " .. item.description or "")
			end,
		}, function(choice)
			if not choice then return end
			if not M.command_context_current(captured) then
				notify("Owner context changed; select a command again.", vim.log.levels.WARN)
				return
			end
			M.show_input()
			local value = "/" .. choice.name .. " "
			layout.set_buffer_lines(ctx, state.input_buf, { value }, true)
			vim.api.nvim_win_set_cursor(state.input_win, { 1, #value })
		end)
	end)
end
function M.refresh_messages() refresh() end
function M.show_input() layout.show_input(ctx) end
function M.show_transcript() layout.show_transcript(ctx) end
function M.show_help()
	draft_buffer(scratch_name("service-help"), "# Local service attachment\n\n:PiControl / <leader>pc (acquire control; confirm before replacing another controller)\n:PiCd / <leader>pC (select a directory on the current host)\n:PiPending (restore picker; Esc hides, Ctrl-q cancels; viewers inspect only)\n:PiQueue (edit/remove accepted prompts; inspect steering/follow-up; :write saves; pauses expire after 30s)\n:PiFollowUp / steering shortcut (separate native queues)\n:PiWorkspace (owner enter/integrate/discard, with existing confirmations)\n:PiWorkspaceReview / :PiWorkspaceReviews (owner diffs; summary S/U stage/unstage all; file s/u index actions, X confirmed baseline restore; all mutations require control; gO inspects owner content, gS original command)\n:PiSidePrompt / :PiSideNew / :PiSideAbort\n:PiRetitle / :PiOperations (typed outcomes and recovery text)\n:PiSubmissions / :PiHostRequest (uncertain outcomes; never replayed)\n:PiSessions (owner archive/unarchive/delete, with workspace warnings)\n:PiSavedOperations (original saved-session outcomes; status only)\n:PiOffers / :PiDrafts (inspect-only)\n:PiDetach / :PiReconnect\n<leader>qq (close frontend; conversation keeps running)\n:PiKill / <leader>qk (confirm kill conversation and close; preserves history and local drafts)\n:PiConsoleRestart is frontend-only. The restart shortcut restarts the owner session.\n\n<C-CR> submits text; <Esc><Esc> aborts.\nSettings/model/thinking/history use typed owner operations.\n:PiCommand / <leader>/ and / completion discover commands from the attached runtime.\n:PiHosts / <leader>ph: attach current frontend, connect/retry/disconnect/edit/forget hosts; existing sessions keep running.\n:PiManagement: inspect overview management outcomes.\n:PiNew: unstarted frontend in the current workspace. First prompt creates the session.\n:PiTranscript: managed owner history (all branches, read-only).\nTranscript Enter inspects owner thinking/tools/skills/artifacts and file links; @ completion uses owner cwd.\nPaged text: n next / p first / r reload. Skill f reads the current owner file.\nSlash commands run on the owner through the shared prompt queue. TUI-only built-ins are not exposed by Pi RPC.\nExcluded resource actions never use a local or raw RPC fallback.\nService stop/restart remains separate: pi-console server stop/restart [--force].")
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
	local values = { { value = local_snapshot(), current = true } }
	local ok, saved = pcall(require("pi-integration.service-drafts").list)
	if ok then vim.list_extend(values, saved) else notify(tostring(saved), vim.log.levels.ERROR) end
	vim.ui.select(values, { prompt = "Local draft recovery (inspect only; never replayed)", format_item = function(item)
		local value = item.value
		return (item.current and "Current frontend " or "") .. tostring(value.saved_at) .. " " .. owner_label(value.host or value.expected_host, value.service_remote, value.service_root)
			.. " " .. tostring(value.channel or "") .. ": " .. preview(table.concat(value.input_lines or {}, " "))
	end }, function(item)
		if item then
			local value = item.value
			draft_buffer(scratch_name("recovered"), table.concat(value.input_lines or {}, "\n"))
			for _, draft in ipairs(value.drafts or {}) do
				recovered_draft(draft)
			end
			if next(value.unresolved or {}) or value.pending_host or next(value.feedback or {}) then
				local summaries = { "# Recovered protected operations", "Inspect only; never replayed." }
				for _, entry in ipairs(value.feedback or {}) do table.insert(summaries, operation_summary(entry, entry.receipt)) end
				for _, envelope in pairs(value.unresolved or {}) do table.insert(summaries, operation_summary(envelope)) end
				if value.pending_host then table.insert(summaries, operation_summary(value.pending_host)) end
				draft_buffer(scratch_name("recovery-status"), table.concat(summaries, "\n\n"))
			end
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
		restarting_frontend = true
		vim.cmd("qall!")
	end)
	if not ok then restarting_frontend = false; vim.fn.delete(path); notify(tostring(err), vim.log.levels.ERROR) end
end
function M.follow_markdown_link()
	local buf = vim.api.nvim_get_current_buf()
	local owner = resources.for_buffer(buf)
	local resource = owner and owner.resource or (buf == state.transcript_buf or buf == state.input_buf or buf == side_buf) and owner_resources() or nil
	return require("pi-integration.utils.markdown-links").follow(nil, resource)
end
function M.show_logs() require("pi-integration.logs").show(ctx) end
function M.restore_status_footer() statusline.update(ctx) end
function M.on_transcript_rendered(buf)
	if buf == state.transcript_buf then transcript.finish_pending_scroll(ctx) end
end
function M.setup(config)
	M.config = vim.tbl_extend("force", M.config, config or {}, { service_root = vim.env.PI_CONSOLE_SERVICE_ROOT,
		service_remote = vim.env.PI_CONSOLE_SERVICE_REMOTE, expected_host = vim.env.PI_CONSOLE_SERVICE_EXPECTED_HOST })
	assert(not M.config.service_remote or not M.config.service_root, "Remote attachment cannot use a local root")
	assert(not M.config.service_remote or (M.config.service_remote:match("^http://[^/?#@%s]+/?$")
		and not M.config.service_remote:find("[%c]")), "Remote endpoint must be an HTTP origin without user info, path, query or fragment")
	assert(vim.tbl_contains({ "conversation", "overview", "sidebar" }, M.config.role), "Invalid frontend role")
	ctx.config, tree_ctx.config = M.config, M.config
end
function M.open(restore)
	selected_cwd = not M.config.service_remote and vim.fn.getcwd() or nil
	if restore then assert(restore.role == M.config.role, "Restart cannot change frontend role") end
	if M.config.role ~= "conversation" then
		local hosts = require("pi-integration.service-hosts")
		for name, fn in pairs({ PiHosts = M.pick_hosts, PiSessions = M.pick_session, PiNew = hosts.new_conversation,
			PiManagement = hosts.management_operations, PiSavedOperations = hosts.saved_operations, PiConsoleRestart = M.restart_console }) do
			vim.api.nvim_create_user_command(name, fn, {})
		end
		hosts.start()
		require("pi-integration." .. M.config.role).open(M.config)
		return
	end
	if restore then
		assert(restore.expected_host or restore.service_remote == M.config.service_remote,
			"Restart target differs from explicit attachment; refusing to restore execution identities")
		if restore.expected_host then M.config.service_remote = restore.service_remote end
		session_id, pending_host = restore.service_session, restore.pending_host
		recovery_requested = true
		pending_host_select = restore.pending_host_select == true
		unresolved = restore.unresolved or {}
		selected_cwd, pending_settings = restore.selected_cwd, restore.pending_settings or {}
		submission_status = restore.submission_status or {}
		feedback = restore.feedback or {}
		feedback_ui.interrupt(feedback)
		if restore.expected_host then M.config.service_root = restore.service_root
		else M.config.service_root = restore.service_root or M.config.service_root end
		M.config.expected_host = restore.expected_host
		owner_states = restore.owner_states or {}
	else session_id, resume_requested = vim.env.PI_CONSOLE_SERVICE_SESSION, vim.env.PI_CONSOLE_SERVICE_RESUME == "1" end
	ctx.session.setup_keymaps = function()
		local actions = setmetatable({ open_transcript_item = M.open_transcript_item }, { __index = M })
		require("pi-integration.keymaps").setup({ state = state, actions = actions, buffer = ctx.buffer,
			ui = { notify = notify }, transcript = { open_item_under_cursor = M.open_transcript_item } })
	end
	statusline.setup(ctx)
	local function record_focus()
		local seconds, microseconds = vim.uv.gettimeofday()
		state.last_focused_at = seconds * 1000000 + microseconds
		publish_attachment()
	end
	vim.api.nvim_create_autocmd({ "FocusGained", "FocusLost" }, { callback = function(event)
		frontend_focused = event.event == "FocusGained"
		if frontend_focused then record_focus() end
	end })
	local backend = require("pi-integration.backends.tmux")
	frontend_focused = backend.available() and backend.is_focused() == true
	if frontend_focused then record_focus() end
	layout.open(ctx)
	if restore then
		layout.set_buffer_lines(ctx, state.input_buf, restore.input_lines or { "" }, true)
		for _, draft in ipairs(restore.drafts or {}) do recovered_draft(draft) end
	end
	for name, fn in pairs({ PiControl = M.take_control, PiPending = M.restore_pending_action, PiQueue = M.pick_queue,
		PiOffers = M.show_offers, PiDrafts = M.show_drafts, PiSubmissions = M.show_submissions, PiDetach = M.detach, PiReconnect = M.reconnect,
		PiFollowUp = M.follow_up, PiSidePrompt = M.side_prompt, PiSideNew = M.new_side, PiSideAbort = M.abort_side,
		PiSavedOperations = require("pi-integration.service-hosts").saved_operations,
		PiHosts = M.pick_hosts, PiManagement = require("pi-integration.service-hosts").management_operations, PiSessions = M.pick_session, PiNew = M.new_session, PiTranscript = M.show_owner_transcript,
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
	publish_attachment()
	require("pi-integration.service-hosts").start()
	if not restore and not session_id then selected_cwd = vim.env.PI_CONSOLE_SERVICE_CWD or selected_cwd end
	vim.env.PI_CONSOLE_SERVICE_NEW, vim.env.PI_CONSOLE_SERVICE_CWD = nil, nil
	connect()
end
vim.api.nvim_create_autocmd("VimLeavePre", { callback = function()
	if heartbeat then heartbeat:stop(); heartbeat:close(); heartbeat = nil end
	backup()
	M.detach()
	local tmux = require("pi-integration.backends.tmux")
	if tmux.available() then
		tmux.clear()
		if M.config.role == "conversation" and not restarting_frontend then tmux.close_sidebar() end
	end
end })
return M
