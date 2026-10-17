local M = {}

-- Both lists navigate selectable group/session rows; details are display-only.
function M.new(win)
	local starts = {}
	local last_row = vim.api.nvim_win_get_cursor(win)[1]
	local navigation = {}

	local function select_row(row)
		last_row = row
		local cursor = vim.api.nvim_win_get_cursor(win)
		if cursor[1] ~= row or cursor[2] ~= 0 then
			vim.api.nvim_win_set_cursor(win, { row, 0 })
		end
	end

	function navigation.snap()
		local row = vim.api.nvim_win_get_cursor(win)[1]
		local target = starts[1]
		for _, start in ipairs(starts) do
			if start == row then
				target = start
				break
			elseif start < row then
				target = start
			elseif row > last_row then
				target = start
				break
			else
				break
			end
		end
		select_row(target or row)
	end

	function navigation.set_rows(rows)
		starts = rows
		local row = vim.api.nvim_win_get_cursor(win)[1]
		local nearest = starts[1]
		for _, start in ipairs(starts) do
			if math.abs(start - row) < math.abs(nearest - row) then
				nearest = start
			end
		end
		select_row(nearest or row)
	end

	function navigation.move(delta)
		local row = vim.api.nvim_win_get_cursor(win)[1]
		local index = 1
		for i, start in ipairs(starts) do
			if start <= row then
				index = i
			end
		end
		local target = starts[math.max(1, math.min(#starts, index + delta))]
		if target then
			select_row(target)
		end
	end

	return navigation
end

return M
