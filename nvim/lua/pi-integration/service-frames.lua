-- Job stdout fragments are not JSON records; join once at each newline.
-- Transport chunks reconstruct records only, never conversation state.
local M = {}
function M.new(record, fail)
	local parts, bytes, transfers, total, count, failed = {}, 0, {}, 0, 0, false
	local function consume(value, size, started)
		assert(type(value) == "table", "Invalid record")
		if value.type ~= "transport_chunk" then
			return record(value, { bytes = size, decodeMs = (vim.uv.hrtime() - started) / 1e6 })
		end
		assert(type(value.transfer) == "string" and #value.transfer == 36 and not value.transfer:find("[^%da-f%-]")
			and type(value.index) == "number" and value.index % 1 == 0 and type(value.text) == "string" and #value.text > 0, "Invalid chunk")
		for key in pairs(value) do
			assert(key == "type" or key == "transfer" or key == "index" or key == "text" or key == "bytes", "Invalid chunk field")
		end
		local _, units = vim.str_utfindex(value.text)
		assert(units <= 16 * 1024, "Chunk too large")
		local transfer = transfers[value.transfer]
		if not transfer then
			assert(value.index == 0 and count < 32, "Invalid transfer")
			transfer = { parts = {}, bytes = 0, decodeMs = 0 }
			transfers[value.transfer], count = transfer, count + 1
		end
		assert(value.index == #transfer.parts and #transfer.parts < 5120, "Out-of-order chunk")
		transfer.bytes, total = transfer.bytes + #value.text, total + #value.text
		assert(transfer.bytes <= 80 * 1024 * 1024 + 32768 and total <= 82 * 1024 * 1024 + 32768, "Transfer too large")
		transfer.parts[#transfer.parts + 1] = value.text
		if value.bytes == nil then
			transfer.decodeMs = transfer.decodeMs + (vim.uv.hrtime() - started) / 1e6
			return
		end
		local text = table.concat(transfer.parts)
		assert(type(value.bytes) == "number" and value.bytes % 1 == 0 and value.bytes > 0
			and value.bytes + 1 <= 80 * 1024 * 1024 and value.bytes == #text, "Invalid completion")
		transfers[value.transfer], total, count = nil, total - transfer.bytes, count - 1
		local decoded = vim.json.decode(text)
		assert(type(decoded) == "table" and decoded.type ~= "transport_chunk", "Invalid transport record")
		return record(decoded, { bytes = #text, decodeMs = transfer.decodeMs + (vim.uv.hrtime() - started) / 1e6 })
	end
	return function(chunks)
		if failed then return end
		for index, chunk in ipairs(chunks) do
			bytes = bytes + #chunk
			if bytes > 80 * 1024 * 1024 then failed = true; fail("Bridge frame too large"); return end
			if chunk ~= "" then parts[#parts + 1] = chunk end
			if index < #chunks then
				local line, size = table.concat(parts), bytes
				parts, bytes = {}, 0
				if line ~= "" then
					local started = vim.uv.hrtime()
					local ok, result = pcall(function() return consume(vim.json.decode(line), size, started) end)
					if not ok then
						failed, transfers, total = true, {}, 0
						fail("Invalid bridge frame or transport chunks"); return
					end
					if result == false then return end
				end
			end
		end
	end
end
return M
