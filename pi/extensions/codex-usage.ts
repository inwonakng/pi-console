import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Buffer } from "node:buffer";

const PROVIDER = "openai-codex";
const STATUS_KEY = "pi-codex-usage";
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const REFRESH_INTERVAL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
const FIVE_HOURS_SECONDS = 5 * 60 * 60;
const WEEK_SECONDS = 7 * 24 * 60 * 60;
const JWT_CLAIM_PATH = "https://api.openai.com/auth";

type UsageWindow = {
	usedPercent: number;
	windowSeconds: number;
	resetsAt?: number;
};

type UsagePayload = {
	updatedAt?: number;
	stale: boolean;
	windows: {
		fiveHour?: UsageWindow;
		weekly?: UsageWindow;
	};
	error?: string;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function finiteNumber(value: unknown): number | undefined {
	const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
	return Number.isFinite(number) ? number : undefined;
}

function normalizeWindow(value: unknown): UsageWindow | undefined {
	const window = asRecord(value);
	if (!window) return undefined;

	const usedPercent = finiteNumber(window.used_percent ?? window.usedPercent);
	const windowSeconds = finiteNumber(
		window.limit_window_seconds ?? window.window_seconds ?? window.windowSeconds ?? window.limitWindowSeconds,
	);
	const resetsAt = finiteNumber(window.reset_at ?? window.resets_at ?? window.resetsAt);
	if (usedPercent === undefined || windowSeconds === undefined) return undefined;

	return {
		usedPercent: Math.min(100, Math.max(0, usedPercent)),
		windowSeconds,
		...(resetsAt === undefined ? {} : { resetsAt }),
	};
}

function parseUsageResponse(value: unknown): UsagePayload["windows"] {
	const response = asRecord(value);
	const rateLimit = asRecord(response?.rate_limit ?? response?.rateLimits);
	if (!rateLimit) return {};

	const windows = [
		normalizeWindow(rateLimit.primary_window ?? rateLimit.primary),
		normalizeWindow(rateLimit.secondary_window ?? rateLimit.secondary),
	].filter((window): window is UsageWindow => window !== undefined);

	return {
		fiveHour: windows.find((window) => window.windowSeconds === FIVE_HOURS_SECONDS),
		weekly: windows.find((window) => window.windowSeconds === WEEK_SECONDS),
	};
}

function accountIdFromToken(token: string): string {
	try {
		const parts = token.split(".");
		const payloadPart = parts[1];
		if (parts.length !== 3 || !payloadPart) throw new Error("invalid token");
		const payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8")) as Record<string, unknown>;
		const auth = asRecord(payload[JWT_CLAIM_PATH]);
		const accountId = auth?.chatgpt_account_id;
		if (typeof accountId !== "string" || accountId === "") throw new Error("missing account ID");
		return accountId;
	} catch {
		throw new Error("Could not read the ChatGPT account ID from Pi's OpenAI login");
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export default function codexUsageExtension(pi: ExtensionAPI) {
	let activeProvider: string | undefined;
	let latest: UsagePayload | undefined;
	let refreshInFlight: Promise<void> | undefined;
	let interval: ReturnType<typeof setInterval> | undefined;
	let sessionContext: ExtensionContext | undefined;

	function publish(ctx: ExtensionContext, payload?: UsagePayload): void {
		if (!sessionContext) return;
		ctx.ui.setStatus(STATUS_KEY, payload ? JSON.stringify(payload) : "");
	}

	async function fetchUsage(ctx: ExtensionContext): Promise<UsagePayload> {
		const auth = await ctx.modelRegistry.getProviderAuth(PROVIDER);
		const token = auth?.auth.apiKey;
		if (!token) throw new Error("OpenAI Codex is not logged in through Pi");

		const headers = new Headers();
		headers.set("Accept", "application/json");
		headers.set("Authorization", `Bearer ${token}`);
		headers.set("ChatGPT-Account-ID", accountIdFromToken(token));
		headers.set("originator", "pi");

		const response = await fetch(USAGE_URL, {
			headers,
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		if (!response.ok) {
			throw new Error(`Codex usage request failed (${response.status} ${response.statusText})`);
		}

		const windows = parseUsageResponse(await response.json());
		if (!windows.fiveHour && !windows.weekly) {
			throw new Error("Codex usage response did not include a 5-hour or weekly limit");
		}
		return {
			updatedAt: Math.floor(Date.now() / 1000),
			stale: false,
			windows,
		};
	}

	function refresh(ctx: ExtensionContext): Promise<void> {
		if (activeProvider !== PROVIDER) {
			publish(ctx);
			return Promise.resolve();
		}
		if (refreshInFlight) return refreshInFlight;

		refreshInFlight = fetchUsage(ctx)
			.then((payload) => {
				latest = payload;
				if (activeProvider === PROVIDER) publish(ctx, payload);
			})
			.catch((error) => {
				latest = {
					...(latest ?? { windows: {} }),
					stale: true,
					error: errorMessage(error),
				};
				if (activeProvider === PROVIDER) publish(ctx, latest);
			})
			.finally(() => {
				refreshInFlight = undefined;
			});
		return refreshInFlight;
	}

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "rpc") return;
		sessionContext = ctx;
		activeProvider = ctx.model?.provider;
		void refresh(ctx);
		if (interval) clearInterval(interval);
		interval = setInterval(() => {
			if (sessionContext) void refresh(sessionContext);
		}, REFRESH_INTERVAL_MS);
	});

	pi.on("model_select", (event, ctx) => {
		if (ctx.mode !== "rpc") return;
		activeProvider = event.model.provider;
		void refresh(ctx);
	});

	pi.on("agent_end", (_event, ctx) => {
		if (ctx.mode === "rpc") void refresh(ctx);
	});

	pi.on("session_shutdown", () => {
		if (interval) clearInterval(interval);
		interval = undefined;
		sessionContext = undefined;
	});

	pi.registerCommand("pi-codex-usage-refresh", {
		description: "Refresh OpenAI Codex usage limits",
		handler: async (_args, ctx) => {
			await refresh(ctx);
		},
	});
}
