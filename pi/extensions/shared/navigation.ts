import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

// RPC titles carry both notification policy and frontend navigation behavior.
export function selectNavigation(
	ctx: ExtensionContext,
	prompt: string,
	options: string[],
	previews?: Record<string, string>,
): Promise<string | undefined> {
	const title = JSON.stringify({ kind: "pi_compact_select", prompt, purpose: "navigation", notify: false, previews });
	return ctx.ui.select(title, options);
}
