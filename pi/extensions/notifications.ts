import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	alerterPath,
	notificationsEnabled,
	notifyPiFinished,
	notifyPiNeedsInput,
	parseNotificationMode,
	setNotificationsEnabled,
	toggleNotificationsEnabled,
} from "./shared/notifications";
import { loadSessionSetting, saveSessionSetting } from "./shared/session-settings";
import { loadExtensionSettings } from "./shared/extension-settings";
import { getPendingWorkspaceId } from "./shared/workspace";
import { isNavigationPrompt } from "./shared/navigation";

const NOTIFICATIONS_SETTING = "notifications";

function setStatus(ctx: ExtensionContext): void {
	ctx.ui.setStatus("pi-notifications", notificationsEnabled() ? "notify on" : "notify off");
}

function restoreNotifications(ctx: ExtensionContext): void {
	const stored = loadSessionSetting(ctx, NOTIFICATIONS_SETTING);
	setNotificationsEnabled(typeof stored === "boolean"
		? stored
		: loadExtensionSettings().notifications?.default !== "disabled");
	setStatus(ctx);
}

function lastAssistantMessage(messages: unknown[]): { stopReason?: string } | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (typeof message === "object" && message !== null && "role" in message && message.role === "assistant") {
			return message as { stopReason?: string };
		}
	}
	return undefined;
}

export default function notificationsExtension(pi: ExtensionAPI) {
	let finalStopReason: string | undefined;
	let questionNotification: { toolCallId: string; notified: boolean } | undefined;

	pi.on("session_start", (_event, ctx) => {
		questionNotification = undefined;
		restoreNotifications(ctx);
	});

	pi.on("session_tree", (_event, ctx) => {
		questionNotification = undefined;
		restoreNotifications(ctx);
	});

	// Unlike execution-start events, tool_call runs after a nested call's queue
	// wait. A queued question must not absorb an earlier tool's approval prompt.
	pi.on("tool_call", (event) => {
		if (event.toolName === "question") {
			questionNotification = { toolCallId: event.toolCallId, notified: false };
		}
	});

	pi.on("tool_execution_end", (event) => {
		if (event.toolCallId === questionNotification?.toolCallId) {
			questionNotification = undefined;
		}
	});

	pi.on("agent_end", (event) => {
		finalStopReason = lastAssistantMessage(event.messages || [])?.stopReason;
	});

	pi.on("ui_prompt_start", (event, ctx) => {
		if (isNavigationPrompt(event.title)) return;
		const notified = notifyPiNeedsInput(ctx, undefined, !questionNotification?.notified);
		if (questionNotification && notified) questionNotification.notified = true;
	});

	pi.on("agent_settled", (_event, ctx) => {
		questionNotification = undefined;
		const stopReason = finalStopReason;
		finalStopReason = undefined;
		if (!stopReason || stopReason === "error" || getPendingWorkspaceId()) {
			return;
		}
		notifyPiFinished(ctx);
	});

	pi.registerCommand("pi-notify", {
		description: "Toggle desktop notifications for Pi completion and requests for user input: /pi-notify [on|off|toggle|test]",
		handler: async (args, ctx) => {
			if (args.trim().toLowerCase() === "test") {
				if (notifyPiFinished(ctx, true)) {
					ctx.ui.notify("Sent Pi test notification", "info");
				}
				return;
			}

			const mode = parseNotificationMode(args);
			if (mode === undefined) {
				ctx.ui.notify("Usage: /pi-notify [on|off|toggle|test]", "warning");
				return;
			}

			const wasEnabled = notificationsEnabled();
			const enabled = mode === "toggle" ? toggleNotificationsEnabled() : mode;
			if (mode !== "toggle") {
				setNotificationsEnabled(enabled);
			}
			if (enabled !== wasEnabled) saveSessionSetting(pi, NOTIFICATIONS_SETTING, enabled);
			setStatus(ctx);
			if (enabled && !alerterPath()) {
				ctx.ui.notify("Pi notifications: on, but alerter was not found", "warning");
			} else {
				ctx.ui.notify(`Pi notifications: ${enabled ? "on" : "off"}`, "info");
			}
		},
	});
}
