-- Bound read adapters for the existing inspectors. Never interpret owner paths locally.
local M = {}
local buffers, completion_cache, completion_pending = {}, {}, {}
local viewer_sequence, buffer_sequence = 0, 0
local MAX_VIEW_BYTES = 4 * 1024 * 1024

function M.invalidate()
	completion_cache, completion_pending = {}, {}
	viewer_sequence = viewer_sequence + 1
	local cmp = package.loaded["blink.cmp"]
	if cmp then
		cmp.cancel()
		-- cancel() alone leaves hidden, pending provider requests cached.
		require("blink.cmp.completion.trigger").hide()
	end
end

function M.for_buffer(buf) return buffers[buf or vim.api.nvim_get_current_buf()] end

-- Filename-only mapping. Native filetype detectors can consult frontend files.
function M.filetype(path)
	local extension = tostring(path or ""):match("%.([%w]+)$")
	return ({ md = "markdown", markdown = "markdown", json = "json", jsonl = "json", lua = "lua",
		py = "python", js = "javascript", ts = "typescript", sh = "sh", rs = "rust", go = "go",
		c = "c", h = "c", cpp = "cpp", yaml = "yaml", yml = "yaml", toml = "toml", diff = "diff", patch = "diff" })[extension] or "text"
end

function M.new(options)
	viewer_sequence = viewer_sequence + 1
	local captured = options.stamp()
	local resource = { label = options.label, context = options.key }
	local function alive() return options.current(captured) end
	function resource.select() viewer_sequence = viewer_sequence + 1; return viewer_sequence end
	function resource.current(ticket) return alive() and (not ticket or viewer_sequence == ticket) end
	function resource.bind(buf, path)
		buffers[buf] = { resource = resource, path = path }
		vim.api.nvim_create_autocmd("BufWipeout", { buffer = buf, once = true, callback = function() buffers[buf] = nil end })
	end
	function resource.qualify(buf, title, path)
		buffer_sequence = buffer_sequence + 1
		vim.api.nvim_buf_set_name(buf, "pi://owner/" .. buffer_sequence .. "/" .. (title or "resource"):gsub("[^%w._-]", "-"))
		vim.bo[buf].buftype, vim.bo[buf].swapfile, vim.bo[buf].modeline = "nofile", false, false
		vim.bo[buf].modifiable, vim.bo[buf].readonly = false, true
		resource.bind(buf, path)
	end
	function resource.read(query, callback, on_error)
		if not alive() then options.notify("Session context changed; reopen the resource."); return end
		viewer_sequence = viewer_sequence + 1
		local ticket = viewer_sequence
		local function fetch(payload)
			options.request("resource.read", vim.tbl_extend("force", payload, { runtimeRevision = captured.revision }), function(ok, result)
				if not alive() or ticket ~= viewer_sequence then return end
				if not ok then
					if on_error then on_error(result) else options.notify(result.message or "Could not read resource") end
					return
				end
				callback(result.data)
			end)
		end
		fetch(query)
	end
	-- Small complete documents preserve existing renderers. Large text uses explicit pages.
	function resource.document(query, callback, on_error)
		if not alive() then options.notify("Session context changed; reopen the resource."); return end
		viewer_sequence = viewer_sequence + 1
		local ticket, parts, bytes = viewer_sequence, {}, 0
		local function fetch(payload)
			options.request("resource.read", vim.tbl_extend("force", payload, { runtimeRevision = captured.revision }), function(ok, result)
				if not alive() or ticket ~= viewer_sequence then return end
				if not ok then
					if on_error then on_error(result.message or "Could not read resource")
					else options.notify(result.message or "Could not read resource") end
					return
				end
				local page = result.data
				bytes = bytes + #page.text
				if bytes > MAX_VIEW_BYTES then
					options.notify("Document exceeds the 4 MiB rendered-view limit; opening paged text instead.")
					resource.open(query, "Large document", "text")
					return
				end
				table.insert(parts, page.text)
				if page.nextOffset and page.nextOffset ~= vim.NIL then
					fetch(vim.tbl_extend("force", query, { offset = page.nextOffset, version = page.version }))
				else callback(table.concat(parts), page) end
			end)
		end
		fetch(query)
	end
	function resource.open_readonly(query, title, filetype, anchor)
		resource.read(query, function(page)
			require("pi-integration.spawn-artifacts").open_resource({ state = options.state, ui = { notify = options.notify },
				window = { parent = options.state.transcript_win }, resources = resource }, query, title, filetype, page, anchor)
		end)
	end
	function resource.open(query, title, filetype, anchor)
		if query.kind == "file" and query.offset == nil and query.version == nil and resource.edit then
			resource.edit(query, title, filetype, anchor)
		else resource.open_readonly(query, title, filetype, anchor) end
	end
	function resource.follow(destination, base)
		resource.select()
		if not alive() then options.notify("Session context changed; reopen the resource."); return true end
		local scheme = destination:match("^(%a[%w+.-]*):")
		if scheme and scheme ~= "file" then
			if scheme == "https" or scheme == "http" or scheme == "mailto" or scheme == "zotero" then
				local _, err = vim.ui.open(destination)
				if err then options.notify(tostring(err)) end
			else options.notify("Unsupported link scheme: " .. scheme) end
			return true
		end
		if destination:sub(1, 2) == "//" then
			local _, err = vim.ui.open("https:" .. destination)
			if err then options.notify(tostring(err)) end
			return true
		end
		if scheme == "file" then
			-- Only an empty authority is a path on this owner. Never invoke the OS file opener.
			if not destination:match("^file:///") then options.notify("File links with a host name are not supported."); return true end
			destination = destination:sub(8)
		end
		local path, anchor = destination:match("^([^#]*)#(.*)$")
		path = path or destination
		path = path:gsub("%%(%x%x)", function(hex) return string.char(tonumber(hex, 16)) end)
		if path == "" then return false end
		if base and path:sub(1, 1) ~= "/" then path = (base:match("^(.*)/[^/]*$") or "") .. "/" .. path end
		path = vim.fs.normalize(path, { expand_env = false })
		resource.open({ kind = "file", path = path }, "File " .. path, M.filetype(path), anchor)
		return true
	end
	return resource
end

-- Draft buffers and commands come from the frontend's existing recovery/receipt path.
-- A file path is only display/link metadata; it never names a frontend file to write.
function M.edit(options, resource, query, title, filetype, anchor)
	local captured = options.stamp()
	local function alive() return options.current(captured) end
	resource.read({ kind = "workspaceFile", path = query.path }, function(page)
		if not page.resourceId or page.resourceId == vim.NIL then
			if page.unsupported and page.unsupported ~= vim.NIL then options.notify(page.unsupported .. "; opening read-only text.") end
			resource.open_readonly(query, title, filetype, anchor)
			return
		end
		local version, resource_id, save_id, submitted = page.version, page.resourceId, nil, nil
		local buf
		local function contents()
			return table.concat(vim.api.nvim_buf_get_lines(buf, 0, -1, false), "\n") .. (vim.bo[buf].endofline and "\n" or "")
		end
		local function status(receipt)
			if not receipt or receipt.id ~= save_id or receipt.status == "accepted" then return end
			if receipt.status == "completed" and receipt.result and receipt.result.resourceId then
				version, resource_id = receipt.result.resourceVersion, receipt.result.resourceId
				if vim.api.nvim_buf_is_valid(buf) and contents() == submitted then vim.bo[buf].modified = false end
				save_id = nil
				options.notify("Workspace file saved. Later local edits remain unsaved.")
			elseif receipt.status == "failed" then
				save_id = nil
			end
		end
		local function lookup()
			if not save_id then return end
			if not alive() then options.notify("Session context changed; inspect the original command via :PiLogs / :PiDrafts."); return end
			options.request("command.status", { commandId = save_id, serviceEpoch = captured.epoch }, function(ok, receipt)
				if not alive() then return end
				if ok then status(receipt) else options.notify("Save status unavailable; draft and original ID retained.") end
			end)
		end
		local function save()
			if save_id then options.notify("Unresolved save; checking the original request only."); lookup(); return end
			if not alive() then options.notify("Session context changed; cannot save. Local draft retained."); return end
			submitted = contents()
			save_id = options.command("workspace.review.save", { resourceId = resource_id, expectedVersion = version, text = submitted }, function(ok, receipt)
				if not alive() then return end
				if ok then status(receipt)
				elseif receipt.delivery == "not_sent" then save_id = nil end
			end, options.control_stamp(), status)
			if save_id then vim.b[buf].pi_review_command_id, vim.b[buf].pi_review_command_epoch = save_id, captured.epoch end
		end
		buffer_sequence = buffer_sequence + 1
		buf = options.draft("pi://owner-file/" .. buffer_sequence .. "/" .. (title or page.path):gsub("[^%w._-]", "-"), page.text, save)
		local value = vim.split(page.text, "\n", { plain = true })
		local eol = #value > 1 and value[#value] == ""
		if eol then table.remove(value) end
		vim.bo[buf].modeline, vim.bo[buf].swapfile = false, false
		vim.bo[buf].buftype, vim.bo[buf].modifiable, vim.bo[buf].readonly = "acwrite", true, false
		vim.api.nvim_buf_set_lines(buf, 0, -1, false, value)
		vim.bo[buf].filetype = filetype or M.filetype(page.path)
		vim.bo[buf].endofline, vim.bo[buf].fixendofline, vim.bo[buf].modified = eol, false, false
		vim.b[buf].pi_review_path = page.reviewPath
		vim.b[buf].pi_review_host, vim.b[buf].pi_review_session, vim.b[buf].pi_review_channel = options.owner, captured.session, options.channel
		resource.bind(buf, page.path)
		vim.keymap.set("n", "gS", lookup, { buffer = buf, desc = "Look up original save" })
		vim.keymap.set("n", "gO", function()
			-- Separate owner view: no refresh ever replaces the user's draft.
			resource.open_readonly(query, "Saved file " .. page.path, filetype)
		end, { buffer = buf, desc = "Inspect saved file content (preserve draft)" })
		vim.keymap.set("n", "<CR>", function() require("pi-integration.utils.markdown-links").follow(nil, resource) end,
			{ buffer = buf, desc = "Follow link" })
		if anchor then pcall(require("pi-integration.utils.markdown-links").jump_to_heading, anchor) end
	end)
end

function M.complete(options, prefix, callback)
	local key = options.key .. ":" .. prefix
	local captured = options.stamp()
	if not options.current(captured) then callback({ entries = {} }); return end
	local cached = completion_cache[key]
	if cached and vim.uv.hrtime() - cached.time < 5000000000 then callback(cached.data); return end
	-- Typing/backspacing within the same directory shares one owner scan and page chain.
	local listener = { callback = callback }
	local cancel = function() listener.callback = nil end
	local pending = completion_pending[key]
	if pending then table.insert(pending, listener); return cancel end
	pending = { listener }
	completion_pending[key] = pending
	local entries, offset, truncated = {}, nil, false
	local function finish(data)
		if completion_pending[key] == pending then completion_pending[key] = nil end
		for _, subscriber in ipairs(pending) do if subscriber.callback then subscriber.callback(data) end end
	end
	local function fetch()
		local query = { runtimeRevision = captured.revision, prefix = prefix, offset = offset }
		options.request("resource.complete", query, function(ok, result)
			if not options.current(captured) then finish({ entries = {} }); return end
			local listening = false
			for _, subscriber in ipairs(pending) do if subscriber.callback then listening = true; break end end
			if not listening then finish({ entries = {} }); return end
			if not ok then finish({ entries = {}, error = result.message }); return end
			vim.list_extend(entries, result.data.entries or {})
			truncated = truncated or result.data.truncated == true
			offset = result.data.nextOffset
			local more = offset and offset ~= vim.NIL
			if more and #entries < 50000 then fetch(); return end
			local data = { entries = entries, truncated = truncated or more == true }
			completion_cache = { [key] = { data = data, time = vim.uv.hrtime() } }
			finish(data)
		end)
	end
	fetch()
	return cancel
end
return M
