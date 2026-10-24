-- Owner review data only. Owner paths never name frontend files or Git commands.
local M = {}
local resources = require("pi-integration.service-resources")
local sequence = 0
local function scratch_name(title)
	sequence = sequence + 1
	return "pi://owner-review/" .. sequence .. "/" .. title
end
local function present(value) return value ~= nil and value ~= vim.NIL end
local function lines(value)
	local result = vim.split(value or "", "\n", { plain = true })
	local eol = #result > 1 and result[#result] == ""
	if eol then table.remove(result) end
	return result, eol
end
local function contents(buf)
	return table.concat(vim.api.nvim_buf_get_lines(buf, 0, -1, false), "\n") .. (vim.bo[buf].endofline and "\n" or "")
end
local function readonly(options, title, value, filetype)
	local buf = require("pi-integration.layout").create_buffer(nil, title, filetype or "text", true)
	local value_lines, eol = lines(value)
	vim.api.nvim_buf_set_lines(buf, 0, -1, false, value_lines)
	vim.bo[buf].endofline, vim.bo[buf].fixendofline, vim.bo[buf].modified = eol, false, false
	vim.bo[buf].buftype, vim.bo[buf].modifiable, vim.bo[buf].readonly = "nofile", false, true
	vim.bo[buf].modeline, vim.bo[buf].filetype = false, filetype or "text"
	vim.cmd("botright split")
	vim.api.nvim_win_set_buf(0, buf)
	return buf
end

function M.open(options, workspace_id, pinned)
	local captured, resource = options.stamp(), options.resource
	local function alive() return options.current(captured) end
	local function query(payload, callback)
		if not alive() then options.notify("Review context changed; reopen it. Local drafts are unchanged."); return end
		options.request("resource.read", vim.tbl_extend("force", payload, { runtimeRevision = captured.revision }), function(ok, result)
			if not alive() then return end
			if not ok then options.notify(result.message or "Workspace review unavailable"); return end
			callback(result.data)
		end)
	end
	local actions = {}
	local function lookup_action(buf)
		local action = actions[buf]
		if not action or not action.pending then return false end
		if not alive() then options.notify("Old review context; inspect the original review action via :PiLogs / :PiDrafts."); return true end
		options.request("command.status", { commandId = action.pending, serviceEpoch = captured.epoch }, function(ok, receipt)
			if ok then action.status(receipt) else options.notify("Review action status unavailable; original ID retained.") end
		end)
		return true
	end
	local function mutate(buf, reference, operation, path)
		local action = actions[buf]
		if action and action.pending then lookup_action(buf); return end
		if not alive() then options.notify("Old review context cannot mutate; drafts retained."); return end
		if not present(reference) or action and action.used then options.notify("Reopen the review before another index/restore action."); return end
		local function unsaved_restore()
			if operation ~= "restore" then return false end
			for _, candidate in ipairs(vim.api.nvim_list_bufs()) do
				if vim.bo[candidate].modified and vim.b[candidate].pi_review_path == path
					and vim.b[candidate].pi_review_host == options.owner and vim.b[candidate].pi_review_session == captured.session then
					options.notify("A local review buffer has unsaved edits for this file; preserve/close it before restoring the workspace file."); return true
				end
			end
			return false
		end
		if unsaved_restore() then return end
		local control = options.control_stamp()
		local function send()
			if not alive() then options.notify("Review context changed; no action sent."); return end
			if unsaved_restore() then return end
			action = { used = false }
			actions[buf] = action
			action.status = function(receipt)
				if not receipt or receipt.id ~= action.pending or receipt.status == "accepted" then return end
				if receipt.status == "completed" or receipt.status == "failed" then
					action.pending = nil
					action.used = receipt.status == "completed"
					if receipt.status == "completed" then options.notify("Review action completed. Reopen the review for fresh versions; local drafts are unchanged. Restore recovery is in :PiLogs.") end
				end
			end
			action.pending = options.command("workspace.review." .. operation, { actionId = reference, confirmed = operation == "restore" and true or nil }, function(ok, receipt)
				if ok then action.status(receipt)
				elseif receipt.delivery == "not_sent" then action.pending = nil end
			end, control, action.status)
			if action.pending then vim.b[buf].pi_review_command_id, vim.b[buf].pi_review_command_epoch = action.pending, captured.epoch end
		end
		if operation == "restore" then
			vim.ui.select({ "Restore baseline", "Cancel" }, { prompt = "Restore " .. path .. " in the workspace? Restores baseline bytes/index, or removes an added file while keeping its index entry. Original bytes remain in the receipt; local drafts stay unchanged." }, function(choice)
				if choice == "Restore baseline" then send() end
			end)
		else send() end
	end
	local function show_file(review, path)
		local payload = { kind = "workspaceReviewFile", reviewId = review.reviewId, path = path }
		query(payload, function(page)
			local prefix = scratch_name(path) .. "/"
			local editable = present(page.resourceId) and not page.historical and not present(page.unsupported)
			local save_id, submitted, version, resource_id = nil, nil, page.version, page.resourceId
			local buf
			local function status(receipt)
				if not receipt or receipt.id ~= save_id or receipt.status == "accepted" then return end
				if receipt.status == "completed" and receipt.result and receipt.result.resourceId then
					version, resource_id = receipt.result.resourceVersion, receipt.result.resourceId
					if vim.api.nvim_buf_is_valid(buf) and contents(buf) == submitted then vim.bo[buf].modified = false end
					save_id = nil
					options.notify("Workspace file saved. Later local edits remain unsaved.")
				elseif receipt.status == "failed" then
					save_id = nil
				end
			end
			local function lookup()
				if not save_id or not alive() then return end
				options.request("command.status", { commandId = save_id, serviceEpoch = captured.epoch }, function(ok, result)
					if not ok then options.notify("Save status unavailable; original ID and draft retained."); return end
					status(result)
				end)
			end
			local function save(target)
				if save_id then options.notify("Unresolved save; checking the original request only."); lookup(); return end
				if lookup_action(target) then return end
				if not editable then options.notify(page.unsupported or "Historical reviews are read-only"); return end
				if not alive() then options.notify("Old review context cannot save; draft retained."); return end
				submitted = contents(target)
				save_id = options.command("workspace.review.save", { resourceId = resource_id, expectedVersion = version, text = submitted }, function(ok, result)
					if ok then status(result)
					elseif result.delivery == "not_sent" then save_id = nil end
				end, options.control_stamp(), status)
				if save_id then vim.b[target].pi_review_command_id, vim.b[target].pi_review_command_epoch = save_id, captured.epoch end
			end
			readonly(options, prefix .. "before", page.before, resources.filetype(path))
			local before_win = vim.api.nvim_get_current_win()
			buf = editable and options.draft(prefix .. "after", page.after, save) or readonly(options, prefix .. "after", page.after, resources.filetype(path))
			local after_win = vim.api.nvim_get_current_win()
			-- draft() uses a horizontal split; place the after view next to before.
			vim.cmd("wincmd L")
			local value, eol = lines(page.after)
			vim.bo[buf].modeline, vim.bo[buf].filetype = false, resources.filetype(path)
			if editable then vim.api.nvim_buf_set_lines(buf, 0, -1, false, value) end
			vim.bo[buf].endofline, vim.bo[buf].fixendofline, vim.bo[buf].modified = eol, false, false
			if not editable then vim.bo[buf].buftype, vim.bo[buf].modifiable, vim.bo[buf].readonly = "nofile", false, true end
			vim.b[buf].pi_review_path = path -- display metadata only
			vim.b[buf].pi_review_host, vim.b[buf].pi_review_session, vim.b[buf].pi_review_channel = options.owner, captured.session, options.channel
			for _, win in ipairs({ before_win, after_win }) do vim.api.nvim_win_call(win, function() vim.cmd("diffthis"); vim.wo.wrap = false end) end
			vim.keymap.set("n", "gO", function()
				-- Always open a separate view. Never refresh/replace an unsaved buffer.
				query(vim.tbl_extend("force", payload, { resourceId = resource_id }), function(latest)
					readonly(options, scratch_name("current/" .. path), latest.after, resources.filetype(path))
				end)
			end, { buffer = buf, desc = "Inspect saved file content (preserve draft)" })
			vim.keymap.set("n", "gS", function() if not lookup_action(buf) then lookup() end end, { buffer = buf, desc = "Look up original review command" })
			if present(page.actionId) and not page.historical then
				for key, operation in pairs({ s = "stage", u = "unstage", X = "restore" }) do
					vim.keymap.set("n", key, function()
						if save_id then options.notify("Resolve the original save before an index/restore action."); lookup(); return end
						mutate(buf, page.actionId, operation, path)
					end, { buffer = buf, desc = "Workspace review " .. operation })
				end
			end
			vim.keymap.set("n", "gD", function() readonly(options, scratch_name("patch/" .. path), page.diff, "diff") end, { buffer = buf, desc = "Inspect workspace diff" })
			if present(page.unsupported) then options.notify(page.unsupported) end
			if present(page.actionUnsupported) then options.notify(page.actionUnsupported) end
		end)
	end
	query({ kind = "workspaceReview", workspaceId = workspace_id, before = pinned and pinned.before, after = pinned and pinned.after }, function(review)
		local output = { "# Workspace review", resource.label,
			review.historical and "Historical (read-only)" or "Current (text :write requires control)", "", review.notice,
			review.partial and "Partial integration: comparison is the intended Git merge, not a captured post-failure tree." or "", "" }
		local entries = {}
		for _, file in ipairs(review.files or {}) do
			table.insert(output, string.format("%s %s (+%s -%s)%s", file.status, file.path, present(file.additions) and file.additions or "?", present(file.deletions) and file.deletions or "?", file.staged and " [staged]" or ""))
			entries[#output] = file.path
		end
		table.insert(output, ""); table.insert(output, "Ignored files (outside Git diff; historical bytes unavailable):")
		for _, path in ipairs(review.ignoredFiles or {}) do table.insert(output, path); if not review.historical then entries[#output] = path end end
		table.insert(output, ""); table.insert(output, "Other ignored files not preserved by workspace cleanup:")
		for _, path in ipairs(review.unpreservedFiles or {}) do table.insert(output, path) end
		table.insert(output, ""); table.insert(output, "Enter opens a file diff: s stages, u unstages, X confirms baseline restore. S stages reviewed working files; U resets the entire workspace index to HEAD. r opens a fresh review without replacing drafts.")
		table.insert(output, ":write saves only text. gO inspects saved file content; gS looks up the original command; gD shows the patch. = denotes an index-only difference against HEAD.")
		if present(review.stageUnsupported) then table.insert(output, "Stage all: " .. review.stageUnsupported) end
		if present(review.unstageUnsupported) then table.insert(output, "Unstage all: " .. review.unstageUnsupported) end
		local buf = readonly(options, scratch_name("summary"), table.concat(output, "\n"), "markdown")
		require("pi-integration.workspace-summary").highlight(buf)
		vim.keymap.set("n", "<CR>", function() local path = entries[vim.api.nvim_win_get_cursor(0)[1]]; if path then show_file(review, path) end end, { buffer = buf, desc = "Open workspace review file" })
		vim.b[buf].pi_review_host, vim.b[buf].pi_review_session, vim.b[buf].pi_review_channel = options.owner, captured.session, options.channel
		if not review.historical then
			vim.keymap.set("n", "S", function() mutate(buf, review.stageId, "stage") end, { buffer = buf, desc = "Stage all reviewed workspace files" })
			vim.keymap.set("n", "U", function() mutate(buf, review.unstageId, "unstage") end, { buffer = buf, desc = "Reset entire workspace index to HEAD" })
		end
		vim.keymap.set("n", "gS", function() lookup_action(buf) end, { buffer = buf, desc = "Look up original review action" })
		vim.keymap.set("n", "r", function()
			if not alive() then options.notify("Review context changed; use :PiWorkspaceReview for the current selection. Drafts are unchanged."); return end
			M.open(options, workspace_id, pinned)
		end, { buffer = buf, desc = "Open fresh review (preserve drafts)" })
	end)
end
return M
