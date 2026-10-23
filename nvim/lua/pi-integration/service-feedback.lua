-- Frontend acknowledgments only. These records never authorize or replay work.
local M = {}
local labels = {
	["prompt.submit"] = "User", ["shell.run"] = "Shell", ["steering.submit"] = "Steering",
	["followUp.submit"] = "Follow-up", ["side.prompt"] = "Side message",
	["turn.abort"] = "Stopping", ["shell.abort"] = "Stopping shell", ["side.abort"] = "Stopping side conversation",
}
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
			if synced and ok and receipt.status == "completed" then table.remove(entries, index) end
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
function M.reconcile(entries, snapshot)
	local receipts = {}
	for _, receipt in ipairs(snapshot.commands or {}) do receipts[receipt.id] = receipt end
	for index = #entries, 1, -1 do
		local entry = entries[index]
		local receipt = receipts[entry.id]
		if entry.sessionId == snapshot.sessionId and receipt and receipt.serviceEpoch == entry.serviceEpoch then
			-- Hand off to authoritative queue/history/settings by identity, never
			-- by message text: identical submissions are valid.
			M.receipt(entries, entry.id, true, receipt, true)
		end
	end
end
local function represented(entry, snapshot)
	if not snapshot or entry.serviceEpoch ~= snapshot.serviceEpoch or entry.runtimeRevision ~= snapshot.runtimeRevision then return false end
	local queue_id = entry.receipt and entry.receipt.result and entry.receipt.result.queueItemId
	if queue_id then
		for _, item in ipairs(snapshot.acceptedQueue.items) do if item.id == queue_id then return true end end
	end
	return false
end
function M.lines(entries, session, snapshot)
	local lines = {}
	for _, entry in ipairs(entries) do
		if entry.sessionId == session and not represented(entry, snapshot) then
			table.insert(lines, "")
			table.insert(lines, "## " .. (labels[entry.operation] or entry.operation) .. " (" .. entry.status .. ")")
			table.insert(lines, "")
			local payload = entry.payload
			local body = payload.text or payload.command or payload.title or payload.mode or payload.level or payload.modelId
			if not body and payload.enabled ~= nil then body = payload.enabled and "Enabled requested" or "Disabled requested" end
			-- Accepted shell output has its own owner work block. Keep the local
			-- acknowledgment, without repeating the command beside that output.
			if body and not (entry.operation == "shell.run" and entry.status == "Accepted") then
				vim.list_extend(lines, vim.split(body, "\n", { plain = true }))
			end
			if entry.error then table.insert(lines, entry.error) end
			if entry.status == "Failed" or entry.status == "Not sent" or entry.status == "Outcome unknown" then
				table.insert(lines, "Request retained in :PiDrafts. Review :PiSubmissions / :PiOperations before resending; never replayed automatically.")
			end
		end
	end
	return lines
end
return M
