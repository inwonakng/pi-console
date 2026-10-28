-- Section replacement keeps the owner authoritative without replaying Pi events.
local M = {}
local fields = {
	history = { "messages", "messageKeys", "omittedMessages", "historyRevision", "hydrated" },
	tools = { "tools" },
	activity = { "partialAssistant", "diagnostics", "permissions", "omittedPermissions", "work", "queue", "execution" },
	status = { "statuses", "widgets", "title", "piState", "stats" },
}
-- Owner/queue replacements can arrive while an older history snapshot is in flight.
-- Keep their watermarks separate from the conversation section baseline.
function M.observe(previous, value, data)
	local identity = previous and previous.sessionId == value.sessionId and previous.serviceEpoch == value.serviceEpoch
	if identity and value.sequence < previous.sequence then return previous end
	local same = identity and previous.runtimeRevision == value.runtimeRevision
	if not data then return same and previous or nil end
	return { sessionId = value.sessionId, serviceEpoch = value.serviceEpoch, runtimeRevision = value.runtimeRevision,
		sequence = value.sequence, data = data }
end
-- Do not publish a partial history as a complete section baseline. Pages refer
-- to the captured snapshot, so live updates cannot change their chronology.
function M.load(result, request, callback)
	local value = type(result) == "table" and (result.snapshot or result) or {}
	local sources = {}
	local function invalid()
		callback(false, { code = "invalid_response", message = "Invalid or incomplete snapshot history" })
	end
	for _, source in pairs({ value.conversation, value.conversationSections and value.conversationSections.history, value.preview }) do
		if type(source) == "table" and source.historyPage then
			if type(source.historyPage) ~= "table" then invalid(); return end
			table.insert(sources, source)
		end
	end
	local index = 0
	local function next_source()
		index = index + 1
		local source = sources[index]
		if not source then callback(true, result); return end
		local id, count = source.historyPage.id, source.historyPage.count
		if type(id) ~= "string" or type(count) ~= "number" or count < 1 or count ~= math.floor(count)
			or type(source.messages) ~= "table" or type(source.messageKeys) ~= "table" then invalid(); return end
		local function next_page()
			local cursor = source.historyPage
			if not cursor then
				if #source.messages ~= count or #source.messageKeys ~= count then invalid(); return end
				next_source(); return
			end
			if type(cursor) ~= "table" or cursor.id ~= id or cursor.count ~= count or cursor.offset ~= #source.messages then invalid(); return end
			request("snapshot.history", { id = id, offset = cursor.offset }, function(ok, page)
				if not ok then callback(false, page); return end
				if type(page) ~= "table" or type(page.messages) ~= "table" or #page.messages == 0
					or type(page.messageKeys) ~= "table" or #page.messageKeys ~= #page.messages
					or #source.messages + #page.messages > count then invalid(); return end
				vim.list_extend(source.messages, page.messages)
				vim.list_extend(source.messageKeys, page.messageKeys)
				source.historyPage = page.historyPage
				next_page()
			end)
		end
		next_page()
	end
	next_source()
end
function M.query(snapshot, hello)
	if not snapshot or not snapshot.conversationRevisions or not hello
		or not vim.tbl_contains(hello.capabilities, "snapshot.sections") then return {} end
	return { known = { sessionId = snapshot.sessionId, serviceEpoch = snapshot.serviceEpoch, runtimeRevision = snapshot.runtimeRevision,
		conversationRevisions = snapshot.conversationRevisions } }
end
function M.merge(previous, value)
	if value.conversation then return value end
	assert(previous and previous.sessionId == value.sessionId and previous.serviceEpoch == value.serviceEpoch
		and previous.runtimeRevision == value.runtimeRevision, "Snapshot sections require a matching baseline")
	assert(type(value.conversationSections) == "table" and type(value.conversationRevisions) == "table", "Missing snapshot sections")
	local conversation = vim.tbl_extend("force", {}, previous.conversation)
	for section, keys in pairs(fields) do
		local changed = value.conversationSections[section]
		if changed then
			for _, key in ipairs(keys) do conversation[key] = changed[key] end
		else
			assert(previous.conversationRevisions[section] == value.conversationRevisions[section], "Snapshot section baseline changed")
		end
	end
	value.conversation, value.conversationSections = conversation, nil
	return value
end
return M
