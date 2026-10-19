local M = {}

function M.format_timestamp(timestamp)
	local text = tostring(timestamp)
	local normalized = text:gsub("%.%d+Z$", "Z")
	local utc = normalized:match("^(%d%d%d%d%-%d%d%-%d%dT%d%d:%d%d:%d%d)Z$")
	if not utc then
		return text
	end

	local seconds = vim.fn.strptime("%Y-%m-%dT%H:%M:%S%z", utc .. "+0000")
	if seconds == 0 and utc ~= "1970-01-01T00:00:00" then
		return text
	end
	return os.date("%Y-%m-%d %H:%M:%S %z", seconds)
end

return M
