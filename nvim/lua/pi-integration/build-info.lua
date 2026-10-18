-- Capture the running build once. A checkout changing on disk does not change
-- the identity of modules already loaded by this Neovim process.
local M = {}

local function text(value)
	return type(value) == "string" and value:gsub("[%c]", " ") or ""
end

local root = text(vim.env.PI_CONSOLE_APP_ROOT or vim.g.pi_console_root)
root = vim.uv.fs_realpath(root) or root
local startup = {
	channel = vim.env.PI_CONSOLE_CHANNEL == "stable" and "stable" or "dev",
	ref = text(vim.env.PI_CONSOLE_BUILD_REF),
	commit = text(vim.env.PI_CONSOLE_BUILD_COMMIT),
	dirty = vim.env.PI_CONSOLE_BUILD_DIRTY == "1",
	app_root = root,
}

if not vim.env.PI_CONSOLE_CHANNEL and root ~= "" then
	-- Porcelain v2 supplies HEAD, branch, and dirty state in one git call.
	local result = vim.system({ "git", "--no-optional-locks", "-C", root, "status", "--porcelain=v2", "--branch" }, { text = true }):wait()
	if result.code == 0 then
		for line in (result.stdout or ""):gmatch("[^\n]+") do
			local commit = line:match("^# branch%.oid (%x+)$")
			local ref = line:match("^# branch%.head (.+)$")
			if commit then startup.commit = commit end
			if ref then startup.ref = text(ref) end
			if line:sub(1, 1) ~= "#" then startup.dirty = true end
		end
	end
end

function M.snapshot()
	return vim.deepcopy(startup)
end

function M.is_dev(entry)
	return type(entry) == "table"
		and ((type(entry.build) == "table" and entry.build.channel == "dev") or entry.channel == "dev")
end

function M.label(build)
	build = build or startup
	if build.channel == "dev" then
		local commit = text(build.commit)
		return "DEV " .. (commit ~= "" and commit:sub(1, 7) or "unknown") .. (build.dirty == true and "*" or "")
	end
	local ref = text(build.ref):gsub("^v", "")
	return ref ~= "" and ref or "stable"
end

function M.statusline_label(width)
	local label = M.label()
	width = math.max(0, width)
	if vim.fn.strdisplaywidth(label) <= width then
		return label
	end
	if startup.channel == "dev" then
		return "DEV"
	end
	return width > 1 and (vim.fn.strcharpart(label, 0, width - 1) .. "…") or vim.fn.strcharpart(label, 0, width)
end

function M.highlight()
	return startup.channel == "dev" and "PiBuildDev" or "PiBuildStable"
end

-- Viewers reserve the identity first, then add complete key hints as they fit.
function M.statusline(width, hints)
	local label = M.statusline_label(width)
	local available = width - vim.fn.strdisplaywidth(label) - 1
	local visible = {}
	for _, hint in ipairs(hints or {}) do
		local needed = vim.fn.strdisplaywidth(hint) + (#visible > 0 and 1 or 0)
		if needed > available then break end
		local styled = hint:gsub("%%", "%%%%"):gsub("^([^:]+):", function(key)
			return "%#PiOverviewKey#" .. key .. "%#PiOverviewStatusLine#:"
		end)
		table.insert(visible, styled)
		available = available - needed
	end
	local left = table.concat(visible, "·")
	return "%#PiOverviewStatusLine#" .. left .. "%=" .. "%#" .. M.highlight() .. "#" .. label:gsub("%%", "%%%%") .. "%*"
end

function M.detail_text(build)
	build = build or startup
	local parts = { M.label(build) }
	if text(build.commit) ~= "" then table.insert(parts, "commit " .. text(build.commit)) end
	if text(build.ref) ~= "" then table.insert(parts, "ref " .. text(build.ref)) end
	if build.dirty == true then table.insert(parts, "dirty at startup") end
	return table.concat(parts, "·")
end

return M
