-- Frontend-local recovery only. These files never authorize or replay service work.
local M = {}
local channel = vim.env.PI_CONSOLE_CHANNEL or "stable"
assert(channel == "stable" or channel == "dev", "Invalid frontend channel")
local state_root = vim.env.XDG_STATE_HOME
if not state_root or state_root == "" then state_root = vim.fs.joinpath(vim.fn.expand("~"), ".local", "state") end
assert(state_root:sub(1, 1) == "/", "XDG_STATE_HOME must be absolute")
-- NVIM_APPNAME changes with stable releases; recovery belongs to the channel.
local directory = vim.fs.joinpath(state_root, "pi-console", "frontend", channel, "service-drafts")
local function private_directory()
	vim.fn.mkdir(directory, "p", 448)
	local stat = assert(vim.uv.fs_lstat(directory))
	assert(stat.type == "directory" and stat.uid == vim.uv.getuid() and bit.band(stat.mode, 63) == 0, "Draft directory must be private (0700)")
end
function M.save(id, value)
	private_directory()
	local path = vim.fs.joinpath(directory, id .. ".json")
	local temporary = path .. ".tmp"
	local file = assert(vim.uv.fs_open(temporary, "w", 384))
	local ok, err = pcall(function()
		assert(vim.uv.fs_write(file, vim.json.encode(value)))
		assert(vim.uv.fs_fsync(file))
	end)
	vim.uv.fs_close(file)
	assert(ok, err)
	assert(vim.uv.fs_rename(temporary, path))
end
function M.list()
	private_directory()
	local values = {}
	for name, kind in vim.fs.dir(directory) do
		if kind == "file" and name:match("^[%w-]+%.json$") then
			local path = vim.fs.joinpath(directory, name)
			local stat = vim.uv.fs_lstat(path)
			if stat and stat.type == "file" and stat.uid == vim.uv.getuid() and bit.band(stat.mode, 63) == 0 and stat.size < 16 * 1024 * 1024 then
				local ok, value = pcall(function() return vim.json.decode(table.concat(vim.fn.readfile(path), "\n")) end)
				if ok then table.insert(values, { path = path, value = value }) end
			end
		end
	end
	return values
end
return M
