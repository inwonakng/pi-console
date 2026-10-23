import { createHash } from "node:crypto";
import { lstatSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { parseDocument } from "yaml";

const mapping = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const digest = (value) => createHash("sha256").update(value).digest("hex");
function load(path, privateState) {
	const inspect = privateState ? lstatSync : statSync;
	let file;
	try { file = inspect(path); }
	catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
	const directory = inspect(dirname(path));
	const privateMode = (stat) => stat.uid === process.getuid?.() && !(stat.mode & 0o077);
	if (!file.isFile() || !directory.isDirectory()
		|| privateState && (!privateMode(file) || !privateMode(directory))) {
		throw new Error("Frontend store has invalid ownership or permissions: " + path);
	}
	return readFileSync(path, "utf8");
}

/** Read-only counterpart of frontend-store/service-hosts. Reload on every call. */
export function readHostRegistry(channel) {
	if (channel !== "stable" && channel !== "dev") throw new Error("Invalid frontend channel");
	const config = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
	const state = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
	if (!isAbsolute(config) || !isAbsolute(state)) throw new Error("Frontend XDG roots must be absolute");
	const source = load(join(config, "pi-console", channel === "dev" ? "hosts-dev.yaml" : "hosts.yaml"), false);
	let data = { version: 1, hosts: [] };
	if (source !== undefined) {
		const document = parseDocument(source);
		const problem = document.errors[0] ?? document.warnings[0];
		if (problem) throw problem;
		data = document.toJS();
	}
	const pinsSource = load(join(state, "pi-console", "frontend", channel, "host-identities.json"), true);
	const pins = pinsSource === undefined ? {} : JSON.parse(pinsSource);
	if (!mapping(pins) || Object.values(pins).some((identity) => typeof identity !== "string" || !identity)) {
		throw new Error("Invalid saved host identities");
	}
	if (!mapping(data) || data.version !== 1 || !Array.isArray(data.hosts)) throw new Error("Invalid hosts file");
	const seen = new Set();
	return data.hosts.map((target) => {
		if (!mapping(target)
			|| target.remote !== undefined && (typeof target.remote !== "string" || !target.remote.trim())
			|| target.root !== undefined && (typeof target.root !== "string" || !isAbsolute(target.root) || target.root.includes("\0"))
			|| target.remote !== undefined && target.root !== undefined
			|| target.alias !== undefined && (typeof target.alias !== "string" || /[\x00-\x1f\x7f]/.test(target.alias))
			|| target.enabled !== undefined && typeof target.enabled !== "boolean"
			|| target.host_id !== undefined && (typeof target.host_id !== "string" || !target.host_id)) {
			throw new Error("Invalid host entry");
		}
		if (target.remote !== undefined) {
			const url = new URL(target.remote);
			if (url.protocol !== "http:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
				throw new Error("Remote endpoint must be an HTTP origin without user info, path, query or fragment");
			}
		}
		const pinKey = target.remote === undefined && target.root === undefined ? "local"
			: "endpoint:" + digest(JSON.stringify([target.remote || "", target.root || ""]));
		if (seen.has(pinKey)) throw new Error("Duplicate configured endpoint");
		seen.add(pinKey);
		return {
			key: "host-" + digest(pinKey),
			alias: target.alias?.trim() ? target.alias : target.remote || target.root || "localhost",
			enabled: target.enabled !== false,
			hostId: Object.hasOwn(pins, pinKey) ? pins[pinKey] : target.host_id,
			remote: target.remote,
			root: target.root,
		};
	});
}
