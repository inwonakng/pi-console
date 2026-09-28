local treesitter = require("nvim-treesitter")

local parsers = {
	"markdown",
	"markdown_inline",
	"latex",
	"yaml",
}

-- This is a no-op for parsers that are already installed.
treesitter.install(parsers)

local group = vim.api.nvim_create_augroup("Treesitter", { clear = true })

vim.api.nvim_create_autocmd("FileType", {
	group = group,
	callback = function(args)
		local filetype = vim.bo[args.buf].filetype
		local language = vim.treesitter.language.get_lang(filetype)

		if language and vim.treesitter.language.add(language) then
			vim.treesitter.start(args.buf, language)
		end
	end,
})
