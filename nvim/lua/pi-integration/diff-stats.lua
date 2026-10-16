local M = {}

local refresh_ms = 2000
local timer
local active
local current_key
local next_refresh = 0

local function workspace_key(workspace)
	if not workspace or workspace.kind ~= "task"
		or type(workspace.id) ~= "string" or type(workspace.path) ~= "string"
		or type(workspace.baselineTree) ~= "string" then
		return nil
	end
	return workspace.id .. "\0" .. workspace.path .. "\0" .. workspace.baselineTree
end

local function cleanup(job)
	if job.tempfile then
		os.remove(job.tempfile)
		job.tempfile = nil
	end
end

local function cancel()
	if active then
		local job = active
		active = nil
		if job.process then
			job.process:kill(15)
		end
		cleanup(job)
	end
end

local function parse_numstat(output, files, rename_sources)
	local entries = vim.split(output, "\0", { plain = true })
	local index = 1
	while index < #entries do
		local added, removed, path = entries[index]:match("^([^\t]+)\t([^\t]+)\t(.*)$")
		if not path then
			return false
		end
		if path == "" then
			-- Renames and --no-index comparisons have separate old/new path fields.
			path = entries[index + 2]
			if not path or path == "" then
				return false
			end
			if rename_sources then
				rename_sources[entries[index + 1]] = path
			end
			index = index + 2
		end
		files[path] = { added = tonumber(added) or 0, removed = tonumber(removed) or 0 }
		index = index + 1
	end
	return true
end

function M.refresh(state, on_change, force)
	local workspace = state.workspace
	local key = workspace_key(workspace)
	if key ~= current_key then
		cancel()
		current_key = key
		next_refresh = 0
		state.workspace_diff = nil
	end
	if not key or active or (not force and vim.uv.now() < next_refresh) then
		return
	end
	next_refresh = vim.uv.now() + refresh_ms
	local job = {}
	active = job
	local files = {}
	local rename_sources = {}
	local function finish(ok)
		cleanup(job)
		if active ~= job then
			return
		end
		active = nil
		if workspace_key(state.workspace) ~= key then
			M.refresh(state, on_change)
			on_change()
			return
		end
		local stats
		if ok then
			stats = { added = 0, removed = 0, files = 0 }
			for _, file in pairs(files) do
				stats.added = stats.added + file.added
				stats.removed = stats.removed + file.removed
				stats.files = stats.files + 1
			end
		end
		if not vim.deep_equal(state.workspace_diff, stats) then
			state.workspace_diff = stats
			on_change()
		end
	end
	local function run(args, different, callback)
		local command = { "git", "--no-optional-locks", "-C", workspace.path }
		vim.list_extend(command, args)
		local ok, process = pcall(vim.system, command, { env = { GIT_LITERAL_PATHSPECS = "1" } }, vim.schedule_wrap(function(result)
			if active ~= job then
				return
			end
			job.process = nil
			if result.code ~= 0 and not (different and result.code == 1) then
				finish(false)
				return
			end
			callback(result.stdout or "")
		end))
		if ok then
			job.process = process
		else
			finish(false)
		end
	end

	local diff_options = { "--no-ext-diff", "--no-textconv", "--find-renames", "--numstat", "-z" }
	run(vim.list_extend({ "diff" }, vim.list_extend(vim.deepcopy(diff_options), { workspace.baselineTree, "--" })), false, function(output)
		if not parse_numstat(output, files, rename_sources) then
			finish(false)
			return
		end
		run({ "ls-files", "--others", "--exclude-standard", "-z" }, false, function(untracked)
			local paths = vim.split(untracked, "\0", { plain = true, trimempty = true })
			local index = 0
			local function collect_next()
				index = index + 1
				local path = paths[index]
				if not path then
					finish(true)
					return
				end
				local function compare(old_path)
					local args = vim.list_extend({ "diff", "--no-index" }, vim.deepcopy(diff_options))
					vim.list_extend(args, { "--", old_path, vim.fs.joinpath(workspace.path, path) })
					run(args, true, function(added_output)
						cleanup(job)
						local added_files = {}
						if not parse_numstat(added_output, added_files) then
							finish(false)
							return
						end
						files[path] = nil
						for _, file in pairs(added_files) do
							files[path] = file
						end
						collect_next()
					end)
				end
				if files[path] then
					-- A staged deletion can leave a recreated, untracked file. Compare it
					-- to the baseline instead of counting a deletion plus a new file.
					run({ "ls-tree", "-z", workspace.baselineTree, "--", path }, false, function(entry)
						local mode, blob = entry:match("^(%d+) blob (%x+)\t")
						if not mode then
							finish(false)
							return
						end
						run({ "cat-file", "blob", blob }, false, function(content)
							job.tempfile = vim.fn.tempname()
							if mode == "120000" then
								if not vim.uv.fs_symlink(content, job.tempfile) then
									finish(false)
									return
								end
							else
								local file = io.open(job.tempfile, "wb")
								if not file then
									finish(false)
									return
								end
								local written = file:write(content)
								local closed = file:close()
								if not written or not closed
									or not vim.uv.fs_chmod(job.tempfile, tonumber(mode:sub(-3), 8)) then
									finish(false)
									return
								end
							end
							compare(job.tempfile)
						end)
					end)
				else
					compare("/dev/null")
				end
			end
			local recreated_renames = {}
			for _, path in ipairs(paths) do
				if rename_sources[path] then
					table.insert(recreated_renames, path)
					table.insert(recreated_renames, rename_sources[path])
				end
			end
			if #recreated_renames > 0 then
				-- If a rename source was recreated, these are now two independent
				-- paths: diff the destination as an addition and restore the source
				-- against its baseline below, rather than counting it twice.
				local args = vim.list_extend({ "diff" }, vim.deepcopy(diff_options))
				vim.list_extend(args, { "--no-renames", workspace.baselineTree, "--" })
				vim.list_extend(args, recreated_renames)
				run(args, false, function(restored_output)
					if not parse_numstat(restored_output, files) then
						finish(false)
						return
					end
					collect_next()
				end)
			else
				collect_next()
			end
		end)
	end)
end

function M.stop()
	if timer then
		timer:stop()
		timer:close()
		timer = nil
	end
	cancel()
	current_key = nil
	next_refresh = 0
end

function M.setup(state, on_change)
	M.stop()
	state.workspace_diff = nil
	local refresh_timer = vim.uv.new_timer()
	timer = refresh_timer
	refresh_timer:start(refresh_ms, refresh_ms, vim.schedule_wrap(function()
		if timer == refresh_timer then
			M.refresh(state, on_change)
		end
	end))
	local group = vim.api.nvim_create_augroup("PiNvimDiffStats", { clear = true })
	vim.api.nvim_create_autocmd({ "FocusGained", "BufWritePost", "DirChanged" }, {
		group = group,
		callback = function() M.refresh(state, on_change, true) end,
	})
	vim.api.nvim_create_autocmd("VimLeavePre", { group = group, callback = M.stop })
end

return M
