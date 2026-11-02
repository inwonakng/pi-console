// Maintained patch for sandbox-runtime 0.0.81. Run by npm postinstall and
// verified by build-runtime.sh. Only per-command validation accepts '*'; the
// global schema, matcher, explicit denies and address guards are unchanged.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const dependencyRoot = new URL("./", pathToFileURL(createRequire(import.meta.url).resolve("@anthropic-ai/sandbox-runtime/package.json")));

const originalHash = "03bd1f22e0b7a5fa401ef8f164390b8bfe8972885856ea8dce0657fa57a31114";
const before = "if (typeof entry !== 'string' || !isValidAllowedDomainEntry(entry)) {";
const after = "if (typeof entry !== 'string' || (entry !== '*' && !isValidAllowedDomainEntry(entry))) {";
const hash = (source) => createHash("sha256").update(source).digest("hex");

export function patchSandboxRuntime(root = dependencyRoot, check = false) {
  const manifest = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
  if (manifest.version !== "0.0.81") throw new Error("Sandbox patch requires exact sandbox-runtime 0.0.81");
  const target = new URL("dist/sandbox/sandbox-manager.js", root);
  const source = readFileSync(target, "utf8");
  // Reversing just our exact edit and checking the whole upstream file also
  // makes repeated installs idempotent without accepting other source changes.
  if (source.split(after).length === 2 && hash(source.replace(after, before)) === originalHash) return;
  if (hash(source) !== originalHash || source.split(before).length !== 2) {
    throw new Error("Sandbox patch source mismatch; refusing to patch unexpected dependency source");
  }
  if (check) throw new Error("Sandbox patch missing; run npm install in pi/ with lifecycle scripts enabled");
  writeFileSync(target, source.replace(before, after));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.slice(2).some((arg) => arg !== "--check")) throw new Error("Usage: patch-sandbox-runtime.mjs [--check]");
    patchSandboxRuntime(undefined, process.argv.includes("--check"));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
