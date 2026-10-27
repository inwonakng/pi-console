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
