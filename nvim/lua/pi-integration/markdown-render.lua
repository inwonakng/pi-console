local M = {}

local render_markdown = require("render-markdown")

local function valid_buf(buf)
	return type(buf) == "number" and vim.api.nvim_buf_is_valid(buf)
end

function M.prepare_buffer(buf, opts)
	if not valid_buf(buf) then
		return
	end
	opts = opts or {}

	pcall(vim.treesitter.start, buf, opts.treesitter or "markdown")
	if opts.latex then
		require("latex_renderer").attach(buf)
	end
end

function M.render(buf, win, opts)
	if not valid_buf(buf) then
		return
	end
	opts = opts or {}

	if type(win) == "number" and vim.api.nvim_win_is_valid(win) then
		render_markdown.render({
			buf = buf,
			win = win,
			event = opts.event or "PiNvim",
		})
		-- render-markdown applies its extmarks on the next scheduled callback.
		-- Redraw after that callback so inactive transcript windows do not keep
		-- stale layout until the cursor enters them.
		vim.schedule(function()
			if valid_buf(buf) and vim.api.nvim_win_is_valid(win) then
				vim.cmd("redraw")
			end
		end)
	end

	if not opts.latex then
		return
	end

	require("latex_renderer").queue(buf)
end

return M
