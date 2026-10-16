import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { suppressNextInputNotification } from "./notifications";

// RPC has no prompt-purpose field, so use the existing structured-title format.
// Notifications and the frontend both recognize this explicit navigation marker.
export function selectNavigation(ctx: ExtensionContext, prompt: string, options: string[]): Promise<string | undefined> {
	if (ctx.mode === "tui") suppressNextInputNotification();
	const title = ctx.mode === "rpc"
		? JSON.stringify({ kind: "pi_compact_select", prompt, purpose: "navigation" })
		: prompt;
	return ctx.ui.select(title, options);
}

export function isNavigationPrompt(title: string | undefined): boolean {
	if (!title) return false;
	try {
		const payload: unknown = JSON.parse(title);
		return typeof payload === "object" && payload !== null
			&& "kind" in payload && payload.kind === "pi_compact_select"
			&& "prompt" in payload && typeof payload.prompt === "string"
			&& "purpose" in payload && payload.purpose === "navigation";
	} catch {
		return false;
	}
}
