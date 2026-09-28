local function show_untracked_files_against_revision()
	local GitAdapter = require("diffview.vcs.adapters.git").GitAdapter
	local RevType = require("diffview.vcs.rev").RevType
	local original = GitAdapter.show_untracked

	function GitAdapter:show_untracked(opt)
		if opt and opt.revs and opt.revs.right.type == RevType.LOCAL then
			return true
		end
		return original(self, opt)
	end
end

local function open_workspace_review()
	local baseline = vim.env.PI_WORKSPACE_BASELINE
	assert(baseline and baseline:match("^[0-9a-f]+$"), "PI_WORKSPACE_BASELINE must be a commit hash")
	show_untracked_files_against_revision()
	vim.cmd("DiffviewOpen " .. baseline .. " --untracked-files=true")
end

local ok, err = xpcall(open_workspace_review, debug.traceback)
if not ok then
	vim.api.nvim_err_writeln("Could not open workspace review:\n" .. err)
	vim.cmd("cquit 1")
end
