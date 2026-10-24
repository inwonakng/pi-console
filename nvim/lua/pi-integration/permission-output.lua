local tool_output = require("pi-integration.tool-output")
local M = {}

-- Fold request/decision entries into one inspectable row at the request's
-- original position. Used by raw owner history and saved-session previews.
function M.add_record(messages, requests, record)
	if record.type ~= "custom" or record.customType ~= "pi-permission-history" then return false end
	local data = record.data
	if type(data) ~= "table" or data.version ~= 1 or type(data.id) ~= "string" then return true end
	if data.state == "pending" and type(data.request) == "string" and type(data.preview) == "string" then
		if not requests[data.id] then
			local message = { role = "permission", permission = vim.deepcopy(data) }
			requests[data.id] = message
			table.insert(messages, message)
		end
	elseif requests[data.id] and (data.state == "allowed" or data.state == "denied" or data.state == "cancelled") then
		local permission = requests[data.id].permission
		if permission.state ~= "pending" then
			-- All-branches history can contain different decisions descended from
			-- the same request. Keep the earlier branch's answer intact.
			permission = vim.deepcopy(permission)
			permission.branchDecision = true
			table.insert(messages, { role = "permission", permission = permission })
		end
		permission.state, permission.choice = data.state, data.choice
		permission.reason, permission.answeredAt = data.reason, data.answeredAt
	end
	return true
end

local labels = { pending = "Pending", allowed = "Allowed", denied = "Denied", cancelled = "Cancelled" }
local function field(lines, label, value)
	if type(value) ~= "string" then return end
	vim.list_extend(lines, { "## " .. label, "" })
	vim.list_extend(lines, vim.split(value, "\n", { plain = true }))
	table.insert(lines, "")
end

function M.append(ctx, lines, items, permission)
	local status = labels[permission.state] or "No recorded decision"
	local detail = { "# Permission request", "" }
	field(detail, "Status", status)
	field(detail, "Selected choice", permission.choice)
	field(detail, "Question", permission.request)
	field(detail, "Tool", permission.tool)
	field(detail, "Access mode", permission.mode)
	field(detail, "Requested scope", permission.scope)
	field(detail, "Working directory", permission.directory)
	field(detail, "Asked at", permission.requestedAt)
	field(detail, "Answered at", permission.answeredAt)
	field(detail, "Cancellation reason", permission.reason)
	vim.list_extend(detail, { "## Offered choices", "" })
	for _, choice in ipairs(permission.options or {}) do table.insert(detail, "- " .. choice) end
	vim.list_extend(detail, { "", "## Command / file preview", "" })
	local preview = permission.preview or ""
	local fence_length = 3
	for ticks in preview:gmatch("`+") do fence_length = math.max(fence_length, #ticks + 1) end
	local fence = string.rep("`", fence_length)
	table.insert(detail, fence .. tostring(permission.previewFiletype or "text"):gsub("[^%w_-]", ""))
	vim.list_extend(detail, vim.split(preview, "\n", { plain = true }))
	table.insert(detail, fence)
	local output_id = tool_output.store(ctx.state, "permission", table.concat(detail, "\n"), "markdown")
	local choice = type(permission.choice) == "string" and (": " .. permission.choice) or ""
	local summary = "Permission: " .. tostring(permission.tool or "tool") .. " | " .. status .. choice
	if permission.branchDecision then summary = summary .. " (another branch)" end
	local scope = tostring(permission.scope or ""):gsub("%s+", " ")
	if scope ~= "" then summary = summary .. " | " .. scope:sub(1, 100) end
	table.insert(lines, "> " .. summary:gsub("[\r\n]", " "))
	table.insert(items, { kind = "tool", output_id = output_id, start_line = #lines, end_line = #lines })
	table.insert(lines, "")
end

return M
