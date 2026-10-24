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
	if type(value) ~= "string" or value == "" then return end
	table.insert(lines, string.format("%-9s%s", label, value:gsub("%s+", " ")))
end

function M.append(ctx, lines, items, permission)
	local status = labels[permission.state] or "No recorded decision"
	local response = type(permission.choice) == "string" and permission.choice ~= "" and permission.choice or status
	local detail = { response, "" }
	local preview = permission.preview or ""
	local scope = permission.scope
	if permission.tool == "bash" and type(scope) == "string" and vim.trim(scope) ~= ""
		and vim.trim(scope) == vim.trim(preview) then
		scope = "This command"
	end
	field(detail, "Tool", permission.tool)
	field(detail, "Mode", permission.mode)
	field(detail, "Scope", scope)
	field(detail, "CWD", permission.directory)
	field(detail, "Asked", permission.requestedAt)
	field(detail, "Answered", permission.answeredAt)
	field(detail, "Reason", permission.reason)
	if permission.branchDecision then table.insert(detail, "Decision recorded on another branch.") end
	local preview_start, preview_end
	if preview ~= "" then
		local fence_length = 3
		for ticks in preview:gmatch("`+") do fence_length = math.max(fence_length, #ticks + 1) end
		local fence = string.rep("`", fence_length)
		local filetype = permission.previewFiletype
		local language = type(filetype) == "string" and filetype:match("^[%w_]+$") and filetype or "text"
		vim.list_extend(detail, { "", fence .. language })
		preview_start = #detail + 1
		vim.list_extend(detail, vim.split(preview, "\n", { plain = true }))
		preview_end = #detail
		table.insert(detail, fence)
	end
	if type(permission.request) == "string" and permission.request ~= "" then
		table.insert(detail, "")
		vim.list_extend(detail, vim.split(permission.request, "\n", { plain = true }))
	end
	local output_id = tool_output.store(ctx.state, "permission", table.concat(detail, "\n"), "text", {
		status_label = status, preview_start = preview_start, preview_end = preview_end,
		preview_filetype = permission.previewFiletype,
	})
	local summary = tostring(permission.tool or "tool") .. ": " .. response
	table.insert(lines, "> " .. summary:gsub("[\r\n]", " "))
	table.insert(items, { kind = "tool", output_id = output_id, start_line = #lines, end_line = #lines })
	table.insert(lines, "")
end

function M.highlight(buf, details)
	vim.api.nvim_set_hl(0, "PiPermissionHeading", { bold = true, default = true })
	vim.api.nvim_buf_set_extmark(buf, vim.api.nvim_create_namespace("pi-permission-detail"), 0, 0, {
		end_col = #vim.api.nvim_buf_get_lines(buf, 0, 1, false)[1],
		hl_group = "PiPermissionHeading",
	})
	-- As in approval previews, syntax belongs to the body, never the metadata.
	local filetype = details.preview_filetype
	vim.api.nvim_buf_call(buf, function()
		vim.cmd("syntax clear")
		vim.b[buf].current_syntax = nil
		if details.preview_start and type(filetype) == "string" and filetype ~= "text" and filetype:match("^[%w_]+$")
			and #vim.fn.globpath(vim.o.runtimepath, "syntax/" .. filetype .. ".vim", false, true) > 0 then
			vim.cmd("syntax include @PiPermissionBody syntax/" .. filetype .. ".vim")
			vim.cmd("syntax region PiPermissionBody start=/\\%" .. details.preview_start
				.. "l/ end=/\\%" .. (details.preview_end + 1) .. "l/ contains=@PiPermissionBody keepend")
			vim.cmd("syntax sync fromstart")
		end
		vim.b[buf].current_syntax = "pi_permission"
	end)
end

return M
