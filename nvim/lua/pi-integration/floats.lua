local M = {}

local close_on_leave_augroup = vim.api.nvim_create_augroup("PiTransientFloats", { clear = false })

local tracked = {}

local function win_valid(win)
	return win and vim.api.nvim_win_is_valid(win)
end

-- Independent of transient tracking: only the newest focus group owns focus.
local focus_groups = {}
local restore_focus

local function schedule_focus_restore()
	local group = focus_groups[#focus_groups]
	if group then
		vim.schedule(function()
			if focus_groups[#focus_groups] == group then
				restore_focus(group)
			end
		end)
	end
end

local function member_valid(win, buf)
	return win_valid(win) and vim.api.nvim_buf_is_valid(buf) and vim.api.nvim_win_get_buf(win) == buf
end

restore_focus = function(group)
	local fallback
	for win, buf in pairs(group.members) do
		if member_valid(win, buf) and vim.api.nvim_win_get_tabpage(win) == vim.api.nvim_get_current_tabpage() then
			fallback = fallback or win
		else
			group.members[win] = nil
		end
	end
	if not fallback then
		group:release()
		return
	end
	local current = vim.api.nvim_get_current_win()
	if group.members[current] then
		group.last_win = current
		return
	end
	local target = group.members[group.last_win] and group.last_win or fallback
	pcall(vim.api.nvim_set_current_win, target)
end

-- Acquire with {win, ...}; :add(win) includes another member. A nested group
-- temporarily owns focus. :release() is idempotent and resumes its parent,
-- never refocusing the released group. Closing its last member also releases it.
function M.has_focus_group()
	return focus_groups[#focus_groups] ~= nil
end

function M.focus_group(wins)
	local group = { members = {}, released = false }

	function group:add(win)
		if self.released or not win_valid(win) then
			return
		end
		self.members[win] = vim.api.nvim_win_get_buf(win)
		if not self.last_win or vim.api.nvim_get_current_win() == win then
			self.last_win = win
		end
	end

	function group:release()
		if self.released then
			return
		end
		self.released = true
		local was_active = focus_groups[#focus_groups] == self
		for index, active in ipairs(focus_groups) do
			if active == self then
				table.remove(focus_groups, index)
				break
			end
		end
		self.members = {}
		if was_active then
			schedule_focus_restore()
		end
	end

	for _, win in ipairs(wins) do
		group:add(win)
	end
	if next(group.members) then
		table.insert(focus_groups, group)
		schedule_focus_restore()
	else
		group:release()
	end
	return group
end

local focus_augroup = vim.api.nvim_create_augroup("PiFloatFocus", { clear = true })
vim.api.nvim_create_autocmd({ "WinLeave", "BufEnter" }, {
	group = focus_augroup,
	callback = schedule_focus_restore,
})
vim.api.nvim_create_autocmd("WinEnter", {
	group = focus_augroup,
	callback = function()
		local group = focus_groups[#focus_groups]
		local win = vim.api.nvim_get_current_win()
		if group and group.members[win] and member_valid(win, group.members[win]) then
			group.last_win = win
		end
	end,
})
vim.api.nvim_create_autocmd({ "WinClosed", "BufHidden", "BufWipeout" }, {
	group = focus_augroup,
	callback = function(event)
		for index = #focus_groups, 1, -1 do
			local group = focus_groups[index]
			for win, buf in pairs(group.members) do
				if (event.event == "WinClosed" and win == tonumber(event.match))
					or (event.event ~= "WinClosed" and buf == event.buf) then
					group.members[win] = nil
				end
			end
			if not next(group.members) then
				group:release()
			end
		end
	end,
})

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
	if win_valid(win) and vim.api.nvim_win_get_tabpage(win) == vim.api.nvim_get_current_tabpage() then
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

function M.close_descendants(win)
	if not win then return end
	for _, child in ipairs(children_of(win)) do
		close_subtree(child)
	end
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
