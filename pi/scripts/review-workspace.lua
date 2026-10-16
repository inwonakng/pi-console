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

local function historical_readonly(config)
	local actions = require("diffview.actions")
	local blocked = {}
	local function readonly_notice()
		vim.notify("Historical workspace review is read-only", vim.log.levels.INFO)
	end
	-- Replace both resolved mappings and exported actions: user mappings may
	-- already hold the original callbacks, or look them up when invoked.
	for _, name in ipairs({
		"toggle_stage_entry",
		"stage_all",
		"unstage_all",
		"restore_entry",
		"goto_file",
		"goto_file_edit",
		"goto_file_split",
		"goto_file_tab",
	}) do
		blocked[actions[name]] = true
		actions[name] = readonly_notice
	end
	for _, mappings in pairs(config.get_config().keymaps) do
		if type(mappings) == "table" then
			for _, mapping in ipairs(mappings) do
				if blocked[mapping[3]] then
					mapping[3] = readonly_notice
				end
			end
		end
	end
	-- Also stop mutation events emitted by custom user callbacks, retaining
	-- the user's other mappings and hooks in this dedicated reviewer process.
	config.user_emitter:on("view_opened", function(_, view)
		for _, name in ipairs({ "toggle_stage_entry", "stage_all", "unstage_all", "restore_entry" }) do
			view.emitter:on(name, function(event)
				event:stop_propagation()
				readonly_notice()
			end)
		end
	end)
	config.user_emitter:on("diff_buf_win_enter", function(_, buf)
		vim.bo[buf].modifiable = false
		vim.bo[buf].readonly = true
	end)
	-- In particular, do not inherit --imply-local from the user's defaults.
	config.get_config().default_args.DiffviewOpen = {}
end

local function open_workspace_review()
	local baseline = vim.env.PI_WORKSPACE_BASELINE
	assert(baseline and baseline:match("^[0-9a-f]+$"), "PI_WORKSPACE_BASELINE must be a commit hash")
	local config = require("diffview.config")
	config.get_config().view.default.layout = "diff2_vertical"
	config.get_config().file_panel.win_config.width = 20
	local after = vim.env.PI_WORKSPACE_REVIEW_AFTER
	if after and after ~= "" then
		assert(after:match("^[0-9a-f]+$"), "PI_WORKSPACE_REVIEW_AFTER must be a commit hash")
		historical_readonly(config)
		vim.cmd("DiffviewOpen " .. baseline .. ".." .. after)
	else
		show_untracked_files_against_revision()
		vim.cmd("DiffviewOpen " .. baseline .. " --untracked-files=true")
	end
end

local ok, err = xpcall(open_workspace_review, debug.traceback)
if not ok then
	vim.api.nvim_err_writeln("Could not open workspace review:\n" .. err)
	vim.cmd("cquit 1")
end
