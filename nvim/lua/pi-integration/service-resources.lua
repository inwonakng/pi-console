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
	function resource.read(query, callback)
		if not alive() then options.notify("Owner resource context changed; reopen the resource."); return end
		viewer_sequence = viewer_sequence + 1
		local ticket = viewer_sequence
		local function fetch(payload)
			options.request("resource.read", vim.tbl_extend("force", payload, { runtimeRevision = captured.revision }), function(ok, result)
				if not alive() or ticket ~= viewer_sequence then return end
				if not ok then options.notify(result.message or "Owner resource read failed"); return end
				callback(result.data)
			end)
		end
		fetch(query)
	end
	-- Small complete documents preserve existing renderers. Large text uses explicit pages.
	function resource.document(query, callback)
		if not alive() then options.notify("Owner resource context changed; reopen the resource."); return end
		viewer_sequence = viewer_sequence + 1
		local ticket, parts, bytes = viewer_sequence, {}, 0
		local function fetch(payload)
			options.request("resource.read", vim.tbl_extend("force", payload, { runtimeRevision = captured.revision }), function(ok, result)
				if not alive() or ticket ~= viewer_sequence then return end
				if not ok then options.notify(result.message or "Owner resource read failed"); return end
				local page = result.data
				bytes = bytes + #page.text
				if bytes > MAX_VIEW_BYTES then
					options.notify("Document exceeds the 4 MiB rendered-view limit; opening paged text instead.")
					resource.open(query, "Large owner document", "text")
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
	function resource.open(query, title, filetype, anchor)
		resource.read(query, function(page)
			require("pi-integration.spawn-artifacts").open_resource({ state = options.state, ui = { notify = options.notify },
				window = { parent = options.state.transcript_win }, resources = resource }, query, title, filetype, page, anchor)
		end)
	end
	function resource.follow(destination, base)
		resource.select()
		if not alive() then options.notify("Owner resource context changed; reopen the resource."); return true end
		local scheme = destination:match("^(%a[%w+.-]*):")
		if scheme and scheme ~= "file" then
			if scheme == "https" or scheme == "http" then
				local _, err = vim.ui.open(destination)
				if err then options.notify(tostring(err)) end
			else options.notify("Owner URI scheme is unavailable: " .. scheme) end
			return true
		end
		if destination:sub(1, 2) == "//" then options.notify("Owner network-path links are unavailable."); return true end
		if scheme == "file" then
			-- Only an empty authority is a path on this owner. Never invoke the OS file opener.
			if not destination:match("^file:///") then options.notify("Owner file URI authority is unavailable."); return true end
			destination = destination:sub(8)
		end
		local path, anchor = destination:match("^([^#]*)#(.*)$")
		path = path or destination
		path = path:gsub("%%(%x%x)", function(hex) return string.char(tonumber(hex, 16)) end)
		if path == "" then return false end
		if base and path:sub(1, 1) ~= "/" then path = (base:match("^(.*)/[^/]*$") or "") .. "/" .. path end
		resource.open({ kind = "file", path = path }, "Owner file " .. path, M.filetype(path), anchor)
		return true
	end
	return resource
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
