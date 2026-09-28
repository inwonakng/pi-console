local M = {}

function M.encode(obj)
	if vim.json and vim.json.encode then
		return vim.json.encode(obj)
	end
	return vim.fn.json_encode(obj)
end

function M.decode(text)
	local ok, decoded
	if vim.json and vim.json.decode then
		ok, decoded = pcall(vim.json.decode, text)
	else
		ok, decoded = pcall(vim.fn.json_decode, text)
	end
	if ok then
		return decoded, nil
	end
	return nil, decoded
end

function M.decode_object(text)
	local decoded = M.decode(text)
	if type(decoded) == "table" then
		return decoded
	end
	return nil
end

return M
