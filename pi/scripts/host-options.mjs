import { open } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Fixed metadata helper only. No session, tools, resource loader or extensions.
// Install the watchdog before importing the host SDK or reading configuration.
const deadline = setTimeout(() => process.exit(1), 15_000);
const MAX_BYTES = 1024 * 1024;
async function cachedModels(path) {
  let file;
  try {
    file = await open(path, "r");
    if ((await file.stat()).size > 16 * MAX_BYTES) throw new Error("Model cache exceeds limit");
    const value = JSON.parse((await file.readFile("utf8")).replace(/^\uFEFF/, ""));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid model cache");
    return value;
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  } finally { await file?.close(); }
}

try {
  const root = process.argv[2];
  const fromHost = path => import(pathToFileURL(join(root, "dist", path)).href);
  const [{ ModelRuntime }, { ReadOnlyAuthStorage }, { getAgentDir }, { getSupportedThinkingLevels }] = await Promise.all([
    fromHost("core/model-runtime.js"), fromHost("core/auth-storage.js"), fromHost("config.js"),
    import(pathToFileURL(join(process.argv[3], "dist", "compat.js")).href),
  ]);
  const cache = await cachedModels(join(getAgentDir(), "models-store.json"));
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
  const result = { models: available.map(model => ({
    provider: model.provider, id: model.id, thinkingLevels: getSupportedThinkingLevels(model),
  })) };
  const output = JSON.stringify(result);
  if (Buffer.byteLength(output) > MAX_BYTES) throw new Error("Model metadata exceeds limit");
  await new Promise((resolve, reject) => process.stdout.write(output + "\n", error => error ? reject(error) : resolve()));
} catch {
  // Never return credential values or SDK diagnostics across this boundary.
  process.exitCode = 1;
} finally { clearTimeout(deadline); }
