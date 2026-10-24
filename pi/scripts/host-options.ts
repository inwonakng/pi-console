// Fixed owner-only metadata command in an unsaved Pi process. Resource discovery
// and startup selection belong to Pi, including its normal project trust gate.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import { loadExtensionSettings } from "../extensions/shared/extension-settings";
import { resolveProjectTrust } from "../extensions/shared/project-trust";
import { modelReady } from "../extensions/shared/model-readiness";

export default function hostOptions(pi: ExtensionAPI): void {
  if (process.env.PI_CONSOLE_SERVICE !== "1") return;
  pi.registerCommand("pi-host-options", {
    description: "Read initialized host options and commands without starting a conversation",
    handler: async (args, ctx) => {
      if (args !== "directory-selected" && args !== "directory-required") throw new Error("Invalid host options request");
      const settings = loadExtensionSettings();
      const model = modelReady(ctx) ? ctx.model : undefined;
      const modelStatus = args === "directory-required" ? "directory-required"
        : !ctx.isProjectTrusted() && resolveProjectTrust(ctx.cwd) === undefined ? "trust-required"
        : model ? undefined : "unavailable";
      const available = ctx.modelRegistry.getAvailable();
      if (ctx.modelRegistry.getError()) throw new Error("Host model configuration is unavailable");
      // Explicit CLI choices may be valid custom IDs outside the catalog.
      const models = model && !available.some(option => option.provider === model.provider && option.id === model.id)
        ? [...available, model] : available;
      if (models.length > 10_000) throw new Error("Model count exceeds limit");
      // Enumerate initialized resources only; never dispatch a discovered command.
      const commands = pi.getCommands().filter(command => command.name !== "pi-host-options");
      if (commands.length > 10_000) throw new Error("Command count exceeds limit");
      const result = {
        commands: commands.map(command => ({ name: command.name, source: command.source,
          ...(command.description !== undefined && { description: command.description }),
          sourceInfo: { path: command.sourceInfo.path, source: command.sourceInfo.source,
            scope: command.sourceInfo.scope, origin: command.sourceInfo.origin,
            ...(command.sourceInfo.baseDir !== undefined && { baseDir: command.sourceInfo.baseDir }) } })),
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
      if (Buffer.byteLength(output) > 1024 * 1024) throw new Error("Host metadata exceeds limit");
      ctx.ui.setStatus("pi-host-options-result", output);
    },
  });
}
