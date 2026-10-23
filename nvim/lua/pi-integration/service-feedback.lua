-- Frontend acknowledgments only. These records never authorize or replay work.
local M = {}
local message_utils = require("pi-integration.utils.message")
function M.tracks(operation)
	return not operation:match("^control%.") and not operation:match("^interaction%.")
		and operation ~= "queue.reserve" and operation ~= "queue.release"
end
function M.add(entries, id, operation, payload, session, epoch, revision)
	local entry = { id = id, operation = operation, payload = payload, sessionId = session,
		serviceEpoch = epoch, runtimeRevision = revision, status = "Pending", sent = false }
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
	local conversation = snapshot.conversation
	local last_observed = 0
	for _, entry in ipairs(entries) do
		if entry.sessionId == snapshot.sessionId and entry.operation == "prompt.submit"
			and entry.serviceEpoch == snapshot.serviceEpoch and entry.runtimeRevision == snapshot.runtimeRevision then
			local item = queued[queue_id(entry)]
			entry.messageOffset = math.max(entry.messageOffset or ((conversation.omittedMessages or 0) + #conversation.messages), last_observed)
			if item and item.status == "queued" then
				-- Queued text cannot be in history yet. Ignore older identical prompts.
				entry.messageOffset = math.max(entry.messageOffset, (conversation.omittedMessages or 0) + #conversation.messages)
			elseif entry.sent and not entry.observedPosition then
				for index, message in ipairs(conversation.messages) do
					local position = (conversation.omittedMessages or 0) + index
					if position > entry.messageOffset and message.role == "user"
						and vim.trim(message_utils.extract_text(message) or "") == vim.trim(entry.payload.text) then
						entry.observedPosition = position
						break
					end
				end
			end
			last_observed = entry.observedPosition or last_observed
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
-- Local prompts use the same renderer as history. Keep their queue identity
-- until handoff finishes, so an observed user message cannot leave a second row.
function M.append_messages(entries, session, visible)
	local covered = {}
	for _, entry in ipairs(entries) do
		if entry.sessionId == session and entry.operation == "prompt.submit" then
			local id = queue_id(entry)
			if id then covered[id] = true end
			if not entry.observedPosition then
				table.insert(visible, { role = "user", content = { { type = "text", text = entry.payload.text } } })
			end
		end
	end
	return covered
end
function M.prompt_errors(entries, session, snapshot)
	local lines = {}
	for _, entry in ipairs(entries) do
		if entry.sessionId == session and entry.operation == "prompt.submit" then
			local error = entry.error
			for _, item in ipairs(snapshot and snapshot.acceptedQueue.items or {}) do
				if item.id == queue_id(entry) and item.error then error = item.error.message end
			end
			if error then vim.list_extend(lines, { "", "Error: " .. error }) end
		end
	end
	return lines
end
return M
