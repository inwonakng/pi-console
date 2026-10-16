vim.api.nvim_create_autocmd("FileType", {
	group = vim.api.nvim_create_augroup("PiMarkdownLinks", { clear = true }),
	pattern = "markdown",
	callback = function(args)
		vim.keymap.set("n", "<CR>", function()
			if not require("pi-integration").follow_markdown_link() then
				vim.cmd("normal! " .. vim.v.count1 .. vim.keycode("<CR>"))
			end
		end, { buffer = args.buf, silent = true, desc = "Follow Markdown link" })
		vim.b[args.buf].undo_ftplugin = (vim.b[args.buf].undo_ftplugin or "") .. "|silent! nunmap <buffer> <CR>"
	end,
})

require("latex_renderer").setup({
	scale = 0.8,
})

require("render-markdown").setup({
	debounce = 0,
	on = {
		render = function(ctx)
			require("pi-integration").on_transcript_rendered(ctx.buf)
		end,
	},
	pipe_table = {
		enabled = false,
	},
	quote = {
		enabled = false,
	},
	ignore = function(buf)
		return vim.api.nvim_buf_get_name(buf):match("pi://input$") ~= nil
	end,
	overrides = {
		buftype = {
			nofile = {
				render_modes = true,
			},
		},
	},
	heading = {
		sign = false,
		setext = false,
		custom = {
			pi_user_you = {
				pattern = "You%s*$",
				icon = "󰭹 ",
				background = "PiUserHeader",
				foreground = "PiUserHeader",
			},
			pi_user_user = {
				pattern = "User%s*$",
				icon = "󰭹 ",
				background = "PiUserHeader",
				foreground = "PiUserHeader",
			},
			pi_assistant = {
				pattern = "Assistant%s*$",
				icon = "󰚩 ",
				background = "PiAssistantHeader",
				foreground = "PiAssistantHeader",
			},
		},
	},
	latex = {
		enabled = false,
	},
	win_options = {
		conceallevel = {
			default = vim.o.conceallevel,
			rendered = 2,
		},
	},
})

require("markdown_table_renderer").setup({
	max_width_ratio = 0.95,
	min_col_width = 6,
	max_col_width = 40,
})
