local M = {}

local function child_text(node, kind)
	for child in node:iter_children() do
		if child:type() == kind then
			return vim.treesitter.get_node_text(child, 0)
		end
	end
end

local function reference_label(text)
	return vim.trim(text:gsub("^%[", ""):gsub("%]$", ""):gsub("%s+", " ")):lower()
end

local function link_destination()
	local parser = vim.treesitter.get_parser(0, "markdown")
	local root = parser:parse(true)[1]:root()
	-- Markdown code fences can themselves contain an injected Markdown parser.
	local row, col = unpack(vim.api.nvim_win_get_cursor(0))
	local outer = root:named_descendant_for_range(row - 1, col, row - 1, col)
	while outer do
		if outer:type() == "fenced_code_block" or outer:type() == "indented_code_block" then
			return
		end
		outer = outer:parent()
	end
	local node = vim.treesitter.get_node({ ignore_injections = false })
	while node do
		local kind = node:type()
		if kind == "inline_link" or kind == "image" or kind == "link_reference_definition" then
			return child_text(node, "link_destination")
		elseif kind == "uri_autolink" or kind == "email_autolink" then
			local uri = vim.treesitter.get_node_text(node, 0):sub(2, -2)
			return kind == "email_autolink" and "mailto:" .. uri or uri
		elseif kind == "full_reference_link" or kind == "collapsed_reference_link" or kind == "shortcut_link" then
			local label = child_text(node, "link_label") or child_text(node, "link_text")
			local query = vim.treesitter.query.parse("markdown", "(link_reference_definition) @definition")
			for _, definition in query:iter_captures(root, 0) do
				if reference_label(child_text(definition, "link_label")) == reference_label(label) then
					return child_text(definition, "link_destination")
				end
			end
			-- An undefined shortcut such as [ordinary text] isn't a link.
			if kind ~= "shortcut_link" then
				error("Markdown reference not found: " .. label, 0)
			end
			return
		end
		node = node:parent()
	end
end

local function percent_decode(text)
	return (text:gsub("%%(%x%x)", function(hex)
		return string.char(tonumber(hex, 16))
	end))
end

local function jump_to_heading(anchor)
	local parser = vim.treesitter.get_parser(0, "markdown")
	local root = parser:parse(true)[1]:root()
	local query = vim.treesitter.query.parse("markdown", [[
		(atx_heading heading_content: (_) @heading)
		(setext_heading heading_content: (_) @heading)
	]])
	local used = {}
	for _, node in query:iter_captures(root, 0) do
		local text = vim.treesitter.get_node_text(node, 0)
		-- Keep visible link labels, not their destinations, in heading IDs.
		text = text:gsub("!?%[([^%]]+)%]%([^)]*%)", "%1"):gsub("%[([^%]]+)%]%[[^%]]*%]", "%1")
		text = vim.fn.substitute(vim.fn.tolower(vim.trim(text)), "[^[:alnum:]_[:space:]-]", "", "g")
		local slug = text:gsub("%s", "-")
		local base, suffix = slug, 0
		while used[slug] do
			suffix = suffix + 1
			slug = base .. "-" .. suffix
		end
		used[slug] = true
		if slug == anchor then
			local row = node:start()
			vim.cmd("normal! m'")
			vim.api.nvim_win_set_cursor(0, { row + 1, 0 })
			vim.cmd("normal! zv")
			return
		end
	end
	error("Markdown heading not found: #" .. anchor, 0)
end

local function follow_link(cwd, resources)
	local destination = link_destination()
	if not destination then
		return false
	end
	destination = destination:gsub("^<", ""):gsub(">$", ""):gsub("\\(%p)", "%1")
	local bound = require("pi-integration.service-resources").for_buffer()
	resources = bound and bound.resource or resources
	if resources then
		if resources.follow(destination, bound and bound.path) then return true end
		local anchor = destination:match("^#(.*)$")
		if anchor then jump_to_heading(percent_decode(anchor)); return true end
		return true
	end
	if vim.api.nvim_buf_get_name(0):match("^pi://") then error("Owner link unavailable: no resource context", 0) end
	if destination:match("^%a[%w+.-]*:") or destination:match("^//") then
		local _, err = vim.ui.open(destination:match("^//") and "https:" .. destination or destination)
		if err then
			error(err, 0)
		end
		return true
	end

	local path, anchor = destination:match("^([^#]*)#(.*)$")
	path = percent_decode(path or destination)
	if path ~= "" then
		if not vim.startswith(path, "/") then
			local name = vim.api.nvim_buf_get_name(0)
			local root = cwd or vim.fn.getcwd()
			if name ~= "" and not name:match("^pi://") then
				root = vim.fs.dirname(name)
			end
			path = vim.fs.joinpath(root, path)
		end
		path = vim.fs.normalize(path, { expand_env = false })
		if vim.fn.filereadable(path) ~= 1 then
			error("Markdown file not found: " .. path, 0)
		end
		vim.cmd.edit(vim.fn.fnameescape(path))
	end
	if anchor and anchor ~= "" then
		jump_to_heading(percent_decode(anchor))
	end
	return true
end

-- Errors consume Enter too: don't open an unrelated transcript item on failure.
function M.jump_to_heading(anchor) return jump_to_heading(percent_decode(anchor)) end
function M.follow(cwd, resources)
	local ok, handled = pcall(follow_link, cwd, resources)
	if not ok then
		require("pi-integration.logs").notify(handled, vim.log.levels.WARN)
		return true
	end
	return handled
end

return M
