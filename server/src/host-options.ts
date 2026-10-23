import { join } from "node:path";
import { managedSpawn, managedResult, stopManaged } from "../../pi/scripts/managed-process.mjs";
import type { HostResources } from "./host-resources.js";
import { object } from "./pi-records.js";
import { CommandError } from "./session-commands.js";

const MAX_BYTES = 1024 * 1024;
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
type ThinkingLevel = typeof THINKING_LEVELS[number];
export type HostOptions = { models: { provider: string; id: string; thinkingLevels: ThinkingLevel[] }[] };
export class OptionsHelperUnresolved extends Error {}

/** Fixed read-only helper under the pinned host environment and resource fence.
 * No Pi worker, conversation, controller or project resources are allocated. */
export async function readHostOptions(resources: HostResources, environment: NodeJS.ProcessEnv): Promise<HostOptions> {
  const ai = resources.resolutions.find(dependency => dependency.from === join(resources.packageRoot, "package.json")
    && dependency.name === "@earendil-works/pi-ai")?.target;
  if (!ai) throw new Error("Pinned host Pi AI dependency is unavailable");
  const child = managedSpawn(process.execPath, [join(resources.appRoot, "pi", "scripts", "host-options.mjs"), resources.packageRoot, ai],
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
  if (!object(value) || Object.keys(value).length !== 1 || !Array.isArray(value.models) || value.models.length > 10_000
    || !value.models.every(model => object(model) && Object.keys(model).length === 3
      && typeof model.provider === "string" && model.provider.length > 0 && Buffer.byteLength(model.provider) <= 1024
      && typeof model.id === "string" && model.id.length > 0 && Buffer.byteLength(model.id) <= 1024
      && Array.isArray(model.thinkingLevels) && model.thinkingLevels.length > 0 && model.thinkingLevels.length <= THINKING_LEVELS.length
      && model.thinkingLevels.every(level => typeof level === "string" && THINKING_LEVELS.includes(level as ThinkingLevel)))) {
    throw new CommandError("resource_unavailable", "Invalid host model options");
  }
  // Project only the declared metadata fields, even from the pinned helper.
  return { models: value.models.map(model => ({ provider: model.provider, id: model.id, thinkingLevels: model.thinkingLevels })) };
}
