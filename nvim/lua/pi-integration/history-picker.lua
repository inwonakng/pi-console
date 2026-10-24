local json = require("pi-integration.utils.json")
local messages = require("pi-integration.messages")
local transcript = require("pi-integration.transcript")
local tool_groups = require("pi-integration.tool-groups")
local M = {}
local MAX_PREVIEW_BYTES = 4 * 1024 * 1024

local function render(row, contents, truncated)
	local records, by_id, leaf = {}, {}, nil
	for line in contents:gmatch("[^\n]+") do
		local record = json.decode_object(line)
		if record then
			table.insert(records, record)
			if record.id and record.type ~= "session" then
				by_id[record.id], leaf = record, record.id
			end
		end
	end
	-- As in the stable picker, preview the latest branch, not every sibling branch.
	local branch, seen = {}, {}
	while leaf and by_id[leaf] and not seen[leaf] do
		seen[leaf] = true
		table.insert(branch, by_id[leaf])
		leaf = by_id[leaf].parentId
	end
	local visible, permissions = {}, {}
	local function add(record)
		if require("pi-integration.permission-output").add_record(visible, permissions, record) then return end
		if record.type == "message" and type(record.message) == "table" then
			table.insert(visible, record.message)
		elseif record.type == "custom_message" then
			table.insert(visible, { role = "custom", customType = record.customType, content = record.content,
				display = record.display, details = record.details, timestamp = record.timestamp })
		elseif record.type == "compaction" then
			table.insert(visible, { role = "compactionSummary", summary = record.summary, tokensBefore = record.tokensBefore,
				firstKeptEntryId = record.firstKeptEntryId, timestamp = record.timestamp })
		elseif record.type == "branch_summary" then
			table.insert(visible, { role = "assistant", content = "Branch summary: " .. tostring(record.summary or "") })
		end
	end
	if #branch > 0 then
		for index = #branch, 1, -1 do add(branch[index]) end
	else
		for _, record in ipairs(records) do add(record) end
	end
	local state = require("pi-integration.state").new()
	local lines, items = messages.collect_message_lines({ state = state, notices = { empty_session = "No messages yet." },
		transcript = { metadata_lines = function() return {} end } }, visible)
	lines, items = tool_groups.preview_lines(lines, items)
	state.transcript_items = items
	if truncated then
		vim.list_extend(lines, { "", "> Preview limited to the first 4 MiB of session history." })
	end
	return { cache_key = row.id, content = lines, filetype = "markdown", pi_state = state }
end

function M.pick(host, rows, format_item, on_choice, opts)
	opts = opts or {}
	local connection, epoch = host.connection, host.hello.serviceEpoch
	local entries, labels, by_id = {}, {}, {}
	local closed, sequence = false, 0
	local cache, cache_order = {}, {}
	for index, row in ipairs(rows) do
		local id = string.format("%06d", index)
		by_id[id] = row
		labels[index] = format_item(row):gsub("[\r\n]", " ")
		table.insert(entries, id .. "\t" .. labels[index])
	end
	local function current()
		return not closed and host.connected and host.connection == connection and host.hello.serviceEpoch == epoch
	end
	local function selected(entry)
		return by_id[entry and entry:match("^(%d+)\t")]
	end
	local function previewer()
		local base = require("fzf-lua.previewer.builtin").buffer_or_file:extend()
		local preview_buf_post, update_render_markdown = base.preview_buf_post, base.update_render_markdown
		function base:parse_entry(entry, callback)
			sequence = sequence + 1
			local ticket, row = sequence, selected(entry)
			if not row then return {} end
			if not current() then return { content = { "Host disconnected; reopen session history." } } end
			if cache[row.id] then return cache[row.id] end
			if not vim.tbl_contains(host.hello.capabilities or {}, "host.history") then
				return { content = { "Transcript preview requires an updated host service." } }
			end
			local parts, bytes = {}, 0
			local function fetch(offset, version)
				connection.request("host.history", { serviceEpoch = epoch, sessionId = row.id, offset = offset, version = version }, function(ok, page)
					if not current() or ticket ~= sequence then callback({}); return end
					if not ok then callback({ content = { page.message or "Session history unavailable." } }); return end
					table.insert(parts, page.text)
					bytes = bytes + #page.text
					local more = page.nextOffset and page.nextOffset ~= vim.NIL
					if more and bytes < MAX_PREVIEW_BYTES then fetch(page.nextOffset, page.version); return end
					local result = render(row, table.concat(parts), more)
					result.tick = page.version -- Invalidate fzf-lua's buffer cache after live appends.
					if row.state ~= "open" then
						cache[row.id] = result
						table.insert(cache_order, row.id)
						if #cache_order > 4 then cache[table.remove(cache_order, 1)] = nil end
					end
					callback(result)
				end)
			end
			fetch()
			return nil -- fzf-lua resumes this preview asynchronously through callback.
		end
		function base:preview_buf_post(entry, min_winopts)
			if entry.cached and entry.cached.tick ~= entry.tick then
				self.bcache:reset_pos(self.preview_bufnr)
			end
			self.pi_preview_state = entry.pi_state
			preview_buf_post(self, entry, min_winopts)
			transcript.apply_quote_highlights_to_buffer(self.preview_bufnr, self.pi_preview_state, { preview = true })
		end
		function base:update_render_markdown()
			update_render_markdown(self)
			transcript.apply_quote_highlights_to_buffer(self.preview_bufnr, self.pi_preview_state, { preview = true })
		end
		return base
	end
	local function action(callback)
		return function(items)
			-- on_close runs before fzf dispatches actions.
			if not host.connected or host.connection ~= connection or host.hello.serviceEpoch ~= epoch then return end
			local chosen, seen = {}, {}
			for _, item in ipairs(items) do
				local row = selected(item)
				if row and not seen[row.id] then table.insert(chosen, row); seen[row.id] = true end
			end
			callback(chosen)
		end
	end
	local keymap = { ["ctrl-f"] = "preview-page-down", ["ctrl-b"] = "preview-page-up", ["ctrl-a"] = "toggle-all" }
	if opts.select_all then keymap.load = "select-all+unbind(load)" end
	require("fzf-lua").fzf_live(function(args)
		local query = args[1] or ""
		if query == "" then return entries end
		local result = vim.system({ "rg", "--no-config", "--color=never", "--smart-case", "--line-number", "--", query },
			{ stdin = labels, text = true }):wait()
		if result.code == 1 then return {} end
		if result.code ~= 0 then return { "\t" .. vim.trim(result.stderr):gsub("\n", " ") } end
		local matches = {}
		for line in result.stdout:gmatch("[^\n]+") do
			local index = tonumber(line:match("^(%d+):"))
			if index and entries[index] then table.insert(matches, entries[index]) end
		end
		return matches
	end, {
		prompt = (opts.archived and "Archived" or "Sessions") .. " on " .. host.alias .. " (regex) > ",
		previewer = { _ctor = previewer },
		winopts = { height = 1.0, width = 1.0, preview = { layout = "vertical", vertical = "up:60%", hidden = false, wrap = true },
			on_close = function() closed = true end },
		fzf_opts = { ["--delimiter"] = "[\t]", ["--with-nth"] = "2..", ["--multi"] = true, ["--no-sort"] = true,
			["--header"] = "Tab: select / Ctrl-a: all / Ctrl-f, Ctrl-b: scroll preview" },
		keymap = { builtin = { ["<C-f>"] = "preview-page-down", ["<C-b>"] = "preview-page-up" }, fzf = keymap },
		actions = {
			enter = { fn = action(function(chosen) if chosen[1] then on_choice(chosen[1]) end end), header = "open" },
			["ctrl-r"] = opts.on_archive and { fn = action(opts.on_archive), header = opts.archived and "unarchive" or "archive" } or nil,
			["ctrl-x"] = opts.on_delete and { fn = action(opts.on_delete), header = "delete" } or nil,
			["ctrl-g"] = opts.on_toggle_view and { fn = action(opts.on_toggle_view), header = opts.archived and "show regular" or "show archived" } or nil,
		},
	})
end

return M
