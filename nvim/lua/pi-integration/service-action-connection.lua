-- User actions reuse their bridge. Discovery and background reads never reconnect it.
local M = {}
function M.new(ctx)
	local gate = { status = nil }
	local action, monitoring, executing
	local function status(value)
		if gate.status == value then return end
		gate.status = value
		ctx.render()
	end
	local function probe(done)
		local finished = false
		local function finish(ok, reason)
			if finished then return end
			finished = true
			done(ok, reason)
		end
		if not ctx.connected() then finish(false, "Conversation bridge is not connected"); return end
		local id = ctx.request("health", {}, function(ok, result)
			finish(ok, not ok and ("Health request failed: " .. tostring(result and result.message or "Unknown error")) or nil)
		end)
		vim.defer_fn(function()
			if finished then return end
			ctx.forget(id)
			finish(false, "Health check timed out after 5 seconds")
		end, 5000)
	end
	function gate.cancel()
		action = nil
		status(nil)
	end
	function gate.run(fn)
		if executing then return fn() end
		if action then ctx.notify("Waiting for Pi connection. This action was ignored; try again once connected."); return end
		local waiting = {}
		action = waiting
		local function finish(ok)
			if action ~= waiting then return end
			action = nil
			status(nil)
			if not ok then
				ctx.notify("Connection recovery failed. Text remains local; no action was retried.")
				return
			end
			executing = true
			local success, err = xpcall(fn, debug.traceback)
			executing = false
			if not success then ctx.notify(tostring(err)) end
		end
		local function wait_ready(deadline)
			if action ~= waiting then return end
			local ready, reason = ctx.ready()
			if ready then finish(true)
			elseif vim.uv.hrtime() / 1e6 >= deadline then
				ctx.disconnect("Readiness timed out after 15 seconds: " .. tostring(reason or "Unknown pending state"))
				finish(false)
			else vim.defer_fn(function() wait_ready(deadline) end, 25) end
		end
		if not ctx.connected() then
			status("Reconnecting")
			ctx.reconnect("Conversation bridge is not connected")
		end
		-- Reuse an existing bridge even while its handshake or attachment is pending.
		-- The bridge handshake has a 10-second deadline; allow attachment recovery too.
		wait_ready(vim.uv.hrtime() / 1e6 + 15000)
	end
	-- Probe only while user work awaits a reply;
	-- losing that connection never retries the request or starts a background reconnect.
	function gate.monitor()
		if monitoring then return end
		local ticket = {}
		monitoring = ticket
		local function check()
			if monitoring ~= ticket then return end
			if not ctx.pending() then monitoring = nil; return end
			probe(function(ok, reason)
				if monitoring ~= ticket then return end
				if not ctx.pending() then monitoring = nil; return end
				if not ok then monitoring = nil; ctx.disconnect(reason); return end
				vim.defer_fn(check, 5000)
			end)
		end
		vim.defer_fn(check, 5000)
	end
	function gate.disconnected() monitoring = nil end
	return gate
end
return M
