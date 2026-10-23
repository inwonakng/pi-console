import { parseArgs, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { clampThinkingLevel } from "@earendil-works/pi-ai";

type Model = NonNullable<ExtensionContext["model"]>;
type ThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;
type Selection = { provider: string; id: string; model?: Model; thinkingLevel?: ThinkingLevel; exactThinking?: boolean };
type Readiness = { ready: boolean; requested?: Selection; reason?: "unavailable" | "refresh-failed" | "selection-failed" };
type PendingSelection = { file: string; selection: Selection };

export const MODEL_READINESS_STATUS = "pi-console-model-readiness";

// Only plain selection data crosses replacement; old Pi APIs/contexts never do.
const key = Symbol.for("pi-console.model-readiness");
const globals = globalThis as typeof globalThis & {
  [key]?: { pending?: PendingSelection; results: WeakMap<ExtensionContext["sessionManager"], Readiness> };
};
const state = globals[key] ??= { results: new WeakMap() };

function validModel(model: ExtensionContext["model"]): model is Model {
  return !!model && model.provider !== "unknown" && model.id !== "unknown" && model.api !== "unknown";
}
function selectedModel(ctx: ExtensionContext): Selection | undefined {
  return validModel(ctx.model) ? { provider: ctx.model.provider, id: ctx.model.id,
    model: structuredClone(ctx.model), thinkingLevel: ctx.thinkingLevel, exactThinking: true } : undefined;
}
function thinkingLevel(value: string | undefined): ThinkingLevel | undefined {
  return value && ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value)
    ? value as ThinkingLevel : undefined;
}

/** Preserve this workspace transition only, including explicit custom models. */
export function preserveModelForSwitch(ctx: ExtensionContext): () => void {
  const file = ctx.sessionManager.getSessionFile();
  const selection = selectedModel(ctx);
  const pending = file && selection ? { file, selection } : undefined;
  state.pending = pending;
  return () => { if (state.pending === pending) state.pending = undefined; };
}

function initialSelection(pi: ExtensionAPI, ctx: ExtensionContext): Selection | undefined {
  const current = selectedModel(ctx);
  const args = parseArgs(process.argv.slice(2));
  // Native CLI resolution owns fuzzy references and custom IDs. Never guess a
  // settings default over an explicit selection that Pi could not resolve.
  if (args.model || args.provider) {
    if (current) return current;
    return args.provider && args.model ? { provider: args.provider, id: args.model, thinkingLevel: args.thinking } : undefined;
  }
  const projection = ctx.sessionManager.buildSessionProjection();
  if (projection.messages.length) {
    // A registered virtual selection holds over the physical model's replies.
    const change = [...ctx.sessionManager.getBranch()].reverse().find(entry => entry.type === "model_change");
    const saved = change?.type === "model_change" && ctx.modelRegistry.find(change.provider, change.modelId)?.api === "pi-virtual"
      ? { provider: change.provider, modelId: change.modelId } : projection.model;
    return saved && saved.provider !== "unknown" && saved.modelId !== "unknown"
      ? { provider: saved.provider, id: saved.modelId, thinkingLevel: args.thinking ?? thinkingLevel(projection.thinkingLevel) } : undefined;
  }
  const settings = pi.getSettings();
  const scoped = ctx.scopedModels.find(option => option.model.provider === settings.defaultProvider && option.model.id === settings.defaultModel)
    ?? ctx.scopedModels[0];
  if (scoped) {
    if (current?.provider === scoped.model.provider && current.id === scoped.model.id) return current;
    return { provider: scoped.model.provider, id: scoped.model.id, model: structuredClone(scoped.model),
      thinkingLevel: args.thinking ?? scoped.thinkingLevel ?? settings.modelThinkingLevels?.[`${scoped.model.provider}/${scoped.model.id}`] ?? settings.defaultThinkingLevel };
  }
  // An unresolved scope must not silently become the configured default.
  if (args.models?.length || settings.enabledModels?.length) return undefined;
  if (settings.defaultProvider && settings.defaultModel) {
    if (current?.provider === settings.defaultProvider && current.id === settings.defaultModel) return current;
    return { provider: settings.defaultProvider, id: settings.defaultModel,
      thinkingLevel: args.thinking ?? settings.modelThinkingLevels?.[`${settings.defaultProvider}/${settings.defaultModel}`] ?? settings.defaultThinkingLevel };
  }
  return current;
}

/** One local provider refresh and exact reselection; never sends model work. */
export async function initializeModelReadiness(pi: ExtensionAPI, ctx: ExtensionContext, signal: AbortSignal): Promise<Readiness> {
  if (signal.aborted) return { ready: false, reason: "unavailable" };
  const pending = state.pending;
  if (pending) state.pending = undefined;
  const previous = selectedModel(ctx);
  let requested: Selection | undefined;
  let result: Readiness = { ready: false, reason: "unavailable" };
  try {
    requested = pending && pending.file === ctx.sessionManager.getSessionFile() ? pending.selection : initialSelection(pi, ctx);
    result.requested = requested;
    if (requested) {
      result.reason = "refresh-failed";
      const refreshed = await ctx.modelRegistry.refresh({ providers: [requested.provider], allowNetwork: false, signal });
      if (signal.aborted) return result;
      if (!refreshed.aborted && !refreshed.errors.has(requested.provider) && !ctx.modelRegistry.getError()) {
        result.reason = "unavailable";
        const model = ctx.modelRegistry.find(requested.provider, requested.id) ?? requested.model;
        if (validModel(model) && ctx.modelRegistry.hasConfiguredAuth(model)) {
          result.reason = "selection-failed";
          if (await pi.setModel(model)) {
            if (signal.aborted) return result;
            const level = requested.thinkingLevel && (requested.exactThinking ? requested.thinkingLevel : clampThinkingLevel(model, requested.thinkingLevel));
            if (level) pi.setThinkingLevel(level);
            const selected = ctx.model;
            if (validModel(selected) && selected.provider === requested.provider && selected.id === requested.id
                && (!level || pi.getThinkingLevel() === level) && ctx.modelRegistry.hasConfiguredAuth(selected)) result = { ready: true, requested };
          }
        }
      }
    }
  } catch {
    // Provider errors can contain credentials; diagnostics keep only the stage.
  }
  if (signal.aborted) return result;
  state.results.set(ctx.sessionManager, result);
  ctx.ui.setStatus(MODEL_READINESS_STATUS, result.ready ? "ready" : "unavailable");
  pi.appendEntry("pi-model-readiness", { version: 1, ready: result.ready, reason: result.reason,
    requested: requested && { provider: requested.provider, id: requested.id },
    previous: previous && { provider: previous.provider, id: previous.id },
    selected: validModel(ctx.model) ? { provider: ctx.model.provider, id: ctx.model.id } : undefined });
  return result;
}

export function modelReady(ctx: ExtensionContext): boolean {
  const selected = ctx.model;
  if (process.env.PI_CONSOLE_SERVICE !== "1") return validModel(selected) && ctx.modelRegistry.hasConfiguredAuth(selected);
  const result = state.results.get(ctx.sessionManager);
  return result?.ready === true && validModel(selected) && selected.provider === result.requested?.provider
    && selected.id === result.requested.id && ctx.modelRegistry.hasConfiguredAuth(selected);
}

/** A later, explicit native model selection can recover a stopped runtime. */
export function recordModelSelection(ctx: ExtensionContext): void {
  const requested = selectedModel(ctx);
  state.results.set(ctx.sessionManager, { ready: !!requested, requested });
  ctx.ui.setStatus(MODEL_READINESS_STATUS, requested ? "ready" : "unavailable");
}
