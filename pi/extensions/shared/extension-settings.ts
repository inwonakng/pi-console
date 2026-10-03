import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { parseDocument } from "yaml";

export interface ExtensionSettings {
	"access-mode"?: {
		"read-paths"?: string[];
		"write-paths"?: string[];
		"temp-dir-prefix"?: string;
	};
	"auto-title"?: {
		"provider-models"?: Record<string, string>;
	};
	"session-picker"?: {
		"archive-after-days"?: number;
	};
}

function requireMapping(value: unknown, path: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${path} must be a mapping`);
	}
	return value as Record<string, unknown>;
}

function requireKnownKeys(value: Record<string, unknown>, keys: string[], path: string) {
	for (const key of Object.keys(value)) {
		if (!keys.includes(key)) {
			throw new Error(`unknown setting ${path}.${key}`);
		}
	}
}

function requirePath(value: unknown, path: string): string {
	if (typeof value !== "string" || !value.trim()
		|| !(isAbsolute(value) || value === "~" || value.startsWith("~/"))
		|| /[*?\[\]\0]/.test(value)) {
		throw new Error(`${path} must be an absolute or home-relative path without wildcards`);
	}
	return value;
}

// Read on demand so every extension sees edits without a watcher or reload cache.
// Add each new extension's section and validation here as it adopts this file.
export function loadExtensionSettings(): ExtensionSettings {
	const path = join(getAgentDir(), "pi-console-config.yaml");
	let source: string;
	try {
		source = readFileSync(path, "utf8");
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
			return {};
		}
		throw error;
	}

	try {
		const document = parseDocument(source);
		const problem = document.errors[0] ?? document.warnings[0];
		if (problem) throw problem;
		const value: unknown = document.toJS();
		if (value === null && document.contents === null) return {};
		const root = requireMapping(value, "settings");
		requireKnownKeys(root, ["access-mode", "auto-title", "session-picker"], "settings");
		const settings: ExtensionSettings = {};

		if (Object.hasOwn(root, "access-mode")) {
			const accessMode = requireMapping(root["access-mode"], "access-mode");
			requireKnownKeys(accessMode, ["read-paths", "write-paths", "temp-dir-prefix"], "access-mode");
			const parsedAccessMode: NonNullable<ExtensionSettings["access-mode"]> = {};
			for (const key of ["read-paths", "write-paths"] as const) {
				if (!Object.hasOwn(accessMode, key)) continue;
				const paths = accessMode[key];
				if (!Array.isArray(paths)) throw new Error(`access-mode.${key} must be a list of paths`);
				parsedAccessMode[key] = paths.map((value, index) => requirePath(value, `access-mode.${key}[${index}]`));
			}
			if (Object.hasOwn(accessMode, "temp-dir-prefix")) {
				const prefix = requirePath(accessMode["temp-dir-prefix"], "access-mode.temp-dir-prefix");
				if (prefix.endsWith("/")) throw new Error("access-mode.temp-dir-prefix must include a directory-name prefix, for example /tmp/pi-console-");
				parsedAccessMode["temp-dir-prefix"] = prefix;
			}
			settings["access-mode"] = parsedAccessMode;
		}

		if (Object.hasOwn(root, "auto-title")) {
			const autoTitle = requireMapping(root["auto-title"], "auto-title");
			requireKnownKeys(autoTitle, ["provider-models"], "auto-title");
			const parsedAutoTitle: NonNullable<ExtensionSettings["auto-title"]> = {};
			if (Object.hasOwn(autoTitle, "provider-models")) {
				const providerModels = requireMapping(autoTitle["provider-models"], "auto-title.provider-models");
				const entries = Object.entries(providerModels).map(([provider, model]) => {
					if (!provider.trim() || provider !== provider.trim() || typeof model !== "string" || !model.trim()) {
						throw new Error(`auto-title.provider-models.${provider} must map a provider ID to a non-empty model ID`);
					}
					return [provider, model.trim()] as const;
				});
				parsedAutoTitle["provider-models"] = Object.fromEntries(entries);
			}
			settings["auto-title"] = parsedAutoTitle;
		}

		if (Object.hasOwn(root, "session-picker")) {
			const sessionPicker = requireMapping(root["session-picker"], "session-picker");
			requireKnownKeys(sessionPicker, ["archive-after-days"], "session-picker");
			const parsedSessionPicker: NonNullable<ExtensionSettings["session-picker"]> = {};
			if (Object.hasOwn(sessionPicker, "archive-after-days")) {
				const archiveAfterDays = sessionPicker["archive-after-days"];
				if (typeof archiveAfterDays !== "number" || !Number.isInteger(archiveAfterDays) || archiveAfterDays <= 0) {
					throw new Error("session-picker.archive-after-days must be a positive integer");
				}
				parsedSessionPicker["archive-after-days"] = archiveAfterDays;
			}
			settings["session-picker"] = parsedSessionPicker;
		}

		return settings;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Invalid extension settings in ${path}: ${message}`);
	}
}
