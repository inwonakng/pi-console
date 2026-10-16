-- tmux layout trees: {left,right} and [top,bottom], with pane IDs at leaves.
-- Work on the current tree, never a saved layout that could undo user edits.
local M = {}

function M.parse(layout)
	-- tmux 3.8 also emits versioned JSON layouts. Normalize both formats to
	-- the same geometry tree; select-layout still accepts the legacy encoding.
	if layout:sub(1, 1) == "{" then
		local document = vim.json.decode(layout)
		assert(document.V == 2 and document.L, "Unsupported tmux JSON layout version")
		local function convert(cell)
			local node = { w = cell.w, h = cell.h, x = cell.x, y = cell.y }
			if cell.t == "p" then
				node.id = assert(tonumber((cell.I or ""):match("^%%(%d+)$")), "Invalid tmux JSON pane ID")
			else
				assert(cell.t == "h" or cell.t == "v", "Invalid tmux JSON split")
				node.kind, node.children = cell.t == "h" and "{" or "[", {}
				for _, child in ipairs(cell.c) do table.insert(node.children, convert(child)) end
			end
			return node
		end
		return convert(document.L)
	end
	local body = assert(layout:match("^%x+,(.+)$"), "Invalid tmux layout")
	local pos = 1
	local function parse()
		local start, _, w, h, x, y, next_pos = body:find("(%d+)x(%d+),(%d+),(%d+)()", pos)
		assert(start == pos, "Invalid tmux layout geometry")
		local node = { w = tonumber(w), h = tonumber(h), x = tonumber(x), y = tonumber(y) }
		pos = next_pos
		local kind = body:sub(pos, pos)
		pos = pos + 1
		if kind == "," then
			local id, finish = body:match("^(%d+)()", pos)
			node.id = assert(tonumber(id), "Invalid tmux pane ID")
			pos = finish
		else
			assert(kind == "{" or kind == "[", "Invalid tmux layout split")
			node.kind, node.children = kind, {}
			while true do
				table.insert(node.children, parse())
				local delimiter = body:sub(pos, pos)
				pos = pos + 1
				if delimiter ~= "," then
					assert(delimiter == (kind == "{" and "}" or "]"), "Invalid tmux layout delimiter")
					break
				end
			end
			assert(#node.children >= 2, "Invalid tmux split children")
		end
		return node
	end
	local root = parse()
	assert(pos == #body + 1, "Trailing tmux layout data")
	return root
end

function M.minimum(node)
	if node.id then
		return 1, 1
	end
	local w, h = 0, 0
	for _, child in ipairs(node.children) do
		local cw, ch = M.minimum(child)
		if node.kind == "{" then
			w, h = w + cw, math.max(h, ch)
		else
			w, h = math.max(w, cw), h + ch
		end
	end
	if node.kind == "{" then
		w = w + #node.children - 1
	else
		h = h + #node.children - 1
	end
	return w, h
end

local function distribute(children, space, dimension)
	local sizes, remaining, weight = {}, space, 0
	for _, child in ipairs(children) do
		weight = weight + child[dimension]
	end
	-- Clamp small subtrees first, then proportionally distribute the remainder.
	while true do
		local clamped = false
		for i, child in ipairs(children) do
			local min_w, min_h = M.minimum(child)
			local minimum = dimension == "w" and min_w or min_h
			if not sizes[i] and remaining * child[dimension] / weight < minimum then
				sizes[i] = minimum
				remaining, weight = remaining - minimum, weight - child[dimension]
				clamped = true
			end
		end
		if not clamped then
			break
		end
	end
	local used = 0
	for i, child in ipairs(children) do
		if not sizes[i] then
			sizes[i] = math.floor(remaining * child[dimension] / weight)
		end
		used = used + sizes[i]
	end
	for i = 1, space - used do
		sizes[(i - 1) % #children + 1] = sizes[(i - 1) % #children + 1] + 1
	end
	return sizes
end

function M.resize(node, w, h, x, y)
	local min_w, min_h = M.minimum(node)
	assert(w >= min_w and h >= min_h, "Terminal is too small for this pane layout")
	if node.children then
		local horizontal = node.kind == "{"
		local sizes = distribute(node.children, (horizontal and w or h) - #node.children + 1, horizontal and "w" or "h")
		local offset = 0
		for i, child in ipairs(node.children) do
			M.resize(child, horizontal and sizes[i] or w, horizontal and h or sizes[i], x + (horizontal and offset or 0), y + (horizontal and 0 or offset))
			offset = offset + sizes[i] + 1
		end
	end
	node.w, node.h, node.x, node.y = w, h, x, y
	return node
end

function M.remove(node, id)
	if node.id then
		if node.id == id then
			return nil
		end
		return node
	end
	for i = #node.children, 1, -1 do
		local child = M.remove(node.children[i], id)
		if child then
			node.children[i] = child
		else
			table.remove(node.children, i)
		end
	end
	if #node.children == 0 then
		return nil
	end
	local result = #node.children == 1 and node.children[1] or node
	return M.resize(result, node.w, node.h, node.x, node.y)
end

function M.add(root, id, width)
	local w, h, x, y = root.w, root.h, root.x, root.y
	local min_w = M.minimum(root)
	assert(w >= width + 1 + min_w, "Terminal is too narrow for the Pi sidebar")
	M.resize(root, w - width - 1, h, x + width + 1, y)
	return {
		w = w, h = h, x = x, y = y, kind = "{",
		children = { { id = id, w = width, h = h, x = x, y = y }, root },
	}
end

function M.serialize(root)
	local function encode(node)
		local geometry = string.format("%dx%d,%d,%d", node.w, node.h, node.x, node.y)
		if node.id then
			return geometry .. "," .. node.id
		end
		local children = {}
		for _, child in ipairs(node.children) do
			table.insert(children, encode(child))
		end
		return geometry .. node.kind .. table.concat(children, ",") .. (node.kind == "{" and "}" or "]")
	end
	local body, checksum = encode(root), 0
	for i = 1, #body do
		checksum = (math.floor(checksum / 2) + checksum % 2 * 32768 + body:byte(i)) % 65536
	end
	return string.format("%04x,%s", checksum, body)
end

return M
