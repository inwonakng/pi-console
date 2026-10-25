-- Job stdout fragments are not JSON records; join once at each newline.
local M = {}
function M.new(record, fail)
	local parts, bytes = {}, 0
	return function(chunks)
		for index, chunk in ipairs(chunks) do
			bytes = bytes + #chunk
			if bytes > 80 * 1024 * 1024 then fail("Bridge frame too large"); return end
			if chunk ~= "" then parts[#parts + 1] = chunk end
			if index < #chunks then
				local line, size = table.concat(parts), bytes
				parts, bytes = {}, 0
				if line ~= "" then
					local started = vim.uv.hrtime()
					local ok, value = pcall(vim.json.decode, line)
					if not ok then fail("Invalid bridge frame"); return end
					if record(value, { bytes = size, decodeMs = (vim.uv.hrtime() - started) / 1e6 }) == false then return end
				end
			end
		end
	end
end
return M
