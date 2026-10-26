-- Owner review data only. Owner paths never name frontend files or Git commands.
local M = {}
local resources = require("pi-integration.service-resources")
local sequence = 0
local selected_ns = vim.api.nvim_create_namespace("PiReviewSelected")
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
local function readonly(options, title, value, filetype, new_tab, target_win)
	local buf = require("pi-integration.layout").create_buffer(nil, title, filetype or "text", true)
	local value_lines, eol = lines(value)
	vim.api.nvim_buf_set_lines(buf, 0, -1, false, value_lines)
	vim.bo[buf].endofline, vim.bo[buf].fixendofline, vim.bo[buf].modified = eol, false, false
	vim.bo[buf].buftype, vim.bo[buf].modifiable, vim.bo[buf].readonly = "nofile", false, true
	vim.bo[buf].modeline, vim.bo[buf].filetype = false, filetype or "text"
	if target_win then vim.api.nvim_set_current_win(target_win) else vim.cmd(new_tab and "tabnew" or "botright split") end
	vim.api.nvim_win_set_buf(0, buf)
	return buf
end

function M.open(options, workspace_id, pinned)
	local captured, resource = options.stamp(), options.resource
	local review_tab, list_win, before_win, after_win, list_buf
	local files, selection, rows = {}, 0, {}
	local help_state, help_lines, displayed = {}, {}, nil
	local help_name = scratch_name("help")
	local function bind_help(buf)
		vim.keymap.set("n", "?", function()
			local output = vim.list_extend({}, help_lines)
			if displayed then
				vim.list_extend(output, { "", "## Displayed file", displayed.path,
					displayed.historical and "Historical file (read-only)" or "Current file" })
				for _, message in ipairs(displayed.messages) do table.insert(output, message) end
			end
			require("pi-integration.help").toggle_window(help_state, {
				name = help_name, title = "Workspace review help", lines = output,
				parent = vim.api.nvim_get_current_win(),
			})
		end, { buffer = buf, desc = "Workspace review help" })
	end
	local function style_window(win, role, path)
		local group = "PiReview" .. role .. "Status"
		vim.wo[win].statusline = "%#" .. group .. "# " .. role
			.. (path and " | " .. path:gsub("%%", "%%%%") or "") .. " %="
		vim.wo[win].fillchars = "stl: ,stlnc: "
		vim.wo[win].winhighlight = "StatusLine:" .. group .. ",StatusLineNC:" .. group
			.. ",DiffChange:PiReviewDiffChange,DiffText:PiReviewDiffText"
	end
	local function anchor_list()
		if not review_tab or not vim.api.nvim_tabpage_is_valid(review_tab)
			or not list_win or not vim.api.nvim_win_is_valid(list_win)
			or vim.api.nvim_get_current_tabpage() ~= review_tab then return end
		local layout = vim.fn.winlayout()
		if layout[1] ~= "leaf" and not (layout[1] == "row" and layout[2][1][1] == "leaf" and layout[2][1][2] == list_win) then
			local width = vim.api.nvim_win_get_width(list_win)
			vim.api.nvim_win_call(list_win, function() vim.cmd("wincmd H") end)
			vim.api.nvim_win_set_width(list_win, width)
		end
	end
	local function ensure_windows()
		if not vim.api.nvim_win_is_valid(list_win) then options.notify("File list closed; reopen the review. Drafts are unchanged."); return false end
		if not before_win or not vim.api.nvim_win_is_valid(before_win) then
			local blank = vim.api.nvim_create_buf(false, true)
			vim.bo[blank].bufhidden = "wipe"
			before_win = vim.api.nvim_open_win(blank, true, { split = "right", win = list_win })
			vim.wo[before_win].winfixwidth = false
			bind_help(blank)
		end
		if not after_win or not vim.api.nvim_win_is_valid(after_win) then
			local blank = vim.api.nvim_create_buf(false, true)
			vim.bo[blank].bufhidden = "wipe"
			after_win = vim.api.nvim_open_win(blank, true, { split = "below", win = before_win })
			vim.wo[after_win].winfixwidth = false
			bind_help(blank)
		end
		style_window(list_win, "Files")
		style_window(before_win, "Before", displayed and displayed.path)
		style_window(after_win, "After", displayed and displayed.path)
		anchor_list()
		return true
	end
	local function display_file(pair)
		if not ensure_windows() then return end
		vim.api.nvim_win_set_buf(before_win, pair.before)
		vim.api.nvim_win_set_buf(after_win, pair.after)
		for _, win in ipairs({ before_win, after_win }) do
			vim.api.nvim_win_call(win, function() vim.cmd("diffthis"); vim.wo.wrap = false end)
		end
		vim.api.nvim_set_current_win(after_win)
		vim.cmd("diffupdate")
		displayed = pair
		style_window(before_win, "Before", pair.path)
		style_window(after_win, "After", pair.path)
		vim.api.nvim_buf_clear_namespace(list_buf, selected_ns, 0, -1)
		if rows[pair.path] then
			vim.api.nvim_buf_set_extmark(list_buf, selected_ns, rows[pair.path] - 1, 0, {
				line_hl_group = "PiReviewSelected", hl_eol = true,
			})
		end
	end
	local function alive() return options.current(captured) end
	local function query(payload, callback)
		if not alive() then options.notify("Review context changed; reopen it. Local drafts are unchanged."); return end
		options.request("resource.read", vim.tbl_extend("force", payload, { runtimeRevision = captured.revision }), function(ok, result)
			if not alive() then return end
			if not ok then options.notify(result.message or "Workspace review unavailable"); return end
			if review_tab then
				if not vim.api.nvim_tabpage_is_valid(review_tab) then return end
				vim.api.nvim_set_current_tabpage(review_tab)
			end
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
		selection = selection + 1
		local ticket = selection
		local pair = files[path]
		if pair then
			if vim.api.nvim_buf_is_valid(pair.before) and vim.api.nvim_buf_is_valid(pair.after) then display_file(pair)
			else options.notify("Review buffer closed; reopen the review. Other drafts are unchanged.") end
			return
		end
		local payload = { kind = "workspaceReviewFile", reviewId = review.reviewId, path = path }
		query(payload, function(page)
			if selection ~= ticket or not ensure_windows() then return end
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
			local before_buf = readonly(options, prefix .. "before", page.before, resources.filetype(path), false, before_win)
			buf = editable and options.draft(prefix .. "after", page.after, save, nil, after_win)
				or readonly(options, prefix .. "after", page.after, resources.filetype(path), false, after_win)
			local value, eol = lines(page.after)
			vim.bo[buf].modeline, vim.bo[buf].filetype = false, resources.filetype(path)
			if editable then vim.api.nvim_buf_set_lines(buf, 0, -1, false, value) end
			vim.bo[buf].endofline, vim.bo[buf].fixendofline, vim.bo[buf].modified = eol, false, false
			if not editable then vim.bo[buf].buftype, vim.bo[buf].modifiable, vim.bo[buf].readonly = "nofile", false, true end
			vim.b[buf].pi_review_path = path -- display metadata only
			vim.b[buf].pi_review_host, vim.b[buf].pi_review_session, vim.b[buf].pi_review_channel = options.owner, captured.session, options.channel
			local messages = {}
			if present(page.unsupported) then table.insert(messages, page.unsupported) end
			if present(page.actionUnsupported) then table.insert(messages, page.actionUnsupported) end
			files[path] = { before = before_buf, after = buf, path = path, historical = page.historical, messages = messages }
			bind_help(before_buf)
			bind_help(buf)
			display_file(files[path])
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
		help_lines = { "# Workspace review", resource.label,
			review.historical and "Historical (read-only)" or "Current (text :write requires control)", "" }
		if present(review.notice) then table.insert(help_lines, review.notice) end
		if review.partial then table.insert(help_lines, "Partial integration: comparison is the intended Git merge, not a captured post-failure tree.") end
		vim.list_extend(help_lines, {
			"", "## Files", "Enter opens a file diff. The highlighted file is the displayed comparison.",
			"S stages reviewed working files; U resets the entire workspace index to HEAD.",
			"r opens a fresh review without replacing drafts; gS looks up the original review action.",
			"= denotes an index-only difference against HEAD.",
			"Ignored files are outside the Git diff; historical bytes are unavailable.",
			"Unpreserved ignored files are not preserved by workspace cleanup.",
			"", "## After pane", "s stages, u unstages, X confirms baseline restore.",
			":write saves only text. gO inspects saved file content without replacing drafts.",
			"gS looks up the original command; gD shows the patch.",
			"Historical reviews cannot save, stage, unstage, or restore.",
			"", "? opens help from any review pane; q or Esc closes help.",
		})
		if present(review.stageUnsupported) then table.insert(help_lines, "Stage all: " .. review.stageUnsupported) end
		if present(review.unstageUnsupported) then table.insert(help_lines, "Unstage all: " .. review.unstageUnsupported) end
		local output, entries = {}, {}
		for _, file in ipairs(review.files or {}) do
			table.insert(output, string.format("%s %s (+%s -%s)%s", file.status, file.path, present(file.additions) and file.additions or "?", present(file.deletions) and file.deletions or "?", file.staged and " [staged]" or ""))
			entries[#output], rows[file.path] = file.path, #output
		end
		table.insert(output, ""); table.insert(output, "Ignored files:")
		for _, path in ipairs(review.ignoredFiles or {}) do
			table.insert(output, path)
			if not review.historical then entries[#output], rows[path] = path, #output end
		end
		table.insert(output, ""); table.insert(output, "Unpreserved ignored files:")
		for _, path in ipairs(review.unpreservedFiles or {}) do table.insert(output, path) end
		if (review.unpreservedFilesOmitted or 0) > 0 then
			table.insert(output, string.format("... %d more ignored files omitted", review.unpreservedFilesOmitted))
		end
		local buf = readonly(options, scratch_name("summary"), table.concat(output, "\n"), "markdown", true)
		list_buf = buf
		bind_help(buf)
		review_tab, list_win = vim.api.nvim_get_current_tabpage(), vim.api.nvim_get_current_win()
		vim.wo[list_win].winfixwidth = true
		local anchoring = false
		vim.api.nvim_create_autocmd({ "WinNew", "WinClosed", "WinResized", "WinEnter", "TabEnter", "SafeState" }, { callback = function(event)
			if not vim.api.nvim_tabpage_is_valid(review_tab) or not vim.api.nvim_win_is_valid(list_win) then return true end
			-- Equal-sized pane moves can change topology without resize or focus events.
			if event.event == "SafeState" then anchor_list(); return end
			if anchoring then return end
			anchoring = true
			vim.schedule(function() anchor_list(); anchoring = false end)
		end })
		-- Reserve the comparison area so the file list starts narrow even before selection.
		ensure_windows()
		vim.api.nvim_win_set_width(list_win, math.min(36, math.max(1, math.floor(vim.o.columns / 4))))
		vim.api.nvim_set_current_win(list_win)
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
