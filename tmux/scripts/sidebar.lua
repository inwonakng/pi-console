-- Invoked by toggle-sidebar.sh in a clean, short-lived Neovim Lua process.
local script_dir = vim.fs.dirname(debug.getinfo(1, "S").source:sub(2))
local layout = dofile(script_dir .. "/sidebar-layout.lua")
local app_root = vim.fs.dirname(vim.fs.dirname(script_dir))
local hook = "window-resized[7310]"

local function tmux(args)
	local command = { "tmux" }
	vim.list_extend(command, args)
	local result = vim.system(command, { text = true }):wait()
	assert(result.code == 0, vim.trim(result.stderr or "tmux command failed"))
	return vim.trim(result.stdout or "")
end

local function run(mode, target)
	assert(mode == "toggle" or mode == "reflow", "Invalid sidebar operation")
	assert(target and target:match("^[%%@]%d+$"), "Expected a tmux pane or window ID")
	local window = tmux({ "display-message", "-p", "-t", target, "#{window_id}" })
	local panes = tmux({ "list-panes", "-t", window, "-F", "#{pane_id}\t#{@pi_sidebar}" })
	local sidebar
	for pane in panes:gmatch("(%%%d+)\t1") do
		assert(not sidebar, "Window contains multiple Pi sidebars; close the extra sidebar first")
		sidebar = pane
	end
	if mode == "reflow" and not sidebar then
		tmux({ "set-hook", "-wu", "-t", window, hook })
		return
	end
	local root = layout.parse(tmux({ "display-message", "-p", "-t", window, "#{window_layout}" }))
	if mode == "toggle" and sidebar then
		local content = layout.remove(root, tonumber(sidebar:sub(2)))
		assert(content, "Cannot remove the only pane in a window")
		tmux({ "set-hook", "-wu", "-t", window, hook })
		tmux({ "kill-pane", "-t", sidebar })
		tmux({ "select-layout", "-t", window, layout.serialize(content) })
		return
	end
	if mode == "reflow" then
		-- Respect user rearrangements: only pin the width while the sidebar is
		-- still a full-height left sibling of the content tree.
		if tmux({ "display-message", "-p", "-t", window, "#{window_zoomed_flag}" }) == "1"
			or root.kind ~= "{" or root.children[1].id ~= tonumber(sidebar:sub(2)) then
			return
		end
		local content = root.children[2]
		if #root.children > 2 then
			-- tmux flattens a horizontal split of a single content pane into
			-- root siblings. Resize those siblings as one region without
			-- changing the tree or the user's new split arrangement.
			content = {
				w = root.w - root.children[1].w - 1, h = root.h,
				x = root.children[2].x, y = root.y, kind = "{", children = {},
			}
			for i = 2, #root.children do
				table.insert(content.children, root.children[i])
			end
		end
		local min_w = layout.minimum(content)
		local width = math.min(34, math.floor(root.w / 3), root.w - min_w - 1)
		if width < 2 or width == root.children[1].w then
			return
		end
		layout.resize(content, root.w - width - 1, root.h, root.x + width + 1, root.y)
		root.children[1].w = width
		tmux({ "select-layout", "-t", window, layout.serialize(root) })
		return
	end

	local min_w = layout.minimum(root)
	local width = math.min(34, math.floor(root.w / 3), root.w - min_w - 1)
	assert(width >= 20, "Terminal is too narrow for the Pi sidebar (needs 20 columns plus the existing panes)")
	-- Check all subtree minimums before creating a process or modifying panes.
	layout.add(vim.deepcopy(root), 0, width)
	local cwd = tmux({ "display-message", "-p", "-t", target, "#{pane_current_path}" })
	local created = tmux({
		"split-window", "-fhbd", "-l", tostring(width), "-P", "-F", "#{pane_id}",
		"-t", target, "-c", cwd, "bash", app_root .. "/bin/pi-console", "--sidebar",
	})
	assert(created:match("^%%%d+$"), "tmux did not return the sidebar pane ID")
	local ok, err = pcall(function()
		tmux({ "set-option", "-p", "-t", created, "@pi_sidebar", "1" })
		tmux({ "select-layout", "-t", window, layout.serialize(layout.add(root, tonumber(created:sub(2)), width)) })
		local reflow = "bash " .. vim.fn.shellescape(script_dir .. "/toggle-sidebar.sh") .. " --reflow " .. window
		tmux({ "set-hook", "-w", "-t", window, hook, "run-shell -b " .. vim.fn.shellescape(reflow) })
	end)
	if not ok then
		-- Roll back only the pane we just created; never touch existing processes.
		pcall(tmux, { "kill-pane", "-t", created })
		error(err)
	end
end

local ok, err = pcall(run, arg[1], arg[2])
if not ok then
	local message = "Pi sidebar: " .. tostring(err)
	io.stderr:write(message .. "\n")
	pcall(tmux, { "display-message", message })
	os.exit(1)
end
