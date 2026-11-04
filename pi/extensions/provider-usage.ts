import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Buffer } from "node:buffer";
import { registerServiceOperation } from "./shared/service-operation";

type UsageProvider = "openai-codex" | "anthropic";
const STATUS_KEY = "pi-provider-usage";
const USAGE_URLS = {
	"openai-codex": "https://chatgpt.com/backend-api/wham/usage",
	anthropic: "https://api.anthropic.com/api/oauth/usage",
};
const providerLabel = (provider: UsageProvider): string => provider === "anthropic" ? "Claude" : "Codex";
const usageProvider = (provider: string | undefined): UsageProvider | undefined =>
	provider === "openai-codex" || provider === "anthropic" ? provider : undefined;
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
	provider: UsageProvider;
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

function parseUsageResponse(value: unknown, provider: UsageProvider): UsagePayload["windows"] {
	const response = asRecord(value);
	if (provider === "anthropic") {
		const window = (value: unknown, windowSeconds: number): UsageWindow | undefined => {
			const record = asRecord(value);
			const usedPercent = finiteNumber(record?.utilization);
			if (usedPercent === undefined) return undefined;
			const resetsAt = typeof record?.resets_at === "string" ? Date.parse(record.resets_at) / 1000 : Number.NaN;
			return {
				usedPercent: Math.min(100, Math.max(0, usedPercent)),
				windowSeconds,
				...(Number.isFinite(resetsAt) ? { resetsAt } : {}),
			};
		};
		return {
			fiveHour: window(response?.five_hour, FIVE_HOURS_SECONDS),
			weekly: window(response?.seven_day, WEEK_SECONDS),
		};
	}
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

export default function providerUsageExtension(pi: ExtensionAPI) {
	let activeProvider: string | undefined;
	const latest = new Map<UsageProvider, UsagePayload>();
	const refreshInFlight = new Map<UsageProvider, Promise<void>>();
	const retryAt = new Map<UsageProvider, number>();
	let interval: ReturnType<typeof setInterval> | undefined;
	let sessionContext: ExtensionContext | undefined;

	function publish(ctx: ExtensionContext, payload?: UsagePayload): void {
		if (!sessionContext) return;
		ctx.ui.setStatus(STATUS_KEY, payload ? JSON.stringify(payload) : "");
	}

	async function fetchUsage(ctx: ExtensionContext, provider: UsageProvider): Promise<UsagePayload> {
		const auth = await ctx.modelRegistry.getProviderAuth(provider);
		const token = auth?.auth.apiKey;
		if (!token) throw new Error(`${providerLabel(provider)} is not logged in through Pi`);
		if (provider === "anthropic" && auth?.source !== "OAuth" && !token.startsWith("sk-ant-oat")) {
			throw new Error("Claude subscription usage is unavailable with an API key; log in through Pi with OAuth");
		}

		const headers = new Headers();
		headers.set("Accept", "application/json");
		headers.set("Authorization", `Bearer ${token}`);
		if (provider === "anthropic") {
			headers.set("anthropic-beta", "oauth-2025-04-20");
			headers.set("User-Agent", "pi-console");
		} else {
			headers.set("ChatGPT-Account-ID", accountIdFromToken(token));
			headers.set("originator", "pi");
		}

		const response = await fetch(USAGE_URLS[provider], {
			headers,
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		if (!response.ok) {
			if (response.status === 429) {
				const retryAfter = response.headers.get("retry-after");
				const seconds = retryAfter === null ? undefined : finiteNumber(retryAfter);
				const deadline = seconds === undefined ? Date.parse(retryAfter ?? "") : Date.now() + seconds * 1000;
				retryAt.set(provider, Math.max(Date.now() + REFRESH_INTERVAL_MS,
					Number.isFinite(deadline) ? deadline : Date.now() + 5 * REFRESH_INTERVAL_MS));
			}
			throw new Error(`${providerLabel(provider)} usage request failed (${response.status} ${response.statusText})`);
		}

		const windows = parseUsageResponse(await response.json(), provider);
		if (!windows.fiveHour && !windows.weekly) {
			throw new Error(`${providerLabel(provider)} usage response did not include a 5-hour or weekly limit`);
		}
		return {
			provider,
			updatedAt: Math.floor(Date.now() / 1000),
			stale: false,
			windows,
		};
	}

	function refresh(ctx: ExtensionContext): Promise<void> {
		const provider = usageProvider(activeProvider);
		if (!provider) {
			publish(ctx);
			return Promise.resolve();
		}
		const inFlight = refreshInFlight.get(provider);
		if (inFlight) return inFlight;
		if (Date.now() < (retryAt.get(provider) ?? 0)) {
			publish(ctx, latest.get(provider));
			return Promise.resolve();
		}

		const request = fetchUsage(ctx, provider)
			.then((payload) => {
				latest.set(provider, payload);
				if (activeProvider === provider) publish(ctx, payload);
			})
			.catch((error) => {
				const payload: UsagePayload = {
					...(latest.get(provider) ?? { provider, windows: {} }),
					stale: true,
					error: errorMessage(error),
				};
				latest.set(provider, payload);
				if (activeProvider === provider) publish(ctx, payload);
			})
			.finally(() => {
				refreshInFlight.delete(provider);
			});
		refreshInFlight.set(provider, request);
		return request;
	}

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "rpc") return;
		sessionContext = ctx;
		activeProvider = ctx.model?.provider;
		publish(ctx);
		void refresh(ctx);
		if (interval) clearInterval(interval);
		interval = setInterval(() => {
			if (sessionContext) void refresh(sessionContext);
		}, REFRESH_INTERVAL_MS);
	});

	pi.on("model_select", (event, ctx) => {
		if (ctx.mode !== "rpc") return;
		activeProvider = event.model.provider;
		const provider = usageProvider(activeProvider);
		publish(ctx, provider ? latest.get(provider) : undefined);
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

	registerServiceOperation(pi, "usage.refresh", async (_payload, ctx) => {
		const provider = usageProvider(activeProvider);
		if (!provider) return { changed: false, status: "not_applicable" };
		await refresh(ctx);
		if (latest.get(provider)?.stale) return;
		return { changed: true, status: "refreshed" };
	});

	for (const command of ["pi-usage-refresh", "pi-codex-usage-refresh"]) {
		pi.registerCommand(command, {
			description: "Refresh Claude or OpenAI Codex usage limits",
			handler: async (_args, ctx) => {
				await refresh(ctx);
			},
		});
	}
}
