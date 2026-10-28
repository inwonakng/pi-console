import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename } from "node:path";
import { DESKTOP_NOTIFICATION_STATUS, deliverDesktopNotification, type DesktopDelivery } from "./desktop-notification.mjs";
import { serviceManaged } from "./service-ui";

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
	options: Omit<DesktopDelivery, "body">,
): boolean {
	if (process.env.PI_SPAWN_AGENT === "1") {
		return false;
	}
	const notification = { id: randomUUID(), title: options.title, kind: options.kind, body: notificationBody(ctx).slice(0, 8192) };
	const published = serviceManaged(ctx);
	if (published) {
		// Private live signal: the owner consumes it before conversation reduction.
		// Publish even when this execution host has no desktop notifier installed.
		ctx.ui.setStatus(DESKTOP_NOTIFICATION_STATUS, JSON.stringify(notification));
	}
	return deliverDesktopNotification({ ...notification, onError: options.onError }) || published;
}

export function notifyPiNeedsInput(ctx: ExtensionContext, title = "Pi needs input", allowNotification = true): boolean {
	if (!allowNotification || !notificationsEnabled()) {
		return false;
	}

	return sendDesktopNotification(ctx, {
		title,
		kind: "input",
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
	return notifyPiOutcome(ctx, "Pi finished", "completion", force);
}

export function notifyPiError(ctx: ExtensionContext): boolean {
	return notifyPiOutcome(ctx, "Pi error", "error");
}

function notifyPiOutcome(ctx: ExtensionContext, title: string, kind: "completion" | "error", force = false): boolean {
	if (!notificationsEnabled() && !force) {
		return false;
	}

	return sendDesktopNotification(ctx, {
		title,
		kind,
		onError: (error) => {
			ctx.ui.notify(`Could not send Pi notification: ${error.message}`, "warning");
		},
	});
}
