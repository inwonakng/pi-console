import { readExtensionSettings, type ExtensionSettings } from "./read-extension-settings.mjs";
export type { ExtensionSettings } from "./read-extension-settings.mjs";

export function loadExtensionSettings(): ExtensionSettings {
	return readExtensionSettings();
}
