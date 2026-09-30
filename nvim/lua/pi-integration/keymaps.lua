local M = {}

local which_key = require("which-key")

M.specs = {
	input = {
		{ modes = { "n", "i" }, lhs = "<C-CR>", action = "submit_prompt", desc = "Submit prompt" },
	},
	shared = {
		{ lhs = "<leader>a", action = "cycle_access_mode", desc = "Cycle access mode" },
		{ lhs = "<leader>i", action = "cycle_integration_mode", desc = "Cycle integration mode" },
		{ lhs = "<leader>?", action = "show_help", desc = "Pi help" },
		{ lhs = "<leader>/", action = "pick_command", desc = "Pick Pi command" },
		{ lhs = "<leader>pi", action = "show_input", desc = "Show Pi input" },
		{ lhs = "<leader>pa", action = "restore_pending_action", desc = "Restore pending action" },
		{ lhs = "<leader>pc", action = "change_cwd", desc = "Change CWD" },
		{ lhs = "<leader>pd", action = "show_workspace_diff", desc = "Diff" },
		{ lhs = "<leader>pr", action = "restart", desc = "Restart Pi" },
		{ lhs = "<leader>pt", action = "show_transcript", desc = "Show Pi transcript" },
		{ lhs = "<leader>pl", action = "show_logs", desc = "Show Pi logs" },
		{ lhs = "<leader>pu", action = "show_usage", desc = "Show Codex usage" },
		{ lhs = "<leader>ps", action = "pick_spawn", desc = "Show subagents" },
		{ lhs = "<leader>A", action = "pick_access_mode", desc = "Pick access mode" },
		{ lhs = "<leader>I", action = "pick_integration_mode", desc = "Pick integration mode" },
		{ lhs = "<leader>m", action = "pick_model", desc = "Pick model" },
		{ lhs = "<leader>t", action = "pick_thinking", desc = "Pick thinking level" },
		{ lhs = "<leader>s", action = "pick_session", desc = "Pick session" },
		{ lhs = "<leader>h", action = "history", desc = "History" },
		{ lhs = "<leader>T", action = "show_tree", desc = "Session tree" },
		{ lhs = "<leader>pn", action = "new_session", desc = "New session in current window" },
		{ lhs = "<leader>pN", action = "new_session_window", desc = "New session in project directory" },
		{ lhs = "<leader>n", action = "toggle_notifications", desc = "Toggle notifications" },
		{ lhs = "<leader>r", action = "refresh_messages", desc = "Refresh transcript" },
		{ lhs = "<leader>R", action = "rename_session", desc = "Rename session" },
	},
	transcript = {
		{ lhs = "<Esc><Esc>", action = "abort", desc = "Abort Pi" },
		{
			lhs = "<CR>",
			action = "open_transcript_item",
			desc = "Open tool/thinking/skill/compaction output",
		},
	},
}

local function action_fn(ctx, action)
	if action == "open_transcript_item" then
		return function()
			ctx.transcript.open_item_under_cursor()
		end
	end

	return function()
		local fn = ctx.actions[action]
		if type(fn) == "function" then
			fn()
		else
			ctx.ui.notify("Missing Pi action: " .. tostring(action), vim.log.levels.ERROR)
		end
	end
end

local function set_keymaps(ctx, buf, specs)
	if not ctx.buffer.valid(buf) then
		return
	end
	for _, spec in ipairs(specs) do
		vim.keymap.set(spec.modes or "n", spec.lhs, action_fn(ctx, spec.action), {
			buffer = buf,
			desc = spec.desc,
		})
	end
end

local function which_key_specs(buf, specs)
	local result = {}
	for _, spec in ipairs(specs) do
		local item = {
			spec.lhs,
			buffer = buf,
			desc = spec.desc,
		}
		if spec.modes then
			item.mode = spec.modes
		end
		table.insert(result, item)
	end
	return result
end

local function register_which_key(ctx, buf, specs)
	if not ctx.buffer.valid(buf) then
		return
	end
	which_key.add(which_key_specs(buf, specs))
end

function M.merged(context)
	local specs = vim.deepcopy(M.specs.shared)
	vim.list_extend(specs, vim.deepcopy(M.specs[context] or {}))
	return specs
end

function M.setup(ctx)
	local input_specs = M.merged("input")
	local transcript_specs = M.merged("transcript")

	set_keymaps(ctx, ctx.state.input_buf, input_specs)
	set_keymaps(ctx, ctx.state.transcript_buf, transcript_specs)
	register_which_key(ctx, ctx.state.input_buf, input_specs)
	register_which_key(ctx, ctx.state.transcript_buf, transcript_specs)
end

function M.help_key_lines()
	local lines = {
		"- `<C-CR>` submit the input buffer.",
	}
	for _, spec in ipairs(M.specs.shared) do
		table.insert(lines, "- `" .. spec.lhs .. "` " .. spec.desc .. ".")
	end
	vim.list_extend(lines, {
		"- `<CR>` open the current tool/thinking/skill/compaction output.",
		"- `<Esc><Esc>` abort Pi.",
		"- `q` or `<Esc>` close this help.",
	})
	return lines
end

return M
