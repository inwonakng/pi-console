export interface SubagentModelSetting {
	provider: string;
	model: string;
}

export interface ExtensionSettings {
	subagents?: {
		models?: Record<string, SubagentModelSetting>;
	};
	server?: {
		port?: number;
		webui?: { enabled?: boolean; "allowed-origins"?: string[] };
	};
	notifications?: {
		default?: "enabled" | "disabled";
	};
	workspace?: {
		"auto-commit"?: boolean;
	};
	"integration-mode"?: {
		default?: "ask" | "allowed";
	};
	"access-mode"?: {
		default?: "readonly" | "ask" | "edit" | "full";
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

export function readExtensionSettings(channel?: "stable" | "dev"): ExtensionSettings;
