local M = {}

local close_on_leave_augroup = vim.api.nvim_create_augroup("PiTransientFloats", { clear = false })

local tracked = {}

local function win_valid(win)
	return win and vim.api.nvim_win_is_valid(win)
end

local function normalize_options(buf, close_fn, opts)
	opts = opts or {}
	local win = opts.win
	if not win_valid(win) and buf and vim.api.nvim_buf_is_valid(buf) then
		for _, candidate in ipairs(vim.api.nvim_list_wins()) do
			if vim.api.nvim_win_get_buf(candidate) == buf then
				win = candidate
				break
			end
		end
	end
	return {
		win = win,
		buf = buf,
		parent = opts.parent,
		group = opts.group,
		close = close_fn,
	}
end

local function untrack(win)
	if not win then
		return
	end
	tracked[win] = nil
end

local function is_descendant(win, ancestor)
	local current = win
	while current and tracked[current] do
		local parent = tracked[current].parent
		if parent == ancestor then
			return true
		end
		current = parent
	end
	return false
end

local function root_of(win)
	local current = win
	local seen = {}
	while current and tracked[current] and tracked[current].parent and not seen[current] do
		seen[current] = true
		current = tracked[current].parent
	end
	return current
end

local function same_stack(a, b)
	return a and b and tracked[a] and tracked[b] and root_of(a) == root_of(b)
end

local function same_group(a, b)
	local a_group = a and tracked[a] and tracked[a].group
	return a_group ~= nil and b and tracked[b] and tracked[b].group == a_group
end

local function focus_window(win)
	if win_valid(win) then
		pcall(vim.api.nvim_set_current_win, win)
		return true
	end
	return false
end

local function focus_nearest_parent(win)
	local current = win
	local seen = {}
	while current and tracked[current] and not seen[current] do
		seen[current] = true
		local parent = tracked[current].parent
		if focus_window(parent) then
			return true
		end
		current = parent
	end
	return false
end

local function close_tracked(win)
	local info = tracked[win]
	if not info then
		return
	end
	focus_nearest_parent(win)
	tracked[win] = nil
	if type(info.close) == "function" then
		info.close()
	elseif win_valid(win) then
		vim.api.nvim_win_close(win, true)
	end
end

local function children_of(win)
	local children = {}
	for child, info in pairs(tracked) do
		if info.parent == win then
			table.insert(children, child)
		end
	end
	return children
end

local function close_subtree(win)
	for _, child in ipairs(children_of(win)) do
		close_subtree(child)
	end
	close_tracked(win)
end

local function close_stack_for(win)
	local root = root_of(win) or win
	close_subtree(root)
end

function M.close_window(win)
	if not win then
		return
	end
	local info = tracked[win]
	if info then
		focus_nearest_parent(win)
	end
	if win_valid(win) then
		vim.api.nvim_win_close(win, true)
	end
	untrack(win)
end

function M.track_window(win, opts)
	if not win_valid(win) then
		return nil
	end
	opts = opts or {}
	tracked[win] = {
		parent = opts.parent,
		group = opts.group,
		close = opts.close,
	}
	return win
end

function M.new_group()
	return {}
end

function M.close_on_win_leave(buf, close_fn, opts)
	if not (buf and vim.api.nvim_buf_is_valid(buf)) then
		return
	end
	local info = normalize_options(buf, close_fn, opts)
	if not win_valid(info.win) then
		return
	end

	M.track_window(info.win, { parent = info.parent, group = info.group, close = close_fn })
	pcall(vim.api.nvim_clear_autocmds, { group = close_on_leave_augroup, buffer = buf })

	vim.api.nvim_create_autocmd("WinLeave", {
		group = close_on_leave_augroup,
		buffer = buf,
		callback = function()
			local leaving_win = info.win
			vim.schedule(function()
				if not tracked[leaving_win] then
					return
				end
				local current = vim.api.nvim_get_current_win()
				if current == leaving_win then
					return
				end
				if is_descendant(current, leaving_win) then
					return
				end
				if same_group(current, leaving_win) then
					return
				end
				if same_stack(current, leaving_win) then
					close_subtree(leaving_win)
					return
				end
				close_stack_for(leaving_win)
			end)
		end,
	})

	vim.api.nvim_create_autocmd({ "BufWipeout", "BufHidden" }, {
		group = close_on_leave_augroup,
		buffer = buf,
		callback = function()
			untrack(info.win)
		end,
	})
end

return M
