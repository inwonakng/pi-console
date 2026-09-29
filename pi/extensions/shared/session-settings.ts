import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const SETTINGS_ENTRY_TYPE = "pi-console-settings";
const SETTINGS_VERSION = 1;

type StoredSetting = {
	version: number;
	name: string;
	value?: unknown;
};

export function loadSessionSetting(ctx: ExtensionContext, name: string): unknown {
	const branch = ctx.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry.type !== "custom" || entry.customType !== SETTINGS_ENTRY_TYPE) continue;
		const data = entry.data as StoredSetting | undefined;
		if (data?.version === SETTINGS_VERSION && data.name === name) return data.value;
	}
	return undefined;
}

export function saveSessionSetting(pi: ExtensionAPI, name: string, value: unknown): void {
	pi.appendEntry<StoredSetting>(SETTINGS_ENTRY_TYPE, {
		version: SETTINGS_VERSION,
		name,
		value,
	});
}
