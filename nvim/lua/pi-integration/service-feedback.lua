-- Frontend acknowledgments only. These records never authorize or replay work.
local M = {}
function M.tracks(operation)
	return not operation:match("^control%.") and not operation:match("^interaction%.")
		and operation ~= "queue.reserve" and operation ~= "queue.release"
end
function M.add(entries, id, operation, payload, session, epoch, revision, snapshot)
	local conversation = snapshot and snapshot.conversation or { messages = {} }
	local keys = conversation.messageKeys or {}
	local entry = { id = id, operation = operation, payload = payload, sessionId = session,
		serviceEpoch = epoch, runtimeRevision = revision, status = "Pending", sent = false,
		timeline = (#keys > 0 or #conversation.messages == 0) and { afterMessage = keys[#keys] or vim.NIL } or nil }
	table.insert(entries, entry)
	return entry
end
function M.receipt(entries, id, ok, receipt, synced)
	for index, entry in ipairs(entries) do
		if entry.id == id then
			entry.receipt = ok and receipt or nil
			entry.error = receipt.error and receipt.error.message or not ok and receipt.message or nil
			if not ok then
				entry.status = receipt.delivery == "not_sent" and "Not sent" or "Outcome unknown"
				if receipt.delivery == "not_sent" then entry.sent = false end
			elseif receipt.status == "failed" then entry.status = "Failed"
			elseif receipt.status == "uncertain" then entry.status = "Outcome unknown"
			elseif receipt.status == "completed" then entry.status = "Completed; syncing"
			elseif receipt.status == "accepted" then entry.status = "Accepted"
			else entry.status = "Outcome unknown" end
			if synced and ok and receipt.status == "completed" and entry.operation ~= "prompt.submit" then
				table.remove(entries, index)
			end
			return
		end
	end
end
function M.bind(entries, host_request, session)
	for _, entry in ipairs(entries) do
		if entry.hostRequest == host_request then entry.sessionId = session end
	end
end
function M.interrupt(entries)
	for _, entry in ipairs(entries) do
		if entry.status ~= "Failed" and entry.status ~= "Not sent" then
			entry.status = entry.sent and "Outcome unknown" or "Not sent"
		end
	end
end
local function queue_id(entry)
	return entry.receipt and entry.receipt.result and entry.receipt.result.queueItemId
end
function M.reconcile(entries, snapshot)
	local receipts, queued = {}, {}
	for _, receipt in ipairs(snapshot.commands or {}) do receipts[receipt.id] = receipt end
	for _, item in ipairs(snapshot.acceptedQueue.items) do queued[item.id] = item end
	for index = #entries, 1, -1 do
		local entry = entries[index]
		local receipt = receipts[entry.id]
		if entry.sessionId == snapshot.sessionId and receipt and receipt.serviceEpoch == entry.serviceEpoch then
			-- Admission and queue handoff use the original command identity.
			M.receipt(entries, entry.id, true, receipt, true)
		end
	end
	for index = #entries, 1, -1 do
		local entry = entries[index]
		if entry.sessionId == snapshot.sessionId and entry.operation == "prompt.submit"
			and entry.receipt and entry.receipt.status == "completed" and not queued[queue_id(entry)] then
			table.remove(entries, index)
		end
	end
end
-- Local turns are display-only. Queue identities and observed message keys
-- replace them with owner history without matching text or authorizing delivery.
function M.timeline_messages(entries, session, snapshot)
	local conversation = snapshot and snapshot.conversation or {}
	local history = vim.deepcopy(conversation.messages or {})
	local positions, ambiguous = {}, {}
	for index, key in ipairs(conversation.messageKeys or {}) do
		history[index].messageKey = key
		if positions[key] then ambiguous[key] = true end
		positions[key] = index
	end
	local buckets, unmatched, queued = {}, {}, {}
	local function place(text, error, timeline, status)
		local observed_key = timeline and timeline.observedMessage
		local observed = positions[observed_key]
		local at
		if observed and not ambiguous[observed_key] then
			at = observed
			-- Pi may already have recorded the same failure in this turn.
			for index = observed + 1, #history do
				if history[index].role == "user" then break end
				if history[index].errorMessage == error then error = nil; break end
			end
		elseif timeline then
			if timeline.afterMessage == vim.NIL and (conversation.omittedMessages or 0) == 0 then at = 0
			elseif timeline.afterMessage and not ambiguous[timeline.afterMessage] then at = positions[timeline.afterMessage] end
		end
		local messages = {}
		if not observed or ambiguous[observed_key] then
			table.insert(messages, { role = "user", content = { { type = "text", text = text } } })
			if status then table.insert(messages, { role = "custom", content = "> Submission: " .. status }) end
		end
		if error and error ~= "" then
			table.insert(messages, { role = "error", content = { { type = "text", text = error } } })
		end
		if at then
			buckets[at] = buckets[at] or {}
			vim.list_extend(buckets[at], messages)
		else table.insert(unmatched, { text = text, status = status, error = error }) end
	end
	local queue = snapshot and snapshot.acceptedQueue.items or {}
	for _, item in ipairs(queue) do
		queued[item.id] = true
		place(item.text, item.error and item.error.message, item.timeline, item.status)
	end
	for _, entry in ipairs(entries) do
		if entry.sessionId == session and entry.operation == "prompt.submit" and not queued[queue_id(entry)] then
			place(entry.payload.text, entry.error, entry.timeline, entry.status)
		end
	end
	for _, permission in ipairs(conversation.permissions or {}) do
		local anchor = permission.afterMessage
		local at = anchor == vim.NIL and (conversation.omittedMessages or 0) == 0 and 0
			or (anchor and not ambiguous[anchor] and positions[anchor])
		if at then
			buckets[at] = buckets[at] or {}
			table.insert(buckets[at], { role = "permission", permission = permission })
		end
	end
	local partial_diagnostics = {}
	for _, diagnostic in ipairs(conversation.diagnostics or {}) do
		local message = { role = "error", content = { { type = "text", text = diagnostic.message } } }
		if diagnostic.assistantTimestamp and diagnostic.assistantTimestamp ~= vim.NIL then
			local partial = conversation.partialAssistant
			if partial and partial.message.timestamp == diagnostic.assistantTimestamp then
				table.insert(partial_diagnostics, message)
			end
		else
			local anchor = diagnostic.afterMessage
			local at = anchor == vim.NIL and (conversation.omittedMessages or 0) == 0 and 0
				or (not ambiguous[anchor] and positions[anchor])
			if at then
				buckets[at] = buckets[at] or {}
				table.insert(buckets[at], message)
			end
		end
	end
	local visible = {}
	if (conversation.omittedPermissions or 0) > 0 then
		table.insert(visible, { role = "custom", content = "> Permission history is limited here; :PiTranscript opens the full saved history." })
	end
	vim.list_extend(visible, buckets[0] or {})
	for index, message in ipairs(history) do
		table.insert(visible, message)
		vim.list_extend(visible, buckets[index] or {})
	end
	if conversation.partialAssistant then table.insert(visible, vim.deepcopy(conversation.partialAssistant.message)) end
	vim.list_extend(visible, partial_diagnostics)
	-- Unknown chronology stays out of the transcript; request details remain in :PiLogs.
	return visible, unmatched
end
return M
