local M = {}

local API = "https://api.zotero.org/users/"
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

local function reference(kind, label, id, user_id)
	local base = API .. user_id .. "/"
	local target
	if kind == "tag" then
		-- URL clients normalize dot-only path segments; their query form is literal.
		target = base .. ((id == "." or id == "..") and "items/top?tag=" or "tags/") .. encode(id)
	else
		target = base .. (kind == "paper" and "items/" or "collections/") .. id
	end
	local escaped = label:gsub("[\\%[%]]", "\\%0")
	return "[Zotero " .. kind .. ": " .. escaped .. "](" .. target .. ")"
end

local function entries_from(rows, kind, user_id)
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
			table.insert(entries, { value = reference(kind, label, id, user_id), label = label, description = description, search = vim.fn.tolower(search) })
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

local function credentials()
	-- Share /zotero-login's native CLI store on the frontend machine. Remote
	-- service credentials are not copied to the editor or sent over its RPC link.
	local path = vim.uv.os_homedir() .. "/.config/zotero-mcp/config.json"
	local info = vim.uv.fs_lstat(path)
	local config = {}
	if info then
		if info.type ~= "file" or (vim.uv.getuid and info.uid ~= vim.uv.getuid())
			or (vim.fn.has("win32") == 0 and bit.band(info.mode, 63) ~= 0) then
			error("Zotero credentials must be an owner-only (0600) regular file. Run /zotero-login in Pi on this frontend machine.", 0)
		end
		local read_ok, lines = pcall(vim.fn.readfile, path)
		local ok, parsed = false, nil
		if read_ok then ok, parsed = pcall(vim.json.decode, table.concat(lines, "\n")) end
		if not ok or type(parsed) ~= "table" or vim.islist(parsed) then
			error("Cannot read Zotero configuration. Run /zotero-login in Pi on this frontend machine.", 0)
		end
		config = parsed
	end
	local env = config.client_env or {}
	if type(env) ~= "table" then error("Invalid Zotero client_env configuration.", 0) end
	for name, value in pairs(env) do
		if type(name) ~= "string" or type(value) ~= "string" then error("Invalid Zotero client_env configuration.", 0) end
	end
	local function get(name)
		return vim.env[name] or env[name] or ""
	end
	local key, user_id = get("ZOTERO_API_KEY"), get("ZOTERO_LIBRARY_ID")
	if get("ZOTERO_LOCAL"):lower() ~= "false" or get("ZOTERO_LIBRARY_TYPE") ~= "user"
		or not key:match("^[A-Za-z0-9]+$") or not user_id:match("^[1-9][0-9]*$") then
		error("Zotero web credentials are unavailable or overridden. Run /zotero-login in Pi on this frontend machine and remove conflicting ZOTERO_* environment overrides.", 0)
	end
	return { key = key, user_id = user_id }
end

local function response_parts(output)
	local headers, status = {}, nil
	-- curl may include a proxy CONNECT or interim response before the API headers.
	while output:match("^HTTP/") do
		local first, last = output:find("\r?\n\r?\n")
		if not first then error("Invalid Zotero response.", 0) end
		local block = output:sub(1, first - 1)
		status = tonumber(block:match("^HTTP/%S+ (%d%d%d)"))
		headers = {}
		for name, value in block:gmatch("\n([^:\r\n]+):%s*([^\r\n]*)") do
			headers[name:lower()] = vim.trim(value)
		end
		output = output:sub(last + 1)
	end
	return status, headers, output
end

local function now()
	return vim.uv.hrtime() / 1000000
end

local function cache_path(user_id, kind)
	return vim.fs.joinpath(vim.fn.stdpath("cache"), "pi-console", "zotero", user_id, kind .. ".json")
end

local function read_cache(user_id, kind)
	local ok, cached = pcall(function()
		local value = vim.json.decode(table.concat(vim.fn.readfile(cache_path(user_id, kind)), "\n"))
		if type(value) ~= "table" or value.schema ~= 1 or value.user_id ~= user_id or value.kind ~= kind
			or type(value.entries) ~= "table" or not vim.islist(value.entries)
			or (value.version ~= nil and (type(value.version) ~= "string" or not value.version:match("^%d+$"))) then
			return nil
		end
		for _, entry in ipairs(value.entries) do
			if type(entry) ~= "table" or type(entry.value) ~= "string" or type(entry.label) ~= "string"
				or type(entry.description) ~= "string" or type(entry.search) ~= "string" then
				return nil
			end
		end
		return value
	end)
	if ok and cached then return cached.entries, cached.version end
end

local function write_cache(user_id, kind, entries, version)
	local path = cache_path(user_id, kind)
	vim.fn.mkdir(vim.fs.dirname(path), "p", 448)
	-- Persist only completion metadata and its version, never the API key.
	local encoded = vim.json.encode({ schema = 1, user_id = user_id, kind = kind, entries = entries, version = version })
	local file, temporary = vim.uv.fs_mkstemp(path .. ".XXXXXX")
	assert(file, temporary)
	local ok, err = pcall(function()
		assert(vim.uv.fs_write(file, encoded, 0) == #encoded, "Incomplete Zotero cache write")
		assert(vim.uv.fs_fsync(file))
	end)
	vim.uv.fs_close(file)
	if ok then ok, err = vim.uv.fs_rename(temporary, path) end
	if not ok then
		vim.uv.fs_unlink(temporary)
		error(err, 0)
	end
end

local source = {}

function source.new()
	return setmetatable({ caches = {}, error_shown = false, backoff_until = 0 }, { __index = source })
end

function source:reset()
	local previous = self.caches
	self.caches, self.account, self.error_shown = {}, nil, false
	for _, state in pairs(previous) do
		if state.process then state.process:kill(15) end
		if state.timer then state.timer:stop(); state.timer:close() end
		for _, waiter in ipairs(state.waiters) do waiter({}) end
	end
end

function source:warn(message, cached)
	if not self.error_shown then
		self.error_shown = true
		require("pi-integration.logs").notify(message .. (cached and " (using cached suggestions)" or ""), vim.log.levels.WARN)
	end
end

function source:enabled()
	return vim.api.nvim_buf_get_name(0) == "pi://input"
end

function source:get_trigger_characters()
	return { "@", ":" }
end

function source:load(kind, callback)
	local ok, auth = pcall(credentials)
	if not ok then
		if self.account then self:reset() end
		self:warn(auth)
		callback({})
		return
	end
	if self.account and (self.account.key ~= auth.key or self.account.user_id ~= auth.user_id) then self:reset() end
	self.account = auth
	local state = self.caches[kind]
	if not state then
		-- Restored suggestions are immediately usable, but always revalidate them.
		state = { loaded = -math.huge, retry = 0, waiters = {} }
		state.entries, state.version = read_cache(auth.user_id, kind)
		self.caches[kind] = state
	end
	if now() < state.retry or (state.entries and now() - state.loaded < 60000) then
		callback(state.entries or {})
		return
	end
	-- Serve stale metadata immediately while a shared refresh finishes.
	if state.entries then callback(state.entries) else table.insert(state.waiters, callback) end
	if state.pending then return end
	state.pending = true
	local rows, version = {}, nil
	local function current() return self.caches[kind] == state end
	local function finish(message)
		if not current() then return end
		state.pending, state.process = false, nil
		if message then
			state.retry = now() + 10000
			self:warn(message, state.entries ~= nil)
		else
			state.loaded, self.error_shown = now(), false
		end
		local waiters = state.waiters
		state.waiters = {}
		for _, waiter in ipairs(waiters) do waiter(state.entries or {}) end
	end
	local page
	page = function(start)
		if not current() then return end
		if now() < self.backoff_until then
			state.timer = vim.defer_fn(function() state.timer = nil; page(start) end, math.min(self.backoff_until - now(), 60000))
			return
		end
		local config = 'header = "Zotero-API-Version: 3"\nheader = "Zotero-API-Key: ' .. auth.key .. '"\n'
		if start == 0 and state.version then config = config .. 'header = "If-Modified-Since-Version: ' .. state.version .. '"\n' end
		-- The key goes through stdin, never argv, a URL, a temporary file or logs.
		-- Disable curlrc so it cannot enable verbose logging or redirect following.
		local args = { "curl", "--disable", "--silent", "--show-error", "--include", "--proto", "=https", "--config", "-",
			API .. auth.user_id .. "/" .. ENDPOINTS[kind] .. "?limit=100&start=" .. start }
		local started, process = pcall(vim.system, args, { text = true, stdin = config, timeout = 15000 }, function(result)
			vim.schedule(function()
				if not current() then return end
				state.process = nil
				if result.code ~= 0 then finish("Zotero web request failed. Check your network connection."); return end
				local parsed, status, headers, body = pcall(response_parts, result.stdout)
				if not parsed then finish("Invalid Zotero response."); return end
				for _, name in ipairs({ "backoff", "retry-after" }) do
					local seconds = tonumber(headers[name])
					if seconds and seconds >= 0 and seconds < math.huge then
						self.backoff_until = math.max(self.backoff_until, now() + seconds * 1000)
					end
				end
				if status == 304 and start == 0 and state.entries then finish(); return end
				if status ~= 200 then
					finish(status == 403 and "Zotero rejected the API key or its permissions. Run /zotero-login in Pi on this frontend machine."
						or "Zotero web API returned HTTP " .. tostring(status) .. ". Try again later.")
					return
				end
				local page_version = headers["last-modified-version"]
				if page_version and not page_version:match("^%d+$") then finish("Invalid Zotero library version."); return end
				if start == 0 then version = page_version
				elseif page_version ~= version then finish("Zotero changed while loading suggestions; retry to refresh the complete list."); return end
				local decoded, entries = pcall(vim.json.decode, body)
				if not decoded or type(entries) ~= "table" or not vim.islist(entries) then finish("Invalid Zotero metadata."); return end
				vim.list_extend(rows, entries)
				local total = tonumber(headers["total-results"])
				if #entries == 100 and (not total or #rows < total) then page(start + 100); return end
				local built, suggestions = pcall(entries_from, rows, kind, auth.user_id)
				if not built then finish("Invalid Zotero metadata."); return end
				state.entries, state.version = suggestions, version
				local saved = pcall(write_cache, auth.user_id, kind, suggestions, version)
				finish()
				if not saved then self:warn("Cannot save Zotero completion cache; suggestions will only be kept for this Neovim session.") end
			end)
		end)
		if started then state.process = process else finish("Cannot start curl for Zotero web completion.") end
	end
	page(0)
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
