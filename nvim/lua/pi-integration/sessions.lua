local json = require("pi-integration.utils.json")
local message_utils = require("pi-integration.utils.message")
local pi_messages = require("pi-integration.messages")
local pi_skills = require("pi-integration.skills")
local pi_state = require("pi-integration.state")
local pi_thinking_output = require("pi-integration.thinking-output")
local pi_tool_output = require("pi-integration.tool-output")
local pi_transcript = require("pi-integration.transcript")
local runtime = require("pi-integration.runtime")
local session_service = require("pi-integration.session-service")

local M = {}

local ARCHIVED_SUFFIX = ".archived"
local DEFAULT_ARCHIVE_AFTER_DAYS = 180
local ARCHIVE_REMINDER_DAYS = 30
local DAY_SECONDS = 24 * 60 * 60
local PICKER_CACHE_VERSION = 1
local reminder_checked = false
local picker_cache
local picker_cache_dirty = false

local function picker_cache_path()
	return vim.fn.stdpath("cache") .. "/pi-console/session-picker.json"
end

local function empty_picker_cache()
	return {
		version = PICKER_CACHE_VERSION,
		candidates = {},
	}
end

local function load_picker_cache()
	if picker_cache then
		return picker_cache
	end
	local ok, lines = pcall(vim.fn.readfile, picker_cache_path())
	local decoded = ok and json.decode_object(table.concat(lines, "\n")) or nil
	if
		type(decoded) ~= "table"
		or decoded.version ~= PICKER_CACHE_VERSION
		or type(decoded.candidates) ~= "table"
	then
		picker_cache = empty_picker_cache()
	else
		picker_cache = { version = PICKER_CACHE_VERSION, candidates = decoded.candidates }
	end
	return picker_cache
end

local function save_picker_cache()
	if not picker_cache_dirty or not picker_cache then
		return
	end
	local path = picker_cache_path()
	local directory = vim.fn.fnamemodify(path, ":h")
	local temporary_path = string.format("%s.%d.tmp", path, (vim.uv or vim.loop).os_getpid())
	local ok = pcall(function()
		if vim.fn.mkdir(directory, "p") == 0 and vim.fn.isdirectory(directory) == 0 then
			error("could not create cache directory")
		end
		if vim.fn.writefile({ json.encode(picker_cache) }, temporary_path) ~= 0 then
			error("could not write picker cache")
		end
		local renamed, err = (vim.uv or vim.loop).fs_rename(temporary_path, path)
		if not renamed then
			error(err or "could not replace picker cache")
		end
	end)
	if vim.fn.filereadable(temporary_path) == 1 then
		vim.fn.delete(temporary_path)
	end
	if ok then
		picker_cache_dirty = false
	end
end

local function file_fingerprint(path)
	local stat = (vim.uv or vim.loop).fs_stat(path)
	if not stat then
		return nil
	end
	return {
		size = stat.size,
		mtime_sec = stat.mtime.sec,
		mtime_nsec = stat.mtime.nsec or 0,
	}
end

local function same_fingerprint(left, right)
	return type(left) == "table"
		and type(right) == "table"
		and left.size == right.size
		and left.mtime_sec == right.mtime_sec
		and left.mtime_nsec == right.mtime_nsec
end

local function dirname(path)
	if not path or path == "" then
		return nil
	end
	return vim.fn.fnamemodify(path, ":h")
end

local function decode_record(line)
	return json.decode_object(line)
end

local function record_message_text(message)
	return message_utils.extract_text(message)
end

local function fallback_title(text)
	text = vim.trim((text or ""):gsub("%s+", " "))
	text = text:gsub("^[Hh]ey[,:%s]+", "")
	text = text:gsub("^[Hh]i[,:%s]+", "")
	text = text:gsub("^[Hh]ello[,:%s]+", "")
	text = text:gsub("[%.%?!:;,]+$", "")
	if #text > 64 then
		text = vim.trim(text:sub(1, 61)) .. "..."
	end
	return text ~= "" and text or nil
end

local function looks_like_bad_model_title(title)
	if type(title) ~= "string" or title == "" then
		return false
	end
	local lower = title:lower()
	return lower:find("<tool_call>", 1, true)
		or lower:find("```", 1, true)
		or lower:match("^sure[%s!,.]")
		or lower:match("^sorry[%s!,.]")
		or lower:match("^i'm sorry")
		or lower:match("^im sorry")
		or lower:match("^i don't")
		or lower:match("^i cannot")
		or lower:match("^i can't")
		or lower:match("^i'll")
		or lower:match("^i will")
		or lower:match("^let me")
end

local function read_candidate(path)
	local candidate = {
		path = path,
		mtime = vim.fn.getftime(path),
		title = nil,
		cwd = nil,
		fingerprint = file_fingerprint(path),
	}
	local first_user_title = nil

	for _, line in ipairs(vim.fn.readfile(path)) do
		local record = decode_record(line)
		if record and record.type == "session" and type(record.cwd) == "string" and record.cwd ~= "" then
			candidate.cwd = record.cwd
		elseif record and record.type == "session_info" and type(record.name) == "string" and vim.trim(record.name) ~= "" then
			candidate.title = vim.trim(record.name)
		elseif record and not first_user_title and record.type == "message" and type(record.message) == "table" and record.message.role == "user" then
			first_user_title = fallback_title(record_message_text(record.message))
		end
	end

	if looks_like_bad_model_title(candidate.title) and first_user_title then
		candidate.title = first_user_title
	end
	candidate.title = candidate.title or first_user_title
	return candidate
end

local function canonical_session_path(path)
	if type(path) ~= "string" or path == "" then
		return nil
	end
	return vim.fn.resolve(vim.fn.fnamemodify(vim.fn.expand(path), ":p"))
end

local function cached_candidate(path)
	local fingerprint = file_fingerprint(path)
	local key = canonical_session_path(path)
	local cache = load_picker_cache()
	local cached = key and cache.candidates[key]
	if fingerprint and cached and same_fingerprint(cached.fingerprint, fingerprint) then
		return {
			path = path,
			mtime = fingerprint.mtime_sec,
			title = cached.title,
			cwd = cached.cwd,
			fingerprint = fingerprint,
		}
	end

	local candidate = read_candidate(path)
	if key and fingerprint then
		cache.candidates[key] = {
			fingerprint = fingerprint,
			title = candidate.title,
			cwd = candidate.cwd,
		}
		picker_cache_dirty = true
	end
	return candidate
end

local function move_cached_candidate(source, target)
	local cache = load_picker_cache()
	local source_key = canonical_session_path(source)
	local target_key = canonical_session_path(target)
	local cached = source_key and cache.candidates[source_key]
	if source_key then
		cache.candidates[source_key] = nil
	end
	if target_key and cached then
		cached.fingerprint = file_fingerprint(target) or cached.fingerprint
		cache.candidates[target_key] = cached
	end
	picker_cache_dirty = true
end

local function remove_cached_candidate(path)
	local key = canonical_session_path(path)
	if key then
		load_picker_cache().candidates[key] = nil
		picker_cache_dirty = true
	end
end

local function regular_session_path(path)
	if type(path) == "string" and path:sub(-#ARCHIVED_SUFFIX) == ARCHIVED_SUFFIX then
		return path:sub(1, -#ARCHIVED_SUFFIX - 1)
	end
	return path
end

local function archived_session_path(path)
	return regular_session_path(path) .. ARCHIVED_SUFFIX
end

local function workspace_root()
	return vim.env.PI_WORKSPACE_ROOT
		or ((vim.env.XDG_STATE_HOME or (vim.fn.expand("~") .. "/.local/state")) .. "/pi/workspaces")
end

local function workspace_records()
	local records = {}
	local records_dir = vim.fn.fnamemodify(workspace_root(), ":p") .. "/records"
	for _, path in ipairs(vim.fn.globpath(records_dir, "*.json", false, true)) do
		local ok, lines = pcall(vim.fn.readfile, path)
		local record = ok and decode_record(table.concat(lines, "\n"))
		if record and record.version == 1 and (record.kind == "task" or record.kind == "child") then
			table.insert(records, record)
		end
	end
	return records
end

local function session_dirs(ctx)
	local dirs = {}
	local seen_dirs = {}
	local function add_dir(path)
		if not path or path == "" then
			return
		end
		path = vim.fn.expand(path)
		local resolved = vim.fn.resolve(path)
		if resolved == "" then
			resolved = path
		end
		if vim.fn.isdirectory(path) == 1 and not seen_dirs[resolved] then
			seen_dirs[resolved] = true
			table.insert(dirs, path)
		end
	end

	add_dir(ctx.config.session_dir)
	if ctx.config.agent_dir and ctx.config.agent_dir ~= "" then
		add_dir(vim.fn.expand(ctx.config.agent_dir) .. "/sessions")
	end
	add_dir(dirname(ctx.state.session_file))
	for _, dir in ipairs(ctx.config.session_dirs or {}) do
		add_dir(dir)
	end
	return dirs
end

local function session_paths(ctx, archived)
	local paths = {}
	local seen_files = {}
	local pattern = archived and ("**/*.jsonl" .. ARCHIVED_SUFFIX) or "**/*.jsonl"
	for _, dir in ipairs(session_dirs(ctx)) do
		for _, path in ipairs(vim.fn.globpath(dir, pattern, false, true)) do
			local resolved = vim.fn.resolve(path)
			if resolved == "" then
				resolved = path
			end
			if not seen_files[resolved] then
				seen_files[resolved] = true
				table.insert(paths, path)
			end
		end
	end
	return paths
end

local function all_conversations(ctx)
	local all = {}
	for _, archived in ipairs({ false, true }) do
		for _, path in ipairs(session_paths(ctx, archived)) do
			table.insert(all, cached_candidate(path))
		end
	end
	local groups = {}
	for _, candidate in ipairs(all) do
		table.insert(groups, { head = candidate, members = { candidate } })
	end
	table.sort(groups, function(a, b)
		return a.head.mtime > b.head.mtime
	end)
	save_picker_cache()
	return groups
end

local function conversations(ctx, opts)
	opts = opts or {}
	local allowed_paths = nil
	if opts.paths then
		allowed_paths = {}
		for _, path in ipairs(opts.paths) do
			allowed_paths[canonical_session_path(path)] = true
		end
	end
	return vim.tbl_filter(function(group)
		local head = group.head
		return (opts.archived == (head.path:sub(-#ARCHIVED_SUFFIX) == ARCHIVED_SUFFIX))
			and (not allowed_paths or allowed_paths[canonical_session_path(head.path)])
	end, all_conversations(ctx))
end

local function refresh_selection(ctx, selected)
	local by_path = {}
	for _, group in ipairs(all_conversations(ctx)) do
		for _, member in ipairs(group.members) do
			by_path[canonical_session_path(member.path)] = group
		end
	end
	local refreshed, seen, changed = {}, {}, 0
	for _, group in ipairs(selected) do
		local current = by_path[canonical_session_path(group.head.path)]
		local original_files = {}
		for _, member in ipairs(group.members) do
			original_files[canonical_session_path(member.path)] = member.fingerprint
		end
		local same_files = current and #current.members == #group.members
		if same_files then
			for _, member in ipairs(current.members) do
				local path = canonical_session_path(member.path)
				if not same_fingerprint(original_files[path], member.fingerprint) then
					same_files = false
					break
				end
			end
		end
		if not same_files then
			changed = changed + 1
		elseif not seen[current] then
			seen[current] = true
			table.insert(refreshed, current)
		end
	end
	return refreshed, changed
end

local function item_title(candidate)
	return candidate.title or vim.fn.fnamemodify(regular_session_path(candidate.path), ":t")
end

local function item_label(candidate)
	local time = os.date("%Y-%m-%d %H:%M", candidate.mtime)
	if candidate.cwd and candidate.cwd ~= "" then
		return string.format("%s  pwd: %s  %s", item_title(candidate), vim.fn.fnamemodify(candidate.cwd, ":~"), time)
	end
	return string.format("%s  %s", item_title(candidate), time)
end

local function path_inside(root, path)
	root = canonical_session_path(root)
	path = canonical_session_path(path)
	return root and path and (root == path or path:sub(1, #root + 1) == root .. "/")
end

local function linked_workspaces(selected)
	local paths = {}
	for _, group in ipairs(selected) do
		for _, member in ipairs(group.members) do
			paths[canonical_session_path(regular_session_path(member.path))] = true
		end
	end
	return vim.tbl_filter(function(record)
		local source = canonical_session_path(record.sourceSessionFile)
		local target = canonical_session_path(record.targetSessionFile)
		return (record.retained == true or record.lifecycle == "cleanup_failed")
			and ((source and paths[source]) or (target and paths[target]))
	end, workspace_records())
end

local function protected_session_paths(ctx, deleting)
	local protected = {}
	local function add(path)
		path = canonical_session_path(regular_session_path(path))
		if path then
			protected[path] = true
		end
	end

	add(ctx.state.session_file)
	add(ctx.state.pending_session_file)
	local instances, err = runtime.list()
	if not instances then
		ctx.ui.notify("Could not check open sessions; leaving session files unchanged: " .. tostring(err), vim.log.levels.WARN)
		return nil
	end
	for _, instance in ipairs(instances) do
		add(instance.path)
	end
	for _, record in ipairs(workspace_records()) do
		if record.retained == true then
			local in_use = not deleting or path_inside(record.worktreePath, vim.fn.getcwd())
			for _, instance in ipairs(instances) do
				in_use = in_use or instance.workspace_id == record.id or path_inside(record.worktreePath, instance.cwd)
			end
			if in_use then
				add(record.sourceSessionFile)
				if deleting or record.kind == "child" then
					add(record.targetSessionFile)
				end
			end
		end
	end
	return protected
end

local function partition_protected(ctx, selected, deleting)
	local protected_paths = protected_session_paths(ctx, deleting)
	if not protected_paths then
		return {}, selected
	end
	local allowed = {}
	local skipped = {}
	for _, group in ipairs(selected) do
		local is_protected = false
		for _, candidate in ipairs(group.members) do
			local path = canonical_session_path(regular_session_path(candidate.path))
			if path and protected_paths[path] then
				is_protected = true
				break
			end
		end
		table.insert(is_protected and skipped or allowed, group)
	end
	return allowed, skipped
end

local function session_files(groups)
	local files = {}
	for _, group in ipairs(groups) do
		vim.list_extend(files, group.members)
	end
	return files
end

local function selected_title(selected)
	if #selected == 1 then
		return " " .. item_title(selected[1].head)
	end
	return ""
end

local function confirm(prompt, callback)
	local choice
	local choice_received = false
	local picker_closed = false
	local dispatched = false
	local function dispatch()
		if dispatched or not choice_received or not picker_closed then
			return
		end
		dispatched = true
		vim.schedule(function()
			callback(choice == "Yes")
		end)
	end

	vim.ui.select({ "Yes", "No" }, {
		prompt = prompt,
		pi_select_layout = "compact",
		on_close = function()
			picker_closed = true
			dispatch()
		end,
	}, function(selected)
		choice = selected
		choice_received = true
		dispatch()
	end)
end

local function rename_sessions(group, archive)
	local changes = {}
	for _, candidate in ipairs(group.members) do
		local target = archive and archived_session_path(candidate.path) or regular_session_path(candidate.path)
		if candidate.path ~= target then
			if vim.fn.filereadable(target) == 1 then
				return false, { string.format("%s: destination already exists", item_title(candidate)) }
			end
			table.insert(changes, { candidate = candidate, source = candidate.path, target = target })
		end
	end

	local moved = {}
	for _, change in ipairs(changes) do
		local ok, err = (vim.uv or vim.loop).fs_rename(change.source, change.target)
		if not ok then
			local failures = { string.format("%s: %s", item_title(change.candidate), err or "rename failed") }
			for index = #moved, 1, -1 do
				local previous = moved[index]
				local restored, restore_err = (vim.uv or vim.loop).fs_rename(previous.target, previous.source)
				if restored then
					move_cached_candidate(previous.target, previous.source)
					previous.candidate.path = previous.source
				else
					table.insert(failures, string.format("%s: could not undo rename: %s", item_title(previous.candidate), restore_err))
				end
			end
			save_picker_cache()
			return false, failures
		end
		move_cached_candidate(change.source, change.target)
		change.candidate.path = change.target
		table.insert(moved, change)
	end
	save_picker_cache()
	return true, {}
end

local function trash_command()
	if vim.fn.executable("trash") == 1 then
		return { "trash" }
	end
	if vim.fn.executable("gio") == 1 then
		return { "gio", "trash" }
	end
	return nil
end

local function delete_sessions(selected, command, callback)
	if command then
		local args = vim.deepcopy(command)
		for _, candidate in ipairs(selected) do
			table.insert(args, candidate.path)
		end
		vim.system(args, { text = true }, function(result)
			vim.schedule(function()
				local succeeded, failed = 0, {}
				local detail = vim.trim(result.stderr or "")
				for _, candidate in ipairs(selected) do
					if vim.fn.filereadable(candidate.path) == 1 then
						table.insert(
							failed,
							string.format("%s: %s", item_title(candidate), detail ~= "" and detail or "trash command left file in place")
						)
					else
						remove_cached_candidate(candidate.path)
						succeeded = succeeded + 1
					end
				end
				save_picker_cache()
				callback(succeeded, failed)
			end)
		end)
		return
	end

	local succeeded, failed = 0, {}
	for _, candidate in ipairs(selected) do
		if vim.fn.delete(candidate.path) ~= 0 then
			table.insert(failed, item_title(candidate) .. ": delete failed")
		else
			remove_cached_candidate(candidate.path)
			succeeded = succeeded + 1
		end
	end
	save_picker_cache()
	callback(succeeded, failed)
end

local function notify_failures(ctx, failures)
	if #failures == 0 then
		return
	end
	local message = table.concat(vim.list_slice(failures, 1, 3), "\n")
	if #failures > 3 then
		message = message .. string.format("\n...and %d more", #failures - 3)
	end
	ctx.ui.notify(message, vim.log.levels.ERROR)
end

local function attach_session(ctx, choice)
	if ctx.session.open_candidate then
		ctx.session.open_candidate(choice)
		return
	end
	local existing, err = runtime.find_session(choice.path)
	if err then
		ctx.ui.notify("Could not check open sessions: " .. err, vim.log.levels.WARN)
		return
	end
	if existing then
		local focused, focus_err = runtime.focus(existing.id)
		if not focused then
			ctx.ui.notify(focus_err, vim.log.levels.WARN)
		end
		return
	end
	ctx.session.switch_session(choice.path)
end

local function decode_selection(items, by_id)
	local selected = {}
	local seen = {}
	for _, item in ipairs(items or {}) do
		local id = item:match("^(%d+)\t")
		local candidate = id and by_id[id]
		if candidate and not seen[id] then
			seen[id] = true
			table.insert(selected, candidate)
		end
	end
	return selected
end

local function session_preview_context(ctx, candidate)
	local state = pi_state.new()
	state.session_file = candidate.path
	state.session_name = candidate.title
	state.last_updated = os.date("%Y-%m-%d %H:%M:%S %z", candidate.mtime)
	state.access_mode = ctx.state.access_mode
	state.integration_mode = ctx.state.integration_mode
	state.workspace = vim.deepcopy(ctx.state.workspace or state.workspace)

	local preview_ctx
	preview_ctx = {
		state = state,
		config = ctx.config,
		notices = ctx.notices,
		messages = {
			extract_text = message_utils.extract_text,
		},
		transcript = {
			metadata_lines = function()
				return pi_transcript.metadata_lines(preview_ctx)
			end,
		},
		tools = {
			record_calls = function(message)
				return pi_tool_output.record_calls(state, message)
			end,
			record_execution_call = function(tool_name, tool_call_id, args)
				return pi_tool_output.record_execution_call(state, tool_name, tool_call_id, args)
			end,
			store_output = function(tool_name, text, filetype, details, message)
				local tool_call_id = message_utils.tool_call_id(message)
				local display = pi_tool_output.display_for_result(state, message)
				return pi_tool_output.store(state, tool_name, text, filetype, details, display, tool_call_id)
			end,
			store_or_update_spawn_run_output = function(run, text)
				return pi_tool_output.store_or_update_spawn_run(state, run, text)
			end,
			bind_spawn_run = function(run, output_id, line)
				return pi_tool_output.bind_spawn_run(state, run, output_id, line)
			end,
			summary_lines = function(output_id)
				return pi_tool_output.summary_lines(state, output_id)
			end,
		},
		thinking = {
			store_output = function(text)
				return pi_thinking_output.store(state, text)
			end,
			summary_lines = function(output_id, streaming)
				return pi_thinking_output.summary_lines(state, output_id, streaming)
			end,
		},
		skills = {
			store_prompt = function(load)
				return pi_skills.store_load(state, load)
			end,
			summary_lines = function(output_id)
				return pi_skills.summary_lines(state, output_id)
			end,
			apply_tool_result = function(message)
				return pi_skills.apply_tool_result(state, message, message_utils.extract_text(message))
			end,
		},
		session = {
			set_model_metadata = function(provider, model)
				local model_id = model
				if type(model) == "table" then
					provider = provider or model.provider or model.providerName or model.providerId
					model_id = model.modelId or model.id or model.name
				end
				if not provider and type(model_id) == "string" and model_id:find("/", 1, true) then
					provider, model_id = model_id:match("^([^/]+)/(.+)$")
				end
				state.provider = provider or state.provider
				state.model_id = model_id or state.model_id
			end,
		},
	}
	return preview_ctx
end

local function session_previewer(ctx, by_id)
	local preview_entries = {}
	return {
		_ctor = function()
			local previewer = require("fzf-lua.previewer.builtin").buffer_or_file:extend()
			local update_render_markdown = previewer.update_render_markdown
			function previewer:parse_entry(entry)
				local id = entry and entry:match("^(%d+)\t")
				local candidate = id and by_id[id]
				if not candidate then
					return {}
				end
				if preview_entries[candidate.path] then
					return preview_entries[candidate.path]
				end
				local preview_ctx = session_preview_context(ctx, candidate)
				local messages = pi_messages.load_session_messages_from_file(preview_ctx, candidate.path)
				local lines = pi_messages.collect_message_lines(preview_ctx, messages)
				local preview_entry = {
					cache_key = candidate.path,
					content = lines,
					filetype = "markdown",
				}
				preview_entries[candidate.path] = preview_entry
				return preview_entry
			end
			function previewer:update_render_markdown()
				update_render_markdown(self)
				pi_transcript.apply_quote_highlights_to_buffer(self.preview_bufnr)
			end
			return previewer
		end,
	}
end

local function reopen(ctx, opts)
	vim.schedule(function()
		M.pick(ctx, opts)
	end)
end

function M.pick(ctx, opts)
	opts = opts or {}
	local view = opts.view == "archived" and "archived" or "regular"
	local archived = view == "archived"
	local session_groups = conversations(ctx, { archived = archived, paths = opts.paths })
	if #session_groups == 0 then
		if not opts.paths and #conversations(ctx, { archived = not archived }) > 0 then
			ctx.ui.notify(archived and "No archived Pi sessions found; showing regular sessions."
				or "No regular Pi sessions found; showing archived sessions.")
			M.pick(ctx, { view = archived and "regular" or "archived" })
			return
		end
		ctx.ui.notify(archived and "No archived Pi sessions found." or "No Pi session files found.", vim.log.levels.WARN)
		return
	end

	local entries, by_id, group_by_path = {}, {}, {}
	for index, group in ipairs(session_groups) do
		local candidate = group.head
		local id = string.format("%06d", index)
		by_id[id] = candidate
		group_by_path[candidate.path] = group
		table.insert(entries, id .. "\t" .. item_label(candidate))
	end

	local reopen_opts = vim.deepcopy(opts)
	reopen_opts.view = view
	local function selected_groups(items)
		local selected = {}
		for _, candidate in ipairs(decode_selection(items, by_id)) do
			table.insert(selected, group_by_path[candidate.path])
		end
		return selected
	end
	local function reopen_current()
		reopen(ctx, reopen_opts)
	end
	local function eligible(selected, refresh, deleting)
		if refresh then
			local changed
			selected, changed = refresh_selection(ctx, selected)
			if changed > 0 then
				ctx.ui.notify(string.format("Skipped %d conversation(s) whose files changed while confirming.", changed), vim.log.levels.WARN)
			end
		end
		local allowed, skipped = partition_protected(ctx, selected, deleting)
		if #skipped > 0 then
			ctx.ui.notify(string.format(deleting and "Skipped %d open conversation(s) or conversation(s) with workspaces in use. Close them before deleting."
				or "Skipped %d active or workspace-linked conversation(s).", #skipped), vim.log.levels.WARN)
		end
		return allowed
	end
	local function archive_or_restore(items)
		local allowed = eligible(selected_groups(items))
		if #allowed == 0 then
			reopen_current()
			return
		end
		local verb = archived and "Unarchive" or "Archive"
		local noun = #allowed == 1 and "conversation" or "conversations"
		local prompt = string.format("%s %d %s (%d files)?%s", verb, #allowed, noun, #session_files(allowed), selected_title(allowed))
		confirm(prompt, function(confirmed)
			if not confirmed then
				reopen_current()
				return
			end
			allowed = eligible(allowed, true)
			local succeeded, failures = 0, {}
			for _, group in ipairs(allowed) do
				local ok, errors = rename_sessions(group, not archived)
				if ok then
					succeeded = succeeded + 1
				else
					vim.list_extend(failures, errors)
				end
			end
			if succeeded > 0 then
				ctx.ui.notify(string.format("%s %d conversation(s).", archived and "Unarchived" or "Archived", succeeded))
			end
			notify_failures(ctx, failures)
			reopen_current()
		end)
	end
	local function delete_selected(items)
		local allowed = eligible(selected_groups(items), false, true)
		if #allowed == 0 then
			return -- leave the blocker visible instead of covering it with the picker
		end
		local paths = {}
		for _, candidate in ipairs(session_files(allowed)) do
			table.insert(paths, candidate.path)
		end
		local command = trash_command()
		local action = command and "Move" or "Permanently delete"
		local destination = command and " to trash" or ""
		local noun = #allowed == 1 and "conversation" or "conversations"
		local prompt = string.format("%s %d %s (%d files)%s?%s", action, #allowed, noun, #session_files(allowed), destination, selected_title(allowed))
		local function delete_files()
			allowed = eligible(allowed, true, true)
			if #allowed == 0 then
				return
			end
			if #linked_workspaces(allowed) > 0 then
				ctx.ui.notify("Linked workspaces changed; session files were kept. Select the sessions again.", vim.log.levels.WARN)
				return
			end
			delete_sessions(session_files(allowed), command, function(deleted, failures)
				if deleted > 0 then
					local fully_deleted = 0
					for _, group in ipairs(allowed) do
						local remaining = false
						for _, member in ipairs(group.members) do
							if vim.fn.filereadable(member.path) == 1 then
								remaining = true
								break
							end
						end
						if not remaining then
							fully_deleted = fully_deleted + 1
						end
					end
					ctx.ui.notify(string.format("%s %d conversation(s) (%d files).", command and "Trashed" or "Deleted", fully_deleted, deleted))
				end
				notify_failures(ctx, failures)
				if #failures == 0 then
					reopen_current()
				end
			end)
		end
		local workspaces = linked_workspaces(allowed)
		local expected_ids = {}
		if #workspaces > 0 then
			local warning = {
				"The following workspaces will also be cleaned up. Remaining worktrees will be removed and unintegrated changes discarded; existing destination changes will not be reverted:",
			}
			for _, record in ipairs(workspaces) do
				table.insert(expected_ids, record.id)
				if record.retained then
					table.insert(warning, string.format("- %s: %s", record.label, record.worktreePath))
				else
					table.insert(warning, string.format("- %s: retrying incomplete Git cleanup (worktree already removed)", record.label))
				end
				table.insert(warning, "  recovery patch: " .. record.resultPatchPath)
			end
			table.insert(warning, "Recovery patches for remaining worktrees will be prepared after confirmation; cleanup retries reuse existing patches. Ignored untracked files, including copied ignored files, are not included in patches and will be removed with the worktrees.")
			prompt = prompt .. "\n\n" .. table.concat(warning, "\n")
		end
		table.sort(expected_ids)
		confirm(prompt, function(confirmed)
			if not confirmed then
				reopen_current()
				return
			end
			local refreshed = eligible(allowed, true, true)
			if #refreshed ~= #allowed then
				return -- do not clean up workspaces for a changed or newly opened session
			end
			allowed = refreshed
			local current_ids = {}
			for _, record in ipairs(linked_workspaces(allowed)) do
				table.insert(current_ids, record.id)
			end
			table.sort(current_ids)
			if not vim.deep_equal(current_ids, expected_ids) then
				ctx.ui.notify("Linked workspaces changed while confirming. Select the sessions again.", vim.log.levels.WARN)
				return
			end
			if #current_ids == 0 then
				delete_files()
				return
			end
			ctx.ui.notify(string.format("Preparing recovery patches for remaining worktrees and finishing cleanup for %d workspace(s)...", #current_ids))
			session_service.request(ctx.config.binary, workspace_root(), { action = "remove", paths = paths, workspaceIds = current_ids }, function(removed)
				if not removed.success then
					ctx.ui.notify(removed.error, vim.log.levels.ERROR)
					return
				end
				delete_files()
			end, function()
				local final = eligible(allowed, true, true)
				if #final ~= #allowed then
					return false
				end
				local ids = {}
				for _, record in ipairs(linked_workspaces(final)) do
					table.insert(ids, record.id)
				end
				table.sort(ids)
				return vim.deep_equal(ids, current_ids)
			end)
		end)
	end
	local function select_session(items)
		local group = selected_groups(items)[1]
		if not group then
			return
		end
		if not archived then
			attach_session(ctx, group.head)
			return
		end
		local selected = eligible({ group }, true)
		if #selected == 0 then
			reopen_current()
			return
		end
		group = selected[1]
		local ok, failures = rename_sessions(group, false)
		if ok then
			attach_session(ctx, group.head)
		else
			notify_failures(ctx, failures)
			reopen_current()
		end
	end

	local keymap = { fzf = { ["ctrl-a"] = "toggle-all" } }
	if opts.select_all then
		keymap.fzf.start = "select-all"
	end
	require("fzf-lua").fzf_exec(entries, {
		prompt = opts.paths ~= nil and "Archive sessions > " or (archived and "Archived > " or "Sessions > "),
		previewer = session_previewer(ctx, by_id),
		fzf_opts = {
			["--multi"] = true,
			["--delimiter"] = "[\t]",
			["--with-nth"] = "2..",
		},
		keymap = keymap,
		actions = {
			enter = { fn = select_session, header = archived and "unarchive and resume" or "resume" },
			["ctrl-r"] = { fn = archive_or_restore, header = archived and "unarchive" or "archive" },
			["ctrl-x"] = { fn = delete_selected, header = "trash" },
			["ctrl-g"] = {
				fn = function()
					reopen(ctx, { view = archived and "regular" or "archived" })
				end,
				header = archived and "show regular" or "show archived",
			},
		},
	})
end

local function reminder_state_path()
	return vim.fn.stdpath("state") .. "/pi-console/session-archive-reminder.json"
end

local function read_reminder_state()
	local ok, lines = pcall(vim.fn.readfile, reminder_state_path())
	if not ok then
		return nil
	end
	return decode_record(table.concat(lines, "\n"))
end

local function write_reminder_state(timestamp)
	local path = reminder_state_path()
	local state_dir = vim.fn.fnamemodify(path, ":h")
	local ok, err = pcall(function()
		if vim.fn.mkdir(state_dir, "p") == 0 and vim.fn.isdirectory(state_dir) == 0 then
			error("could not create state directory")
		end
		if vim.fn.writefile({ json.encode({ version = 1, prompted_at = timestamp }) }, path) ~= 0 then
			error("could not write reminder state")
		end
	end)
	return ok, err
end

local function archive_after_days(ctx)
	local configured = ctx.config.archive_after_days
	if type(configured) == "number" and configured > 0 and configured == math.floor(configured) then
		return configured
	end
	return DEFAULT_ARCHIVE_AFTER_DAYS
end

local function stale_session_paths(ctx, timestamp)
	local stale_before = timestamp - (archive_after_days(ctx) * DAY_SECONDS)
	local stale = {}
	local allowed = partition_protected(ctx, conversations(ctx, { archived = false }))
	for _, group in ipairs(allowed) do
		if group.head.mtime >= 0 and group.head.mtime < stale_before then
			table.insert(stale, group.head.path)
		end
	end
	return stale
end

function M.maybe_prompt_archive(ctx)
	if reminder_checked then
		return
	end
	reminder_checked = true

	local now = os.time()
	local state = read_reminder_state()
	if state and type(state.prompted_at) == "number" and now - state.prompted_at < ARCHIVE_REMINDER_DAYS * DAY_SECONDS then
		return
	end
	local stale = stale_session_paths(ctx, now)
	if #stale == 0 then
		return
	end
	local ok, err = write_reminder_state(now)
	if not ok then
		ctx.ui.notify("Could not save the Pi session archive reminder: " .. tostring(err), vim.log.levels.WARN)
		return
	end
	confirm(string.format("Review %d Pi session(s) inactive for over %d days for archiving?", #stale, archive_after_days(ctx)), function(confirmed)
		if not confirmed then
			return
		end
		M.pick(ctx, {
			view = "regular",
			paths = stale,
			select_all = true,
		})
	end)
end

return M
