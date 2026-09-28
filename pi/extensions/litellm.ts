import { createHash } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { getModels, getProviders } from "@earendil-works/pi-ai/compat";

const PROVIDER = "litellm";
const CACHE_FILENAME = "litellm-provider-models.json";
const OLD_CACHE_FILENAME = "litellm-models.json";
const DEFAULT_BASE_URL = "https://litellm.example.com";
const DEFAULT_DISCOVERY_TIMEOUT_MS = 5_000;
const LOGIN_DISCOVERY_TIMEOUT_MS = 10_000;
const RESPONSE_PROBE_TIMEOUT_MS = 8_000;
const RESPONSE_PROBE_VERSION = 2;
const CACHE_STALE_MS = 24 * 60 * 60 * 1000;
const RESPONSE_PROBE_CONCURRENCY = 3;
const PERMANENT_EXPIRES_AT = Number.MAX_SAFE_INTEGER;

type Api = "openai-completions" | "openai-responses";

type Cost = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
};

type ProviderModelConfig = {
	id: string;
	name: string;
	api?: Api;
	baseUrl?: string;
	reasoning: boolean;
	thinkingLevelMap?: Partial<Record<"off" | "minimal" | "low" | "medium" | "high" | "xhigh", string | null>>;
	input: ("text" | "image")[];
	cost: Cost;
	contextWindow: number;
	maxTokens: number;
	compat?: Record<string, unknown>;
};

type DiscoverySource = "model_info" | "models_list";

type ResponseProbeResult = {
	supported: boolean;
	probedAt: number;
	probeVersion?: number;
	status?: number;
	error?: string;
};

type Cache = {
	baseUrl: string;
	apiKeyFingerprint?: string;
	fetchedAt: number;
	probeVersion?: number;
	source: DiscoverySource;
	models: ProviderModelConfig[];
	responseProbes: Record<string, ResponseProbeResult>;
};

type LiteLLMCredentials = {
	type?: string;
	access?: string;
	refresh?: string;
	expires?: number;
	baseUrl?: string;
};

type ResolvedCredentials = {
	baseUrl?: string;
	apiKey?: string;
	apiKeyFingerprint?: string;
};

const DEFAULT_COST: Cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 16_384;

const KNOWN_MODELS: Record<string, Partial<ProviderModelConfig>> = {
	"azure/gpt-5.5": {
		name: "GPT-5.5",
		reasoning: true,
		thinkingLevelMap: { off: "none", xhigh: "xhigh", minimal: null },
		input: ["text", "image"],
		contextWindow: 272_000,
		maxTokens: 128_000,
		cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
	},
};

const ANTHROPIC_MODEL_PATTERN = /(?:^|[-_/.:])(?:anthropic\/|(?:claude|opus|sonnet|haiku)(?=$|[-_/.:]))/i;
const GPT_REASONING_PATTERN = /(?:^|[-_/])(?:gpt-5|o[134]|o1|o3|o4)(?:$|[-_/.:])/i;
const KNOWN_PROVIDER_SET = new Set(getProviders());

function agentDir(): string {
	try {
		return getAgentDir();
	} catch {
		return process.env.PI_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	}
}

function authPath(): string {
	return join(agentDir(), "auth.json");
}

function cachePath(): string {
	return join(agentDir(), CACHE_FILENAME);
}

function oldCachePath(): string {
	return join(agentDir(), OLD_CACHE_FILENAME);
}

function normalizeBaseUrl(input: string): string {
	return input.trim().replace(/\/+$/, "").replace(/\/v1\/?$/i, "");
}

function fingerprint(value: string | undefined): string | undefined {
	if (!value) return undefined;
	return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function cleanConfig(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed && trimmed !== "undefined" ? trimmed : undefined;
}

async function readJsonFile<T>(path: string): Promise<T | undefined> {
	try {
		return JSON.parse(await readFile(path, "utf8")) as T;
	} catch {
		return undefined;
	}
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
	await mkdir(join(path, ".."), { recursive: true });
	await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function removeOldLiteLLMCache(): Promise<void> {
	try {
		await unlink(oldCachePath());
	} catch {
		// Best-effort cleanup. The homemade provider uses CACHE_FILENAME instead.
	}
}

async function readAuthEntry(): Promise<LiteLLMCredentials | undefined> {
	const auth = await readJsonFile<Record<string, LiteLLMCredentials>>(authPath());
	return auth?.[PROVIDER];
}

async function resolveCredentials(): Promise<ResolvedCredentials> {
	const entry = await readAuthEntry();
	const envBaseUrl = cleanConfig(process.env.LITELLM_BASE_URL);
	const envApiKey = cleanConfig(process.env.LITELLM_API_KEY);
	const authBaseUrl = entry?.type === "oauth" && entry.baseUrl ? normalizeBaseUrl(entry.baseUrl) : undefined;
	const authApiKey = entry?.type === "oauth" ? cleanConfig(entry.access) : undefined;
	const apiKey = authApiKey ?? envApiKey;
	return {
		baseUrl: authBaseUrl ?? (envBaseUrl ? normalizeBaseUrl(envBaseUrl) : undefined),
		apiKey,
		apiKeyFingerprint: fingerprint(apiKey),
	};
}

function discoveryTimeoutMs(): number {
	const raw = process.env.LITELLM_DISCOVERY_TIMEOUT_MS;
	if (raw === undefined) return DEFAULT_DISCOVERY_TIMEOUT_MS;
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_DISCOVERY_TIMEOUT_MS;
}

function isOffline(): boolean {
	return process.env.LITELLM_OFFLINE === "1" || process.env.PI_OFFLINE === "1";
}

function isListModelsMode(): boolean {
	return process.argv.includes("--list-models");
}

function cacheIsFresh(cache: Cache | undefined): cache is Cache {
	return Boolean(cache && cache.probeVersion === RESPONSE_PROBE_VERSION && Date.now() - cache.fetchedAt <= CACHE_STALE_MS);
}

function withTimeout(timeoutMs: number, signal?: AbortSignal): { signal: AbortSignal; cancel: () => void } {
	const controller = new AbortController();
	const abort = () => controller.abort(signal?.reason);
	if (signal) {
		if (signal.aborted) controller.abort(signal.reason);
		else signal.addEventListener("abort", abort, { once: true });
	}
	const timer = setTimeout(() => controller.abort(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
	return {
		signal: controller.signal,
		cancel: () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
		},
	};
}

async function fetchJson(url: string, apiKey: string, options: { timeoutMs: number; signal?: AbortSignal }) {
	const { signal, cancel } = withTimeout(options.timeoutMs, options.signal);
	try {
		const response = await fetch(url, {
			headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
			signal,
		});
		if (!response.ok) return { ok: false as const, status: response.status };
		return { ok: true as const, data: await response.json() };
	} finally {
		cancel();
	}
}

async function postJson(url: string, apiKey: string, body: unknown, options: { timeoutMs: number; signal?: AbortSignal }) {
	const { signal, cancel } = withTimeout(options.timeoutMs, options.signal);
	try {
		const response = await fetch(url, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				Accept: "application/json",
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
			signal,
		});
		let data: unknown;
		try {
			data = await response.json();
		} catch {
			data = undefined;
		}
		return { ok: response.ok, status: response.status, data };
	} finally {
		cancel();
	}
}

function toKnownProvider(provider: string | undefined): string | undefined {
	if (!provider) return undefined;
	const normalized = provider.toLowerCase();
	return KNOWN_PROVIDER_SET.has(normalized) ? normalized : undefined;
}

function lookupIds(id: string): string[] {
	const values = new Set([id]);
	if (id.includes("/")) values.add(id.slice(id.indexOf("/") + 1));
	return [...values];
}

function findCatalogModel(id: string, ownedBy?: string): Partial<ProviderModelConfig> | undefined {
	const exactKnown = KNOWN_MODELS[id.toLowerCase()];
	if (exactKnown) return exactKnown;

	const prefixProvider = toKnownProvider(id.split("/")[0]);
	const candidateProviders = [toKnownProvider(ownedBy), prefixProvider].filter((p): p is string => Boolean(p));
	for (const provider of candidateProviders) {
		for (const lookupId of lookupIds(id)) {
			const model = getModels(provider).find((m) => m.id === lookupId || m.id === `${provider}/${lookupId}`);
			if (model) return model as Partial<ProviderModelConfig>;
		}
	}
	return undefined;
}

function compatForModel(id: string): Record<string, unknown> {
	if (ANTHROPIC_MODEL_PATTERN.test(id)) return { supportsStore: false, cacheControlFormat: "anthropic" };
	return { supportsStore: false };
}

function costFromModelInfo(info: Record<string, unknown>, fallback?: Cost): Cost {
	const number = (key: string) => (typeof info[key] === "number" ? (info[key] as number) : undefined);
	return {
		input: number("input_cost_per_token") !== undefined ? number("input_cost_per_token")! * 1_000_000 : (fallback?.input ?? 0),
		output: number("output_cost_per_token") !== undefined ? number("output_cost_per_token")! * 1_000_000 : (fallback?.output ?? 0),
		cacheRead:
			number("cache_read_input_token_cost") !== undefined
				? number("cache_read_input_token_cost")! * 1_000_000
				: (fallback?.cacheRead ?? 0),
		cacheWrite:
			number("cache_creation_input_token_cost") !== undefined
				? number("cache_creation_input_token_cost")! * 1_000_000
				: (fallback?.cacheWrite ?? 0),
	};
}

function modelFromInfo(entry: Record<string, unknown>): ProviderModelConfig | undefined {
	const id = typeof entry.model_name === "string" ? entry.model_name : undefined;
	if (!id) return undefined;
	const info = (entry.model_info && typeof entry.model_info === "object" ? entry.model_info : {}) as Record<string, unknown>;
	if (typeof info.mode === "string" && info.mode !== "chat") return undefined;
	const catalog = findCatalogModel(id);
	return {
		id,
		name: catalog?.name ?? id,
		reasoning: Boolean(info.supports_reasoning ?? catalog?.reasoning ?? GPT_REASONING_PATTERN.test(id)),
		thinkingLevelMap: catalog?.thinkingLevelMap,
		input: info.supports_vision ? ["text", "image"] : (catalog?.input ?? ["text"]),
		cost: costFromModelInfo(info, catalog?.cost),
		contextWindow: typeof info.max_input_tokens === "number" ? info.max_input_tokens : (catalog?.contextWindow ?? DEFAULT_CONTEXT_WINDOW),
		maxTokens: typeof info.max_output_tokens === "number" ? info.max_output_tokens : (catalog?.maxTokens ?? DEFAULT_MAX_TOKENS),
		compat: compatForModel(id),
	};
}

function modelFromList(entry: Record<string, unknown>): ProviderModelConfig | undefined {
	const id = typeof entry.id === "string" ? entry.id : undefined;
	if (!id) return undefined;
	const ownedBy = typeof entry.owned_by === "string" ? entry.owned_by : undefined;
	const catalog = findCatalogModel(id, ownedBy);
	return {
		id,
		name: catalog?.name ?? id,
		reasoning: Boolean(catalog?.reasoning ?? GPT_REASONING_PATTERN.test(id)),
		thinkingLevelMap: catalog?.thinkingLevelMap,
		input: catalog?.input ?? ["text"],
		cost: catalog?.cost ?? DEFAULT_COST,
		contextWindow: catalog?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
		maxTokens: catalog?.maxTokens ?? DEFAULT_MAX_TOKENS,
		compat: compatForModel(id),
	};
}

async function discoverModels(baseUrl: string, apiKey: string, options: { timeoutMs: number; signal?: AbortSignal }) {
	const base = normalizeBaseUrl(baseUrl);
	const infoResult = await fetchJson(`${base}/model/info`, apiKey, options);
	if (infoResult.ok) {
		const data = Array.isArray((infoResult.data as { data?: unknown[] }).data) ? (infoResult.data as { data: unknown[] }).data : [];
		return {
			source: "model_info" as const,
			models: data.map((entry) => modelFromInfo(entry as Record<string, unknown>)).filter((m): m is ProviderModelConfig => Boolean(m)),
		};
	}
	if (![401, 403, 404].includes(infoResult.status)) {
		throw new Error(`/model/info returned ${infoResult.status}`);
	}

	const listResult = await fetchJson(`${base}/v1/models`, apiKey, options);
	if (!listResult.ok) throw new Error(`/v1/models returned ${listResult.status}`);
	const data = Array.isArray((listResult.data as { data?: unknown[] }).data) ? (listResult.data as { data: unknown[] }).data : [];
	return {
		source: "models_list" as const,
		models: data.map((entry) => modelFromList(entry as Record<string, unknown>)).filter((m): m is ProviderModelConfig => Boolean(m)),
	};
}

function valueContainsFunctionCall(value: unknown): boolean {
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	if (record.type === "function_call" || record.type === "tool_call") return true;
	for (const nested of Object.values(record)) {
		if (Array.isArray(nested)) {
			if (nested.some(valueContainsFunctionCall)) return true;
		} else if (valueContainsFunctionCall(nested)) {
			return true;
		}
	}
	return false;
}

function parseSseData(line: string): unknown | undefined {
	if (!line.startsWith("data:")) return undefined;
	const data = line.slice(5).trim();
	if (!data || data === "[DONE]") return undefined;
	try {
		return JSON.parse(data);
	} catch {
		return undefined;
	}
}

async function probeResponsesModel(baseUrl: string, apiKey: string, modelId: string, signal?: AbortSignal): Promise<ResponseProbeResult> {
	const probedAt = Date.now();
	try {
		const { signal: timeoutSignal, cancel } = withTimeout(RESPONSE_PROBE_TIMEOUT_MS, signal);
		try {
			const response = await fetch(`${normalizeBaseUrl(baseUrl)}/v1/responses`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${apiKey}`,
					Accept: "text/event-stream, application/json",
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					model: modelId,
					input: [
						{
							role: "user",
							content: [
								{
									type: "input_text",
									text: "Call the probe_responses_capability function now with ok=true. Do not answer in text.",
								},
							],
						},
					],
					tools: [
						{
							type: "function",
							name: "probe_responses_capability",
							description: "Report that Responses streaming function calls work.",
							strict: false,
							parameters: {
								type: "object",
								properties: { ok: { type: "boolean" } },
								required: ["ok"],
								additionalProperties: false,
							},
						},
					],
					tool_choice: { type: "function", name: "probe_responses_capability" },
					stream: true,
					store: false,
					max_output_tokens: 64,
				}),
				signal: timeoutSignal,
			});

			if (!response.ok) {
				const text = await response.text().catch(() => "");
				return {
					supported: false,
					probedAt,
					probeVersion: RESPONSE_PROBE_VERSION,
					status: response.status,
					error: text.slice(0, 300),
				};
			}
			if (!response.body) {
				return { supported: false, probedAt, probeVersion: RESPONSE_PROBE_VERSION, status: response.status, error: "streaming response had no body" };
			}

			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = "";
			let sawFunctionCall = false;
			let sawCompleted = false;
			while (!sawCompleted) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split(/\r?\n/);
				buffer = lines.pop() ?? "";
				for (const line of lines) {
					const event = parseSseData(line);
					if (!event) continue;
					if (valueContainsFunctionCall(event)) sawFunctionCall = true;
					const type = (event as { type?: unknown }).type;
					if (type === "response.completed" || type === "response.done") sawCompleted = true;
					if (type === "response.failed" || type === "error") {
						return { supported: false, probedAt, probeVersion: RESPONSE_PROBE_VERSION, status: response.status, error: JSON.stringify(event).slice(0, 300) };
					}
				}
			}

			return {
				supported: sawFunctionCall && sawCompleted,
				probedAt,
				probeVersion: RESPONSE_PROBE_VERSION,
				status: response.status,
				error: sawFunctionCall ? undefined : "streaming Responses probe did not produce a function call",
			};
		} finally {
			cancel();
		}
	} catch (error) {
		return {
			supported: false,
			probedAt,
			probeVersion: RESPONSE_PROBE_VERSION,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

function cachedProbeIsFresh(probe: ResponseProbeResult | undefined): probe is ResponseProbeResult {
	return Boolean(probe && probe.probeVersion === RESPONSE_PROBE_VERSION && Date.now() - probe.probedAt <= CACHE_STALE_MS);
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	async function worker() {
		while (next < items.length) {
			const index = next++;
			results[index] = await fn(items[index]);
		}
	}
	await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
	return results;
}

async function applyResponsesRouting(
	baseUrl: string,
	apiKey: string,
	models: ProviderModelConfig[],
	cachedProbes: Record<string, ResponseProbeResult> | undefined,
	options: { forceProbe?: boolean; signal?: AbortSignal } = {},
): Promise<{ models: ProviderModelConfig[]; responseProbes: Record<string, ResponseProbeResult> }> {
	const responseProbes: Record<string, ResponseProbeResult> = { ...(cachedProbes ?? {}) };
	const toProbe = options.forceProbe ? models : models.filter((model) => !cachedProbeIsFresh(responseProbes[model.id]));
	await mapWithConcurrency(toProbe, RESPONSE_PROBE_CONCURRENCY, async (model) => {
		responseProbes[model.id] = await probeResponsesModel(baseUrl, apiKey, model.id, options.signal);
	});

	return {
		responseProbes,
		models: models.map((model) => {
			const usesResponses = responseProbes[model.id]?.supported === true;
			return {
				...model,
				api: usesResponses ? "openai-responses" : "openai-completions",
				reasoning: usesResponses ? true : model.reasoning,
				compat: { supportsStore: false, ...(model.compat ?? {}) },
			};
		}),
	};
}

async function discoverAndCache(
	baseUrl: string,
	apiKey: string,
	options: { timeoutMs: number; signal?: AbortSignal; forceProbe?: boolean },
): Promise<Cache> {
	const previous = await readJsonFile<Cache>(cachePath());
	const discovered = await discoverModels(baseUrl, apiKey, { timeoutMs: options.timeoutMs, signal: options.signal });
	const routed = await applyResponsesRouting(
		baseUrl,
		apiKey,
		discovered.models,
		previous?.baseUrl === baseUrl && previous.apiKeyFingerprint === fingerprint(apiKey) ? previous.responseProbes : undefined,
		{ forceProbe: options.forceProbe, signal: options.signal },
	);
	const cache: Cache = {
		baseUrl,
		apiKeyFingerprint: fingerprint(apiKey),
		fetchedAt: Date.now(),
		probeVersion: RESPONSE_PROBE_VERSION,
		source: discovered.source,
		models: routed.models,
		responseProbes: routed.responseProbes,
	};
	await writeJsonFile(cachePath(), cache);
	return cache;
}

async function loadUsableCache(creds: ResolvedCredentials): Promise<Cache | undefined> {
	const cache = await readJsonFile<Cache>(cachePath());
	if (!cache || !creds.baseUrl || cache.baseUrl !== creds.baseUrl) return undefined;
	if (cache.apiKeyFingerprint && creds.apiKeyFingerprint && cache.apiKeyFingerprint !== creds.apiKeyFingerprint) return undefined;
	return cache;
}

function modelBaseUrl(baseUrl: string | undefined): string {
	return `${normalizeBaseUrl(baseUrl ?? DEFAULT_BASE_URL)}/v1`;
}

export default async function (pi: ExtensionAPI) {
	await removeOldLiteLLMCache();

	let creds = await resolveCredentials();
	let models: ProviderModelConfig[] = [];
	let startupWarning: string | undefined;
	const startupCache = await loadUsableCache(creds);
	const shouldUseFreshCache = cacheIsFresh(startupCache) && !isListModelsMode();

	if (shouldUseFreshCache) {
		models = startupCache.models;
	} else if (creds.baseUrl && creds.apiKey && !isOffline() && discoveryTimeoutMs() > 0) {
		try {
			const cache = await discoverAndCache(creds.baseUrl, creds.apiKey, { timeoutMs: discoveryTimeoutMs() });
			models = cache.models;
		} catch (error) {
			startupWarning = error instanceof Error ? error.message : String(error);
			models = startupCache?.models ?? [];
			process.stderr.write(
				startupCache
					? `LiteLLM: discovery failed (${startupWarning}); using cached models.\n`
					: `LiteLLM: discovery failed (${startupWarning}); registering provider with no models.\n`,
			);
		}
	} else {
		models = startupCache?.models ?? [];
	}

	const oauth = {
		name: "LiteLLM",
		login: async (callbacks: any) => {
			const rawBaseUrl = (await callbacks.onPrompt({
				message: "Enter LiteLLM proxy URL (no trailing /v1):",
				placeholder: "https://litellm.example.com",
			})).trim();
			const apiKey = (await callbacks.onPrompt({ message: "Enter LiteLLM API key:" })).trim();
			if (!rawBaseUrl || !apiKey) throw new Error("Base URL and API key are required");

			const baseUrl = normalizeBaseUrl(rawBaseUrl);
			callbacks.onProgress?.("Discovering LiteLLM models and probing Responses support...");
			const cache = await discoverAndCache(baseUrl, apiKey, {
				timeoutMs: LOGIN_DISCOVERY_TIMEOUT_MS,
				signal: callbacks.signal,
				forceProbe: true,
			});
			models = cache.models;
			creds = { baseUrl, apiKey, apiKeyFingerprint: fingerprint(apiKey) };
			registerProvider(baseUrl, models);
			callbacks.onProgress?.(
				`LiteLLM: ${models.length} models discovered; ${models.filter((m) => m.api === "openai-responses").length} use Responses.`,
			);
			return { access: apiKey, refresh: "", expires: PERMANENT_EXPIRES_AT, baseUrl };
		},
		refreshToken: async (credentials: any) => credentials,
		getApiKey: (credentials: any) => credentials.access,
		modifyModels: (modelsToModify: any[], credentials: any) => {
			const baseUrl = credentials?.baseUrl ? normalizeBaseUrl(credentials.baseUrl) : undefined;
			if (!baseUrl) return modelsToModify;
			return modelsToModify.map((model) => (model.provider === PROVIDER ? { ...model, baseUrl: `${baseUrl}/v1` } : model));
		},
	};

	function registerProvider(baseUrl: string | undefined, nextModels: ProviderModelConfig[]) {
		pi.registerProvider(PROVIDER, {
			name: "LiteLLM",
			baseUrl: modelBaseUrl(baseUrl),
			apiKey: "$LITELLM_API_KEY",
			api: "openai-completions",
			models: nextModels,
			oauth,
		});
	}

	registerProvider(creds.baseUrl, models);

	async function runRefresh(forceProbe = true) {
		const fresh = await resolveCredentials();
		if (!fresh.baseUrl || !fresh.apiKey) throw new Error("no credentials. Run /login and choose LiteLLM, or set LITELLM_BASE_URL and LITELLM_API_KEY.");
		const cache = await discoverAndCache(fresh.baseUrl, fresh.apiKey, {
			timeoutMs: discoveryTimeoutMs() || LOGIN_DISCOVERY_TIMEOUT_MS,
			forceProbe,
		});
		creds = fresh;
		models = cache.models;
		registerProvider(fresh.baseUrl, models);
		return cache;
	}

	pi.registerCommand("litellm-refresh", {
		description: "Re-discover LiteLLM models and probe Responses API support.",
		handler: async (_args, ctx) => {
			if (isOffline()) {
				ctx.ui.notify("LiteLLM refresh disabled by offline mode", "warning");
				return;
			}
			try {
				const cache = await runRefresh(true);
				await ctx.modelRegistry.refresh();
				ctx.ui.notify(
					`LiteLLM: ${cache.models.length} models refreshed; ${cache.models.filter((m) => m.api === "openai-responses").length} use Responses.`,
					"info",
				);
			} catch (error) {
				ctx.ui.notify(`LiteLLM refresh failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});

	pi.on("session_start", (_event, ctx) => {
		if (startupWarning) ctx.ui.notify(`LiteLLM discovery warning: ${startupWarning}`, "warning");
	});
}
