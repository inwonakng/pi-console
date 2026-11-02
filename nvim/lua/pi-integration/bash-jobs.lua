-- Observational frontend controls. Completion delivery remains owned by the agent.
local M = {}
local waits = {}
local function clean(value) return tostring(value):gsub("[%c]", " ") end

function M.open(options)
	local resources, state = options.resources, options.state
	local key = resources.context
	waits[key] = waits[key] or {}
	local pending = waits[key]
	local function invoke(operation, payload, done, accepted, failed)
		if not options.current() then return end
		return options.command(operation, payload, function(ok, receipt)
			if not ok then
				if failed then failed() end
				options.notify(receipt.message or "Bash operation was not accepted")
			elseif accepted then accepted(receipt) end
		end, function(receipt)
			if not options.current() then return end
			if receipt.status ~= "completed" then
				if failed then failed() end
				options.notify(receipt.error and receipt.error.message or "Bash operation failed"); return
			end
			if done then done(receipt.result and receipt.result.bash) end
		end)
	end
	local list, details
	details = function(job)
		if not options.current() then return end
		local buf = vim.api.nvim_create_buf(false, true)
		vim.bo[buf].bufhidden = "wipe"
		local lines = { "Bash job " .. job.jobId, "", "j join · s stop · c cancel wait · r refresh · o stdout · e stderr · l list · q close", "" }
		for _, field in ipairs({ "command", "cwd", "state", "cleanup", "createdAt", "startedAt", "endedAt", "exitCode", "signal", "sandboxBlocked", "stopReason", "error", "completion", "restored" }) do
			local value = job[field]
			if value ~= nil and value ~= vim.NIL then table.insert(lines, field .. ": " .. clean(value)) end
		end
		if pending[job.jobId] then table.insert(lines, "Waiting (observational): " .. pending[job.jobId]) end
		vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
		resources.qualify(buf, "Bash " .. job.jobId)
		require("pi-integration.floats").close_window(state.spawn_win)
		local width = math.max(1, math.min(100, vim.o.columns - 4))
		local height = math.max(1, math.min(#lines, vim.o.lines - 6))
		local win = vim.api.nvim_open_win(buf, true, { relative = "editor", style = "minimal", border = "rounded",
			width = width, height = height, row = math.max(0, math.floor((vim.o.lines - height) / 2)),
			col = math.max(0, math.floor((vim.o.columns - width) / 2)), title = " Bash jobs [" .. resources.label .. "] " })
		state.spawn_win, state.spawn_buf = win, buf
		vim.wo[win].wrap = true
		local function close()
			if vim.api.nvim_win_is_valid(win) then vim.api.nvim_win_close(win, true) end
			if state.spawn_win == win then state.spawn_win, state.spawn_buf = nil, nil end
		end
		local function refresh()
			invoke("bash.status", { jobId = job.jobId }, function(result)
				if result and vim.api.nvim_win_is_valid(win) then details(result.job) end
			end)
		end
		local function map(lhs, fn, desc) vim.keymap.set("n", lhs, fn, { buffer = buf, silent = true, desc = desc }) end
		map("r", refresh, "Refresh Bash job")
		map("j", function()
			if pending[job.jobId] then options.notify("Already waiting; s stops the command, c cancels only this wait."); return end
			pending[job.jobId] = "accepting"
			local id = invoke("bash.join", { jobId = job.jobId }, function(result)
				pending[job.jobId] = nil
				options.notify(result and result.kind == "bash_join_cancelled" and "Bash join cancelled; command not stopped." or "Bash join finished (agent result remains uncollected).")
				refresh()
			end, function(receipt)
				if receipt.status == "accepted" and receipt.result then pending[job.jobId] = receipt.result.waitId end
			end, function() pending[job.jobId] = nil end)
			if not id then pending[job.jobId] = nil end
		end, "Wait for job (observational)")
		map("s", function()
			invoke("bash.stop", { jobId = job.jobId }, function() options.notify("Bash stop finished; inspect cleanup state."); refresh() end)
		end, "Stop Bash job (also usable during join)")
		map("c", function()
			local wait = pending[job.jobId]
			if not wait or wait == "accepting" then options.notify("No accepted join wait to cancel."); return end
			invoke("bash.cancel-wait", { invocationId = wait }, function() pending[job.jobId] = nil; refresh() end)
		end, "Cancel only the join wait")
		for lhs, stream in pairs({ o = "stdout", e = "stderr" }) do
			map(lhs, function() resources.open({ kind = "bash-job", jobId = job.jobId, stream = stream }, "Bash " .. stream .. " " .. job.jobId, "text") end,
				"Read bounded Bash " .. stream .. " (n next, p first, r refresh)")
		end
		map("l", function() close(); list(0) end, "Bash job list")
		map("q", close, "Close job (leave command and wait running)")
		map("<Esc>", close, "Close job (leave command and wait running)")
	end
	list = function(offset)
		invoke("bash.list", { offset = offset }, function(result)
			if not result then return end
			local choices = vim.deepcopy(result.jobs or {})
			if result.nextOffset and result.nextOffset ~= vim.NIL then table.insert(choices, { page = result.nextOffset, label = "Next jobs…" }) end
			if offset > 0 then table.insert(choices, { page = 0, label = "First jobs…" }) end
			if #choices == 0 then options.notify("No Bash jobs in this session."); return end
			vim.ui.select(choices, { prompt = "Bash jobs (observational)", format_item = function(item)
				return item.label or (item.state .. " · " .. item.jobId .. " · " .. clean(item.command))
			end }, function(choice)
				if not choice or not options.current() then return end
				if choice.page then list(choice.page) else details(choice) end
			end)
		end)
	end
	list(0)
end
return M
