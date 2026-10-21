-- Machine-local, channel-stable stores. Never read or migrate legacy state.
local M = {}
local uv = vim.uv
local channel = vim.env.PI_CONSOLE_CHANNEL or "stable"
assert(channel == "stable" or channel == "dev", "Invalid frontend channel")
function M.root(kind)
	local base
	if kind == "config" then base = vim.env.XDG_CONFIG_HOME else base = vim.env.XDG_STATE_HOME end
	if not base or base == "" then
		base = kind == "config" and vim.fs.joinpath(vim.fn.expand("~"), ".config") or vim.fs.joinpath(vim.fn.expand("~"), ".local", "state")
	end
	assert(base:sub(1, 1) == "/", "Frontend XDG roots must be absolute")
	return vim.fs.joinpath(base, "pi-console", "frontend", channel)
end
function M.prepare(directory)
	vim.fn.mkdir(directory, "p", 448)
	local stat = assert(uv.fs_lstat(directory))
	assert(stat.type == "directory" and stat.uid == uv.getuid() and bit.band(stat.mode, 63) == 0,
		"Frontend directory must be private and owned by this user: " .. directory)
end
function M.path(name, kind) return vim.fs.joinpath(M.root(kind), name .. ".json") end
function M.load(name, initial, kind)
	local path = M.path(name, kind)
	local stat, err, code = uv.fs_lstat(path)
	if not stat then if code == "ENOENT" then return vim.deepcopy(initial) end; error(err) end
	M.prepare(vim.fs.dirname(path))
	assert(stat.type == "file" and stat.uid == uv.getuid() and bit.band(stat.mode, 63) == 0, "Frontend file must be private: " .. path)
	return vim.json.decode(table.concat(vim.fn.readfile(path), "\n"))
end
function M.update(name, initial, callback, kind)
	local path = M.path(name, kind)
	local ok, result, message = pcall(function()
		M.prepare(vim.fs.dirname(path))
		local lock = path .. ".lock"
		local fd, err = uv.fs_open(lock, "wx", 384)
		assert(fd, "Frontend store is busy; retry shortly: " .. tostring(err))
		local temporary = path .. "." .. uv.os_getpid() .. ".tmp"
		local updated, value, detail = pcall(function()
			local data = M.load(name, initial, kind)
			local before = vim.deepcopy(data)
			local answer, failure = callback(data)
			if not answer then return nil, failure end
			if not vim.deep_equal(before, data) then
				local out = assert(uv.fs_open(temporary, "wx", 384))
				local wrote, write_error = uv.fs_write(out, vim.json.encode(data) .. "\n", 0)
				local synced, sync_error = uv.fs_fsync(out)
				uv.fs_close(out)
				assert(wrote, write_error); assert(synced, sync_error)
				assert(uv.fs_rename(temporary, path))
			end
			return answer
		end)
		if uv.fs_lstat(temporary) then uv.fs_unlink(temporary) end
		uv.fs_close(fd); assert(uv.fs_unlink(lock))
		if not updated then error(value) end
		return value, detail
	end)
	if not ok then return nil, tostring(result) end
	return result, message
end
return M
