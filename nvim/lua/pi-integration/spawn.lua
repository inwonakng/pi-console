local spawn_artifacts = require("pi-integration.spawn-artifacts")

local M = {}

local function worktree_info(run)
	return type(run.worktree) == "table" and run.worktree or nil
end

local function run_label(run)
	local agent = run.agent or "generic"
	local status = run.status or "unknown"
	local id = run.runId or "unknown"
	local worktree = worktree_info(run)
	local integration = worktree and worktree.integration
	local suffix = integration and integration ~= vim.NIL and (" · " .. tostring(integration)) or ""
	return string.format("%s · %s · %s%s", status, agent, id, suffix)
end

local function send_spawn_action(ctx, run, action)
	local id = run.runId
	if not id or id == "" then
		ctx.ui.notify("Spawn run has no id", vim.log.levels.ERROR)
		return
	end
	ctx.rpc.send({ type = "prompt", message = "/spawn-control " .. action .. " " .. id }, function(event)
		if not event.success then
			ctx.ui.notify(event.error or ("Could not send spawn action: " .. action), vim.log.levels.ERROR)
		elseif action == "join" then
			ctx.ui.notify("Joining subagent " .. id)
		elseif action == "stop" then
			ctx.ui.notify("Stopping subagent " .. id)
		else
			ctx.ui.notify("Requested subagent " .. action .. ": " .. id)
		end
	end)
end

local function pick_send_action(ctx, run)
	local actions = { "status", "join", "stop" }
	vim.ui.select(actions, { prompt = "Send subagent action", pi_select_layout = "compact" }, function(choice)
		if choice then
			send_spawn_action(ctx, run, choice)
		end
	end)
end

function M.pick(ctx)
	local runs = ctx.state.spawn_runs or {}
	if #runs == 0 then
		ctx.ui.notify("No spawned subagents in this session", vim.log.levels.WARN)
		return
	end

	local choices = {}
	for index = #runs, 1, -1 do
		table.insert(choices, runs[index])
	end

	vim.ui.select(choices, {
		prompt = "Spawned subagents",
		format_item = run_label,
	}, function(choice)
		if choice then
			spawn_artifacts.pick_run(ctx, choice, function()
				pick_send_action(ctx, choice)
			end)
		end
	end)
end

return M
