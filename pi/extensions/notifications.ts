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
import { getPendingWorkspaceId } from "./shared/workspace";

function setStatus(ctx: ExtensionContext): void {
	ctx.ui.setStatus("pi-notifications", notificationsEnabled() ? "notify on" : "notify off");
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

	pi.on("session_start", (_event, ctx) => {
		setStatus(ctx);
	});

	pi.on("agent_end", (event) => {
		finalStopReason = lastAssistantMessage(event.messages || [])?.stopReason;
	});

	pi.on("ui_prompt_start", (_event, ctx) => {
		if (!ctx.isIdle()) {
			notifyPiNeedsInput(ctx);
		}
	});

	pi.on("agent_settled", (_event, ctx) => {
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

			const enabled = mode === "toggle" ? toggleNotificationsEnabled() : mode;
			if (mode !== "toggle") {
				setNotificationsEnabled(enabled);
			}
			setStatus(ctx);
			if (enabled && !alerterPath()) {
				ctx.ui.notify("Pi notifications: on, but alerter was not found", "warning");
			} else {
				ctx.ui.notify(`Pi notifications: ${enabled ? "on" : "off"}`, "info");
			}
		},
	});
}
