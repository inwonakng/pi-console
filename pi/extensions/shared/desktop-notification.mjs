import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DESKTOP_NOTIFICATION_STATUS = "pi-console-desktop-notification";
const defaultIconPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../assets/pi-logo.png");
const disabledSounds = new Set(["0", "false", "no", "none", "off", "silent"]);

/** Only display data crosses hosts, never commands, paths to executables or environment settings. */
export function validDesktopNotification(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		&& typeof value.id === "string" && /^[\w-]{1,128}$/.test(value.id)
		&& ["input", "completion"].includes(value.kind)
		&& typeof value.title === "string" && value.title.length > 0 && value.title.length <= 256 && !value.title.includes("\0")
		&& typeof value.body === "string" && value.body.length <= 8192 && !value.body.includes("\0");
}

function executablePath(command) {
	const candidates = command.includes("/") ? [command]
		: (process.env.PATH ?? "").split(delimiter).filter(Boolean).map((directory) => join(directory, command));
	return candidates.find((path) => {
		try { accessSync(path, constants.X_OK); return true; }
		catch { return false; }
	});
}

function desktopNotifier() {
	if (process.platform === "linux") {
		const command = executablePath("notify-send");
		return command ? { command, kind: "notify-send" } : undefined;
	}
	if (process.platform !== "darwin") return;
	for (const candidate of [process.env.ALERTER, "alerter", "/opt/homebrew/bin/alerter", "/usr/local/bin/alerter"]) {
		const command = candidate && executablePath(candidate);
		if (command) return { command, kind: "alerter" };
	}
	const found = spawnSync("/bin/zsh", ["-lc", "command -v alerter"], { encoding: "utf-8" });
	const command = found.status === 0 && found.stdout?.trim();
	return command ? { command, kind: "alerter" } : undefined;
}

function notificationIconPath() {
	const configured = process.env.PI_NOTIFICATION_ICON;
	if (configured && existsSync(configured)) return configured;
	return existsSync(defaultIconPath) ? defaultIconPath : undefined;
}

function configuredSound(envName, fallback) {
	const configured = process.env[envName] ?? process.env.PI_NOTIFICATION_SOUND;
	if (configured === undefined) return fallback;
	const value = configured.trim();
	return !value || disabledSounds.has(value.toLowerCase()) ? undefined : value;
}

function configuredTimeout(envName, fallback) {
	const configured = process.env[envName] ?? process.env.PI_NOTIFICATION_TIMEOUT;
	if (configured === undefined || configured.trim() === "") return fallback;
	const parsed = Number.parseFloat(configured);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/** Local delivery only. Receiving a remote notification must never publish another event. */
export function deliverDesktopNotification({ title, body, kind, onError }) {
	const notifier = desktopNotifier();
	if (!notifier) return false;
	const input = kind === "input";
	const icon = notificationIconPath();
	const sound = configuredSound(input ? "PI_PERMISSION_SOUND" : "PI_COMPLETION_SOUND",
		process.platform === "linux" ? (input ? "dialog-information" : "complete") : (input ? "Ping" : "Glass"));
	const timeout = configuredTimeout(input ? "PI_PERMISSION_NOTIFICATION_TIMEOUT" : "PI_COMPLETION_NOTIFICATION_TIMEOUT", input ? 15 : 8);
	let args;
	if (notifier.kind === "alerter") {
		args = ["--title", title, "--message", body, "--group", input ? "pi-coding-agent-input" : "pi-coding-agent"];
		if (icon) args.push("--app-icon", icon);
		if (sound) args.push("--sound", sound);
		if (timeout) args.push("--timeout", String(timeout));
	} else {
		args = ["--app-name=pi-console"];
		if (icon) args.push("--icon", icon);
		args.push("--hint", sound ? `string:sound-name:${sound}` : "boolean:suppress-sound:true");
		if (timeout) args.push("--expire-time", String(Math.round(timeout * 1000)));
		args.push("--", title, body);
	}
	const child = spawn(notifier.command, args, { detached: true, stdio: "ignore" });
	child.on("error", (error) => onError?.(error));
	child.on("exit", (code) => {
		if (code !== null && code !== 0) onError?.(new Error(`${notifier.kind} exited with code ${code}`));
	});
	child.unref();
	return true;
}
