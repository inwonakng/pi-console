local floats = require("pi-integration.floats")
local keymaps = require("pi-integration.keymaps")

local M = {}

local function buffer_valid(buf)
	return buf and vim.api.nvim_buf_is_valid(buf)
end

local function create_buffer(name)
	local buf = vim.api.nvim_create_buf(false, true)
	vim.api.nvim_buf_set_name(buf, name)
	vim.bo[buf].bufhidden = "hide"
	vim.bo[buf].filetype = "markdown"
	vim.bo[buf].modifiable = false
	return buf
end

local function set_lines(buf, lines)
	vim.bo[buf].modifiable = true
	vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
	vim.bo[buf].modifiable = false
end

function M.toggle_window(state, options)
	if state.help_win and vim.api.nvim_win_is_valid(state.help_win) then
		floats.close_window(state.help_win)
		state.help_win = nil
		return
	end

	if not buffer_valid(state.help_buf) then
		state.help_buf = create_buffer(options.name)
	end
	set_lines(state.help_buf, options.lines)

	local width = math.min(72, math.max(48, math.floor(vim.o.columns * 0.55)))
	local height = math.min(#options.lines + 2, math.max(14, math.floor(vim.o.lines * 0.65)))
	local row = math.max(1, math.floor((vim.o.lines - height) / 2))
	local col = math.max(0, math.floor((vim.o.columns - width) / 2))

	state.help_win = vim.api.nvim_open_win(state.help_buf, true, {
		relative = "editor",
		width = width,
		height = height,
		row = row,
		col = col,
		style = "minimal",
		border = "rounded",
		title = " " .. options.title .. " ",
		title_pos = "center",
	})
	vim.wo[state.help_win].wrap = true
	vim.wo[state.help_win].linebreak = true

	local close_help_win = function()
		floats.close_window(state.help_win)
		state.help_win = nil
	end
	floats.close_on_win_leave(state.help_buf, close_help_win, { win = state.help_win, parent = options.parent })
	vim.keymap.set("n", "q", close_help_win, { buffer = state.help_buf, desc = "Close help" })
	vim.keymap.set("n", "<Esc>", close_help_win, { buffer = state.help_buf, desc = "Close help" })
end

function M.toggle(ctx)
	local lines = { "# Session help", "", "## Keybindings", "" }
	vim.list_extend(lines, keymaps.help_key_lines())
	vim.list_extend(lines, {
		"",
		"## Commands",
		"",
		"- `:PiControl` acquire control; confirm before replacing another controller.",
		"- `:PiCd [directory]` choose a directory on the current host before starting a conversation.",
		"- `:PiCommand` pick a slash command, template, or skill from the attached runtime; input / completion also discovers them.",
		"- `:PiPending` restore a pending picker. Esc hides it; Ctrl-q cancels the request. Viewers inspect only.",
		"- `:PiQueue` inspect, edit, or remove queued messages. Ctrl+Enter saves an edit; editing pauses dispatch while connected.",
		"- `:PiSteer` / `:PiFollowUp` send to the separate native steering and follow-up queues.",
		"- `:PiSide` toggle the side conversation; hiding preserves its draft and conversation.",
		"- `:PiSidePrompt` / `:PiSideNew` / `:PiSideAbort` prompt, replace, or stop side work.",
		"- `:PiWorkspace` enter, integrate, or discard a task workspace with the configured confirmations.",
		"- `:PiWorkspaceReview` / `:PiWorkspaceReviews` inspect current or saved workspace diffs. Each review pane has its own `<leader>?` help.",
		"- `:PiRetitle` generate a session title.",
		"- `:PiLogs` inspect notifications, action outcomes, and recovery text; Enter opens details.",
		"- `:PiHostRequest` inspect unresolved session creation or resume requests.",
		"- `:PiSessions` browse sessions and archive, unarchive, or delete them with workspace warnings.",
		"- `:PiSavedOperations` inspect original saved-session outcomes without repeating operations.",
		"- `:PiOffers` / `:PiDrafts` inspect effect offers and local drafts.",
		"- `:PiDetach` / `:PiReconnect` detach or reconnect this frontend.",
		"- `:PiKill` confirm stopping the session and closing its frontend; preserves history and local drafts.",
		"- `:PiConsoleRestart` restart the frontend; installed dev uses the latest selected build.",
		"- `:PiRestart` restart this conversation worker using the running server build; interrupts active work.",
		"- `:PiHosts` attach, connect, retry, disconnect, edit, or forget hosts. Restart server applies the installed build on a chosen host/channel; force interruption requires separate confirmation, and saved sessions stay stopped. Last server restart inspects the latest outcome.",
		"- `:PiManagement` inspect overview management outcomes.",
		"- `:PiNew` create a conversation in the original directory. Its worker starts immediately; unused windows are cleaned up on close.",
		"- `:PiRefreshOptions` refresh cached pre-start models, defaults, and commands; otherwise they expire after 60 seconds.",
		"- `:PiTranscript` inspect session history across all branches, read-only.",
		"",
		"## Session views",
		"",
		"- Settings, model, thinking, and history apply to the attached session.",
		"- Transcript Enter inspects thinking, tools, skills, artifacts, and file links; @ completion uses the session directory.",
		"- History, side conversation, and workspace review views use `<leader>?` for their own help.",
		"- Paged text: n next, p first, r reload. Skill f reads the current skill file.",
		"- Slash commands run on the session host through the shared prompt queue. TUI-only built-ins are unavailable through Pi RPC.",
		"- Excluded resource actions never use a local or raw RPC fallback.",
		"- Service restart is available in Hosts. Installation and frontend restart remain separate; service stop is CLI-only: pi-console server stop [--force].",
	})
	M.toggle_window(ctx.state, {
		name = "pi://help",
		title = "Session help",
		lines = lines,
		parent = vim.api.nvim_get_current_win(),
	})
end

return M
