// Fixed owner-only command in an unsaved Pi process. Model/provider discovery
// and startup selection belong to Pi, not a second implementation in the server.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import { loadExtensionSettings } from "../extensions/shared/extension-settings";
import { resolveProjectTrust } from "../extensions/shared/project-trust";

export default function hostOptions(pi: ExtensionAPI): void {
  if (process.env.PI_CONSOLE_SERVICE !== "1") return;
  pi.registerCommand("pi-host-options", {
    description: "Read initialized host model options without starting a conversation",
    handler: async (args, ctx) => {
      if (args !== "directory-selected" && args !== "directory-required") throw new Error("Invalid host options request");
      const settings = loadExtensionSettings();
      const model = ctx.model;
      const modelStatus = args === "directory-required" ? "directory-required"
        : !ctx.isProjectTrusted() && resolveProjectTrust(ctx.cwd) === undefined ? "trust-required"
        : model ? undefined : "unavailable";
      const available = await ctx.modelRegistry.getAvailable();
      if (ctx.modelRegistry.getError()) throw new Error("Host model configuration is unavailable");
      // Explicit CLI choices may be valid custom IDs outside the catalog.
      const models = model && !available.some(option => option.provider === model.provider && option.id === model.id)
        ? [...available, model] : available;
      if (models.length > 10_000) throw new Error("Model count exceeds limit");
      const result = {
        models: models.map(model => ({ provider: model.provider, id: model.id,
          contextWindow: model.contextWindow, thinkingLevels: getSupportedThinkingLevels(model) })),
        defaults: {
          accessMode: settings["access-mode"]?.default ?? "ask",
          integrationMode: settings["integration-mode"]?.default ?? "ask",
          notificationsEnabled: settings.notifications?.default !== "disabled",
          ...(model && !modelStatus ? { model: { provider: model.provider, id: model.id },
            thinkingLevel: pi.getThinkingLevel(), contextWindow: model.contextWindow } : { modelStatus }),
        },
      };
      const output = JSON.stringify(result);
      if (Buffer.byteLength(output) > 1024 * 1024) throw new Error("Model metadata exceeds limit");
      ctx.ui.setStatus("pi-host-options-result", output);
    },
  });
}
