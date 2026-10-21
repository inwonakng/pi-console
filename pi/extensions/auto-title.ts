import { registerServiceOperation } from "./shared/service-operation";
import { serviceRuntimeId, serviceUi } from "./shared/service-ui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadExtensionSettings } from "./shared/extension-settings";

const TITLE_LIMIT = 80;
const TITLE_MAX_TOKENS = 800;
const TITLE_TIMEOUT_MS = 60_000;
const LABEL_ENTRY = "pi-session-label";
type SessionLabel = { title: string; slug?: string };
const TITLE_SYSTEM_PROMPT = [
	'You generate conversation labels. Output ONLY a JSON object: {"title":"...","slug":"..."}.',
	"Generate a brief title that would help the user find this conversation later.",
	"Also generate a concise slug for a narrow terminal tab: 1–4 lowercase words joined by single hyphens.",
	"The slug must capture the topic, not just copy the first four words of the title. Use only letters, numbers, and hyphens.",
	"Example output: {\"title\":\"Cleaning up Zotero library tags\",\"slug\":\"zotero-tag-cleanup\"}",
	"No Markdown fences or text outside the JSON object. The title must be:",
	"- A single line",
	"- ≤80 characters",
	"- No explanations",
	"- you MUST use the same language as the user message you are summarizing",
	"- Title must be grammatically correct and read naturally",
	"- no word salad",
	"- Never include tool names in the title (e.g. \"read tool\", \"bash tool\", \"edit tool\")",
	"- Focus on the main topic or question the user needs to retrieve",
	"- Vary your phrasing - avoid repetitive patterns like always starting with \"Analyzing\"",
	"- When a file is mentioned, focus on WHAT the user wants to do WITH the file, not just that they shared it",
	"- Keep exact: technical terms, numbers, filenames, HTTP codes",
	"- Remove: the, this, my, a, an",
	"- Never assume tech stack",
	"- Never use tools",
	"- NEVER respond to questions, just generate a title for the conversation",
	"- The title should NEVER include \"summarizing\" or \"generating\" when generating a title",
	"- DO NOT SAY YOU CANNOT GENERATE A TITLE OR COMPLAIN ABOUT THE INPUT",
	"- Always output something meaningful, even if the input is minimal.",
	"- If the user message is short or conversational (e.g. \"hello\", \"lol\", \"what's up\", \"hey\"):",
	"  → create a title that reflects the user's tone or intent (such as Greeting, Quick check-in, Light chat, Intro message, etc.)",
	"\"debug 500 errors in production\" → Debugging production 500 errors",
	"\"refactor user service\" → Refactoring user service",
	"\"why is app.js failing\" → app.js failure investigation",
	"\"implement rate limiting\" → Rate limiting implementation",
	"\"how do I connect postgres to my API\" → Postgres API connection",
	"\"best practices for React hooks\" → React hooks best practices",
	"\"@src/auth.ts can you add refresh token support\" → Auth refresh token support",
	"\"@utils/parser.ts this is broken\" → Parser bug fix",
	"\"look at @config.json\" → Config review",
	"\"@App.tsx add dark mode toggle\" → Dark mode toggle in App",
].join("\n");

function titleModel(ctx: ExtensionContext) {
	const provider = ctx.model?.provider;
	if (!provider) throw new Error("No active provider for title generation");

	const providerModels = loadExtensionSettings()["auto-title"]?.["provider-models"];
	const configuredId = providerModels && Object.hasOwn(providerModels, provider) ? providerModels[provider] : undefined;
	const available = ctx.modelRegistry.getAvailable()
		.filter((model) => model.provider === provider && model.input.includes("text"));
	if (configuredId) {
		const model = available.find((candidate) => candidate.id === configuredId);
		if (!model) {
			throw new Error(
				`Configured title model ${provider}/${configuredId} is not an available text model; check auto-title.provider-models in pi-console-config.yaml`,
			);
		}
		return model;
	}

	// Equal input/output token weighting. Catalog prices may not reflect subscription quotas.
	const candidates = available.filter((model) =>
		Number.isFinite(model.cost.input) && model.cost.input >= 0
		&& Number.isFinite(model.cost.output) && model.cost.output >= 0,
	);
	candidates.sort((a, b) =>
		(a.cost.input + a.cost.output) - (b.cost.input + b.cost.output) || a.id.localeCompare(b.id),
	);
	const model = candidates[0];
	if (!model) {
		throw new Error(
			`No available text model with catalog pricing for ${provider}; configure auto-title.provider-models in pi-console-config.yaml`,
		);
	}
	return model;
}

function isPromptTitleCandidate(text: string) {
	const trimmed = text.trim();
	return trimmed !== "" && !trimmed.startsWith("/") && !trimmed.startsWith("!") && !trimmed.startsWith("#");
}

function normalizeWhitespace(text: string) {
	return text.replace(/\s+/g, " ").trim();
}

function stripLeadingCommandLanguage(text: string) {
	return text
		.replace(/^(can you|could you|please|pls|hey|hi|hello)[,:\s]+/i, "")
		.replace(/^(implement|create|build|add|fix|debug|review|explain)\s+(me\s+)?/i, "$1 ");
}

function deterministicTitle(text: string) {
	const normalized = stripLeadingCommandLanguage(normalizeWhitespace(text))
		.replace(/[.?!:;,]+$/g, "")
		.trim();
	if (normalized.length <= TITLE_LIMIT) {
		return normalized || "New session";
	}
	return `${normalized.slice(0, TITLE_LIMIT - 3).trimEnd()}...`;
}

function cleanTitle(text: string, limit = TITLE_LIMIT) {
	return normalizeWhitespace(text)
		.replace(/^["'`*_]+|["'`*_]+$/g, "")
		.replace(/^(title|session title)\s*[:\-]\s*/i, "")
		.replace(/[.?!:;,]+$/g, "")
		.slice(0, limit)
		.trim();
}

function validSlug(value: unknown): value is string {
	return typeof value === "string" && value === value.toLowerCase()
		&& /^[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+){0,3}$/u.test(value);
}

function cleanModelLabel(text: string): SessionLabel | undefined {
	const content = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim()
		.replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i, "$1");
	let value: unknown;
	try { value = JSON.parse(content); } catch { return undefined; }
	if (!value || typeof value !== "object" || !("title" in value) || !("slug" in value)
		|| typeof value.title !== "string" || !validSlug(value.slug)) return undefined;
	const title = cleanTitle(value.title);
	return title ? { title, slug: value.slug } : undefined;
}

function savedLabel(ctx: ExtensionContext, title: string | undefined): SessionLabel | undefined {
	// Labels, like Pi session names, are session-wide rather than branch-local.
	const entries = ctx.sessionManager.getEntries();
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type !== "custom" || entry.customType !== LABEL_ENTRY) continue;
		const data = entry.data;
		if (data && typeof data === "object" && "title" in data && data.title === title
			&& typeof data.title === "string" && "slug" in data && validSlug(data.slug)) {
			return { title: data.title, slug: data.slug };
		}
		return undefined;
	}
}

function titleUserPrompt(text: string) {
	return `Generate a title and short slug for this conversation:\n${text.slice(0, 1200)}`;
}

function previewText(value: unknown, limit = 160) {
	if (typeof value !== "string") {
		return undefined;
	}
	const normalized = normalizeWhitespace(value);
	if (!normalized) {
		return undefined;
	}
	return normalized.length > limit ? `${normalized.slice(0, limit - 3).trimEnd()}...` : normalized;
}

function messageText(message: unknown) {
	if (!message || typeof message !== "object") {
		return "";
	}
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") {
		return content;
	}
	if (Array.isArray(content)) {
		return content
			.map((item) => {
				if (typeof item === "string") {
					return item;
				}
				if (item && typeof item === "object" && "type" in item && item.type === "text" && "text" in item) {
					const text = item.text;
					return typeof text === "string" ? text : "";
				}
				return "";
			})
			.join("");
	}
	return "";
}

function branchUserMessages(ctx: ExtensionContext) {
	return ctx.sessionManager
		.getBranch()
		.flatMap((entry) => entry.type === "message" && entry.message.role === "user" ? [messageText(entry.message)] : [])
		.filter((text) => text.trim() !== "");
}

function branchUserMessagesWithEvent(ctx: ExtensionContext, message: unknown) {
	const messages = branchUserMessages(ctx);
	const text = messageText(message);
	if (text.trim() !== "" && !messages.includes(text)) {
		messages.push(text);
	}
	return messages;
}

async function modelTitle(prompt: string, ctx: ExtensionContext, sessionSignal: AbortSignal) {
	const model = titleModel(ctx);
	const signal = AbortSignal.any([sessionSignal, AbortSignal.timeout(TITLE_TIMEOUT_MS)]);
	const response = await ctx.modelRegistry.complete(
		model,
		{
			systemPrompt: TITLE_SYSTEM_PROMPT,
			messages: [{ role: "user", content: titleUserPrompt(prompt), timestamp: Date.now() }],
		},
		{
			maxTokens: Math.min(TITLE_MAX_TOKENS, model.maxTokens),
			cacheRetention: "none",
			signal,
		},
	);
	signal.throwIfAborted();
	if (response.stopReason === "error" || response.stopReason === "aborted") {
		throw new Error(`Title request to ${model.provider}/${model.id} failed: ${response.errorMessage || response.stopReason}`);
	}

	const content = messageText(response);
	const label = cleanModelLabel(content);
	if (!label) {
		throw new Error(
			`Title response from ${model.provider}/${model.id} did not contain a valid title and 1–4-word lowercase slug; stop_reason=${response.stopReason}; content=${previewText(content) || "<empty>"}`,
		);
	}
	return label;
}

function publishLabel(ctx: ExtensionContext, label: SessionLabel | undefined) {
	// Structured metadata is for the RPC frontend, not the terminal footer.
	if (ctx.mode === "rpc") {
		ctx.ui.setStatus(LABEL_ENTRY, JSON.stringify({ sessionFile: ctx.sessionManager.getSessionFile(), ...label }));
	}
}

function setTitle(pi: ExtensionAPI, ctx: ExtensionContext, title: string, slug?: string) {
	pi.setSessionName(title);
	// An explicit rename or fallback without a slug also invalidates an old one.
	const label = { title, slug };
	pi.appendEntry<SessionLabel>(LABEL_ENTRY, label);
	ctx.ui.setTitle(`Pi - ${title}`);
	ctx.ui.setStatus("pi-session-title", title);
	publishLabel(ctx, label);
}

export default function autoTitleExtension(pi: ExtensionAPI) {
	let titleGenerationInFlightForSession: string | undefined;
	let sessionController = new AbortController();

	pi.on("session_shutdown", () => {
		sessionController.abort();
	});

	pi.on("session_start", (_event, ctx) => {
		sessionController.abort();
		sessionController = new AbortController();
		titleGenerationInFlightForSession = undefined;
		const title = pi.getSessionName();
		publishLabel(ctx, savedLabel(ctx, title));
		if (title) {
			ctx.ui.setTitle(`Pi - ${title}`);
			ctx.ui.setStatus("pi-session-title", title);
		}
	});

	pi.on("message_end", (event, ctx) => {
		if (event.message.role !== "user" || pi.getSessionName()) {
			return undefined;
		}

		const userMessages = branchUserMessagesWithEvent(ctx, event.message);
		if (userMessages.length !== 1 || !isPromptTitleCandidate(userMessages[0])) {
			return undefined;
		}

		const currentSessionKey = () => ctx.sessionManager.getSessionFile() || "ephemeral";
		const sessionKey = currentSessionKey();
		if (titleGenerationInFlightForSession === sessionKey) {
			return undefined;
		}
		titleGenerationInFlightForSession = sessionKey;

		const prompt = userMessages[0];
		ctx.ui.setStatus("pi-session-title", "Generating title…");

		const signal = sessionController.signal;
		void modelTitle(prompt, ctx, signal)
			.then((label) => {
				if (signal.aborted || currentSessionKey() !== sessionKey || pi.getSessionName()) {
					return;
				}
				setTitle(pi, ctx, label.title, label.slug);
			})
			.catch((error: unknown) => {
				if (signal.aborted) return;
				if (currentSessionKey() === sessionKey && !pi.getSessionName()) {
					setTitle(pi, ctx, deterministicTitle(prompt));
				}
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Could not generate model session title: ${message}`, "warning");
			})
			.finally(() => {
				if (!signal.aborted && titleGenerationInFlightForSession === sessionKey) {
					titleGenerationInFlightForSession = undefined;
				}
			});

		return undefined;
	});

	// A fixed, managed-only capability. Legacy slash commands retain their UI and
	// normalization behavior; only this path promises a correlated terminal result.
	if (process.env.PI_CONSOLE_SERVICE === "1") pi.registerCommand("pi-console-rename", {
		description: "Internal managed session rename",
		handler: async (args, ctx) => {
			const request: unknown = JSON.parse(args);
			if (ctx.mode !== "rpc" || !request || typeof request !== "object" || Array.isArray(request)) {
				throw new Error("Invalid managed rename request");
			}
			const value = request as Record<string, unknown>;
			if (value.version !== 1 || ![value.invocationId, value.runtimeId, value.sessionId, value.sessionFile]
				.every((part) => typeof part === "string" && !!part)
				|| !Object.keys(value).every((key) => ["version", "invocationId", "runtimeId", "sessionId", "sessionFile", "title"].includes(key))) {
				throw new Error("Invalid managed rename identity");
			}
			const ui = ctx.ui;
			const identity = { version: 1, invocationId: value.invocationId, runtimeId: value.runtimeId,
				sessionId: value.sessionId, sessionFile: value.sessionFile };
			const reply = (outcome: { status: "completed"; title: string }
				| { status: "failed"; code: "invalid_title" | "context_unavailable" }
				| { status: "uncertain"; code: "mutation_failed" }) => {
				ui.setStatus("pi-console-rename-result", JSON.stringify({ ...identity, ...outcome }));
			};
			// Keep these input bounds in step with server/src/session-rename.ts.
			if (typeof value.title !== "string" || !value.title.trim() || Buffer.byteLength(value.title) > 4096
				|| /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value.title)) {
				reply({ status: "failed", code: "invalid_title" });
				return;
			}
			const title = cleanTitle(value.title);
			if (!title) { reply({ status: "failed", code: "invalid_title" }); return; }
			if (serviceRuntimeId(ctx) !== value.runtimeId || ctx.sessionManager.getSessionId() !== value.sessionId
				|| ctx.sessionManager.getSessionFile() !== value.sessionFile || !ctx.isIdle()) {
				reply({ status: "failed", code: "context_unavailable" });
				return;
			}
			// No await between the last context check and the synchronous writes.
			// setTitle writes more than one entry: a thrown error may be partial.
			try { setTitle(pi, ctx, title); }
			catch { reply({ status: "uncertain", code: "mutation_failed" }); return; }
			reply({ status: "completed", title });
		},
	});

	pi.registerCommand("pi-title", {
		description: "Set the current session title: /pi-title <title>",
		handler: async (args, ctx) => {
			const title = cleanTitle(args);
			if (!title) {
				ctx.ui.notify("Usage: /pi-title <title>", "warning");
				return;
			}
			setTitle(pi, ctx, title);
		},
	});

	const retitle = async (ctx: ExtensionContext): Promise<{ title: string } | undefined> => {
			const prompt = branchUserMessages(ctx).slice(0, 3).join("\n\n");
			if (!prompt) {
				ctx.ui.notify("No user messages to title.", "warning");
				return;
			}

			const signal = sessionController.signal;
			const originalTitle = pi.getSessionName();
			let label: Awaited<ReturnType<typeof modelTitle>>;
			try {
				label = await modelTitle(prompt, ctx, signal);
			} catch (error) {
				if (signal.aborted) return;
				let fallback: string | undefined;
				if (!pi.getSessionName()) {
					setTitle(pi, ctx, deterministicTitle(prompt));
					fallback = pi.getSessionName();
				}
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Could not generate model session title: ${message}`, "warning");
				return fallback ? { title: fallback } : undefined;
			}
			if (signal.aborted || pi.getSessionName() !== originalTitle) return;
			setTitle(pi, ctx, label.title, label.slug);
			return { title: pi.getSessionName()! };
	};
	registerServiceOperation(pi, "title.generate", (_payload, ctx) => retitle(ctx));
	pi.registerCommand("pi-retitle", {
		description: "Regenerate the current session title and short tab slug using the title model",
		handler: async (_args, ctx) => {
			const prompt = branchUserMessages(ctx).slice(0, 3).join("\n\n");
			if (!prompt) {
				ctx.ui.notify("No user messages to title.", "warning");
				return;
			}

			const signal = sessionController.signal;
			const originalTitle = pi.getSessionName();
			try {
				const label = await modelTitle(prompt, ctx, signal);
				if (!signal.aborted && pi.getSessionName() === originalTitle) setTitle(pi, ctx, label.title, label.slug);
			} catch (error) {
				if (signal.aborted) return;
				if (!pi.getSessionName()) setTitle(pi, ctx, deterministicTitle(prompt));
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Could not generate model session title: ${message}`, "warning");
			}
		},
	});

	pi.registerCommand("pi-rename", {
		description: "Rename the current session",
		handler: async (args, ctx) => {
			let title = cleanTitle(args);
			if (!title) {
				const value = await serviceUi(ctx).input(
					JSON.stringify({ kind: "pi_input", prompt: "Rename Session: ", notify: false }),
					pi.getSessionName() || "",
				);
				title = cleanTitle(value || "");
			}
			if (!title) {
				return;
			}
			setTitle(pi, ctx, title);
		},
	});
}
