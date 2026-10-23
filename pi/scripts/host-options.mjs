import { open, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

// Fixed metadata helper only. No session, tools, resource loader or extensions.
// Install the watchdog before importing the host SDK or reading configuration.
const deadline = setTimeout(() => process.exit(1), 15_000);
const MAX_BYTES = 1024 * 1024;
async function readText(path, maxBytes = MAX_BYTES) {
  let file;
  try {
    file = await open(path, "r");
    const info = await file.stat();
    if (!info.isFile() || info.size > maxBytes) throw new Error("Invalid metadata file");
    return (await file.readFile("utf8")).replace(/^\uFEFF/, "");
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  } finally { await file?.close(); }
}

try {
  const { readExtensionSettings } = await import("../extensions/shared/read-extension-settings.mjs");
  const root = process.argv[2];
  const fromHost = path => import(pathToFileURL(join(root, "dist", path)).href);
  const [{ ModelRuntime }, { ReadOnlyAuthStorage }, { getAgentDir, CONFIG_DIR_NAME }, ai,
    { SettingsManager }, resolver, { DEFAULT_THINKING_LEVEL }, { hasTrustRequiringProjectResources }] = await Promise.all([
    fromHost("core/model-runtime.js"), fromHost("core/auth-storage.js"), fromHost("config.js"),
    import(pathToFileURL(join(process.argv[3], "dist", "compat.js")).href),
    fromHost("core/settings-manager.js"), fromHost("core/model-resolver.js"), fromHost("core/defaults.js"),
    fromHost("core/trust-manager.js"),
  ]);
  const { getSupportedThinkingLevels, clampThinkingLevel } = ai;
  const agentDir = getAgentDir();
  const input = JSON.parse(process.argv[4]);
  const cache = JSON.parse(await readText(join(agentDir, "models-store.json"), 16 * MAX_BYTES) ?? "{}");
  if (!cache || typeof cache !== "object" || Array.isArray(cache)) throw new Error("Invalid model cache");
  const runtime = await ModelRuntime.create({
    credentials: new ReadOnlyAuthStorage(),
    allowModelNetwork: false,
    // Restore offline catalogs without FileModelsStore creating files or locks.
    // Any SDK cache updates remain local to this short-lived process.
    modelsStore: {
      async read(id) { return cache[id] === undefined ? undefined : structuredClone(cache[id]); },
      async write(id, value) { cache[id] = structuredClone(value); },
      async delete(id) { delete cache[id]; },
    },
  });
  const available = await runtime.getAvailable();
  if (runtime.getError()) throw new Error("Host model configuration is unavailable");
  if (available.length > 10_000) throw new Error("Model count exceeds limit");
  const defaults = { modelStatus: input.cwd ? "unavailable" : "directory-required" };
  let startupModel;
  try {
    const settings = readExtensionSettings(agentDir);
    defaults.accessMode = settings["access-mode"]?.default ?? "ask";
    defaults.integrationMode = settings["integration-mode"]?.default ?? "ask";
    defaults.notificationsEnabled = settings.notifications?.default !== "disabled";
  } catch { /* Invalid settings must not be presented as known defaults. */ }
  if (input.cwd) {
    try {
      const cwd = await realpath(input.cwd);
      const global = await readText(join(agentDir, "settings.json"));
      let project;
      const settings = SettingsManager.fromStorage({
        withLock(scope, read) {
          if (read(scope === "global" ? global : project) !== undefined) throw new Error("Read-only settings");
        },
      }, { projectTrusted: false });
      if (settings.drainErrors().length) throw new Error("Invalid settings");
      let trusted = true;
      if (hasTrustRequiringProjectResources(cwd)) {
        // ProjectTrustStore.get() creates locks/directories. Read its file
        // snapshot instead; previews never persist a trust decision.
        const trust = JSON.parse(await readText(join(agentDir, "trust.json")) ?? "{}");
        if (!trust || typeof trust !== "object" || Array.isArray(trust)
          || Object.values(trust).some(value => value !== true && value !== false && value !== null)) throw new Error("Invalid trust store");
        trusted = undefined;
        for (let path = cwd; ; path = dirname(path)) {
          if (trust[path] === true || trust[path] === false) { trusted = trust[path]; break; }
          if (dirname(path) === path) break;
        }
        if (trusted === undefined) {
          const policy = settings.getDefaultProjectTrust();
          if (policy !== "ask") trusted = policy === "always";
        }
      }
      // A pending trust prompt can change project model settings. Leave them
      // unknown until the user decides, rather than previewing global guesses.
      if (trusted === undefined) defaults.modelStatus = "trust-required";
      else {
        if (trusted) project = await readText(join(cwd, CONFIG_DIR_NAME, "settings.json"));
        settings.setProjectTrusted(trusted);
        if (settings.drainErrors().length) throw new Error("Invalid settings");
        let model, thinkingLevel;
        if (input.model) {
          const selected = resolver.resolveCliModel({ cliProvider: input.provider, cliModel: input.model, modelRuntime: runtime });
          if (selected.error) throw new Error("Invalid owner model");
          ({ model, thinkingLevel } = selected);
        } else {
          const patterns = settings.getEnabledModels();
          const scoped = patterns?.length ? resolver.resolveModelScopeFromModels(patterns, available).scopedModels : [];
          const saved = scoped.find(item => item.model.provider === settings.getDefaultProvider() && item.model.id === settings.getDefaultModel());
          const provider = settings.getDefaultProvider();
          const id = settings.getDefaultModel();
          if (scoped.length) ({ model, thinkingLevel } = saved ?? scoped[0]);
          else if (provider && id && !runtime.getModel(provider, id)) {
            // Extensions may register this provider only when a session starts.
            // Show the saved choice without inventing capabilities or loading code.
            defaults.model = { provider, id };
            defaults.thinkingLevel = settings.getModelThinkingLevel(provider, id) ?? settings.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL;
            defaults.modelStatus = "configured";
          } else ({ model } = await resolver.findInitialModel({ scopedModels: [], isContinuing: false,
            defaultProvider: provider, defaultModelId: id, modelRuntime: runtime }));
        }
        if (model) {
          thinkingLevel ??= settings.getModelThinkingLevel(model.provider, model.id) ?? settings.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL;
          const level = clampThinkingLevel(model, thinkingLevel);
          defaults.model = { provider: model.provider, id: model.id };
          defaults.thinkingLevel = level;
          defaults.contextWindow = model.contextWindow;
          delete defaults.modelStatus;
          startupModel = model;
        }
      }
    } catch { /* Unresolvable model settings leave the independent defaults intact. */ }
  }
  // Explicit owner CLI models can be valid custom IDs outside the catalog.
  // Keep their thinking choices available to the pre-start picker too.
  const models = startupModel && !available.some(model => model.provider === startupModel.provider && model.id === startupModel.id)
    ? [...available, startupModel] : available;
  if (models.length > 10_000) throw new Error("Model count exceeds limit");
  const result = { models: models.map(model => ({
    provider: model.provider, id: model.id, contextWindow: model.contextWindow, thinkingLevels: getSupportedThinkingLevels(model),
  })), defaults };
  const output = JSON.stringify(result);
  if (Buffer.byteLength(output) > MAX_BYTES) throw new Error("Model metadata exceeds limit");
  await new Promise((resolve, reject) => process.stdout.write(output + "\n", error => error ? reject(error) : resolve()));
} catch {
  // Never return credential values or SDK diagnostics across this boundary.
  process.exitCode = 1;
} finally { clearTimeout(deadline); }
