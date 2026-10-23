import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readExtensionSettings, type ExtensionSettings } from "./read-extension-settings.mjs";
export type { ExtensionSettings } from "./read-extension-settings.mjs";

export function loadExtensionSettings(): ExtensionSettings {
	return readExtensionSettings(getAgentDir());
}
