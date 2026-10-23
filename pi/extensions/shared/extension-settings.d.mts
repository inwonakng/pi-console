import type { AccessMode } from "./access-state.js";
import type { IntegrationMode } from "./integration-state.js";

export interface ExtensionSettings {
	notifications?: {
		default?: "enabled" | "disabled";
	};
	"integration-mode"?: {
		default?: IntegrationMode;
	};
	"access-mode"?: {
		default?: AccessMode;
		"read-paths"?: string[];
		"write-paths"?: string[];
		"temp-dir-prefix"?: string;
		"macos-denial-monitor"?: boolean;
	};
	"auto-title"?: {
		"provider-models"?: Record<string, string>;
	};
	"session-picker"?: {
		"archive-after-days"?: number;
	};
}

export function readExtensionSettings(agentDir: string): ExtensionSettings;
