import { join } from "node:path";
import { PiProcess, type PiExit } from "./pi-process.js";
import type { HostResources } from "./host-resources.js";
import { object } from "./pi-records.js";
import { CommandError } from "./session-commands.js";

const MAX_BYTES = 1024 * 1024;
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
type ThinkingLevel = typeof THINKING_LEVELS[number];
type ModelIdentity = { provider: string; id: string };
export type HostOptions = {
  models: (ModelIdentity & { contextWindow: number; thinkingLevels: ThinkingLevel[] })[];
  defaults: {
    accessMode?: "readonly" | "ask" | "edit" | "full";
    integrationMode?: "ask" | "allowed";
    notificationsEnabled?: boolean;
    model?: ModelIdentity;
    thinkingLevel?: ThinkingLevel;
    contextWindow?: number;
    modelStatus?: "trust-required" | "unavailable" | "directory-required";
  };
};
function modelIdentity(value: unknown): value is ModelIdentity & Record<string, unknown> {
  return object(value) && typeof value.provider === "string" && value.provider.length > 0 && Buffer.byteLength(value.provider) <= 1024
    && typeof value.id === "string" && value.id.length > 0 && Buffer.byteLength(value.id) <= 1024;
}
function validContextWindow(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
export class OptionsHelperUnresolved extends Error {}

/** Ask a normally initialized, unsaved Pi worker under the host resource fence.
 * The fixed command reads metadata only; no prompt is sent to a model. */
export async function readHostOptions(resources: HostResources, environment: NodeJS.ProcessEnv,
  input: { cwd?: string; provider?: string; model?: string }, assertExecutionAllowed: () => void): Promise<HostOptions> {
  let worker: PiProcess | undefined;
  let value: unknown;
  let received = false;
  let deadline: NodeJS.Timeout | undefined;
  try {
    worker = new PiProcess({ binary: resources.binary, appRoot: resources.appRoot, cwd: input.cwd ?? resources.root,
      sessionDirectory: join(resources.root, "sessions"), workspaceRoot: join(resources.root, "workspaces"),
      session: { id: "host-options" }, environment, provider: input.provider, model: input.model, hostOptionsHelper: true,
      assertExecutionAllowed, onExit: () => {}, onEvent: event => {
        if (event.type !== "extension_ui_request" || event.method !== "setStatus" || event.statusKey !== "pi-host-options-result") return;
        if (received || typeof event.statusText !== "string" || Buffer.byteLength(event.statusText) > MAX_BYTES) {
          throw new Error("Invalid host model options");
        }
        received = true;
        value = JSON.parse(event.statusText);
      } });
    const helper = worker;
    deadline = setTimeout(() => { void helper.stop(); }, 30_000);
    await worker.ready();
    const commands = await worker.request({ type: "get_commands" });
    if (commands.command !== "get_commands" || !commands.data.commands.some(command => command.name === "pi-host-options"
      && command.source === "extension" && command.sourceInfo?.path === join(resources.appRoot, "pi", "scripts", "host-options.ts"))) {
      throw new Error("Missing fixed host options helper capability");
    }
    const response = await worker.request({ type: "prompt", message: "/pi-host-options " + (input.cwd ? "directory-selected" : "directory-required") });
    if (response.command !== "prompt" || response.data.disposition !== "handled" || !received) throw new Error("Missing host options result");
  } catch {
    // Never forward SDK/provider diagnostics or credential-bearing model objects.
    throw new CommandError("resource_unavailable", "Host model options are unavailable");
  } finally {
    if (deadline) clearTimeout(deadline);
    if (worker) {
      let exit: PiExit;
      try {
        exit = await worker.stop();
        if (exit.descendantsUnresolved) throw new Error("Unresolved descendants");
      } catch {
        throw new OptionsHelperUnresolved("Host options helper cleanup is unresolved; explicitly reconcile before further execution");
      }
      if (exit.error) throw new CommandError("resource_unavailable", "Host model options are unavailable");
    }
  }
  if (!object(value) || Object.keys(value).length !== 2 || !object(value.defaults)
    || Object.keys(value.defaults).some(key => !["accessMode", "integrationMode", "notificationsEnabled", "model", "thinkingLevel", "contextWindow", "modelStatus"].includes(key))
    || (value.defaults.accessMode !== undefined && (typeof value.defaults.accessMode !== "string" || !["readonly", "ask", "edit", "full"].includes(value.defaults.accessMode)))
    || (value.defaults.integrationMode !== undefined && (typeof value.defaults.integrationMode !== "string" || !["ask", "allowed"].includes(value.defaults.integrationMode)))
    || (value.defaults.notificationsEnabled !== undefined && typeof value.defaults.notificationsEnabled !== "boolean")
    || (value.defaults.model !== undefined && (!modelIdentity(value.defaults.model) || Object.keys(value.defaults.model).length !== 2))
    || (value.defaults.thinkingLevel !== undefined && (!value.defaults.model || !THINKING_LEVELS.includes(value.defaults.thinkingLevel as ThinkingLevel)))
    || (value.defaults.contextWindow !== undefined && (!value.defaults.model || !validContextWindow(value.defaults.contextWindow)))
    || (value.defaults.modelStatus !== undefined && (typeof value.defaults.modelStatus !== "string"
      || !["trust-required", "unavailable", "directory-required"].includes(value.defaults.modelStatus)))
    || !Array.isArray(value.models) || value.models.length > 10_000
    || !value.models.every(model => modelIdentity(model) && Object.keys(model).length === 4 && validContextWindow(model.contextWindow)
      && Array.isArray(model.thinkingLevels) && model.thinkingLevels.length > 0 && model.thinkingLevels.length <= THINKING_LEVELS.length
      && model.thinkingLevels.every(level => typeof level === "string" && THINKING_LEVELS.includes(level as ThinkingLevel)))) {
    throw new CommandError("resource_unavailable", "Invalid host model options");
  }
  // Project only the declared metadata fields, even from the pinned helper.
  const defaults = value.defaults as HostOptions["defaults"];
  return { models: value.models.map(model => ({ provider: model.provider, id: model.id, contextWindow: model.contextWindow, thinkingLevels: model.thinkingLevels })),
    defaults: {
      ...(defaults.accessMode !== undefined && { accessMode: defaults.accessMode }),
      ...(defaults.integrationMode !== undefined && { integrationMode: defaults.integrationMode }),
      ...(defaults.notificationsEnabled !== undefined && { notificationsEnabled: defaults.notificationsEnabled }),
      ...(defaults.model && { model: { provider: defaults.model.provider, id: defaults.model.id } }),
      ...(defaults.thinkingLevel !== undefined && { thinkingLevel: defaults.thinkingLevel }),
      ...(defaults.contextWindow !== undefined && { contextWindow: defaults.contextWindow }),
      ...(defaults.modelStatus !== undefined && { modelStatus: defaults.modelStatus }),
    } };
}
