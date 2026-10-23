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
	local visible = {}
	local function add(record)
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

function M.pick(host, rows, format_item, on_choice)
	local connection, epoch = host.connection, host.hello.serviceEpoch
	local entries, by_id = {}, {}
	local closed, sequence = false, 0
	local cache, cache_order = {}, {}
	for index, row in ipairs(rows) do
		local id = string.format("%06d", index)
		by_id[id] = row
		table.insert(entries, id .. "\t" .. format_item(row):gsub("[\r\n]", " "))
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
	require("fzf-lua").fzf_exec(entries, {
		prompt = "History on " .. host.alias .. " > ",
		previewer = { _ctor = previewer },
		winopts = { height = 1.0, width = 1.0, preview = { layout = "vertical", vertical = "up:60%", hidden = false, wrap = true },
			on_close = function() closed = true end },
		fzf_opts = { ["--delimiter"] = "[\t]", ["--with-nth"] = "2..", ["--no-multi"] = true, ["--no-sort"] = true,
			["--header"] = "Ctrl-f / Ctrl-b: scroll transcript preview" },
		keymap = { builtin = { ["<C-f>"] = "preview-page-down", ["<C-b>"] = "preview-page-up" },
			fzf = { ["ctrl-f"] = "preview-page-down", ["ctrl-b"] = "preview-page-up" } },
		actions = { enter = function(items)
			-- on_close has run by the time fzf dispatches the selection.
			if host.connected and host.connection == connection and host.hello.serviceEpoch == epoch then
				local row = selected(items[1])
				if row then on_choice(row) end
			end
		end },
	})
end

return M
