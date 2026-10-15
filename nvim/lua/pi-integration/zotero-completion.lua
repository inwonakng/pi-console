local M = {}

local API = "http://127.0.0.1:23119/api/users/0/"
local KINDS = { "paper", "collection", "tag" }
local ENDPOINTS = { paper = "items/top", collection = "collections", tag = "tags" }

local function token(line, col)
	local before = line:sub(1, col)
	local start, prefix = before:match("()@z:([^@\r\n]*)$")
	if not start or (start > 1 and not before:sub(start - 1, start - 1):match("%s")) then
		return nil
	end
	return { start = start - 1, prefix = "@z:" .. prefix, tail = prefix }
end

-- Also used by source selection, so unrelated providers never scan @z: queries.
function M.owns(line, col)
	return token(line, col) ~= nil
end

local function text(value)
	if type(value) ~= "string" then
		return ""
	end
	return vim.trim((value:gsub("<[^>]*>", ""):gsub("[%c]", " "):gsub("%s+", " ")))
end

local function encode(value)
	return (value:gsub("[^%w%-_.~]", function(char)
		return ("%%%02X"):format(char:byte())
	end))
end

local function reference(kind, label, id)
	local target
	if kind == "tag" then
		-- URL clients normalize dot-only path segments; their query form is literal.
		target = API .. ((id == "." or id == "..") and "items/top?tag=" or "tags/") .. encode(id)
	else
		target = "zotero://select/library/" .. (kind == "paper" and "items/" or "collections/") .. id
	end
	local escaped = label:gsub("[\\%[%]]", "\\%0")
	return "[Zotero " .. kind .. ": " .. escaped .. "](" .. target .. ")"
end

local function entries_from(rows, kind)
	local entries, collections = {}, {}
	for _, row in ipairs(rows) do
		if type(row) ~= "table" then
			error("Invalid Zotero record")
		end
		if type(row.key) == "string" and type(row.data) == "table" then
			collections[row.key] = row.data
		end
	end
	for _, row in ipairs(rows) do
		local data = type(row.data) == "table" and row.data or {}
		local id = kind == "tag" and row.tag or row.key
		local valid = type(id) == "string" and (kind == "tag" or (#id == 8 and id:match("^[A-Z0-9]+$")))
		local excluded = kind == "paper" and vim.tbl_contains({ "attachment", "note", "annotation" }, data.itemType)
		local label = text(kind == "tag" and id or kind == "collection" and data.name or data.title)
		if valid and not excluded and label ~= "" then
			local description, search = kind, label
			if kind == "paper" then
				local authors, short_names, tags = {}, {}, {}
				for _, creator in ipairs(type(data.creators) == "table" and data.creators or {}) do
					local name = text(creator.name)
					table.insert(authors, name ~= "" and name or (text(creator.firstName) .. " " .. text(creator.lastName)))
					local short = text(creator.lastName)
					if short == "" then
						short = name ~= "" and name or text(creator.firstName)
					end
					if short ~= "" then
						table.insert(short_names, short)
					end
				end
				for _, tag in ipairs(type(data.tags) == "table" and data.tags or {}) do
					table.insert(tags, text(tag.tag))
				end
				local author = table.concat(authors, ", ")
				local year = text(data.date):match("%f[%d]%d%d%d%d%f[%D]") or ""
				local venue = ""
				for _, field in ipairs({ "journalAbbreviation", "publicationTitle", "conferenceName", "proceedingsTitle" }) do
					venue = text(data[field])
					if venue ~= "" then
						break
					end
				end
				local byline = (short_names[1] or "") .. (#short_names > 1 and " et al." or "")
				description = table.concat(vim.tbl_filter(function(value)
					return value ~= ""
				end, { year, venue, byline }), " · ")
				search = table.concat({ label, text(data.shortTitle), text(data.citationKey), author, year, table.concat(tags, " ") }, " ")
			elseif kind == "collection" then
				local seen, parent = { [id] = true }, text(data.parentCollection)
				while parent ~= "" and not seen[parent] and collections[parent] do
					seen[parent] = true
					local ancestor = collections[parent]
					label = text(ancestor.name) .. " / " .. label
					parent = text(ancestor.parentCollection)
				end
				search = label
			end
			table.insert(entries, { value = reference(kind, label, id), label = label, description = description, search = vim.fn.tolower(search) })
		end
	end
	table.sort(entries, function(a, b)
		return a.label < b.label
	end)
	return entries
end

-- Same matching rule as the raw Pi provider: all words, then subsequence fallback.
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

function source:load(kind, callback)
	local state = self.caches[kind]
	if not state then
		state = { loaded = 0, retry = 0, waiters = {} }
		self.caches[kind] = state
	end
	local now = vim.uv.hrtime() / 1000000
	if now < state.retry or (state.entries and now - state.loaded < 60000) then
		callback(state.entries or {})
		return
	end
	-- Serve stale metadata immediately while refreshing it in the background.
	if state.entries then
		callback(state.entries)
	else
		table.insert(state.waiters, callback)
	end
	if state.pending then
		return
	end
	state.pending = true
	vim.system({ "curl", "--silent", "--show-error", "--fail", "--noproxy", "*", "-H", "Zotero-API-Version: 3", API .. ENDPOINTS[kind] }, { text = true, timeout = 3000 }, function(result)
		vim.schedule(function()
			local ok, entries = pcall(function()
				if result.code ~= 0 then
					error("Zotero request failed")
				end
				local rows = vim.json.decode(result.stdout)
				if type(rows) ~= "table" or not vim.islist(rows) then
					error("Expected a Zotero result list")
				end
				return entries_from(rows, kind)
			end)
			if ok then
				state.entries, state.loaded = entries, vim.uv.hrtime() / 1000000
				self.error_shown = false
			else
				state.retry = vim.uv.hrtime() / 1000000 + 10000
				if not self.error_shown then
					self.error_shown = true
					vim.notify("Zotero unavailable" .. (state.entries and " (using cached suggestions)" or "") .. ". Open Zotero and enable Settings → Advanced → Allow other applications to communicate with Zotero.", vim.log.levels.WARN)
				end
			end
			state.pending = false
			local waiters = state.waiters
			state.waiters = {}
			for _, waiter in ipairs(waiters) do
				waiter(state.entries or {})
			end
		end)
	end)
end

function source:get_completions(ctx, callback)
	local cancelled = false
	local function complete(entries, ref)
		if cancelled then
			return
		end
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
	local ref = token(ctx.line, ctx.cursor[2])
	if vim.api.nvim_buf_get_name(ctx.bufnr) ~= "pi://input" or not ref then
		callback({ items = {}, is_incomplete_forward = false, is_incomplete_backward = false })
		return
	end
	local kind, query = ref.tail:match("^([^:]+):(.*)$")
	if not kind then
		local entries = {}
		for _, candidate in ipairs(KINDS) do
			if candidate:sub(1, #ref.tail) == ref.tail then
				table.insert(entries, { value = "@z:" .. candidate .. ":", label = "@z:" .. candidate .. ":", description = "Search Zotero " .. candidate .. "s" })
			end
		end
		complete(entries, ref)
	elseif ENDPOINTS[kind] then
		self:load(kind, function(entries)
			local matches = {}
			for index, entry in ipairs(entries) do
				local rank = score(entry.search, query)
				if rank then
					table.insert(matches, { entry = entry, score = rank, index = index })
				end
			end
			table.sort(matches, function(a, b)
				return a.score == b.score and a.index < b.index or a.score < b.score
			end)
			local filtered = {}
			for index = 1, math.min(20, #matches) do
				table.insert(filtered, matches[index].entry)
			end
			complete(filtered, ref)
		end)
	else
		complete({}, ref)
	end
	return function()
		cancelled = true
	end
end

M.new = source.new
return M
