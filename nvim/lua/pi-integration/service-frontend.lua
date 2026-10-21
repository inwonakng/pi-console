-- The B3 attachment owns only UI/drafts. It never launches or stops Pi.
local M = { config = {}, service_mode = true }
local layout = require("pi-integration.layout")
local messages = require("pi-integration.messages")
local transcript = require("pi-integration.transcript")
local state = require("pi-integration.state").new()
local session_id, attachment, snapshot, hello, grant, job
local callbacks, unresolved, offers, drafts = {}, {}, {}, {}
local submission_status = {}
local pending_host, initial_attempted, resume_requested
local generation, counter, refresh_scheduled, refreshing, dirty = 0, 0, false, false, false
local approval_win, approval_buf, approval_request, heartbeat
local recovery_id, backup_scheduled
local render, refresh, connect, attach

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
	notify(name .. " is unavailable in the B3 service slice. No local/RPC fallback was executed.", vim.log.levels.WARN)
end
local function close_approval()
	if approval_win and vim.api.nvim_win_is_valid(approval_win) then vim.api.nvim_win_close(approval_win, true) end
	approval_win, approval_request = nil, nil
end
local function control_current()
	return job and attachment and grant and snapshot and snapshot.controller
		and snapshot.controller.attachmentId == attachment and snapshot.controller.grantId == grant.grantId
end
local function stamp()
	return { generation = generation, attachment = attachment, token = grant and grant.token,
		revision = snapshot and snapshot.runtimeRevision, session = session_id }
end
local function same_context(s)
	return snapshot and s.generation == generation and s.attachment == attachment
		and s.revision == snapshot.runtimeRevision and s.session == session_id
end
local function current(s)
	return control_current() and same_context(s) and s.token == grant.token
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
local function command(operation, payload, callback, captured)
	if not snapshot or not attachment then notify("Attach to a live session first."); return end
	if captured and not current(captured) then notify("Stale editor/dialog; its text remains a local draft.", vim.log.levels.WARN); return end
	if not operation:match("^control%.") and not control_current() then notify("Viewer: use :PiControl or confirmed :PiTakeover first.", vim.log.levels.WARN); return end
	local envelope = { version = 1, id = uid(), sessionId = session_id, serviceEpoch = snapshot.serviceEpoch,
		runtimeRevision = snapshot.runtimeRevision, operation = operation, payload = object_payload(payload) }
	if operation ~= "control.acquire" and operation ~= "control.takeover" then envelope.controlToken = grant and grant.token end
	unresolved[envelope.id] = envelope -- Diagnostic identity only, never replayed.
	request("command", envelope, function(ok, result)
		-- Only an acknowledgment or proven local non-delivery resolves this send.
		-- A failed request/status lookup alone never proves non-admission.
		if ok or result.delivery == "not_sent" then
			unresolved[envelope.id], submission_status[envelope.id] = nil, nil
		end
		if callback then callback(ok, result) end
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
	if not valid(state.input_buf) then return end
	recovery_id = recovery_id or uid()
	local ok, err = pcall(require("pi-integration.service-drafts").save, recovery_id, local_snapshot())
	if not ok then notify("Could not preserve local drafts: " .. tostring(err), vim.log.levels.ERROR) end
end
local ctx = { state = state, config = M.config, notices = { empty_session = "Send non-slash text after acquiring control." },
	buffer = { valid = valid, set_modifiable = function(buf, value) vim.bo[buf].modifiable = value end },
	session = { setup_keymaps = function() end }, transcript = { refresh_ui = function() end } }
local function metadata()
	local controller = snapshot and snapshot.controller
	local submissions = {}
	for id, envelope in pairs(unresolved) do
		if envelope.operation == "prompt.submit" and envelope.sessionId == session_id then
			table.insert(submissions, id .. " (" .. (submission_status[id] or "outcome unknown") .. ")")
		end
	end
	return { "# Pi — local service (B3)", "", "Channel: " .. tostring(hello and hello.channel or vim.env.PI_CONSOLE_CHANNEL or "stable")
		.. " | " .. (job and "connected" or "disconnected") .. " | " .. (control_current() and "CONTROLLER" or "VIEWER"),
		"Host: " .. tostring(hello and hello.hostId or "—"), "Service build: " .. tostring(hello and hello.buildId or "—"),
		"Session: " .. tostring(session_id or "—") .. " | " .. tostring(snapshot and snapshot.phase or "unattached"),
		"Owner cwd: " .. tostring(snapshot and snapshot.interactions.runtime and snapshot.interactions.runtime.cwd or "—"),
		"Control: " .. tostring(controller and controller.label or "unclaimed"),
		"Pending requests: " .. tostring(snapshot and #snapshot.interactions.pending or 0) .. " (:PiPending)",
		"Shared queue: " .. tostring(snapshot and #snapshot.acceptedQueue.items or 0) .. " (:PiQueue)",
		"Protected submissions (:PiSubmissions; not unsent drafts): " .. (#submissions > 0 and table.concat(submissions, ", ") or "none"),
		"Effects: inspect-only (:PiOffers). Slash/shell/settings/history/workspace actions are unavailable in B3.",
		(snapshot and snapshot.error) and ("Error: " .. snapshot.error) or "", "" }
end
ctx.transcript.metadata_lines = metadata
render = function()
	if not valid(state.transcript_buf) then return end
	local conversation = snapshot and snapshot.conversation
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
				vim.list_extend(lines, { "", "## Bash (owner)", work.text, "", work.output or "" })
			end
		end
		for _, item in ipairs(snapshot.acceptedQueue.items) do
			vim.list_extend(lines, { "", "### Queue " .. item.id .. " — " .. item.status .. " r" .. item.revision,
				item.text, item.error and item.error.message or "" })
		end
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
		request("snapshot", {}, function(ok, value)
			refreshing = false
			if ok and gen == generation then apply_snapshot(value) end
			if dirty then refresh() end
		end)
	end, 100)
end
local function disconnected()
	generation = generation + 1
	job, attachment, grant = nil, nil, nil
	callbacks = {}
	refreshing, refresh_scheduled, dirty = false, false, false
	close_approval()
	render()
end
attach = function(id)
	if not job then return end
	local gen = generation
	request("attach", { sessionId = id, label = "Neovim " .. vim.fn.getpid() }, function(ok, value)
		if not ok or gen ~= generation then return end
		close_approval()
		session_id, attachment, grant, snapshot = id, value.attachmentId, nil, nil
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
	local envelope = { id = uid(), serviceEpoch = hello.serviceEpoch, operation = operation, payload = payload }
	pending_host = envelope
	request("host.command", envelope, function(ok, receipt)
		if ok then
			pending_host = nil
			if receipt.result then attach(receipt.result.sessionId) end
		end
	end)
end
local function recover_host()
	if not pending_host then return false end
	request("host.status", { serviceEpoch = pending_host.serviceEpoch, commandId = pending_host.id }, function(ok, receipt)
		if ok and receipt.result then pending_host = nil; attach(receipt.result.sessionId)
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
			if value.update.command and unresolved[value.update.command.id] then submission_status[value.update.command.id] = value.update.command.status end
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
		if not same_context(captured) then notify("Attachment changed; request control again for this session."); return end
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
	if original:match("^%s*[/!]") then unavailable("Slash and shell prompts"); return end
	for id, envelope in pairs(unresolved) do
		if envelope.operation == "prompt.submit" and envelope.sessionId == session_id and vim.trim(envelope.payload.text) == vim.trim(original) then
			notify("Submission " .. id .. " may already be accepted. Review :PiSubmissions before sending this text again.", vim.log.levels.WARN)
			return
		end
	end
	local captured = stamp()
	command("prompt.submit", { text = original }, function(ok)
		if ok and same_context(captured) and text(state.input_buf) == original then layout.set_buffer_lines(ctx, state.input_buf, { "" }, true) end
	end)
end
function M.show_submissions()
	local choices = {}
	for id, envelope in pairs(unresolved) do
		if envelope.operation == "prompt.submit" and envelope.sessionId == session_id then table.insert(choices, id) end
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
	vim.ui.select(snapshot.acceptedQueue.items, { prompt = "Shared accepted queue", format_item = function(item) return item.status .. " r" .. item.revision .. " " .. item.text end }, function(item)
		if not item then return end
		local captured = stamp()
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
	local choices = snapshot.interactions.pending
	vim.ui.select(choices, { prompt = "Pending owner requests (viewer can inspect)", format_item = function(item) return item.request.method .. " " .. item.request.id end }, function(item)
		if not item then return end
		close_approval()
		local request_data, captured = item.request, stamp()
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
	request("sessions", {}, function(ok, result)
		if not ok then return end
		vim.ui.select(result.sessions, { prompt = "Service sessions", format_item = function(item) return item.id .. " " .. (item.name or item.cwd) .. " (" .. item.state .. ")" end }, function(item)
			if not item then return end
			if item.state == "open" then attach(item.id)
			else vim.ui.select({ "Cancel", "Resume" }, { prompt = "Explicitly resume saved conversation? No queued work is replayed." }, function(choice) if choice == "Resume" then host_operation("host.resume", { sessionId = item.id }) end end) end
		end)
	end)
end
function M.new_session() host_operation("host.create", { cwd = vim.fn.getcwd() }) end
function M.refresh_messages() refresh() end
function M.show_input() layout.show_input(ctx) end
function M.show_transcript() layout.show_transcript(ctx) end
function M.show_help()
	draft_buffer("pi://service-help/" .. uid(), "# B3 local attachment\n\n:PiControl / :PiTakeover / :PiRelease\n:PiPending (inspect; Enter on an option answers)\n:PiQueue (edits are local until :write; pauses expire after 30s)\n:PiOffers (inspect-only; never mutates input)\n:PiDetach / :PiReconnect\n:PiConsoleRestart (frontend only, retains drafts, no control reacquisition)\n\n<C-CR> submit non-slash text, <Esc><Esc> abort.\nUnsupported commands never run via raw RPC or local Pi.\nService stop/restart is separate: pi-console server stop/restart [--force].")
end
function M.open_transcript_item()
	local item = transcript.transcript_item_at_line(ctx, vim.api.nvim_win_get_cursor(0)[1])
	if not item then unavailable("Owner file/navigation links"); return end
	if item.kind == "tool_group" then require("pi-integration.tool-groups").toggle(ctx, item); transcript.render(ctx)
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
	for _, buf in ipairs(vim.api.nvim_list_bufs()) do
		if vim.bo[buf].modified and buf ~= state.input_buf and buf ~= state.transcript_buf and not drafts[buf] then notify("Save unrelated modified buffers before restarting."); return end
	end
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
		PiOffers = M.show_offers, PiDrafts = M.show_drafts, PiSubmissions = M.show_submissions, PiDetach = M.detach, PiReconnect = M.reconnect }) do
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
		if control_current() then request("heartbeat", { controlToken = grant.token }, function(ok) if not ok then grant = nil; close_approval(); render() end end) end
	end))
	connect()
end
for _, name in ipairs({ "restart", "change_cwd", "steer", "toggle_side", "new_side", "abort_side", "pick_command", "pick_spawn", "show_tree",
	"set_access_mode", "pick_access_mode", "cycle_access_mode", "set_integration_mode", "pick_integration_mode", "cycle_integration_mode",
	"pick_model", "pick_thinking", "show_workspace_diff", "new_session_window", "toggle_notifications", "show_logs", "show_usage", "restore_session_transcript",
	"start", "refresh_session_stats", "fail_pending_prompts", "flush_queued_prompts", "finish_loading_if_ready" }) do
	M[name] = function() unavailable(name) end
end
vim.api.nvim_create_autocmd("VimLeavePre", { callback = function()
	if heartbeat then heartbeat:stop(); heartbeat:close(); heartbeat = nil end
	backup()
	M.detach()
end })
return M
