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
local function field(label, value)
	if type(value) ~= "string" or value == "" then return nil end
	return string.format("%-9s%s", label, value:gsub("%s+", " "))
end

local function fields(lines, left, right)
	if left and right then
		table.insert(lines, left .. string.rep(" ", math.max(4, 38 - vim.fn.strdisplaywidth(left))) .. right)
	elseif left or right then
		table.insert(lines, left or right)
	end
end

function M.append(ctx, lines, items, permission)
	local status = labels[permission.state] or "No recorded decision"
	local detail = { type(permission.choice) == "string" and permission.choice ~= "" and permission.choice or status, "" }
	if type(permission.request) == "string" and permission.request ~= "" then
		vim.list_extend(detail, vim.split(permission.request, "\n", { plain = true }))
		table.insert(detail, "")
	end
	fields(detail, field("Tool", permission.tool), field("Mode", permission.mode))
	fields(detail, field("Scope", permission.scope))
	fields(detail, field("CWD", permission.directory))
	fields(detail, field("Asked", permission.requestedAt), field("Answered", permission.answeredAt))
	fields(detail, field("Reason", permission.reason))
	if permission.branchDecision then table.insert(detail, "Decision recorded on another branch.") end
	table.insert(detail, "")
	local preview_start = #detail + 1
	vim.list_extend(detail, vim.split(permission.preview or "", "\n", { plain = true }))
	local output_id = tool_output.store(ctx.state, "permission", table.concat(detail, "\n"), "text", {
		status_label = status, preview_start = preview_start, preview_filetype = permission.previewFiletype,
	})
	local choice = type(permission.choice) == "string" and (": " .. permission.choice) or ""
	local summary = "Permission: " .. tostring(permission.tool or "tool") .. " | " .. status .. choice
	if permission.branchDecision then summary = summary .. " (another branch)" end
	local scope = tostring(permission.scope or ""):gsub("%s+", " ")
	if scope ~= "" then summary = summary .. " | " .. scope:sub(1, 100) end
	table.insert(lines, "> " .. summary:gsub("[\r\n]", " "))
	table.insert(items, { kind = "tool", output_id = output_id, start_line = #lines, end_line = #lines })
	table.insert(lines, "")
end

function M.highlight(buf, details)
	vim.api.nvim_buf_set_extmark(buf, vim.api.nvim_create_namespace("pi-permission-detail"), 0, 0, {
		end_col = #vim.api.nvim_buf_get_lines(buf, 0, 1, false)[1],
		hl_group = "PiPermissionQuote",
	})
	-- As in approval previews, syntax belongs to the body, never the metadata.
	local filetype = details.preview_filetype
	vim.api.nvim_buf_call(buf, function()
		vim.cmd("syntax clear")
		vim.b[buf].current_syntax = nil
		if type(filetype) == "string" and filetype ~= "text" and filetype:match("^[%w_]+$")
			and #vim.fn.globpath(vim.o.runtimepath, "syntax/" .. filetype .. ".vim", false, true) > 0 then
			vim.cmd("syntax include @PiPermissionBody syntax/" .. filetype .. ".vim")
			vim.cmd("syntax region PiPermissionBody start=/\\%" .. details.preview_start
				.. "l/ end=/\\%$/ contains=@PiPermissionBody keepend")
			vim.cmd("syntax sync fromstart")
		end
		vim.b[buf].current_syntax = "pi_permission"
	end)
end

return M
