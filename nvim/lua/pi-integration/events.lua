local M = {}
local json = require("pi-integration.utils.json")
local pending_picker = require("pi-integration.pending-picker")

local function decode_approval_payload(message)
	if type(message) ~= "string" or message == "" then
		return nil
	end
	local decoded = json.decode_object(message)
	if not decoded or decoded.kind ~= "pi_approval_preview" then
		return nil
	end
	return decoded
end

local function decode_compact_select_payload(title)
	local payload = type(title) == "string" and json.decode_object(title)
	if not payload or payload.kind ~= "pi_compact_select" or type(payload.prompt) ~= "string" then
		return nil
	end
	return payload
end

local function approval_select_opts(payload, prompt)
	local header = {}
	local function field(key, value)
		if type(value) == "string" and value ~= "" then
			table.insert(header, { key, (value:gsub("[\r\n]+", " ")) })
		end
	end
	if payload.sideConversationId then field("Conversation", "Side") end
	local origin = type(payload.provenance) == "table" and payload.provenance or {}
	if origin.workerId then
		field("Worker", origin.workerId)
		field("Assignment", origin.assignmentId)
		field("Workspace", origin.workspaceId or "(none)")
		field("Request ID", origin.requestId)
	end
	field("Tool", payload.tool or "tool")
	field("Request", payload.request or prompt)
	field("Access scope", payload.path)
	field("Command CWD", payload.directory)
	field("Mode", payload.mode)
	if not payload.request and payload.summary ~= prompt then
		field("Details", payload.summary)
	end
	return {
		prompt = prompt,
		prompt_label = "Permission",
		pi_select_layout = "compact",
		preview_header = header,
		preview_text = type(payload.preview) == "string" and payload.preview or "",
		preview_filetype = payload.preview_filetype,
	}
end

local function confirm_with_preview(ctx, event, respond)
	local payload = decode_approval_payload(event.message)
	if not payload then
		return false
	end

	payload.sideConversationId = event.side_conversation_id
	local prompt = type(event.title) == "string" and event.title ~= "" and event.title
		or (payload.tool and ("Allow " .. payload.tool .. "?") or "Pi confirm")
	pending_picker.select(ctx, event.id, { "Allow", "Deny" }, approval_select_opts(payload, prompt), function(choice)
		respond({ confirmed = choice == "Allow" })
	end)
	return true
end

local function select_capability_approval(ctx, event, respond)
	local payload = decode_approval_payload(event.title)
	if not payload then
		return false
	end

	local tool = type(payload.tool) == "string" and payload.tool ~= "" and payload.tool or "tool"
	local prompt = "Allow " .. tool .. "?"
	pending_picker.select(ctx, event.id, event.options or {}, approval_select_opts(payload, prompt), function(choice)
		respond(choice and { value = choice } or { cancelled = true })
	end)
	return true
end

-- Shared dialog presentation only; callers own lifecycle and response transport.
function M.open_dialog(ctx, event, respond)
	event = vim.deepcopy(event)
	local title = type(event.title) == "string" and json.decode_object(event.title) or nil
	while title and (title.kind == "pi_service_dialog" or title.kind == "pi_side_dialog") and type(title.title) == "string" do
		event.title = title.title
		title = json.decode_object(event.title)
	end
	if title and title.kind == "pi_input" and type(title.prompt) == "string" then event.title = title.prompt end
	if event.method == "select" then
		if select_capability_approval(ctx, event, respond) then
			return
		end
		local compact_select = decode_compact_select_payload(event.title)
		local prompt = compact_select and compact_select.prompt or event.title or "Pi select"
		local select_opts = {
			prompt = prompt,
			prompt_label = event.side_dialog_id and "Side choice" or "Choice",
			pi_select_layout = "compact",
			preview_text = prompt,
		}
		if compact_select and type(compact_select.previews) == "table" then
			select_opts.preview_title = prompt
			select_opts.preview_filetype = "markdown"
			select_opts.preview_text = function(item)
				local text = compact_select.previews[item]
				return type(text) == "string" and text or prompt
			end
		elseif compact_select and type(compact_select.preview) == "string" then
			select_opts.preview_title = prompt
			select_opts.preview_text = compact_select.preview
			select_opts.preview_filetype = compact_select.preview_filetype
			if compact_select.preview_kind == "workspace_summary" then
				select_opts.preview_highlight = require("pi-integration.workspace-summary").highlight
			end
		end
		pending_picker.select(ctx, event.id, event.options or {}, select_opts, function(choice)
			respond(choice and { value = choice } or { cancelled = true })
		end)
	elseif event.method == "confirm" then
		if confirm_with_preview(ctx, event, respond) then
			return
		end
		local payload = type(event.title) == "string" and json.decode_object(event.title)
		local prompt = type(payload) == "table" and payload.kind == "pi_confirmation"
			and type(payload.prompt) == "string" and payload.prompt or event.title or "Pi confirm"
		local preview_text = prompt
		if type(event.message) == "string" and event.message ~= "" then
			preview_text = preview_text .. "\n\n" .. event.message
		end
		pending_picker.select(ctx, event.id, { "Yes", "No" }, {
			prompt = prompt,
			prompt_label = "Confirmation",
			pi_select_layout = "compact",
			preview_text = preview_text,
		}, function(choice)
			respond({ confirmed = choice == "Yes" })
		end)
	elseif event.method == "input" or event.method == "editor" then
		return pending_picker.input(ctx, event, function(value)
			respond(value and { value = value } or { cancelled = true })
		end)
	end
end

return M
