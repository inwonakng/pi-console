-- User actions check their own bridge. Discovery and background reads never reconnect it.
local M = {}
function M.new(ctx)
	local gate = { status = nil }
	local action, monitoring, executing
	local function status(value)
		gate.status = value
		ctx.render()
	end
	local function probe(done)
		local finished = false
		local function finish(ok)
			if finished then return end
			finished = true
			done(ok)
		end
		if not ctx.connected() then finish(false); return end
		local id = ctx.request("health", {}, function(ok) finish(ok) end)
		vim.defer_fn(function()
			if finished then return end
			ctx.forget(id)
			finish(false)
		end, 5000)
	end
	function gate.cancel()
		action = nil
		status(nil)
	end
	function gate.run(fn)
		if executing then return fn() end
		if action then ctx.notify("Waiting for the connection; no duplicate action queued."); return end
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
			if ctx.ready() then finish(true)
			elseif vim.uv.hrtime() / 1e6 >= deadline then
				ctx.disconnect()
				finish(false)
			else vim.defer_fn(function() wait_ready(deadline) end, 25) end
		end
		local function reconnect()
			if action ~= waiting then return end
			status("Reconnecting")
			ctx.reconnect()
			-- The bridge handshake has a 10-second deadline; allow attachment recovery too.
			wait_ready(vim.uv.hrtime() / 1e6 + 15000)
		end
		status("Checking connection")
		probe(function(ok)
			if action ~= waiting then return end
			if ok then
				ctx.sync()
				wait_ready(vim.uv.hrtime() / 1e6 + 15000)
			else reconnect() end
		end)
	end
	-- A request can outlive its preflight check. Probe only while user work awaits a reply;
	-- losing that connection never retries the request or starts a background reconnect.
	function gate.monitor()
		if monitoring then return end
		local ticket = {}
		monitoring = ticket
		local function check()
			if monitoring ~= ticket then return end
			if not ctx.pending() then monitoring = nil; return end
			probe(function(ok)
				if monitoring ~= ticket then return end
				if not ctx.pending() then monitoring = nil; return end
				if not ok then monitoring = nil; ctx.disconnect(); return end
				vim.defer_fn(check, 5000)
			end)
		end
		vim.defer_fn(check, 5000)
	end
	function gate.disconnected() monitoring = nil end
	return gate
end
return M
