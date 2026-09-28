local floats = require("pi-integration.floats")
local buffer_utils = require("pi-integration.utils.buffer")

local M = {}

local function line_count_text(text)
	if type(text) ~= "string" or text == "" then
		return 0
	end
	local _, count = text:gsub("\n", "")
	if text:sub(-1) == "\n" then
		return count
	end
	return count + 1
end

local function markdown_title(line)
	local title = line:match("^%s*%*%*(.-)%*%*%s*$") or line:match("^%s*__(.-)__%s*$")
	if not title then
		title = line:match("^%s*#+%s+(.+)%s*$")
		if title then
			title = title:gsub("%s+#+%s*$", "")
		end
	end
	if not title then
		return nil
	end
	title = vim.trim(title)
	return title ~= "" and title or nil
end

local function thinking_titles(text)
	local titles = {}
	for line in tostring(text or ""):gmatch("[^\r\n]+") do
		local title = markdown_title(line)
		if title then
			table.insert(titles, title)
		end
	end
	return titles
end

function M.reset(state)
	state.thinking_outputs = {}
	state.next_thinking_output_id = 0
	state.active_thinking_output_id = nil
	state.active_thinking_line = nil
end

function M.store(state, text)
	state.next_thinking_output_id = state.next_thinking_output_id + 1
	local id = state.next_thinking_output_id
	state.thinking_outputs[id] = {
		text = text or "",
		filetype = "markdown",
	}
	return id
end

function M.append(state, output_id, delta)
	local output = state.thinking_outputs[output_id]
	if not output then
		return
	end
	output.text = (output.text or "") .. (delta or "")
end

function M.text(state, output_id)
	local output = state.thinking_outputs[output_id]
	return output and output.text or nil
end

function M.summary_lines(state, output_id, streaming)
	local output = state.thinking_outputs[output_id]
	if not output then
		return { "> Thinking unavailable." }
	end
	local titles = thinking_titles(output.text)
	if #titles > 0 then
		return {
			"> 󰔛 " .. table.concat(titles, " · "),
		}
	end
	local line_label
	if streaming then
		line_label = "streaming..."
	else
		local lines = line_count_text(output.text)
		line_label = lines == 1 and "1 line" or (tostring(lines) .. " lines")
	end
	return {
		"> 󰔛 Thinking · " .. line_label,
	}
end

function M.open_float(ctx, output_id)
	local state = ctx.state
	local output = state.thinking_outputs[output_id]
	if not output then
		ctx.ui.notify("Thinking output unavailable", vim.log.levels.WARN)
		return true
	end

	local width = math.max(40, math.floor(vim.o.columns * 0.85))
	local height = math.max(10, math.floor(vim.o.lines * 0.8))
	width = math.min(width, math.max(1, vim.o.columns - 4))
	height = math.min(height, math.max(1, vim.o.lines - 4))
	local row = math.floor((vim.o.lines - height) / 2)
	local col = math.floor((vim.o.columns - width) / 2)

	local buf = buffer_utils.create_scratch({
		name = "pi://thinking/" .. output_id,
		filetype = output.filetype or "markdown",
		lines = vim.split(output.text or "", "\n", { plain = true }),
	})

	local win = vim.api.nvim_open_win(buf, true, {
		relative = "editor",
		width = width,
		height = height,
		row = row,
		col = col,
		style = "minimal",
		border = "rounded",
		title = " Thinking ",
		title_pos = "left",
	})

	vim.api.nvim_set_option_value("wrap", true, { win = win })
	vim.api.nvim_set_option_value("number", false, { win = win })
	vim.api.nvim_set_option_value("relativenumber", false, { win = win })
	vim.api.nvim_set_option_value("signcolumn", "no", { win = win })

	local close_thinking_win = function()
		floats.close_window(win)
	end
	floats.close_on_win_leave(buf, close_thinking_win, { win = win, parent = ctx.window.parent })
	vim.keymap.set("n", "q", close_thinking_win, { buffer = buf, silent = true, desc = "Close thinking output" })
	vim.keymap.set("n", "<Esc>", close_thinking_win, { buffer = buf, silent = true, desc = "Close thinking output" })
	vim.keymap.set("n", "y", function()
		vim.fn.setreg("+", output.text or "")
		ctx.ui.notify("Yanked thinking output")
	end, { buffer = buf, silent = true, desc = "Yank thinking output" })

	return true
end

return M
