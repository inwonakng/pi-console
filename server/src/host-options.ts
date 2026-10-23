import { join } from "node:path";
import { managedSpawn, managedResult, stopManaged } from "../../pi/scripts/managed-process.mjs";
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
    modelStatus?: "configured" | "trust-required" | "unavailable" | "directory-required";
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

/** Fixed read-only helper under the pinned host environment and resource fence.
 * No Pi worker, conversation, controller or project resources are allocated. */
export async function readHostOptions(resources: HostResources, environment: NodeJS.ProcessEnv,
  input: { cwd?: string; provider?: string; model?: string }): Promise<HostOptions> {
  const ai = resources.resolutions.find(dependency => dependency.from === join(resources.packageRoot, "package.json")
    && dependency.name === "@earendil-works/pi-ai")?.target;
  if (!ai) throw new Error("Pinned host Pi AI dependency is unavailable");
  const child = managedSpawn(process.execPath, [join(resources.appRoot, "pi", "scripts", "host-options.mjs"), resources.packageRoot, ai, JSON.stringify(input)],
    { cwd: resources.root, env: { ...environment, PI_OFFLINE: "1" }, stdio: ["pipe", "pipe", "pipe"] });
  let bytes = 0;
  const chunks: Buffer[] = [];
  let failure = false;
  const stop = () => {
    if (failure) return;
    failure = true;
    if (!stopManaged(child)) child.kill("SIGTERM");
  };
  const deadline = setTimeout(stop, 30_000);
  child.stdin.on("error", stop);
  child.stdout.on("error", stop);
  child.stderr.on("error", stop);
  child.stdout.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > MAX_BYTES + 1) stop();
    else if (!failure) chunks.push(chunk);
  });
  // SDK/provider diagnostics can contain credentials. Drain without retaining them.
  child.stderr.resume();
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
    child.once("error", () => { failure = true; });
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(deadline);
  let evidence;
  try { evidence = managedResult(child); }
  catch { throw new OptionsHelperUnresolved("Host options helper cleanup is unproven; explicitly reconcile before further execution"); }
  if (evidence?.managedUnresolved) throw new OptionsHelperUnresolved("Host options helper cleanup is unresolved; explicitly reconcile before further execution");
  if (failure || (evidence ?? exit).code !== 0 || (evidence ?? exit).signal || evidence?.error) {
    throw new CommandError("resource_unavailable", "Host model options are unavailable");
  }
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw new CommandError("resource_unavailable", "Invalid host model options"); }
  if (!object(value) || Object.keys(value).length !== 2 || !object(value.defaults)
    || Object.keys(value.defaults).some(key => !["accessMode", "integrationMode", "notificationsEnabled", "model", "thinkingLevel", "contextWindow", "modelStatus"].includes(key))
    || (value.defaults.accessMode !== undefined && (typeof value.defaults.accessMode !== "string" || !["readonly", "ask", "edit", "full"].includes(value.defaults.accessMode)))
    || (value.defaults.integrationMode !== undefined && (typeof value.defaults.integrationMode !== "string" || !["ask", "allowed"].includes(value.defaults.integrationMode)))
    || (value.defaults.notificationsEnabled !== undefined && typeof value.defaults.notificationsEnabled !== "boolean")
    || (value.defaults.model !== undefined && (!modelIdentity(value.defaults.model) || Object.keys(value.defaults.model).length !== 2))
    || (value.defaults.thinkingLevel !== undefined && (!value.defaults.model || !THINKING_LEVELS.includes(value.defaults.thinkingLevel as ThinkingLevel)))
    || (value.defaults.contextWindow !== undefined && (!value.defaults.model || !validContextWindow(value.defaults.contextWindow)))
    || (value.defaults.modelStatus !== undefined && (typeof value.defaults.modelStatus !== "string"
      || !["configured", "trust-required", "unavailable", "directory-required"].includes(value.defaults.modelStatus)))
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
