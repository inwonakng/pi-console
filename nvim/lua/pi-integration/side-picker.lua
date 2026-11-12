local floats = require("pi-integration.floats")
local M = {}

function M.open(side, actions)
	local entries, chats = {}, {}
	for _, chat in ipairs(side.conversations or {}) do
		chats[chat.id] = chat
		local label = (chat.id == side.id and "● " or "  ") .. chat.title
			.. (chat.running and " (running)" or "") .. " · " .. (chat.lastUsedAt or ""):sub(1, 16):gsub("T", " ")
		table.insert(entries, chat.id .. "\t" .. label:gsub("[%c]", " "))
	end
	local function selected(entry) return chats[entry and entry:match("^([^\t]+)\t")] end
	local preview = require("fzf-lua.previewer.builtin").buffer_or_file:extend()
	function preview:parse_entry(entry)
		local chat = selected(entry)
		return { content = chat and vim.split(chat.preview ~= "" and chat.preview or "No messages yet.", "\n", { plain = true }) or {}, filetype = "markdown" }
	end
	local focus
	local function release() if focus then focus:release(); focus = nil end end
	local function act(fn)
		return function(items)
			local chat = selected(items[1])
			if chat and actions.current() then fn(chat) end
		end
	end
	require("fzf-lua").fzf_exec(entries, {
		prompt = "Side chats > ",
		previewer = { _ctor = function() return preview end },
		winopts = {
			width = 1.0, height = 1.0,
			preview = { layout = "vertical", vertical = "up:60%", hidden = false, wrap = true },
			on_create = function(event) focus = floats.focus_group({ event.winid }) end,
			on_close = release,
		},
		fzf_opts = { ["--delimiter"] = "[\t]", ["--with-nth"] = "2..", ["--no-sort"] = true,
			["--header"] = "Enter: open / Ctrl-x: delete / Ctrl-f, Ctrl-b: scroll preview" },
		keymap = { builtin = { ["<C-f>"] = "preview-page-down", ["<C-b>"] = "preview-page-up" },
			fzf = { ["ctrl-f"] = "preview-page-down", ["ctrl-b"] = "preview-page-up" } },
		actions = {
			enter = { fn = act(function(chat) actions.select(chat.id) end), header = "open" },
			["ctrl-x"] = { fn = act(actions.delete), header = "delete" },
		},
	})
end

return M
