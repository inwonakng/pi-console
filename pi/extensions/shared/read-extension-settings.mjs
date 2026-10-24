import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import { parseDocument } from "yaml";

function requireMapping(value, path) {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${path} must be a mapping`);
	}
	return value;
}

function requireKnownKeys(value, keys, path) {
	for (const key of Object.keys(value)) {
		if (!keys.includes(key)) {
			throw new Error(`unknown setting ${path}.${key}`);
		}
	}
}

function requirePath(value, path) {
	if (typeof value !== "string" || !value.trim()
		|| !(isAbsolute(value) || value === "~" || value.startsWith("~/"))
		|| /[*?\[\]\0]/.test(value)) {
		throw new Error(`${path} must be an absolute or home-relative path without wildcards`);
	}
	return value;
}

// Read on demand so every extension sees edits without a watcher or reload cache.
// Add each new extension's section and validation here as it adopts this file.
export function readExtensionSettings(channel = process.env.PI_CONSOLE_CHANNEL) {
	const root = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
	if (!isAbsolute(root)) throw new Error("XDG_CONFIG_HOME must be absolute");
	const filename = channel === "dev" ? "config-dev.yaml" : "config.yaml";
	const path = join(root, "pi-console", filename);
	let source;
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
		const value = document.toJS();
		if (value === null && document.contents === null) return {};
		const root = requireMapping(value, "settings");
		requireKnownKeys(root, ["notifications", "access-mode", "integration-mode", "workspace", "auto-title", "session-picker", "server"], "settings");
		const settings = {};

		if (Object.hasOwn(root, "server")) {
			const server = requireMapping(root.server, "server");
			requireKnownKeys(server, ["port", "webui"], "server");
			settings.server = {};
			if (Object.hasOwn(server, "port")) {
				if (!Number.isInteger(server.port) || server.port < 1 || server.port > 65535) {
					throw new Error("server.port must be an integer between 1 and 65535");
				}
				settings.server.port = server.port;
			}
			if (Object.hasOwn(server, "webui")) {
				const webui = requireMapping(server.webui, "server.webui");
				requireKnownKeys(webui, ["enabled"], "server.webui");
				settings.server.webui = {};
				if (Object.hasOwn(webui, "enabled")) {
					if (typeof webui.enabled !== "boolean") throw new Error("server.webui.enabled must be a boolean");
					settings.server.webui.enabled = webui.enabled;
				}
			}
		}

		if (Object.hasOwn(root, "notifications")) {
			const notifications = requireMapping(root.notifications, "notifications");
			requireKnownKeys(notifications, ["default"], "notifications");
			settings.notifications = {};
			if (Object.hasOwn(notifications, "default")) {
				const value = notifications.default;
				if (value !== "enabled" && value !== "disabled") {
					throw new Error("notifications.default must be enabled or disabled");
				}
				settings.notifications.default = value;
			}
		}

		if (Object.hasOwn(root, "integration-mode")) {
			const integrationMode = requireMapping(root["integration-mode"], "integration-mode");
			requireKnownKeys(integrationMode, ["default"], "integration-mode");
			settings["integration-mode"] = {};
			if (Object.hasOwn(integrationMode, "default")) {
				const value = integrationMode.default;
				if (value !== "ask" && value !== "allowed") {
					throw new Error("integration-mode.default must be ask or allowed");
				}
				settings["integration-mode"].default = value;
			}
		}

		if (Object.hasOwn(root, "workspace")) {
			const workspace = requireMapping(root.workspace, "workspace");
			requireKnownKeys(workspace, ["auto-commit"], "workspace");
			settings.workspace = {};
			if (Object.hasOwn(workspace, "auto-commit")) {
				if (typeof workspace["auto-commit"] !== "boolean") throw new Error("workspace.auto-commit must be a boolean");
				settings.workspace["auto-commit"] = workspace["auto-commit"];
			}
		}

		if (Object.hasOwn(root, "access-mode")) {
			const accessMode = requireMapping(root["access-mode"], "access-mode");
			requireKnownKeys(accessMode, ["default", "read-paths", "write-paths", "temp-dir-prefix", "macos-denial-monitor"], "access-mode");
			const parsedAccessMode = {};
			if (Object.hasOwn(accessMode, "default")) {
				const value = accessMode.default;
				if (value !== "readonly" && value !== "ask" && value !== "edit" && value !== "full") {
					throw new Error("access-mode.default must be readonly, ask, edit, or full");
				}
				parsedAccessMode.default = value;
			}
			for (const key of ["read-paths", "write-paths"]) {
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
			if (Object.hasOwn(accessMode, "macos-denial-monitor")) {
				const monitor = accessMode["macos-denial-monitor"];
				if (typeof monitor !== "boolean") throw new Error("access-mode.macos-denial-monitor must be a boolean");
				parsedAccessMode["macos-denial-monitor"] = monitor;
			}
			settings["access-mode"] = parsedAccessMode;
		}

		if (Object.hasOwn(root, "auto-title")) {
			const autoTitle = requireMapping(root["auto-title"], "auto-title");
			requireKnownKeys(autoTitle, ["provider-models"], "auto-title");
			const parsedAutoTitle = {};
			if (Object.hasOwn(autoTitle, "provider-models")) {
				const providerModels = requireMapping(autoTitle["provider-models"], "auto-title.provider-models");
				const entries = Object.entries(providerModels).map(([provider, model]) => {
					if (!provider.trim() || provider !== provider.trim() || typeof model !== "string" || !model.trim()) {
						throw new Error(`auto-title.provider-models.${provider} must map a provider ID to a non-empty model ID`);
					}
					return [provider, model.trim()];
				});
				parsedAutoTitle["provider-models"] = Object.fromEntries(entries);
			}
			settings["auto-title"] = parsedAutoTitle;
		}

		if (Object.hasOwn(root, "session-picker")) {
			const sessionPicker = requireMapping(root["session-picker"], "session-picker");
			requireKnownKeys(sessionPicker, ["archive-after-days"], "session-picker");
			const parsedSessionPicker = {};
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
