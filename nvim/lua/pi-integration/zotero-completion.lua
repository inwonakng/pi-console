-- blink.cmp source for @z: Zotero references in pi://input. zotero-tools owns
-- credentials, Zotero requests, entry building and the persistent cache; this
-- module keeps entries in memory, refreshes them in the background and ranks.
local M = {}

local KINDS = { "paper", "collection", "tag" }
local MAX_AGE, RETRY = 60000, 10000

local function token(line, col)
	local before = line:sub(1, col)
	local start, tail = before:match("()@z:([^@\r\n]*)$")
	if not start or (start > 1 and not before:sub(start - 1, start - 1):match("%s")) then
		return nil
	end
	return { start = start - 1, tail = tail }
end

-- All words must match: contiguous matches rank ahead of subsequence matches.
local function score(search, query)
	local total = 0
	for word in vim.fn.tolower(query):gmatch("%S+") do
		local contiguous = search:find(word, 1, true)
		if contiguous then
			total = total + contiguous - 1
		else
			local position = 0
			for char in word:gmatch(".") do
				position = search:find(char, position + 1, true)
				if not position then
					return nil
				end
			end
			total = total + 1000 + position - 1
		end
	end
	return total
end

local function now()
	return vim.uv.hrtime() / 1000000
end

local function valid(entries)
	if type(entries) ~= "table" then return nil end
	for _, entry in ipairs(entries) do
		if type(entry) ~= "table" or type(entry.value) ~= "string" or type(entry.label) ~= "string"
			or type(entry.description) ~= "string" or type(entry.search) ~= "string" then
			return nil
		end
	end
	return entries
end

local source = {}

function source.new()
	return setmetatable({ caches = {}, error_shown = false }, { __index = source })
end

function source:enabled()
	return vim.api.nvim_buf_get_name(0) == "pi://input"
end

function source:get_trigger_characters()
	return { "@", ":" }
end

function source:warn(message, cached)
	if not self.error_shown then
		self.error_shown = true
		require("pi-integration.logs").notify(message .. (cached and " (using cached suggestions)" or ""), vim.log.levels.WARN)
	end
end

-- Serve held entries immediately; refresh through the CLI at most once a minute.
-- The CLI prints cached entries first and a second line only if they changed.
function source:load(kind, callback)
	local state = self.caches[kind]
	if not state then
		state = { loaded = -math.huge, retry = 0, waiters = {} }
		self.caches[kind] = state
	end
	if state.job then
		if state.entries then callback(state.entries) else table.insert(state.waiters, callback) end
		return
	end
	if now() < state.retry or (state.entries and now() - state.loaded < MAX_AGE) then
		callback(state.entries or {})
		return
	end
	if state.entries then callback(state.entries) else table.insert(state.waiters, callback) end
	local function flush()
		local waiters = state.waiters
		state.waiters = {}
		for _, waiter in ipairs(waiters) do waiter(state.entries or {}) end
	end
	local buffered, failure = "", nil
	local function line(text)
		local ok, envelope = pcall(vim.json.decode, text)
		if not ok or type(envelope) ~= "table" then return end
		if envelope.ok == true then
			local entries = valid(type(envelope.data) == "table" and envelope.data.entries)
			if entries then
				state.entries = entries
				flush()
			end
		elseif type(envelope.error) == "table" and type(envelope.error.message) == "string" then
			failure = envelope.error.message
		end
	end
	local started, job = pcall(vim.system, { "zotero-tools", "completions", kind }, {
		text = true,
		stdout = function(_, data)
			if not data then return end
			vim.schedule(function()
				buffered = buffered .. data
				local start = 1
				for stop in buffered:gmatch("()\n") do
					line(buffered:sub(start, stop - 1))
					start = stop + 1
				end
				buffered = buffered:sub(start)
			end)
		end,
	}, function(result)
		vim.schedule(function()
			state.job = nil
			if result.code == 0 then
				state.loaded, self.error_shown = now(), false
			else
				state.retry = now() + RETRY
				self:warn(failure or ("zotero-tools exited with status " .. result.code .. "."), state.entries ~= nil)
			end
			flush()
		end)
	end)
	if started then
		state.job = job
	else
		state.retry = now() + RETRY
		self:warn("zotero-tools is not installed or not on PATH. Run scripts/install.sh in the zotero-tools checkout.")
		flush()
	end
end

function source:get_completions(ctx, callback)
	local cancelled = false
	local ref = token(ctx.line, ctx.cursor[2])
	local function complete(entries)
		if cancelled then return end
		local items = {}
		for _, entry in ipairs(entries) do
			table.insert(items, {
				label = entry.label,
				kind = require("blink.cmp.types").CompletionItemKind.Reference,
				detail = entry.description,
				labelDetails = { description = entry.description },
				-- Already filtered across the full query, including author/tag matches.
				filterText = ctx.get_keyword(),
				sortText = ("%04d"):format(#items + 1),
				textEdit = {
					newText = entry.value .. (entry.value:sub(1, 3) == "@z:" and "" or " "),
					range = {
						start = { line = ctx.cursor[1] - 1, character = ref.start },
						["end"] = { line = ctx.cursor[1] - 1, character = ctx.cursor[2] },
					},
				},
			})
		end
		callback({ items = items, is_incomplete_forward = true, is_incomplete_backward = true })
	end
	if vim.api.nvim_buf_get_name(ctx.bufnr) ~= "pi://input" or not ref then
		callback({ items = {}, is_incomplete_forward = false, is_incomplete_backward = false })
		return
	end
	local kind, query = ref.tail:match("^([^:]+):(.*)$")
	if not kind then
		local entries = {}
		for _, candidate in ipairs(KINDS) do
			if candidate:sub(1, #ref.tail) == ref.tail then
				local value = "@z:" .. candidate .. ":"
				table.insert(entries, { value = value, label = value, description = "Search Zotero " .. candidate .. "s" })
			end
		end
		complete(entries)
	elseif vim.tbl_contains(KINDS, kind) then
		self:load(kind, function(entries)
			local matches = {}
			for index, entry in ipairs(entries) do
				local rank = score(entry.search, query)
				if rank then table.insert(matches, { entry = entry, score = rank, index = index }) end
			end
			table.sort(matches, function(a, b)
				return a.score == b.score and a.index < b.index or a.score < b.score
			end)
			local filtered = {}
			for index = 1, math.min(20, #matches) do
				table.insert(filtered, matches[index].entry)
			end
			complete(filtered)
		end)
	else
		complete({})
	end
	return function()
		cancelled = true
	end
end

M.new = source.new
return M
