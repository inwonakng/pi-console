local M = {}
local ns = vim.api.nvim_create_namespace("PiWorkspaceSummary")

function M.highlight(buf)
	vim.api.nvim_buf_clear_namespace(buf, ns, 0, -1)
	local function mark(row, first, last, group)
		vim.api.nvim_buf_set_extmark(buf, ns, row, first - 1, {
			end_col = last - 1,
			hl_group = group,
		})
	end

	for i, line in ipairs(vim.api.nvim_buf_get_lines(buf, 0, -1, false)) do
		local count_start, count_end, added_start, added_end, deleted_start, deleted_end =
			line:match("^()%d+ files? changed(), ()%d+ insertions%(%+%)(), ()%d+ deletions%(%-%)()$")
		if count_start then
			mark(i - 1, count_start, count_end, "PiWorkspaceSummaryCount")
			mark(i - 1, added_start, added_end, "PiWorkspaceSummaryAdd")
			mark(i - 1, deleted_start, deleted_end, "PiWorkspaceSummaryDelete")
		elseif line:match("^[AMDT?=] ") then
			-- Match only the trailing counters, never numbers inside a filename.
			added_start, added_end, deleted_start, deleted_end = line:match("  ()%+%d+()  ()%-%d+()$")
			if not added_start then
				local entry = line:gsub(" %[staged%]$", "")
				added_start, added_end, deleted_start, deleted_end = entry:match(" %(()%+[%d?]+() ()%-[%d?]+()%)$")
			end
			if added_start then
				mark(i - 1, added_start, added_end, "PiWorkspaceSummaryAdd")
				mark(i - 1, deleted_start, deleted_end, "PiWorkspaceSummaryDelete")
			end
		end
	end
end

return M
