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
local logs = require("pi-integration.logs")
local snapshots = require("pi-integration.service-snapshot")
local side_view = require("pi-integration.side")
local feedback = {}
state.show_nested_tools = false
local session_id, attachment, snapshot, hello, grant, job
local authority
local session_status, session_error, recovery_requested
local control_loss_generation = 0
local callbacks, unresolved, offers, drafts = {}, {}, {}, {}
local outcomes = {}
local kill_pending
local pending_new_session, sync_new_session
local pending_host, pending_host_select, resume_requested
local generation, counter, refresh_scheduled, refreshing, dirty = 0, 0, false, false, false
local refresh_timer, refresh_due, refresh_urgent, refresh_ticket
local refresh_callbacks = {}
local last_refresh = -math.huge
local visibility_timer, visibility_pending
local transcript_cache, rendered_transcript, rendered_metadata = {}, nil, nil
local rendered_side, rendered_side_buf
local initial_scroll_pending = false
state.frontend_visible = true -- Unknown visibility must not suppress the UI.
local selection = 0
local approval_win, approval_request, heartbeat
local approval_context, pending_context
local pending_seen, pending_replies = {}, {}
local ctx, sync_pending
local recovery_id, backup_scheduled, restarting_frontend
local render, refresh, connect, attach, acquire_control, recover_selection, tree_ctx, advance_start, host_options, backup
local side_buf, side_input_buf, side_context, side_id
local side_permission_state, side_permission_items = {}, {}
local queue_editor
local side_draft_saved, side_draft_pending, side_after_draft, restored_side_draft, side_prompt_pending
local save_side_draft, side_save_scheduled, side_reset_draft
local resume_check
local stats_timer, stats_pending, workspace_stats_key
local owner_states, pending_settings = {}, {}
local selected_cwd, starting, auto_control_selection, startup_options, startup_status
local startup_options_context, startup_options_pending
local frontend_focused = false
local action_connection, close_bridge
local load_metrics
local function status_data(key)
	local raw = snapshot and snapshot.conversation.statuses[key]
	local ok, value = pcall(vim.json.decode, raw or "")
	return ok and value or nil
end
local function publish_attachment(heartbeat_only)
	local tmux = require("pi-integration.backends.tmux")
	if M.config.role ~= "conversation" or not tmux.available() then return end
	if frontend_focused then
		state.seen_seq = state.completion_seq
		state.viewed_seq = state.completion_seq
	end
	local pi_state = snapshot and snapshot.piState or {}
	local name = pi_state.sessionName ~= "" and pi_state.sessionName or "New Session"
	local label = status_data("pi-session-label")
	local slug = type(label) == "table" and label.sessionFile == pi_state.sessionFile and label.title == pi_state.sessionName
		and type(label.slug) == "string" and label.slug ~= "" and label.slug or name
	local identity = M.config.expected_host or "unknown"
	local status = "Loading"
	if action_connection and action_connection.status then status = action_connection.status
	elseif not job then status = "Disconnected"
	elseif not hello then status = "Connecting"
	elseif not session_id then status = starting and "Starting" or "Unstarted"
	elseif not attachment then status = session_status or "Unattached"
	elseif snapshot then
		status = snapshot.phase == "stopped" and "Stopped" or snapshot.status
		if status == "Idle" and snapshot.turnOutcome == "completed" and state.completion_seq > state.seen_seq then status = "Done" end
	end
	if status == "Stopped" then name, slug = "Stopped session", "Stopped session" end
	tmux.publish({ version = 1, frontend_attachment = true, host_id = identity, session_id = session_id,
		pid = vim.uv.os_getpid(), server = vim.v.servername ~= "" and vim.v.servername or vim.fn.serverstart(),
		updated = os.time(), cwd = not session_id and selected_cwd or state.session_cwd or selected_cwd,
		title = name, slug = slug,
		status = status, last_focused_at = state.last_focused_at,
		service_epoch = snapshot and snapshot.serviceEpoch, runtime_revision = snapshot and snapshot.runtimeRevision,
		seen_seq = state.seen_seq, viewed_seq = state.viewed_seq }, heartbeat_only)
end
local function owner_key() return M.config.expected_host or M.config.service_remote or M.config.service_root or "local" end
local function owner_label(identity, remote, root)
	local host = identity and require("pi-integration.service-hosts").find(identity)
	return host and host.alias or remote or root or "Local host"
end
local function current_owner_label()
	return owner_label(M.config.expected_host, M.config.service_remote, M.config.service_root)
end

local function log(text, level)
	logs.add(level, text, nil, { session = session_id })
end
local function notify(text, level)
	logs.notify(text, level, { session = session_id })
end
local function cancel_new_session(message)
	if not pending_new_session then return end
	pending_new_session.timer:stop()
	pending_new_session.timer:close()
	pending_new_session = nil
	if message then notify(message, vim.log.levels.WARN) end
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
local function operation_summary(envelope, receipt)
	local lines = { "# Action details", "", "Inspect only. Work is never replayed automatically.", "" }
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
	if result and result.sessionId then table.insert(lines, "Session available; select it in :PiSessions.") end
	if result and result.resourceId then table.insert(lines, "File version saved.") end
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
	if not receipt then table.insert(lines, "Outcome unknown. This request is never replayed automatically.") end
	return table.concat(lines, "\n")
end
local function queue_summary(item)
	local lines = { "# Accepted queue item", "" }
	fields(lines, item, { { "status", "Status" }, { "revision", "Revision" }, { "text", "Text" } })
	fields(lines, item.error, { { "message", "Error" } })
	return table.concat(lines, "\n")
end
local function run_label(run)
	return type(run.agent) == "string" and run.agent ~= "" and run.agent
		or type(run.role) == "string" and run.role ~= "" and run.role or "Subagent"
end
local function unavailable(name)
	notify(name .. " is unavailable on this service path. No local/RPC fallback was executed.", vim.log.levels.WARN)
end
local function fail_start(message)
	if not starting then return end
	if starting.entry then
		starting.entry.status, starting.entry.error = "Not sent", message
	end
	starting, startup_status = nil, nil
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
	if authority and value.serviceEpoch == authority.epoch and value.sequence < authority.sequence then return false end
	local owner = full and value or value.owner
	local controller = current_controller()
	if owner then controller = owner.controller end
	if authority and (authority.controller and authority.controller.grantId) ~= (controller and controller.grantId) then offers = {} end
	if not authority or authority.epoch ~= value.serviceEpoch or authority.revision ~= value.runtimeRevision then
		resources.invalidate()
		if authority then tree.close(tree_ctx) end
	end
	authority = { epoch = value.serviceEpoch, sequence = value.sequence, revision = value.runtimeRevision, controller = controller }
	return true
end
local function control_current()
	local controller = current_controller()
	return job and attachment and grant and controller
		and controller.attachmentId == attachment and controller.grantId == grant.grantId
end
local function can_kill_session()
	return control_current() and snapshot and snapshot.phase ~= "stopped" and snapshot.phase ~= "failed"
		and snapshot.phase ~= "stopping" and hello and vim.tbl_contains(hello.capabilities or {}, "session.kill")
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
local record_command
local function request(method, payload, callback)
	if not job then notify("Disconnected. Use :PiReconnect; no mutation was retried.", vim.log.levels.WARN); return end
	local id = uid()
	callbacks[id] = { callback = callback or function() end, quiet = method == "heartbeat", method = method,
		operation = payload and payload.operation, started = vim.uv.hrtime() / 1e6 }
	local ok, sent = pcall(vim.fn.chansend, job, vim.json.encode({ id = id, method = method, payload = object_payload(payload) }) .. "\n")
	if not ok or sent == 0 then
		-- A failed pipe write can still have partially delivered a mutation.
		close_bridge()
		return
	end
	if method == "command" or method == "host.command" then action_connection.monitor() end
	return id
end
local action_names = {
	["prompt.submit"] = "Send message", ["shell.run"] = "Run shell command",
	["steering.submit"] = "Send steering message", ["followUp.submit"] = "Send follow-up",
	["side.prompt"] = "Send side message", ["model.set"] = "Change model",
	["thinking.set"] = "Change thinking level", ["turn.abort"] = "Stop generation",
	["resource.read"] = "Read resource", ["session.read"] = "Read session data",
	["snapshot"] = "Refresh session", ["command.status"] = "Check action status", ["heartbeat"] = "Renew control",
	["session.restart"] = "Restart conversation worker", ["session.kill"] = "Stop session",
	["host.create"] = "Create session", ["host.resume"] = "Resume session", ["host.recover"] = "Recover session",
	["history.navigate"] = "Navigate history", ["workspace.enter"] = "Enter workspace",
	["workspace.integrate"] = "Integrate workspace", ["workspace.discard"] = "Discard workspace",
}
local function action_name(operation)
	return action_names[operation] or operation:gsub("%.", " ")
end
local function failure_reason(error)
	if error and error.code == "stale_runtime" then
		return "This request is out of date after a session restart, workspace switch, or conversation history change. Check the result before retrying."
	end
	return error and error.message or "The server did not confirm the outcome."
end
record_command = function(receipt, envelope, live)
	local id = receipt.id or envelope and envelope.id
	local epoch = receipt.serviceEpoch or envelope and envelope.serviceEpoch
	local host_action = envelope and envelope.operation:match("^host%.")
	local target = host_action and (envelope.payload.sessionId or "host") or receipt.sessionId or envelope and envelope.sessionId or session_id
	if not id or not epoch then return end
	local host, channel = owner_key(), hello and hello.channel or vim.env.PI_CONSOLE_CHANNEL or "stable"
	local key = table.concat({ host, channel, target or "", epoch, id }, "/")
	local previous = logs.get(key)
	envelope = envelope or unresolved[id] or previous and previous.envelope
	if previous and previous.envelope == envelope and vim.deep_equal(previous.receipt, receipt) then return end
	local operation = receipt.operation or envelope and envelope.operation
	if not operation then return end
	local status = receipt.status or "unknown"
	local label = action_name(operation)
	local failed = status == "failed" or status == "uncertain" or status == "unknown"
	local message = label .. ": " .. status
	if failed then
		local uncertain = status ~= "failed" or receipt.error and receipt.error.code == "stale_runtime"
		message = (uncertain and ("Completion of " .. label .. " could not be confirmed.") or ("Action " .. label .. " not completed."))
			.. " Reason: " .. failure_reason(receipt.error)
		if operation == "side.draft" or operation:match("^workspace%.review%.") then message = message .. " Local draft retained." end
	end
	local old_status = previous and previous.status
	if previous and (old_status == "completed" or old_status == "failed" or old_status == "uncertain") then
		if status == "accepted" or status == "sending" or status == "unknown" then return end
		if status == old_status and receipt.recoveryAvailable and previous.receipt and not previous.receipt.recoveryAvailable then receipt = previous.receipt end
	end
	local entry = logs.add(failed and "warn" or "info", message, operation_summary(envelope, receipt), {
		key = key, session = target,
		inspect = function()
			if not job or not hello or owner_key() ~= host or hello.channel ~= channel or not host_action and session_id ~= target then
				logs.detail(operation_summary(envelope, receipt) .. "\n\nReconnect to the original host/session to refresh this outcome.")
				return
			end
			local origin = vim.api.nvim_get_current_win()
			request(host_action and "host.status" or "command.status", { serviceEpoch = epoch, commandId = id }, function(ok, result)
				if not vim.api.nvim_win_is_valid(origin) or vim.api.nvim_get_current_win() ~= origin then return end
				logs.detail(operation_summary(envelope, ok and result or receipt) .. (not ok and ("\n\nStatus lookup failed: " .. tostring(result.message)) or ""))
			end)
		end,
	})
	entry.envelope, entry.receipt, entry.status = envelope, receipt, status
	if status == "completed" or status == "failed" or status == "uncertain" then unresolved[id] = nil end
	if live and failed and status ~= old_status then logs.display(message, "warn") end
end
local function record_queue(item)
	local key = table.concat({ owner_key(), session_id, "queue", item.id }, "/")
	local entry = logs.get(key)
	if item.error or entry then
		local message = "Send message: " .. item.status
		if item.error then message = "Message delivery failed or interrupted. Reason: " .. failure_reason(item.error) end
		local _, changed = logs.add(item.error and "warn" or "info", message, queue_summary(item), { key = key, session = session_id })
		if changed and item.error then logs.display(message, "warn") end
	end
end
local function resource_options()
	return { request = request, stamp = stamp, current = function(s) return job and attachment and same_context(s) end, notify = notify, state = state,
		label = current_owner_label() .. "/" .. tostring(hello and hello.channel or ""),
		key = table.concat({ tostring(hello and hello.hostId or owner_key()), tostring(hello and hello.channel or ""),
			tostring(snapshot and snapshot.serviceEpoch), tostring(session_id), tostring(current_revision()),
			tostring(snapshot and snapshot.interactions.runtime and snapshot.interactions.runtime.cwd) }, "/") }
end
local open_workspace_review, open_owner_file
local function owner_resources()
	local resource = resources.new(resource_options())
	resource.review = function(id, pinned) open_workspace_review(id, pinned) end
	resource.edit = function(query, title, filetype, anchor) open_owner_file(resource, query, title, filetype, anchor) end
	return resource
end
function M.complete_files(prefix, callback)
	if session_id then
		if not job or not snapshot or not attachment then callback({ entries = {} }); return end
		return resources.complete(resource_options(), prefix, callback)
	end
	if not job or not hello or not selected_cwd then callback({ entries = {} }); return end
	if not vim.tbl_contains(hello.capabilities or {}, "host.complete") then
		callback({ entries = {}, error = "Host file completion is unavailable." }); return
	end
	local epoch, cwd, connection = hello.serviceEpoch, selected_cwd, job
	local options = resource_options()
	options.key = table.concat({ "host", hello.hostId, hello.channel, epoch, cwd }, "/")
	options.current = function(captured)
		return job == connection and hello and not session_id and not attachment and same_selection(captured)
			and hello.serviceEpoch == epoch and selected_cwd == cwd
	end
	options.request = function(_, query, done)
		return request("host.complete", { serviceEpoch = epoch, cwd = cwd, prefix = query.prefix, offset = query.offset }, function(ok, result)
			done(ok, ok and { data = result } or result)
		end)
	end
	return resources.complete(options, prefix, callback)
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
	record_command({ id = envelope.id, status = "sending" }, envelope)
	if terminal then outcomes[envelope.id] = { callback = terminal, captured = captured or stamp(), lifecycle = operation == "session.kill", transition = operation == "history.navigate", history_refresh = operation == "history.delete" } end
	if feedback_ui.tracks(operation) then
		local entry = submission and submission.entry
		local input_buf = submission and submission.input_buf
		entry = entry or feedback_ui.add(feedback, envelope.id, operation, envelope.payload, session_id,
			snapshot.serviceEpoch, current_revision(), snapshot)
		entry.id, entry.sessionId, entry.serviceEpoch, entry.runtimeRevision = envelope.id, session_id, snapshot.serviceEpoch, current_revision()
		entry.status, entry.sent = "Sending", true
		if valid(input_buf) and operation ~= "side.prompt" then
			layout.set_buffer_lines(ctx, input_buf, { "" }, true)
			vim.bo[input_buf].modified = false
		end
		render()
		if operation == "prompt.submit" then transcript.scroll_to_bottom_unless_focused(ctx) end
		vim.cmd("redraw")
		if not backup() then
			entry.status, entry.error, entry.sent = "Not sent", "Local recovery could not be saved. No command was sent.", false
			record_command({ id = envelope.id, status = "failed", error = { message = entry.error } }, envelope, true)
			unresolved[envelope.id], outcomes[envelope.id] = nil, nil
			render()
			return
		end
	end
	request("command", envelope, function(ok, result)
		record_command(ok and result or { id = envelope.id, status = result.delivery == "not_sent" and "failed" or "unknown", error = result }, envelope, true)
		feedback_ui.receipt(feedback, envelope.id, ok, result)
		-- Keep pending IDs for status recovery, never for blocking a new send.
		if result.delivery == "not_sent" then unresolved[envelope.id] = nil end
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
local function draft_buffer(name, contents, on_save, on_hide, target_win)
	local buf = layout.create_buffer(nil, name, "markdown", true)
	vim.api.nvim_buf_set_lines(buf, 0, -1, false, vim.split(contents or "", "\n", { plain = true }))
	vim.bo[buf].modified = false
	drafts[buf] = name
	local function save()
		if not on_save then notify("Recovered inspect-only draft: copy/review it explicitly before submitting."); return end
		action_connection.run(function() if valid(buf) then on_save(buf) end end)
	end
	vim.api.nvim_create_autocmd("BufWriteCmd", { buffer = buf, callback = save })
	if on_save then
		vim.keymap.set({ "n", "i" }, "<C-CR>", function()
			vim.cmd("stopinsert")
			save()
		end, { buffer = buf, desc = "Submit editor text" })
	end
	if on_hide then
		local hidden = false
		vim.api.nvim_create_autocmd({ "BufHidden", "BufUnload", "BufWipeout" }, { buffer = buf, callback = function()
			if hidden then return end
			hidden = true
			on_hide()
		end })
	end
	if target_win then vim.api.nvim_set_current_win(target_win) else vim.cmd("botright split") end
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
		side_draft = valid(side_input_buf) and text(side_input_buf) or restored_side_draft,
		unresolved = unresolved, pending_host = pending_host, pending_host_select = pending_host_select,
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
	ui = { notify = notify }, logs = { add = function(level, message, details)
		logs.add(level, message, details, { session = session_id })
		logs.display(message, level)
	end },
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
	if state.frontend_visible then
		if not rendered_transcript or rendered_transcript.buf ~= state.transcript_buf then render()
		else statusline.update(ctx); transcript.render(ctx) end
	end
	if sync_pending then vim.schedule(sync_pending) end
end
local function update_status_state()
	local initial = session_id and startup_status and startup_status.session_id == session_id and startup_status or nil
	local defaults = initial or not session_id and startup_options and startup_options.defaults or {}
	local conversation = snapshot and snapshot.conversation
	local statuses = conversation and conversation.statuses or {}
	local pi_state = snapshot and snapshot.piState or {}
	state.session_name = pi_state.sessionName ~= "" and pi_state.sessionName or nil
	state.session_id = session_id
	state.session_cwd = snapshot and snapshot.interactions.runtime and snapshot.interactions.runtime.cwd or selected_cwd
	state.host_name = current_owner_label()
	state.connection_status = job and (hello and "connected" or "connecting") or "disconnected"
	local status_error = snapshot and snapshot.error or not attachment and session_error or nil
	if status_error and state.status_error ~= status_error then notify(status_error, vim.log.levels.ERROR) end
	state.status_error = status_error
	local terminal = snapshot and (snapshot.phase == "stopped" or snapshot.phase == "failed") and snapshot.phase
	state.client_status = attachment and (terminal and ("session " .. terminal) or control_current() and "active" or "view only")
		or (session_id and ("session " .. (session_status or "unattached")) or starting and "starting" or "unstarted")
	if action_connection and action_connection.status then state.client_status = action_connection.status end
	if kill_pending and kill_pending.status == "stopping" then state.client_status = "Stopping session..."
	elseif kill_pending and kill_pending.status == "unknown" then state.client_status = "stop outcome unknown" end
	state.can_kill_session = not kill_pending and not not can_kill_session()
	require("pi-integration.keymaps").update_kill({ state = state, actions = M, buffer = ctx.buffer })
	state.access_mode = (statuses["pi-access-mode"] or ""):match("^Mode: (%w+)$") or defaults.accessMode
	state.integration_mode = (statuses["pi-integration-mode"] or ""):match("^Integration: (%w+)$") or defaults.integrationMode
	state.notification_status = statuses["pi-notifications"]
	if not state.notification_status and defaults.notificationsEnabled ~= nil then
		state.notification_status = defaults.notificationsEnabled and "notify on" or "notify off"
	end
	state.workspace = snapshot and snapshot.workspace or (not session_id and { localCheckout = true, cwd = selected_cwd } or nil)
	local stats_key = state.workspace and state.workspace.id and table.concat({ tostring(session_id), tostring(current_revision()), state.workspace.id }, "/")
	if stats_key ~= workspace_stats_key then state.workspace_diff, workspace_stats_key = nil, stats_key end
	local model = pi_state.model or defaults.model
	state.provider = model and model.provider
	state.model_id = model and model.id
	state.thinking_level = pi_state.thinkingLevel or defaults.thinkingLevel
	state.model_status = statuses["pi-console-model-readiness"] == "unavailable" and "unavailable"
		or (not session_id or initial) and (defaults.modelStatus or (not startup_options and "loading" or nil)) or nil
	if state.model_status == "unavailable" then state.provider, state.model_id = nil, nil end
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
	state.session_stats = conversation and conversation.stats or initial and initial.sessionStats
	if not session_id then
		state.session_stats = { tokens = { input = 0, output = 0 }, cost = 0,
			contextUsage = { tokens = 0, contextWindow = context_window or vim.NIL } }
	end
	-- Retire each startup fallback once its owner value has arrived.
	if initial then
		if statuses["pi-access-mode"] then initial.accessMode = nil end
		if statuses["pi-integration-mode"] then initial.integrationMode = nil end
		if statuses["pi-notifications"] then initial.notificationsEnabled = nil end
		if pi_state.model then initial.model, initial.modelStatus = nil, nil end
		if statuses["pi-console-model-readiness"] == "unavailable" then initial.model, initial.modelStatus = nil, nil end
		if pi_state.thinkingLevel then initial.thinkingLevel = nil end
		if conversation and conversation.stats then initial.sessionStats = nil end
	end
	state.codex_usage = status_data("pi-codex-usage")
	state.spawn_running_count = snapshot and #(snapshot.subagentRuns or {}) or 0
	state.session_activity = attachment and snapshot and snapshot.status or nil
	state.is_loading = job ~= nil and (not hello or session_status == "checking" or session_status == "attaching"
		or session_status == "restoring" or attachment ~= nil and snapshot and snapshot.phase == "initializing")
	local stages = { checking = "checking session", attaching = "receiving session", restoring = "starting worker" }
	state.loading_stage = state.is_loading and (not hello and "connecting" or stages[session_status]
		or snapshot and snapshot.trust and snapshot.trust.state == "pending" and "waiting for trust" or "initializing worker") or nil
	state.is_agent_running = state.session_activity == "Working" or state.session_activity == "Compacting"
	state.is_streaming = attachment ~= nil and pi_state.isStreaming == true
	state.is_retrying = state.session_activity == "Retrying"
	state.activity_label = state.session_activity == "Compacting" and "compacting" or "work"
	state.pending_user_messages = snapshot and snapshot.acceptedQueue.items or {}
	state.queue_edit_item = snapshot and snapshot.acceptedQueue.reservation and snapshot.acceptedQueue.reservation.itemId
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
render = function(metadata_only)
	-- A pending open may detach this frontend. Finish the current state update first.
	if pending_new_session then vim.schedule(function() sync_new_session() end) end
	if not valid(state.transcript_buf) then return end
	local conversation = snapshot and snapshot.conversation
	update_status_state()
	publish_attachment()
	if sync_pending then vim.schedule(sync_pending) end
	if not state.frontend_visible then return end
	layout.update_input_sidebar(ctx)
	local inputs = { messages = conversation and conversation.messages, keys = conversation and conversation.messageKeys,
		partial = conversation and conversation.partialAssistant, tools = conversation and conversation.tools,
		permissions = conversation and conversation.permissions, omittedPermissions = conversation and conversation.omittedPermissions,
		omittedMessages = conversation and conversation.omittedMessages, diagnostics = conversation and conversation.diagnostics,
		feedback = feedback, queue = snapshot and snapshot.acceptedQueue.items,
		buf = state.transcript_buf, nested = state.show_nested_tools, workspace = state.workspace,
		selection = selection, revision = current_revision(), generation = generation }
	local metadata = transcript.metadata_lines(ctx)
	local body_changed = not (metadata_only and rendered_transcript) and not vim.deep_equal(inputs, rendered_transcript)
	local metadata_changed = not vim.deep_equal(metadata, rendered_metadata)
	if body_changed then
		local visible, unplaced = feedback_ui.timeline_messages(feedback, session_id, snapshot)
		if #unplaced > 0 and state.unplaced_submissions ~= #unplaced then
			notify(tostring(#unplaced) .. " unpositioned submissions (:PiLogs)", vim.log.levels.WARN)
		end
		state.unplaced_submissions = #unplaced
		local lines, items = messages.collect_message_lines(ctx, visible, conversation and conversation.tools, transcript_cache)
		local split = {}
		for _, line in ipairs(lines) do
			if line:find("\n", 1, true) then vim.list_extend(split, vim.split(line, "\n", { plain = true }))
			else split[#split + 1] = line end
		end
		transcript.update_lines(ctx, split)
		transcript.apply_collected_transcript_items(ctx, items)
		-- Feedback is local mutable state; owner snapshot sections are immutable.
		inputs.feedback = vim.deepcopy(feedback)
		rendered_transcript = inputs
	elseif metadata_changed then
		transcript.update_metadata(ctx)
	end
	rendered_metadata = metadata
	local side_raw = conversation and conversation.statuses["pi-side"]
	if valid(side_buf) and (side_buf ~= rendered_side_buf or side_raw ~= rendered_side) then
		rendered_side_buf, rendered_side = side_buf, side_raw
		local side = status_data("pi-side")
		if side and side.id and side.id ~= side_id then
			if side_id and valid(side_input_buf) then
				local reset = side_reset_draft
				if reset and reset.id == side_id and reset.buf == side_input_buf and current(reset.captured)
					and vim.api.nvim_buf_get_changedtick(side_input_buf) == reset.tick then
					layout.set_buffer_lines(ctx, side_input_buf, { "" }, true)
					vim.bo[side_input_buf].modified = false
				end
				side_draft_saved = side.draft or ""
				side_reset_draft = nil
			end
			side_id = side.id
		end
		local side_lines = { "# Side conversation", "", "Ctrl+Enter sends. :PiSideNew resets; :PiSideAbort stops.", "" }
		side_permission_items = {}
		require("pi-integration.tool-output").reset(side_permission_state)
		if side then
			table.insert(side_lines, side.running and "Working" or "Idle")
			if side.error then
				table.insert(side_lines, "Side status: " .. tostring(side.error))
			end
			local function permissions_after(key)
				for _, permission in ipairs(side.permissions and side.permissions.items or {}) do
					if permission.afterMessage == key then
						require("pi-integration.permission-output").append({ state = side_permission_state }, side_lines, side_permission_items, permission)
					end
				end
			end
			if side.permissions and (side.permissions.omitted or 0) > 0 then
				table.insert(side_lines, "> Older permission records are omitted from this view.")
			end
			permissions_after(vim.NIL)
			for index, message in ipairs(side.messages or {}) do
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
				permissions_after(side.messageKeys and side.messageKeys[index])
			end
			if side.partialMessage then
				for _, block in ipairs(side.partialMessage.content or {}) do vim.list_extend(side_lines, vim.split(block.text or block.thinking or "", "\n", { plain = true })) end
			end
		end
		side_view.render(side_buf, side_lines)
		side_permission_state.transcript_items = side_permission_items
		transcript.apply_quote_highlights_to_buffer(side_buf, side_permission_state)
	end
	-- Every snapshot is a pure render; never replay event/effect handlers.
	if body_changed or metadata_changed then transcript.render(ctx) end
	if initial_scroll_pending then
		initial_scroll_pending = false
		transcript.scroll_to_bottom_unless_focused(ctx)
	end
	statusline.update(ctx)
end
local function refresh_workspace_stats()
	if not state.frontend_visible or not job or not attachment or not snapshot or not state.workspace or not state.workspace.id then return end
	if stats_pending then return end
	local captured = stamp()
	stats_pending = captured
	request("resource.read", { kind = "workspaceStats", runtimeRevision = captured.revision }, function(ok, result)
		if stats_pending == captured then stats_pending = nil end
		if not job or not attachment or not same_context(captured) then return end
		state.workspace_diff = ok and result.data ~= vim.NIL and result.data or nil
		statusline.update(ctx)
	end)
end
local function apply_snapshot(value)
	if value.sessionId ~= session_id then return end
	observe_authority(value, true)
	local previous = snapshot
	if snapshot and value.serviceEpoch == snapshot.serviceEpoch and value.sequence < snapshot.sequence then return end
	snapshot = snapshots.merge(snapshot, value)
	local same_runtime = previous and previous.serviceEpoch == snapshot.serviceEpoch
		and previous.runtimeRevision == snapshot.runtimeRevision
	state.completion_seq = snapshot.completionSeq or 0
	if not same_runtime then
		state.pending_transcript_scroll = nil
		-- Existing history on attach/reconnect or a replacement runtime is already seen.
		state.seen_seq = state.completion_seq
		state.viewed_seq = nil
	end
	if grant and not control_current() then grant = nil; close_approval() end
	if approval_request then
		local live = false
		for _, item in ipairs(snapshot.interactions.pending) do if item.request.id == approval_request and not item.submitted then live = true end end
		if not live then close_approval() end
	end
	for _, receipt in ipairs(snapshot.commands or {}) do record_command(receipt) end
	for _, item in ipairs(snapshot.acceptedQueue.items or {}) do record_queue(item) end
	feedback_ui.reconcile(feedback, snapshot)
	-- History received while hidden is aligned only when it is first drawn.
	if snapshot.conversation.hydrated and (not previous or not previous.conversation.hydrated) then initial_scroll_pending = true end
	local render_started = vim.uv.hrtime() / 1e6
	render()
	if load_metrics then
		load_metrics.renderMs = (load_metrics.renderMs or 0) + vim.uv.hrtime() / 1e6 - render_started
		if snapshot.phase == "ready" and snapshot.conversation.hydrated then
			local details = vim.tbl_extend("force", {}, load_metrics, { elapsedMs = vim.uv.hrtime() / 1e6 - load_metrics.started,
				worker = snapshot.startupTimings, messages = #snapshot.conversation.messages })
			details.started = nil
			logs.add("info", "Session loading timings", details, { session = session_id, key = "load:" .. generation .. ":" .. selection })
			load_metrics = nil
		end
	end
	if auto_control_selection then
		local runtime = snapshot.interactions.runtime
		if not same_selection(auto_control_selection) or current_controller() or snapshot.error then
			auto_control_selection = nil
		elseif runtime and runtime.active and snapshot.piState and snapshot.piState.sessionId == runtime.sessionId
			and snapshot.piState.sessionFile == runtime.sessionFile then
			-- Attach once as controller if unclaimed, waiting for managed identity
			-- during startup. Never take over or retry after losing control.
			auto_control_selection = nil
			acquire_control(false, stamp())
		end
	end
	if state.frontend_visible then tree.update(tree_ctx) end
	if advance_start then advance_start() end
end
refresh = function(immediate, callback)
	if callback then table.insert(refresh_callbacks, callback) end
	dirty = true
	refresh_urgent = refresh_urgent or immediate == true
	if refreshing or not attachment or not job then return end
	local now = vim.uv.hrtime() / 1000000
	local interval = state.frontend_visible and 100 or 1000
	local delay = refresh_urgent and 0 or math.max(0, last_refresh + interval - now)
	local due = now + delay
	if refresh_scheduled and refresh_due <= due then return end
	refresh_timer = refresh_timer or vim.uv.new_timer()
	refresh_timer:stop()
	refresh_scheduled, refresh_due = true, due
	local gen, target, selected, selected_selection = generation, attachment, session_id, selection
	local ticket = {}
	refresh_ticket = ticket
	refresh_timer:start(math.ceil(delay), 0, vim.schedule_wrap(function()
		if ticket ~= refresh_ticket or gen ~= generation or target ~= attachment or selected ~= session_id or selected_selection ~= selection then return end
		refresh_scheduled, refresh_due = false, nil
		local flight, completed = {}, refresh_callbacks
		refresh_callbacks = {}
		dirty, refreshing, refresh_urgent = false, flight, false
		last_refresh = vim.uv.hrtime() / 1000000
		request("snapshot", snapshots.query(snapshot, hello), function(ok, value)
			if refreshing ~= flight then return end
			refreshing = false
			if gen == generation and target == attachment and selected == session_id and selected_selection == selection then
				if ok then apply_snapshot(value)
				else cancel_new_session("Could not load session directory: " .. (value.message or "Snapshot request failed.")) end
				for _, done in ipairs(completed) do done(ok, value) end
			end
			if dirty then refresh() end
		end)
	end))
end
local function reset_refresh(detached, preserve_body)
	if refresh_timer then refresh_timer:stop() end
	-- Selection changes retain ownership of an outstanding read until its reply;
	-- only a disconnected bridge guarantees that reply can never arrive.
	if detached then refreshing = false end
	refresh_scheduled, dirty, refresh_urgent = false, false, false
	refresh_callbacks = {}
	refresh_ticket, refresh_due, last_refresh = nil, nil, -math.huge
	if not preserve_body then
		transcript_cache, rendered_transcript, rendered_metadata = {}, nil, nil
		rendered_side, rendered_side_buf, initial_scroll_pending = nil, nil, false
	end
end
local function disconnected(reason, details, intentional)
	local entry
	if reason then
		entry = logs.add(intentional and vim.log.levels.INFO or vim.log.levels.WARN, "Connection closed: " .. tostring(reason),
			vim.tbl_extend("force", { host = current_owner_label(), endpoint = M.config.service_remote or M.config.service_root or "local",
				host_id = M.config.expected_host, service_epoch = hello and hello.serviceEpoch, connection_id = hello and hello.connectionId,
				attachment = attachment, generation = generation }, details or {}),
			{ session = session_id, key = "connection:" .. generation })
	end
	cancel_new_session("Connection lost while loading session directory. No new frontend was opened.")
	if action_connection then action_connection.disconnected() end
	-- Creation may have succeeded remotely while its reply was lost. Keep only
	-- a prompt that has never reached prompt.submit; reconcile creation first.
	local waiting_start = pending_host and starting and not starting.context and not starting.busy
		and starting.entry and not starting.entry.sent and starting or nil
	for _, envelope in pairs(unresolved) do
		record_command({ id = envelope.id, status = "unknown", error = { message = "Connection lost before the outcome was confirmed. Reconnect to check its status; nothing will be resent automatically." } }, envelope)
	end
	tree.close(tree_ctx)
	offers = {}
	resources.invalidate()
	generation = generation + 1
	job, attachment, grant, authority, hello, startup_options, startup_status = nil, nil, nil, nil, nil, nil, nil
	startup_options_context, startup_options_pending = nil, nil
	stats_pending, workspace_stats_key, state.workspace_diff = nil, nil, nil
	session_status, session_error = "unattached", nil
	feedback_ui.interrupt(feedback)
	callbacks, outcomes, auto_control_selection, starting, resume_check = {}, {}, nil, waiting_start, nil
	if waiting_start then waiting_start.entry.status = "Waiting for connection" end
	kill_pending = nil
	reset_refresh(true)
	close_approval()
	render()
	return entry
end
attach = function(id)
	if not job then return end
	if pending_new_session and pending_new_session.session ~= id then cancel_new_session() end
	auto_control_selection = nil
	tree.close(tree_ctx)
	offers = {}
	if pending_host then pending_host_select = false end
	resources.invalidate()
	selection = selection + 1
	-- Keep the current body/cache while the replacement snapshot is in flight.
	reset_refresh(false, true)
	if not load_metrics then load_metrics = { started = vim.uv.hrtime() / 1e6 } end
	local gen, selected = generation, selection
	session_status, session_error, state.control_loss_reason = "attaching", nil, nil
	render(true)
	request("attach", { sessionId = id, label = "neovim@" .. vim.fn.hostname() }, function(ok, value)
		if gen ~= generation or selected ~= selection then return end
		if not ok then
			fail_start("Startup attachment failed; submitted text remains in :PiDrafts.")
			session_status, session_error = "unavailable", value.message .. " Use :PiReconnect to retry or :PiSessions to explicitly reopen."
			render()
			return
		end
		session_status, session_error = nil, nil
		close_approval()
		reset_refresh()
		session_id, attachment, grant, snapshot, authority = id, value.attachmentId, nil, nil, nil
		auto_control_selection = stamp()
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
					record_command(receipt)
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
	record_command({ id = envelope.id, status = "sending" }, envelope)
	request("host.command", envelope, function(ok, receipt)
		record_command(ok and receipt or { id = envelope.id, status = receipt.delivery == "not_sent" and "failed" or "unknown", error = receipt }, envelope, true)
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
					if operation == "host.create" and startup_status then startup_status.session_id = session_id end
					feedback_ui.bind(feedback, envelope.id, session_id)
					backup()
					attach(session_id)
				else notify("Host request completed; select the session in :PiSessions. Current view was not changed.") end
			elseif receipt.error then
				fail_start("Startup failed; submitted text remains in :PiDrafts.")
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
				if row.live then attach(session_id); return end
				if row.stopReason == "service_shutdown" and allow_restore and vim.tbl_contains(hello.capabilities, "host.recover") then
					host_operation("host.recover", { sessionId = session_id }); return
				end
			end
			session_status = not row and "unavailable" or row.archived and "archived" or row.deleted and "deleted" or "Stopped"
			session_error = "Session " .. session_status .. ". Use :PiSessions to inspect or explicitly reopen it."
		end
		render()
	end)
end
local function recover_host(allow_restore)
	if not pending_host then return false end
	local envelope, captured = pending_host, stamp()
	session_status, session_error = "checking", nil
	render()
	request("host.status", { serviceEpoch = envelope.serviceEpoch, commandId = envelope.id }, function(ok, receipt)
		if pending_host ~= envelope then return end
		if ok then record_command(receipt, envelope) end
		local select_result = pending_host_select == true
		if ok and receipt.result then
			pending_host, pending_host_select = nil, nil
			if select_result and same_selection(captured) then
				session_id = receipt.result.sessionId
				feedback_ui.bind(feedback, envelope.id, session_id)
				recover_selection(allow_restore)
			elseif same_selection(captured) then
				session_status, session_error = nil, nil
			end
		else
			fail_start("Session creation could not be confirmed; submitted text remains in :PiDrafts. Inspect :PiHostRequest before retrying.")
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
	load_metrics = { started = vim.uv.hrtime() / 1e6 }
	local stderr = ""
	local disconnect_entry
	local function update_disconnect(details)
		disconnect_entry = disconnect_entry or logs.get("connection:" .. gen)
		if disconnect_entry then
			logs.add(disconnect_entry.level, disconnect_entry.message, vim.tbl_extend("force", disconnect_entry.details, details),
				{ session = disconnect_entry.session, key = disconnect_entry.key })
		end
	end
	local function record(value, frame)
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
				notify("Host identity changed; confirm in Hosts before selecting."); M.detach(); return
			end
			hello = result
			if load_metrics then load_metrics.connectionMs = vim.uv.hrtime() / 1e6 - load_metrics.started end
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
			local pending = callbacks[value.id]; callbacks[value.id] = nil
			if load_metrics and pending and (pending.method == "attach" or pending.method == "snapshot") then
				load_metrics.snapshotWaitMs = (load_metrics.snapshotWaitMs or 0) + vim.uv.hrtime() / 1e6 - pending.started
				load_metrics.bytes = (load_metrics.bytes or 0) + frame.bytes
				load_metrics.decodeMs = (load_metrics.decodeMs or 0) + frame.decodeMs
			end
			if value.success == false and not (pending and (pending.method == "command" or pending.method == "host.command")) then
				local report = pending and pending.quiet and log or notify
				local message = value.error.code .. ": " .. value.error.message
				if value.error.code == "stale_runtime" then message = "Action " .. action_name(pending and pending.method or "Session request") .. " not completed. Reason: " .. failure_reason(value.error) end
				report(message, vim.log.levels.WARN)
			end
			if value.success and pending and pending.method == "command.status" then record_command(value.result) end
			if pending then pending.callback(value.success, value.success and value.result or value.error) end
		elseif value.type == "update" then
			if value.update.sessionId ~= session_id then return end
			local close = value.update.closeFrontend
			if close and close.attachmentId == attachment and hello and value.update.serviceEpoch == hello.serviceEpoch then
				if backup() and can_close_frontend() then
					M.detach()
					vim.cmd("qall!")
				end
				return
			end
			local old_revision = current_revision()
			local authority_updated = observe_authority(value.update, false)
			if old_revision ~= current_revision() then close_approval() end
			local receipt = value.update.command
			if receipt then
				record_command(receipt, nil, true)
				feedback_ui.receipt(feedback, receipt.id, true, receipt)
				render()
			end
			if receipt and receipt.status ~= "accepted" and outcomes[receipt.id] then
				local outcome = outcomes[receipt.id]; outcomes[receipt.id] = nil
				if outcome_current(outcome, receipt) then outcome.callback(receipt) end
			end
			if authority_updated and value.update.owner then
				-- Snapshots can overtake queued updates. Only accepted authority may
				-- revoke local callbacks before the coalesced read.
				if grant and not control_current() then
					grant = nil
					close_approval()
					update_status_state()
					statusline.update(ctx)
				end
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
						elseif effect.type == "extension_signal" and effect.key == "pi-spawn-notification" then
							local decoded, intent = pcall(vim.json.decode, effect.value or "")
							if decoded and type(intent) == "table" and type(intent.message) == "string" and #intent.message <= 4096 then
								notify(intent.message, intent.level == "error" and vim.log.levels.ERROR or intent.level == "warning" and vim.log.levels.WARN or vim.log.levels.INFO)
							end
						elseif effect.type == "extension_signal" and effect.key == "pi-history-changed" then refresh() end
					end)
				end
			end
			local change = value.update.conversation
			local event = change and change.type == "event" and change.event
			local streaming = event and (event.type == "message_update" or event.type == "tool_execution_update"
				or event.type == "extension_ui_request" and (event.method == "setStatus" or event.method == "setWidget"))
			local immediate = value.update.owner or receipt or value.update.acceptedQueue
				or change and not streaming and change.type ~= "status" and change.type ~= "widget"
			refresh(not not immediate)
		elseif value.type == "control_lost" then
			if value.sessionId == session_id and hello and value.serviceEpoch == hello.serviceEpoch
				and value.attachmentId == attachment and (not grant or value.grantId == grant.grantId) then
				grant = nil
				control_loss_generation = control_loss_generation + 1
				state.control_loss_reason = tostring(value.reason)
				notify("Control lost: " .. state.control_loss_reason, vim.log.levels.WARN)
				close_approval()
				render()
			end
		elseif value.type == "disconnected" then
			disconnect_entry = disconnected(value.message or "Service disconnected", { code = value.code, connection_id = value.connectionId })
		end
	end
	local consume = require("pi-integration.service-frames").new(function(value, frame)
		local handled, err = xpcall(function() record(value, frame) end, debug.traceback)
		if not handled then notify("Service UI error: " .. tostring(err), vim.log.levels.ERROR); M.detach(); return false end
		return gen == generation
	end, function(message) notify(message); M.detach() end)
	local started = vim.fn.jobstart(args, {
		stdin = "pipe",
		on_stdout = function(_, chunks)
			if gen == generation then consume(chunks) end
		end,
		on_stderr = function(_, chunks)
			stderr = (stderr .. table.concat(chunks, "\n")):sub(-4096)
			update_disconnect({ stderr = stderr })
		end,
		on_exit = function(_, code)
			if gen == generation then
				disconnect_entry = disconnected("Bridge exited unexpectedly (exit " .. tostring(code) .. ")")
			end
			update_disconnect({ exit_code = code, stderr = stderr })
		end,
	})
	if started <= 0 then disconnected("Could not start Node bridge", { jobstart_result = started }); return end
	job = started
end

close_bridge = function(reason, intentional)
	local old = job
	disconnected(reason, nil, intentional)
	if old then vim.fn.jobstop(old) end -- Only the relay, never a Pi worker.
end
function M.detach(reason)
	cancel_new_session()
	action_connection.cancel()
	fail_start("Startup cancelled; submitted text remains in :PiDrafts.")
	close_bridge(type(reason) == "string" and reason or nil, true)
end
function M.reconnect()
	action_connection.cancel()
	close_bridge()
	recovery_requested = true
	connect()
end
function M.host_disabled(identity, target, reason)
	local endpoint_match = target and target.service_remote == M.config.service_remote and target.service_root == M.config.service_root
		and (not identity or M.config.expected_host == identity)
	if endpoint_match or identity and M.config.expected_host == identity then
		M.detach(job and reason or nil)
	end
end
function M.select_owner(target, id, resume, cwd)
	assert(M.config.role == "conversation", "Only conversation frontends can select a host")
	local host_changed = target.expected_host ~= M.config.expected_host or target.service_root ~= M.config.service_root
		or target.service_remote ~= M.config.service_remote
	local settings = not host_changed and not session_id and not id and pending_settings or {}
	local switching = host_changed or id ~= session_id or cwd ~= nil or resume
		or target.service_root ~= M.config.service_root or target.service_remote ~= M.config.service_remote
	if switching then
		if not backup() then return end
		side_view.hide()
		side_buf, side_input_buf, side_context, side_id = nil, nil, nil, nil
		side_draft_saved, side_draft_pending, side_after_draft, restored_side_draft = nil, nil, nil, nil
		state.pending_transcript_scroll = nil
		-- The old selection's input must remain recoverable after new autosaves.
		recovery_id = nil
		owner_states[owner_key()] = { unresolved = unresolved, feedback = feedback,
			pending_host = pending_host, pending_host_select = false }
		M.detach()
		M.config.service_root, M.config.service_remote = target.service_root, target.service_remote
		M.config.expected_host = target.expected_host
		local saved = owner_states[owner_key()] or {}
		unresolved, feedback = saved.unresolved or {}, saved.feedback or {}
		pending_host, pending_host_select = saved.pending_host, false
		session_id, resume_requested, selected_cwd, recovery_requested = id, resume, cwd, false
		snapshot, hello, pending_settings = nil, nil, settings
		state.control_loss_reason = nil
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
acquire_control = function(takeover, captured)
	if not same_context(captured) or captured.controller ~= (current_controller() and current_controller().grantId) then
		notify("Attachment/controller changed; request control again for this session."); return
	end
	command(takeover and "control.takeover" or "control.acquire", takeover and { confirmed = true } or {}, function(ok)
		if not ok or not same_context(captured) then fail_start("Startup control was not acquired; submitted text remains in :PiDrafts."); return end
		local loss_generation = control_loss_generation
		request("grant", {}, function(found, value)
			if not found or not same_context(captured) or value == vim.NIL or loss_generation ~= control_loss_generation then
				fail_start("Startup control was not acquired; submitted text remains in :PiDrafts."); return
			end
			grant, state.control_loss_reason = value, nil
			refresh(true, function(synced)
				if not synced then fail_start("Startup synchronization failed; submitted text remains in :PiDrafts."); return end
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
		vim.ui.select({ "Take over", "Cancel" }, { prompt = "Take control from " .. controller.label .. "? Accepted work continues." }, function(choice)
			if choice == "Take over" then acquire_control(true, captured) end
		end)
	else acquire_control(false, captured) end
end
local function submit_input(original, entry)
	local statuses = snapshot and snapshot.conversation and snapshot.conversation.statuses or {}
	if statuses["pi-console-model-readiness"] == "unavailable" and not original:match("^%s*/") then
		notify("Model unavailable. Select the intended model before submitting; text was not sent.")
		return
	end
	local id = command("prompt.submit", { text = original }, nil, nil, nil,
		{ entry = entry, input_buf = not entry and text(state.input_buf) == original and state.input_buf or nil })
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
				if starting == start then fail_start("Startup settings did not complete; submitted text remains in :PiDrafts. Inspect :PiLogs before retrying.") end
			end
			local id = command(operation, payload, function(ok) if not ok then failed() end end, start.context, function(receipt)
				if starting ~= start then return end
				if receipt.status ~= "completed" then failed(); return end
				pending_settings[operation] = nil
				start.busy = false
				if operation == "model.set" then refresh() else advance_start() end
			end)
			if not id then failed() end
			return
		end
	end
	local statuses = snapshot.conversation and snapshot.conversation.statuses or {}
	if statuses["pi-console-model-readiness"] == "unavailable" then
		fail_start("Model unavailable; submitted text remains in :PiDrafts. Select the intended model before resending."); return
	end
	starting = nil
	submit_input(start.input, start.entry)
	render()
end
function M.submit_prompt(original)
	original = original or text(state.input_buf)
	local trimmed = vim.trim(original)
	if trimmed == "" then return end
	if starting then notify("Session startup is already pending; input remains local."); return end
	if not session_id then
		if not hello or not job then notify("Connect to a host before submitting."); return end
		if not selected_cwd then notify("Choose a directory with :PiCd before submitting."); return end
		if pending_host then notify("Host request unresolved; inspect :PiHostRequest before submitting."); return end
		if startup_options and startup_options.defaults.modelStatus == "unavailable" and not pending_settings["model.set"] then
			notify("Model unavailable. Select the intended model before submitting; text remains local."); return
		end
	elseif next(pending_settings) then
		if not control_current() then notify("Use :PiControl before applying pending settings and submitting."); return end
	else submit_input(original); return end
	if not session_id then
		-- Preserve the displayed selection across allocation and partial snapshots.
		startup_status = { accessMode = state.access_mode, integrationMode = state.integration_mode,
			notificationsEnabled = state.notification_status and state.notification_status == "notify on",
			model = state.model_id and { provider = state.provider, id = state.model_id },
			modelStatus = state.model_status, thinkingLevel = state.thinking_level, sessionStats = state.session_stats }
	end
	local entry = feedback_ui.add(feedback, uid(), "prompt.submit", { text = original }, session_id, hello.serviceEpoch, current_revision(), snapshot)
	entry.status = "Creating session"
	starting = { input = original, entry = entry }
	if text(state.input_buf) == original then
		layout.set_buffer_lines(ctx, state.input_buf, { "" }, true)
		vim.bo[state.input_buf].modified = false
	end
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
		vim.ui.select({ "Allow a new host request", "Keep protected" }, { prompt = "Existing request may already have created/resumed a session; review its outcome first." }, function(choice)
			if choice == "Allow a new host request" and pending_host == envelope then pending_host, pending_host_select = nil, nil end
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
					if not reservation_id or not current(captured) then return end
					local editor = { id = reservation_id, captured = captured }
					queue_editor = editor
					local expected_revision = item.revision
					-- Only this editor's acknowledged edit advances its revision;
					-- snapshots must not authorize saving over another edit/dispatch.
					editor.buf = draft_buffer(scratch_name("queue-draft"), item.text, function(buf)
						if queue_editor ~= editor then notify("Queue editing pause ended; reopen the queue before saving. Draft retained."); return end
						local submitted = text(buf)
						command("queue.edit", { itemId = item.id, expectedRevision = expected_revision, text = submitted }, function(saved, edit_receipt)
							if saved and edit_receipt.result and edit_receipt.result.queueItemId == item.id then
								expected_revision = edit_receipt.result.queueItemRevision
								if valid(buf) and text(buf) == submitted then vim.bo[buf].modified = false end
							end
						end, captured)
					end, function()
						if queue_editor == editor then queue_editor = nil end
						if current(captured) then command("queue.release", { reservationId = reservation_id }, nil, captured) end
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
	return request_data.method .. ": " .. preview(title)
end
local function dialog_preview(value, lines, label)
	local data = dialog_description(value)
	if not data then fields(lines, { text = value }, { { "text", label } }); return end
	local origin = type(data.provenance) == "table" and data.provenance or {}
	if origin.workerId then
		fields(lines, { worker = origin.workerId, assignment = origin.assignmentId,
			workspace = origin.workspaceId or "(none)", request = origin.requestId },
			{ { "worker", "Worker" }, { "assignment", "Assignment" }, { "workspace", "Workspace" }, { "request", "Request ID" } })
	end
	fields(lines, data, { { "title", "Title" }, { "prompt", "Prompt" }, { "tool", "Tool" },
		{ "request", "Request" }, { "summary", "Summary" }, { "path", "Access scope" },
		{ "directory", "Command directory" }, { "mode", "Mode" }, { "preview", "Preview" } })
	for choice, contents in pairs(data.previews or {}) do
		fields(lines, { text = contents }, { { "text", tostring(choice) } })
	end
end
local function effect_summary(effect)
	local lines = { "# Offer", "" }
	fields(lines, effect, { { "type", "Type" }, { "text", "Editor text" }, { "message", "Message" }, { "level", "Level" }, { "key", "Signal" } })
	if effect.type == "extension_signal" then
		if effect.key == "pi-spawn-notification" then
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
		if not dialogs_ready() then notify("Waiting for the current session state."); refresh(); return end
		if approval_request then
			pending_picker.restore(ctx)
			return
		end
		for _, item in ipairs(snapshot.interactions.pending) do
			if not item.submitted and not pending_replies[item.request.id] then open_pending(item); return end
		end
		notify("No pending request.")
		return
	end
	local item
	for _, candidate in ipairs(snapshot.interactions.pending) do
		if not candidate.submitted then item = candidate; break end
	end
	if not item then notify("No pending request."); return end
	close_approval()
	local lines = { "# Pending request", "", request_label(item), "", "Take control to answer (:PiControl).", "" }
	dialog_preview(item.request.title, lines, "Title")
	dialog_preview(item.request.message, lines, "Message")
	fields(lines, item.request, { { "prefill", "Initial text" }, { "placeholder", "Placeholder" } })
	for _, option in ipairs(item.request.options or {}) do table.insert(lines, "- " .. option) end
	if item.tag and item.tag.deadline then table.insert(lines, "Deadline: " .. os.date("%Y-%m-%d %H:%M:%S", math.floor(item.tag.deadline / 1000))) end
	local approval_buf = layout.create_buffer(nil, scratch_name("approval"), "markdown", false)
	layout.set_buffer_lines(ctx, approval_buf, lines, false)
	local width = math.max(1, math.min(100, vim.o.columns - 4))
	local height = math.max(1, math.min(30, vim.o.lines - 4))
	approval_win = vim.api.nvim_open_win(approval_buf, true, {
		relative = "editor", style = "minimal", border = "rounded", width = width, height = height,
		row = math.floor((vim.o.lines - height - 2) / 2), col = math.floor((vim.o.columns - width - 2) / 2),
	})
	vim.keymap.set("n", "q", close_approval, { buffer = approval_buf })
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
local function new_session_cwd()
	local cwd
	if session_id then
		-- New conversations must not inherit another session's task worktree.
		cwd = snapshot and snapshot.workspace and snapshot.workspace.directory
	else
		cwd = selected_cwd
	end
	if type(cwd) == "string" and cwd ~= "" then return cwd end
end
sync_new_session = function()
	local pending = pending_new_session
	if not pending then return end
	-- Attachment startup changes the attachment/selection stamps, but keeps this target.
	if pending.generation ~= generation or pending.session ~= session_id then cancel_new_session(); return end
	local failure = snapshot and (snapshot.error
		or (snapshot.phase == "failed" or snapshot.phase == "stopped" or snapshot.phase == "stopping") and "Session is " .. snapshot.phase)
		or not attachment and session_error
	if failure then cancel_new_session("Could not load session directory: " .. failure); return end
	local cwd = new_session_cwd()
	if not cwd then return end
	cancel_new_session()
	pending.open(cwd)
end
local function with_new_session_cwd(open)
	if pending_new_session then return end
	local cwd = new_session_cwd()
	if cwd then open(cwd); return end
	if not session_id then notify("Choose a directory with :PiCd first."); return end
	if not job then notify("Connect to the session host before loading its directory."); return end
	local pending = { open = open, generation = generation, session = session_id, timer = vim.uv.new_timer() }
	pending_new_session = pending
	sync_new_session()
	if pending_new_session ~= pending then return end
	notify("Loading session directory...")
	pending.timer:start(15000, 0, vim.schedule_wrap(function()
		if pending_new_session == pending then
			cancel_new_session("Timed out loading session directory. No new frontend was opened; try again after the session is ready.")
		end
	end))
	refresh(true)
end
function M.new_session()
	if M.config.role ~= "conversation" then return require("pi-integration.service-hosts").new_conversation() end
	with_new_session_cwd(function(cwd) M.select_owner(M.config, nil, false, cwd) end)
end
function M.change_cwd(path)
	if not hello or not job then notify("Connect to a host before choosing its directory."); return end
	local captured, epoch = stamp(), hello.serviceEpoch
	if path then
		request("host.directories", { serviceEpoch = epoch, path = path, offset = 0 }, function(ok, page)
			if not hello or hello.serviceEpoch ~= epoch or not same_selection(captured) then return end
			if ok then M.select_owner(M.config, nil, false, page.path)
			else notify(page.message or "Directory unavailable", vim.log.levels.WARN) end
		end)
		return
	end
	require("pi-integration.directory-history").owner_input({ label = current_owner_label(),
		key = (vim.env.PI_CONSOLE_CHANNEL or "stable") .. "/" .. hello.hostId,
		current = function() return hello and hello.serviceEpoch == epoch and same_selection(captured) end,
		request = function(query, callback)
			request("host.directories", vim.tbl_extend("force", query, { serviceEpoch = epoch }), callback)
		end }, function(cwd)
		if hello and hello.serviceEpoch == epoch and same_selection(captured) then M.select_owner(M.config, nil, false, cwd) end
	end)
end
function M.restart()
	if not session_id then notify("Connection ready; no conversation worker exists yet."); return end
	local captured, label = stamp(), "Restart conversation worker"
	vim.ui.select({ label, "Cancel" }, { prompt = label .. " using the running server build? Active work is interrupted; history/workspaces and recovery text remain." }, function(choice)
		if choice == label then command("session.restart", { confirmed = true }, nil, captured) end
	end)
end
function M.detach_frontend()
	if not can_close_frontend() or not backup() then return end
	vim.cmd("qall!")
end
function M.close_unstarted(expected_pid)
	if expected_pid ~= vim.uv.os_getpid() or M.config.role ~= "conversation" then return false, "Frontend changed; select the action again" end
	if session_id then return false, "Frontend now has a session; select the action again" end
	if not can_close_frontend() then return false, "Save unrelated modified buffers before closing the frontend" end
	if not backup() then return false, "Could not preserve local drafts; frontend left open" end
	-- Reply to the overview before exiting, and recheck after yielding to input.
	vim.schedule(function()
		if session_id then notify("Frontend now has a session; select the action again."); return end
		M.detach_frontend()
	end)
	return true
end
function M.quit()
	if not session_id then return M.detach_frontend() end
	local captured = stamp()
	vim.ui.select({ "Detach", "Stop", "Cancel" }, { prompt = "Close frontend:" }, function(choice)
		if choice == "Stop" then
			if not same_selection(captured) then notify("Session changed; choose the action again."); return end
			M.kill_session()
		elseif choice == "Detach" then M.detach_frontend() end
	end)
end
function M.kill_session()
	if kill_pending then notify("Stop already pending; no duplicate request sent."); return end
	if not can_kill_session() then notify("Stop requires control of a live session (:PiControl)."); return end
	if not can_close_frontend() then return end
	local captured, label = stamp(), "Stop session"
	kill_pending = captured
	captured.status = "confirming"
	vim.ui.select({ label, "Cancel" }, { prompt = "Stop session and close its controller?" }, function(choice)
		if kill_pending ~= captured then return end
		if choice ~= label or not current(captured) or not can_kill_session() or not can_close_frontend() then
			kill_pending = nil
			render()
			return
		end
		captured.status = "stopping"
		render()
		local sent = command("session.kill", { confirmed = true }, function(ok, result)
			if kill_pending ~= captured or not same_selection(captured) or ok then return end
			if result.delivery == "not_sent" then kill_pending = nil
			else
				captured.status = "unknown"
			end
			render()
		end, captured, function(receipt)
			if kill_pending ~= captured then return end
			if receipt.status == "uncertain" then captured.status = "unknown" else kill_pending = nil end
			if receipt.status == "completed" then
				local preserved = backup()
				M.detach()
				if preserved and can_close_frontend() then vim.cmd("qall!") end
			else render() end
		end)
		if sent then notify("Stopping session...")
		else kill_pending = nil; render() end
	end)
end
function M.new_session_window()
	with_new_session_cwd(function(cwd)
		local opened, err = require("pi-integration.backends.tmux").launch_service(M.config.launcher, M.config, nil, cwd)
		if not opened then notify(err) end
	end)
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
	vim.ui.select(values, { prompt = label .. (session_id and "" or " (pending)") }, function(value)
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
local function host_options_current(context)
	return context and hello and job and same_selection(context.captured)
		and context.epoch == hello.serviceEpoch and context.cwd == selected_cwd
end
host_options = function(callback, force)
	if not hello or not job then notify("Connect to a host to read its model options."); return end
	if not vim.tbl_contains(hello.capabilities or {}, "host.options") then unavailable("Pre-start model options"); return end
	local captured = stamp()
	local now = vim.uv.hrtime() / 1000000
	if not force and startup_options and host_options_current(startup_options_context)
		and now < startup_options_context.expires then
		if callback then callback(startup_options, captured) end
		return
	end
	startup_options, startup_options_context = nil, nil
	local pending = startup_options_pending
	if host_options_current(pending) then
		if force and not pending.force then
			-- Refresh after the earlier discovery finishes, so it cannot repopulate stale metadata.
			table.insert(pending.callbacks, function(_, _, err)
				if host_options_current(pending) then host_options(callback, true)
				elseif callback then callback(nil, captured, err) end
			end)
		elseif callback then table.insert(pending.callbacks, callback) end
		return
	end
	local context = { captured = captured, cwd = selected_cwd, epoch = hello.serviceEpoch,
		force = force, callbacks = callback and { callback } or {} }
	startup_options_pending = context
	request("host.options", { serviceEpoch = context.epoch, cwd = context.cwd, refresh = force or nil }, function(ok, data)
		if startup_options_pending == context then startup_options_pending = nil end
		local err
		if not host_options_current(context) then
			err = { message = "Host selection changed." }
		elseif not ok then
			err = data
			startup_options = { defaults = { modelStatus = "unavailable" }, models = {} }
			render()
		else
			-- Start the remaining lifetime at request dispatch, conservatively allowing for transit time.
			context.expires = now + math.max(0, tonumber(data.cacheTtlMs) or 0)
			startup_options, startup_options_context = data, context
			render()
		end
		for _, done in ipairs(context.callbacks) do done(not err and data or nil, captured, err) end
	end)
end
function M.refresh_options()
	if session_id then notify("Options refresh is for unstarted sessions; live sessions read their own runtime."); return end
	host_options(function(data) if data then notify("Host options refreshed.") end end, true)
end
function M.pick_model()
	local read = not session_id and host_options or function(callback) owner_read("models", callback) end
	read(function(data, captured)
		if not data then return end
		if #data.models == 0 then notify("Pi found no available models on this host.", vim.log.levels.WARN); return end
		vim.ui.select(data.models, { prompt = "Model", format_item = function(model) return model.provider .. "/" .. model.id end }, function(model)
			if model then setting("model.set", { provider = model.provider, modelId = model.id }, captured) end
		end)
	end)
end
function M.pick_thinking()
	if not session_id then
		host_options(function(data, captured)
			if not data then return end
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
		vim.ui.select(data.levels, { prompt = "Thinking level" }, function(level)
			if level then setting("thinking.set", { level = level }, captured) end
		end)
	end)
end
local function submit_draft(operation, buf, captured, submitted, submitted_tick)
	submitted = submitted or text(buf)
	submitted_tick = submitted_tick or vim.api.nvim_buf_get_changedtick(buf)
	if vim.trim(submitted) == "" then return end
	local function completed(receipt)
		if operation ~= "side.prompt" or receipt.status == "accepted" then return end
		side_prompt_pending = nil
		if receipt.status == "completed" and current(captured) and buf == side_input_buf then
			side_draft_saved = ""
			if vim.api.nvim_buf_get_changedtick(buf) == submitted_tick then
				layout.set_buffer_lines(ctx, buf, { "" }, true)
				vim.bo[buf].modified = false
			end
		end
		if (receipt.status == "completed" or receipt.status == "failed") and current(captured) and buf == side_input_buf then save_side_draft() end
	end
	local id = command(operation, { text = submitted }, function(ok, receipt)
		if ok then completed(receipt)
		elseif operation == "side.prompt" and receipt.delivery == "not_sent" then side_prompt_pending = nil end
	end, captured, completed, { input_buf = buf })
	if operation == "side.prompt" then side_prompt_pending = id end
end
local function native_draft(operation, initial)
	local captured = stamp()
	local buf = draft_buffer(scratch_name(operation), initial or "", function(buf)
		submit_draft(operation, buf, captured)
	end)
	owner_resources().bind(buf)
end
function M.steer(initial)
	if not snapshot or not snapshot.conversation.execution.running then notify("Steering requires an active turn."); return end
	native_draft("steering.submit", initial)
end
function M.follow_up() native_draft("followUp.submit") end
save_side_draft = function(after)
	if not valid(side_input_buf) or not side_context or not current(side_context) then return end
	if after then side_after_draft = after end
	if side_draft_pending or side_prompt_pending then return end
	local value, captured, input = text(side_input_buf), side_context, side_input_buf
	if value == side_draft_saved then
		local action = side_after_draft; side_after_draft = nil
		if action then action() end
		return
	end
	local pending = {}
	side_draft_pending = pending
	local function finished(receipt)
		if side_draft_pending ~= pending or receipt.status == "accepted" then return end
		side_draft_pending = nil
		if receipt.status == "completed" and current(captured) and input == side_input_buf then
			side_draft_saved = value
			if text(input) ~= value or side_after_draft then save_side_draft() end
		else
			side_after_draft = nil
		end
	end
	pending.id = command("side.draft", { text = value }, function(ok, receipt)
		if ok then finished(receipt)
		elseif receipt.delivery == "not_sent" then side_draft_pending, side_after_draft = nil, nil end
	end, captured, finished)
	if not pending.id then side_draft_pending, side_after_draft = nil, nil end
end
function M.side_prompt()
	if not valid(side_buf) or not valid(side_input_buf) or not same_context(side_context)
		or side_context.token ~= (grant and grant.token) then
		side_view.hide()
		side_context, side_id = stamp(), nil
		side_draft_pending, side_after_draft, side_prompt_pending = nil, nil, nil
		local side = status_data("pi-side")
		side_draft_saved = side and side.draft or ""
		local initial = restored_side_draft or side_draft_saved
		restored_side_draft = nil
		side_buf = layout.create_buffer(ctx, scratch_name("side-transcript"), "markdown", false)
		side_input_buf = layout.create_buffer(ctx, scratch_name("side-input"), "markdown", true)
		layout.set_buffer_lines(ctx, side_input_buf, vim.split(initial, "\n", { plain = true }), true)
		vim.bo[side_input_buf].modified = false
		drafts[side_input_buf] = vim.api.nvim_buf_get_name(side_input_buf)
		local captured, input = side_context, side_input_buf
		local function submit()
			if not current(captured) then
				notify("Stale editor/dialog; its text remains a local draft.", vim.log.levels.WARN); return
			end
			local side = status_data("pi-side")
			if side and side.running then notify("The side conversation is working. Wait or use :PiSideAbort."); return end
			if side_prompt_pending or side_after_draft then notify("Wait for the pending side message to finish submitting."); return end
			local submitted, tick = text(input), vim.api.nvim_buf_get_changedtick(input)
			save_side_draft(function()
				if current(captured) and input == side_input_buf then submit_draft("side.prompt", input, captured, submitted, tick) end
			end)
		end
		vim.keymap.set({ "n", "i" }, "<C-CR>", function()
			action_connection.run(submit)
		end, { buffer = input, desc = "Send side message" })
		vim.api.nvim_create_autocmd("BufHidden", { buffer = input, callback = function() save_side_draft() end })
		local resource = owner_resources()
		vim.keymap.set("n", "<CR>", function()
			if require("pi-integration.utils.markdown-links").follow(nil, resource) then return end
			local item = require("pi-integration.tool-groups").item_at_line(side_permission_items, vim.api.nvim_win_get_cursor(0)[1])
			if item then require("pi-integration.tool-output").open_float({ state = side_permission_state,
				ui = { notify = notify }, window = { parent = vim.api.nvim_get_current_win() }, resources = resource }, item.output_id) end
		end, { buffer = side_buf, desc = "Inspect side permission" })
		for _, buf in ipairs({ side_buf, side_input_buf }) do
			resource.bind(buf)
			require("pi-integration.markdown-render").prepare_buffer(buf, { latex = buf == side_buf })
			vim.keymap.set("n", "<leader>n", M.new_side, { buffer = buf, desc = "New side conversation" })
			vim.keymap.set("n", "<leader>pa", M.restore_pending_action, { buffer = buf, desc = "Restore pending action" })
		end
	end
	side_view.open(side_buf, side_input_buf)
	render()
end
function M.toggle_side()
	if side_view.visible() then side_view.hide() else M.side_prompt() end
end
function M.new_side()
	local captured, focus = stamp(), nil
	local function release_focus()
		if focus then focus:release(); focus = nil end
	end
	vim.ui.select({ "New side conversation", "Cancel" }, {
		prompt = "Stop and replace the side conversation?",
		on_create = function(event)
			if side_view.visible() then focus = require("pi-integration.floats").focus_group({ event.winid }) end
		end,
		on_close = release_focus,
	}, function(choice)
		release_focus()
		if choice == "New side conversation" then
			if valid(side_input_buf) and side_context and current(side_context) then
				side_reset_draft = { id = side_id, buf = side_input_buf, tick = vim.api.nvim_buf_get_changedtick(side_input_buf), captured = captured }
				save_side_draft(function() command("side.reset", {}, nil, captured) end)
			else command("side.reset", {}, nil, captured) end
		end
	end)
end
function M.abort_side() command("side.abort", {}) end
function M.pick_spawn()
	local data, captured = status_data("pi-spawn-runs"), stamp()
	vim.ui.select(data and data.runs or {}, { prompt = "Subagents", format_item = run_label }, function(run)
		if not run or not same_context(captured) then return end
		local details = {}
		fields(details, run, { { "status", "Status" }, { "progress", "Latest activity" }, { "prompt", "Task" },
			{ "error", "Error" }, { "cleanupError", "Cleanup error" },
			{ "startedAt", "Started" }, { "completedAt", "Completed" },
			{ "joined", "Joined" }, { "cancellationRequested", "Cancelled without joining" }, { "settled", "Cleanup finished" },
			{ "integration", "Integration" }, { "integrationReason", "Integration details" }, { "worktreePath", "Retained worktree" } })
		fields(details, run.integrationBlock, { { "integration", "Integration blocked" }, { "reason", "Reason" } })
		vim.ui.select({ "Artifacts", "Inspect", "Join", "Stop" }, {
			prompt = run_label(run), preview_title = run_label(run),
			preview_text = table.concat(details, "\n"), preview_filetype = "markdown",
		}, function(action)
			if not same_context(captured) then return end
			if action == "Artifacts" then require("pi-integration.spawn-artifacts").pick_run({ state = state, ui = { notify = notify }, resources = owner_resources() }, run, function() end)
			elseif action == "Inspect" then
				local lines = { "# Subagent", "" }
				fields(lines, run, { { "agent", "Agent" }, { "role", "Role" }, { "status", "Status" },
					{ "prompt", "Task" }, { "startedAt", "Started" }, { "completedAt", "Completed" },
					{ "accessMode", "Access mode" }, { "isolation", "Isolation" }, { "mode", "Interaction mode" },
					{ "error", "Error" }, { "cleanupError", "Cleanup error" }, { "progress", "Progress" },
					{ "joined", "Joined" }, { "joinRequested", "Join requested" }, { "cancellationRequested", "Cancelled without joining" },
					{ "settled", "Cleanup finished" }, { "integration", "Integration" },
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
	vim.ui.select({ "Inspect state", "Enter", "Integrate and return", "Discard" }, { prompt = "Workspace" }, function(action)
		if action == "Inspect state" then
			local lines = { "# Workspace", "" }
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
open_owner_file = function(resource, query, title, filetype, anchor)
	resources.edit({ owner = hello and hello.hostId, channel = hello and hello.channel,
		request = request, stamp = stamp, current = function(s) return job and attachment and same_context(s) end,
		control_stamp = stamp, command = command, draft = draft_buffer, notify = notify }, resource, query, title, filetype, anchor)
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
		if not ok then notify(result.message or "Workspace reviews unavailable"); return end
		vim.ui.select(result.data.entries or {}, { prompt = "Workspace reviews", format_item = function(item)
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
		local lines = { "# Usage", "" }
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
	command(operation, payload, nil, captured, function(receipt)
		if receipt.status == "completed" then completed(receipt.result or {}) end
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
			if not ok then notify(result.message or "History unavailable", vim.log.levels.WARN); done(nil); return end
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
			if not opened then notify((err or "Could not open clone") .. "\nClone saved; select it in :PiSessions.", vim.log.levels.ERROR) end
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
	if not captured or not job then return false end
	if captured.host_discovery then
		return hello and not session_id and not attachment and same_selection(captured)
			and captured.epoch == hello.serviceEpoch and captured.cwd == selected_cwd
	end
	return attachment and same_context(captured) and captured.epoch == snapshot.serviceEpoch
end
-- Read the attached runtime every time; no host/session command list is reused.
function M.get_commands(callback)
	if not session_id and job and hello then
		if not vim.tbl_contains(hello.capabilities or {}, "host.options") then callback({}, "Host command discovery is unavailable."); return end
		local captured = stamp()
		captured.token, captured.controller = nil, nil
		captured.host_discovery, captured.epoch, captured.cwd = true, hello.serviceEpoch, selected_cwd
		host_options(function(result, _, err)
			if not M.command_context_current(captured) then callback({}); return end
			if not result then callback({}, err and err.message or "Could not read host commands"); return end
			callback(result.commands or {}, nil, captured)
		end)
		return
	end
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
		if not ok then callback({}, result.message or "Could not read session commands"); return end
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
				notify("Session context changed; select a command again.", vim.log.levels.WARN)
				return
			end
			M.show_input()
			local value = "/" .. choice.name .. " "
			layout.set_buffer_lines(ctx, state.input_buf, { value }, true)
			vim.api.nvim_win_set_cursor(state.input_win, { 1, #value })
		end)
	end)
end
function M.refresh_messages() refresh(true) end
function M.show_input() layout.show_input(ctx) end
function M.show_transcript() layout.show_transcript(ctx) end
function M.show_help()
	draft_buffer(scratch_name("service-help"), "# Local service attachment\n\n:PiControl / <leader>pc (acquire control; confirm before replacing another controller)\n:PiCd / <leader>pC (select a directory on the current host)\n:PiPending (restore picker; Esc hides, Ctrl-q cancels; viewers inspect only)\n:PiQueue (edit/remove accepted prompts; inspect steering/follow-up; Ctrl+Enter saves; editing pauses dispatch while connected)\n:PiFollowUp / steering shortcut (separate native queues)\n:PiWorkspace (enter/integrate/discard, with existing confirmations)\n:PiWorkspaceReview / <leader>pd / :PiWorkspaceReviews (workspace diffs; summary S/U stage/unstage all; file s/u index actions, X confirmed baseline restore; all mutations require control; gO inspects saved file content, gS original command)\n:PiSidePrompt / :PiSideNew / :PiSideAbort\n:PiRetitle (generate session title)\n:PiLogs / <leader>pl (notifications, action outcomes and recovery text; Enter inspects details)\n:PiHostRequest (unresolved session creation/resume)\n:PiSessions (archive/unarchive/delete, with workspace warnings)\n:PiSavedOperations (original saved-session outcomes; status only)\n:PiOffers / :PiDrafts (inspect-only)\n:PiDetach / :PiReconnect\n<leader>qq (choose Detach, Stop or Cancel)\n:PiKill / <leader>pk (confirm stop session and close frontend; preserves history and local drafts)\n:PiConsoleRestart / <leader>pr: restart the frontend (installed dev uses the latest selected build).\n:PiRestart / <leader>pR: restart this conversation worker using the running server build; interrupts active work.\n\n<C-CR> submits text; <Esc><Esc> aborts.\nSettings/model/thinking/history apply to the attached session.\n:PiCommand / <leader>/ and / completion discover commands from the attached runtime.\n:PiHosts / <leader>ph: attach current frontend, connect/retry/disconnect/edit/forget hosts; Restart server applies the installed build on a chosen host/channel. Confirm separately to force interrupted work; saved sessions stay stopped. Last server restart inspects the latest outcome.\n:PiManagement: inspect overview management outcomes.\n:PiNew: unstarted frontend in the original directory. First prompt creates the session.\n:PiRefreshOptions: refresh cached pre-start models, defaults, and commands (otherwise expire after 60 seconds).\n:PiTranscript: session history (all branches, read-only).\nTranscript Enter inspects thinking/tools/skills/artifacts and file links; @ completion uses the session directory.\nPaged text: n next / p first / r reload. Skill f reads the current skill file.\nSlash commands run on the session host through the shared prompt queue. TUI-only built-ins are not exposed by Pi RPC.\nExcluded resource actions never use a local or raw RPC fallback.\nService restart is also available in Hosts; installation and frontend restart remain separate. Service stop stays CLI-only: pi-console server stop [--force].")
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
	require("pi-integration.spawn-transcript").open({ state = state, ui = { notify = notify }, window = { parent = state.transcript_win }, resources = owner_resources() }, nil, "History (all branches)", { kind = "history" })
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
				local summaries = { "# Recovered actions", "Inspect only; never replayed." }
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
function M.show_logs()
	for _, entry in ipairs(feedback) do
		record_command(entry.receipt or { id = entry.id, status = entry.sent and "unknown" or entry.error and "failed" or "pending", error = entry.error and { message = entry.error } }, entry)
	end
	logs.show()
end
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
local function follow_resumed_selection()
	if not session_id or pending_host or not frontend_focused or session_status == "checking" or session_status == "attaching" then return end
	local stopped = snapshot and (snapshot.phase == "stopped" or snapshot.phase == "failed")
	if job and hello and (not attachment or stopped) and not resume_check then
		local captured = stamp()
		resume_check = captured
		request("sessions", {}, function(ok, result)
			if resume_check == captured then resume_check = nil end
			if not ok or not same_selection(captured) then return end
			for _, row in ipairs(result.sessions or {}) do
				if row.id == session_id and row.live and not row.archived and not row.deleted then attach(session_id); return end
			end
		end)
	end
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
		feedback = restore.feedback or {}
		restored_side_draft = restore.side_draft
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
	local backend = require("pi-integration.backends.tmux")
	local function check_visibility()
		if not backend.available() or visibility_pending then return end
		visibility_pending = true
		backend.is_visible_async(function(visible)
			visibility_pending = false
			if not visibility_timer then return end
			-- A failed query must never strand the UI in hidden mode.
			visible = visible ~= false
			local was_visible = state.frontend_visible
			state.frontend_visible = visible
			if visible and not was_visible then
				render()
				-- A previously queued decoration pass may have been skipped on hide.
				transcript.render(ctx)
				refresh(true)
				refresh_workspace_stats()
			end
		end)
	end
	vim.api.nvim_create_autocmd({ "FocusGained", "FocusLost" }, { callback = function(event)
		frontend_focused = event.event == "FocusGained"
		if frontend_focused then record_focus(); follow_resumed_selection(); check_visibility() end
	end })
	if backend.available() then
		visibility_timer = vim.uv.new_timer()
		visibility_timer:start(0, 1000, vim.schedule_wrap(check_visibility))
	end
	frontend_focused = backend.available() and backend.is_focused() == true
	if frontend_focused then record_focus() end
	-- Resolve saved owner metadata before the layout's first render.
	require("pi-integration.service-hosts").start()
	if not restore and not session_id then selected_cwd = vim.env.PI_CONSOLE_SERVICE_CWD or selected_cwd end
	vim.env.PI_CONSOLE_SERVICE_NEW, vim.env.PI_CONSOLE_SERVICE_CWD = nil, nil
	connect()
	layout.open(ctx)
	if restore then
		layout.set_buffer_lines(ctx, state.input_buf, restore.input_lines or { "" }, true)
		for _, draft in ipairs(restore.drafts or {}) do recovered_draft(draft) end
	end
	for name, fn in pairs({ PiControl = M.take_control, PiPending = M.restore_pending_action, PiQueue = M.pick_queue,
		PiOffers = M.show_offers, PiDrafts = M.show_drafts, PiDetach = M.detach, PiReconnect = M.reconnect,
		PiFollowUp = M.follow_up, PiSidePrompt = M.side_prompt, PiSideNew = M.new_side, PiSideAbort = M.abort_side,
		PiSavedOperations = require("pi-integration.service-hosts").saved_operations,
		PiHosts = M.pick_hosts, PiManagement = require("pi-integration.service-hosts").management_operations, PiSessions = M.pick_session, PiNew = M.new_session, PiTranscript = M.show_owner_transcript,
		PiWorkspaceReview = M.show_workspace_diff, PiWorkspaceReviews = M.pick_workspace_reviews,
		PiWorkspace = M.pick_workspace, PiKill = M.kill_session, PiRetitle = M.retitle, PiHostRequest = M.show_host_request,
		PiRefreshOptions = M.refresh_options }) do
		vim.api.nvim_create_user_command(name, fn, {})
	end
	vim.api.nvim_create_autocmd({ "TextChanged", "TextChangedI", "BufWritePost" }, { callback = function(event)
		if event.buf ~= state.input_buf and not drafts[event.buf] then return end
		if event.buf == side_input_buf and not side_save_scheduled then
			side_save_scheduled = true
			vim.defer_fn(function() side_save_scheduled = false; save_side_draft() end, 500)
		end
		if backup_scheduled then return end
		backup_scheduled = true
		vim.defer_fn(function() backup_scheduled = false; backup() end, 500)
	end })
	stats_timer = vim.uv.new_timer()
	stats_timer:start(0, 2000, vim.schedule_wrap(refresh_workspace_stats))
	heartbeat = vim.uv.new_timer()
	heartbeat:start(5000, 5000, vim.schedule_wrap(function()
		publish_attachment(true)
		follow_resumed_selection()
		-- The bridge renews control independently of UI scheduling. Only the
		-- visible queue editor's finite pause is renewed from this callback.
		local editor = queue_editor
		if control_current() and editor and current(editor.captured) and valid(editor.buf)
			and vim.fn.bufwinid(editor.buf) ~= -1 then
			request("heartbeat", { controlToken = grant.token, reservationId = editor.id }, function(ok, result)
				if ok and result.reservationCurrent == false and queue_editor == editor then
					queue_editor = nil
					log("Queue editing pause expired; draft retained. Reopen the queue before saving.", vim.log.levels.WARN)
				end
			end)
		end
	end))
	publish_attachment()
end
vim.api.nvim_create_autocmd("VimLeavePre", { callback = function()
	if visibility_timer then visibility_timer:stop(); visibility_timer:close(); visibility_timer = nil end
	if refresh_timer then refresh_timer:stop(); refresh_timer:close(); refresh_timer = nil end
	if stats_timer then stats_timer:stop(); stats_timer:close(); stats_timer = nil end
	if heartbeat then heartbeat:stop(); heartbeat:close(); heartbeat = nil end
	backup()
	M.detach()
	local tmux = require("pi-integration.backends.tmux")
	if tmux.available() then
		tmux.clear()
		if M.config.role == "conversation" and not restarting_frontend then tmux.close_sidebar() end
	end
end })
action_connection = require("pi-integration.service-action-connection").new({
	connected = function() return job ~= nil end,
	request = request,
	forget = function(id) if id then callbacks[id] = nil end end,
	render = function() if render and ctx and state.input_buf then render() end end,
	notify = notify,
	disconnect = close_bridge,
	reconnect = function(reason)
		close_bridge(reason)
		recovery_requested = true
		connect()
	end,
	ready = function()
		if not job then return false, "bridge not running" end
		if not hello then return false, "service handshake pending" end
		if session_status == "checking" or session_status == "attaching" or session_status == "restoring" then return false, session_status end
		if not attachment then return true end -- Unstarted or unavailable; the action reports its own prerequisites.
		if not snapshot then return false, "initial snapshot pending" end
		if snapshot.serviceEpoch ~= hello.serviceEpoch or snapshot.runtimeRevision ~= current_revision() then
			return false, "runtime synchronization pending"
		end
		if auto_control_selection then return false, "initial control acquisition pending" end
		for _, pending in pairs(callbacks) do
			if pending.method == "grant" or pending.method == "command"
				and (pending.operation == "control.acquire" or pending.operation == "control.takeover") then
				return false, "control acquisition pending"
			end
		end
		return true -- Authority checks remain in the action; a viewer can still request control.
	end,
	pending = function()
		for _, pending in pairs(callbacks) do
			if pending.method == "command" or pending.method == "host.command" then return true end
		end
		return false
	end,
})
-- Wrap entry points, not command callbacks: dialogs keep their original stamps,
-- and background refresh/completion paths must never reconnect or replay work.
for _, name in ipairs({ "submit_prompt", "take_control", "change_cwd", "restart", "kill_session", "abort",
	"rename_session", "pick_queue", "restore_pending_action", "show_offers", "show_host_request", "refresh_options",
	"pick_model", "pick_thinking", "steer", "follow_up", "side_prompt", "toggle_side", "new_side", "abort_side",
	"pick_spawn", "retitle", "pick_workspace", "show_workspace_diff", "pick_workspace_reviews", "show_usage",
	"show_tree", "pick_command", "refresh_messages", "show_owner_transcript", "set_access_mode", "pick_access_mode",
	"cycle_access_mode", "set_integration_mode", "pick_integration_mode", "cycle_integration_mode", "toggle_notifications" }) do
	local fn = M[name]
	M[name] = function(...)
		if M.config.role ~= "conversation" then return fn(...) end
		if not session_id and (name:find("access_mode", 1, true) or name:find("integration_mode", 1, true) or name == "toggle_notifications") then
			return fn(...)
		end
		local args = { ... }
		local count = select("#", ...)
		if name == "submit_prompt" then args, count = { text(state.input_buf) }, 1 end
		action_connection.run(function() fn(unpack(args, 1, count)) end)
	end
end
return M
