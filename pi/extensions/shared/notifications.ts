import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type DesktopNotificationOptions = {
	title: string;
	group: string;
	soundEnv?: string;
	defaultSound?: string;
	timeoutEnv?: string;
	defaultTimeoutSeconds?: number;
	onError?: (error: Error) => void;
};

const defaultIconPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../assets/pi-logo.png");
const DISABLED_SOUND_VALUES = new Set(["0", "false", "no", "none", "off", "silent"]);

type NotificationState = {
	desktopNotificationsEnabled: boolean;
};

const notificationStateKey = Symbol.for("pi.extensions.notifications.state");
const notificationStateHost = globalThis as Record<PropertyKey, unknown>;
const notificationState = (notificationStateHost[notificationStateKey] ??= {
	desktopNotificationsEnabled: true,
}) as NotificationState;

export function notificationsEnabled(): boolean {
	return notificationState.desktopNotificationsEnabled;
}

export function setNotificationsEnabled(enabled: boolean): void {
	notificationState.desktopNotificationsEnabled = enabled;
}

export function toggleNotificationsEnabled(): boolean {
	notificationState.desktopNotificationsEnabled = !notificationState.desktopNotificationsEnabled;
	return notificationState.desktopNotificationsEnabled;
}

// Prompt policy travels with our structured RPC title, never with a later request.
export function promptDisablesNotification(title: string | undefined): boolean {
	if (!title) return false;
	try {
		const payload: unknown = JSON.parse(title);
		return typeof payload === "object" && payload !== null
			&& "kind" in payload && typeof payload.kind === "string"
			&& ["pi_confirmation", "pi_compact_select", "pi_input", "pi_approval_preview", "pi_side_dialog"].includes(payload.kind)
			&& "notify" in payload && payload.notify === false;
	} catch {
		return false;
	}
}

export function parseNotificationMode(input: string | undefined): boolean | "toggle" | undefined {
	const value = (input ?? "").trim().toLowerCase();
	if (value === "" || value === "toggle") {
		return "toggle";
	}
	if (["on", "yes", "true", "1", "enable", "enabled"].includes(value)) {
		return true;
	}
	if (["off", "no", "false", "0", "disable", "disabled"].includes(value)) {
		return false;
	}
	return undefined;
}

function executablePath(command: string): string | undefined {
	const candidates = command.includes("/") ? [command]
		: (process.env.PATH ?? "").split(delimiter).filter(Boolean).map((directory) => join(directory, command));
	return candidates.find((path) => {
		try { accessSync(path, constants.X_OK); return true; }
		catch { return false; }
	});
}

function desktopNotifier(): { command: string; kind: "alerter" | "notify-send" } | undefined {
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

export function notificationIconPath(): string | undefined {
	const configured = process.env.PI_NOTIFICATION_ICON;
	if (configured && existsSync(configured)) {
		return configured;
	}
	return existsSync(defaultIconPath) ? defaultIconPath : undefined;
}

export function configuredNotificationSound(envName: string | undefined, fallback: string | undefined): string | undefined {
	const configured = (envName ? process.env[envName] : undefined) ?? process.env.PI_NOTIFICATION_SOUND;
	if (configured === undefined) {
		return fallback;
	}

	const value = configured.trim();
	if (!value || DISABLED_SOUND_VALUES.has(value.toLowerCase())) {
		return undefined;
	}
	return value;
}

export function configuredNotificationTimeout(
	envName: string | undefined,
	fallbackSeconds: number | undefined,
): number | undefined {
	const configured = (envName ? process.env[envName] : undefined) ?? process.env.PI_NOTIFICATION_TIMEOUT;
	if (configured === undefined || configured.trim() === "") {
		return fallbackSeconds;
	}

	const parsed = Number.parseFloat(configured);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		return undefined;
	}
	return parsed;
}

export function readableCwd(cwd: string, maxLength = 48): string {
	const home = homedir();
	const path = cwd === home ? "~" : cwd.startsWith(`${home}/`) ? `~/${cwd.slice(home.length + 1)}` : cwd;
	if (path.length <= maxLength) {
		return path;
	}

	const prefix = path.startsWith("~/") ? "~" : path.startsWith("/") ? "/" : "";
	const parts = path.split("/").filter(Boolean);
	const finalDir = parts.at(-1) ?? path;
	const shortenedPrefix = prefix === "/" ? "/.../" : prefix ? `${prefix}/.../` : ".../";
	const withFinalDir = `${shortenedPrefix}${finalDir}`;
	if (withFinalDir.length <= maxLength) {
		return withFinalDir;
	}

	const available = Math.max(1, maxLength - shortenedPrefix.length - 3);
	return `${shortenedPrefix}${finalDir.slice(0, available)}...`;
}

export function notificationBody(ctx: ExtensionContext): string {
	return `${ctx.sessionManager.getSessionName() || basename(ctx.cwd)}\n${readableCwd(ctx.cwd)}`;
}

export function sendDesktopNotification(
	ctx: ExtensionContext,
	options: DesktopNotificationOptions,
): boolean {
	const notifier = desktopNotifier();
	if (!notifier) return false;

	const icon = notificationIconPath();
	const sound = configuredNotificationSound(options.soundEnv, options.defaultSound);
	const timeout = configuredNotificationTimeout(options.timeoutEnv, options.defaultTimeoutSeconds);
	let args: string[];
	if (notifier.kind === "alerter") {
		args = ["--title", options.title, "--message", notificationBody(ctx), "--group", options.group];
		if (icon) args.push("--app-icon", icon);
		if (sound) args.push("--sound", sound);
		if (timeout) args.push("--timeout", String(timeout));
	} else {
		args = ["--app-name=pi-console"];
		if (icon) args.push("--icon", icon);
		args.push("--hint", sound ? `string:sound-name:${sound}` : "boolean:suppress-sound:true");
		if (timeout) args.push("--expire-time", String(Math.round(timeout * 1000)));
		args.push("--", options.title, notificationBody(ctx));
	}

	// Delivery belongs to the worker's host, even without any connected clients.
	const child = spawn(notifier.command, args, { detached: true, stdio: "ignore" });
	child.on("error", (error) => options.onError?.(error));
	child.on("exit", (code) => {
		if (code !== null && code !== 0) options.onError?.(new Error(`${notifier.kind} exited with code ${code}`));
	});
	child.unref();
	return true;
}

export function notifyPiNeedsInput(ctx: ExtensionContext, title = "Pi needs input", allowNotification = true): boolean {
	if (!allowNotification || !notificationsEnabled()) {
		return false;
	}

	return sendDesktopNotification(ctx, {
		title,
		group: "pi-coding-agent-input",
		soundEnv: "PI_PERMISSION_SOUND",
		defaultSound: process.platform === "linux" ? "dialog-information" : "Ping",
		timeoutEnv: "PI_PERMISSION_NOTIFICATION_TIMEOUT",
		defaultTimeoutSeconds: 15,
		onError: (error) => {
			ctx.ui.notify(`Could not send Pi notification: ${error.message}`, "warning");
		},
	});
}

export function notifyPiToolApproval(ctx: ExtensionContext): boolean {
	return notifyPiNeedsInput(ctx, "Pi: Tool Approval");
}

export function notifyPiWorkspaceIntegration(ctx: ExtensionContext): boolean {
	return notifyPiNeedsInput(ctx, "Pi: Workspace Integration");
}

export function notifyPiFinished(ctx: ExtensionContext, force = false): boolean {
	if (process.env.PI_SPAWN_AGENT === "1") {
		return false;
	}
	if (!notificationsEnabled() && !force) {
		return false;
	}

	return sendDesktopNotification(ctx, {
		title: "Pi finished",
		group: "pi-coding-agent",
		soundEnv: "PI_COMPLETION_SOUND",
		defaultSound: process.platform === "linux" ? "complete" : "Glass",
		timeoutEnv: "PI_COMPLETION_NOTIFICATION_TIMEOUT",
		defaultTimeoutSeconds: 8,
		onError: (error) => {
			ctx.ui.notify(`Could not send Pi notification: ${error.message}`, "warning");
		},
	});
}
