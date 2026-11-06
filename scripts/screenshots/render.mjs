// Render captured tmux screens and the web UI to PNG files with Playwright.
//   node render.mjs terminal SCREEN.ansi OUT.png COLS ROWS
//   node render.mjs web URL OUT_DIR SESSION_COUNT CONVERSATION_TITLE
//   node render.mjs check   (only verify that Chromium starts)
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const font = process.env.SCREENSHOT_FONT || "JetBrainsMono Nerd Font";
const [mode, ...args] = process.argv.slice(2);

// Close to the dark theme used by the bundled Neovim colors; only affects
// palette (non-truecolor) cells such as the tmux status line.
const theme = {
	background: "#0f1014", foreground: "#d4d4d8", cursor: "#0f1014",
	black: "#1b1d23", red: "#e06c75", green: "#98c379", yellow: "#e5c07b", blue: "#61afef",
	magenta: "#c678dd", cyan: "#56b6c2", white: "#abb2bf", brightBlack: "#5c6370", brightRed: "#e06c75",
	brightGreen: "#98c379", brightYellow: "#e5c07b", brightBlue: "#61afef", brightMagenta: "#c678dd",
	brightCyan: "#56b6c2", brightWhite: "#e6e6e6",
};

async function terminal(browser, [input, output, cols, rows]) {
	const page = await browser.newPage({ deviceScaleFactor: 2, viewport: { width: 800, height: 600 } });
	await page.setContent(`<!doctype html><html><body style="margin:0;background:#000">
		<div id="frame" style="display:inline-block;padding:56px 64px;background:#000">
			<div style="border:1px solid #2c2e36;border-radius:14px;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.6);background:${theme.background}">
				<div style="height:30px;display:flex;align-items:center;gap:8px;padding:0 14px;background:#1a1b21">
					<span style="width:12px;height:12px;border-radius:50%;background:#ff5f57"></span>
					<span style="width:12px;height:12px;border-radius:50%;background:#febc2e"></span>
					<span style="width:12px;height:12px;border-radius:50%;background:#28c840"></span>
				</div>
				<div id="term" style="padding:12px 14px"></div>
			</div>
		</div></body></html>`);
	await page.addStyleTag({ path: require.resolve("@xterm/xterm/css/xterm.css") });
	await page.addScriptTag({ path: require.resolve("@xterm/xterm/lib/xterm.js") });
	await page.addScriptTag({ path: require.resolve("@xterm/addon-unicode11/lib/addon-unicode11.js") });
	const screen = readFileSync(input, "utf8").replace(/\n$/, "").replaceAll("\n", "\r\n");
	await page.evaluate(async ({ screen, cols, rows, font, theme }) => {
		await document.fonts.load(`16px "${font}"`);
		const term = new window.Terminal({ cols, rows, fontFamily: `"${font}", monospace`, fontSize: 16,
			lineHeight: 1.1, theme, allowProposedApi: true, cursorStyle: "bar", cursorInactiveStyle: "none" });
		term.loadAddon(new window.Unicode11Addon.Unicode11Addon());
		term.unicode.activeVersion = "11";
		term.open(document.getElementById("term"));
		await new Promise((resolve) => term.write(screen, resolve));
		await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
	}, { screen, cols: Number(cols), rows: Number(rows), font, theme });
	const frame = page.locator("#frame");
	const box = await frame.boundingBox();
	await page.setViewportSize({ width: Math.ceil(box.width), height: Math.ceil(box.height) });
	await frame.screenshot({ path: output });
	await page.close();
}

async function web(browser, [url, outDir, count, title]) {
	const page = await browser.newPage({ deviceScaleFactor: 3, viewport: { width: 390, height: 844 }, colorScheme: "dark" });
	await page.goto(url);
	await page.waitForFunction((count) => document.querySelectorAll("#session-list .session-row").length >= count,
		Number(count), { timeout: 30_000 });
	await page.waitForTimeout(500);
	await page.screenshot({ path: join(outDir, "webui-overview.png") });
	await page.locator(".session-row", { hasText: title }).click();
	const conversation = page.locator(".conversation:not([hidden])");
	await conversation.locator("[data-id=messages] > *").first().waitFor({ timeout: 30_000 });
	await page.waitForTimeout(1000);
	await page.screenshot({ path: join(outDir, "webui-conversation.png") });
	await page.close();
}

let browser;
try {
	browser = await chromium.launch();
} catch (error) {
	console.error(error.message.split("\n").find((line) => line.includes("error while loading shared libraries")) ?? error.message);
	console.error("Chromium cannot start. Install its system libraries, for example:\n  sudo npx --prefix scripts/screenshots playwright install-deps chromium");
	process.exit(1);
}
// A missing font silently falls back and draws Nerd Font icons as boxes.
async function check(browser) {
	const page = await browser.newPage();
	const found = await page.evaluate((font) => {
		const draw = (family) => {
			const canvas = document.createElement("canvas");
			const context = canvas.getContext("2d");
			context.font = `32px ${family}`;
			context.fillText("\uf07b\ue0b6", 4, 36);
			return canvas.toDataURL();
		};
		return draw(`"${font}", monospace`) !== draw("monospace");
	}, font);
	await page.close();
	if (!found) {
		console.error(`Font "${font}" with Nerd Font icons is not installed. Install it (for example from\nhttps://www.nerdfonts.com) or set SCREENSHOT_FONT to an installed Nerd Font family.`);
		process.exitCode = 1;
	}
}

try {
	if (mode === "check") await check(browser);
	else if (mode === "terminal") await terminal(browser, args);
	else if (mode === "web") await web(browser, args);
	else throw new Error(`Unknown mode: ${mode}`);
} finally {
	await browser.close();
}
