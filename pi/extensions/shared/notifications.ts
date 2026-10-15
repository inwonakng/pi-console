import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type AlerterNotificationOptions = {
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
	missingAlerterWarned?: boolean;
	suppressedInputNotifications: number;
};

const notificationStateKey = Symbol.for("pi.extensions.notifications.state");
const notificationStateHost = globalThis as Record<PropertyKey, unknown>;
const notificationState = (notificationStateHost[notificationStateKey] ??= {
	desktopNotificationsEnabled: false,
	suppressedInputNotifications: 0,
}) as NotificationState;
notificationState.suppressedInputNotifications ??= 0;

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

export function suppressNextInputNotification(): void {
	notificationState.suppressedInputNotifications++;
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

export function alerterPath(): string | undefined {
	const configured = process.env.ALERTER;
	if (configured && existsSync(configured)) {
		return configured;
	}

	for (const candidate of ["/opt/homebrew/bin/alerter", "/usr/local/bin/alerter"]) {
		if (existsSync(candidate)) {
			return candidate;
		}
	}

	const found = spawnSync("/bin/zsh", ["-lc", "command -v alerter"], { encoding: "utf-8" });
	const path = found.stdout?.trim();
	return found.status === 0 && path ? path : undefined;
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

export function sendAlerterNotification(
	ctx: ExtensionContext,
	options: AlerterNotificationOptions,
): boolean {
	const alerter = alerterPath();
	if (!alerter) {
		return false;
	}

	const args = ["--title", options.title, "--message", notificationBody(ctx), "--group", options.group];
	const iconPath = notificationIconPath();
	if (iconPath) {
		args.push("--app-icon", iconPath);
	}
	const sound = configuredNotificationSound(options.soundEnv, options.defaultSound);
	if (sound) {
		args.push("--sound", sound);
	}
	const timeout = configuredNotificationTimeout(options.timeoutEnv, options.defaultTimeoutSeconds);
	if (timeout) {
		args.push("--timeout", String(timeout));
	}

	const child = spawn(alerter, args, {
		detached: true,
		stdio: "ignore",
	});
	child.on("error", (error) => {
		options.onError?.(error);
	});
	child.unref();
	return true;
}

function reportNotificationResult(ctx: ExtensionContext, notified: boolean): boolean {
	if (!notified && !notificationState.missingAlerterWarned) {
		notificationState.missingAlerterWarned = true;
		ctx.ui.notify("Pi notifications are on, but alerter was not found.", "warning");
	}
	return notified;
}

export function notifyPiNeedsInput(ctx: ExtensionContext, title = "Pi needs input"): boolean {
	if (notificationState.suppressedInputNotifications > 0) {
		notificationState.suppressedInputNotifications--;
		return false;
	}
	if (!notificationsEnabled()) {
		return false;
	}

	return reportNotificationResult(ctx, sendAlerterNotification(ctx, {
		title,
		group: "pi-coding-agent-input",
		soundEnv: "PI_PERMISSION_SOUND",
		defaultSound: "Ping",
		timeoutEnv: "PI_PERMISSION_NOTIFICATION_TIMEOUT",
		defaultTimeoutSeconds: 15,
		onError: (error) => {
			ctx.ui.notify(`Could not send Pi notification: ${error.message}`, "warning");
		},
	}));
}

function notifySpecificInputRequest(ctx: ExtensionContext, title: string): boolean {
	const notified = notifyPiNeedsInput(ctx, title);
	suppressNextInputNotification();
	return notified;
}

export function notifyPiToolApproval(ctx: ExtensionContext): boolean {
	return notifySpecificInputRequest(ctx, "Pi: Tool Approval");
}

export function notifyPiWorkspaceIntegration(ctx: ExtensionContext): boolean {
	return notifySpecificInputRequest(ctx, "Pi: Workspace Integration");
}

export function notifyPiFinished(ctx: ExtensionContext, force = false): boolean {
	if (!notificationsEnabled() && !force) {
		return false;
	}

	return reportNotificationResult(ctx, sendAlerterNotification(ctx, {
		title: "Pi finished",
		group: "pi-coding-agent",
		soundEnv: "PI_COMPLETION_SOUND",
		defaultSound: "Glass",
		timeoutEnv: "PI_COMPLETION_NOTIFICATION_TIMEOUT",
		defaultTimeoutSeconds: 8,
		onError: (error) => {
			ctx.ui.notify(`Could not send Pi notification: ${error.message}`, "warning");
		},
	}));
}
