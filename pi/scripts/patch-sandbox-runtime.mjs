// Maintained patches for sandbox-runtime 0.0.81. Run by npm postinstall and
// verified by build-runtime.sh. Preserve the upstream filters and per-command
// sandbox; optionally reuse a host-owned isolated Linux network namespace.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const dependencyRoot = new URL("./", pathToFileURL(createRequire(import.meta.url).resolve("@anthropic-ai/sandbox-runtime/package.json")));
const hash = (source) => createHash("sha256").update(source).digest("hex");
const patches = [
  {
    path: "dist/sandbox/sandbox-manager.js",
    hash: "03bd1f22e0b7a5fa401ef8f164390b8bfe8972885856ea8dce0657fa57a31114",
    edits: [
      ["if (typeof entry !== 'string' || !isValidAllowedDomainEntry(entry)) {",
        "if (typeof entry !== 'string' || (entry !== '*' && !isValidAllowedDomainEntry(entry))) {"],
      ["case 'linux':\n            return wrapCommandWithSandboxLinux({\n                command,",
        "case 'linux':\n            return wrapCommandWithSandboxLinux({\n                sessionNetwork: customConfig?.linuxSessionNetwork,\n                command,"],
    ],
  },
  {
    path: "dist/sandbox/linux-sandbox-utils.js",
    hash: "3880ba176ec09e5fdda364b1135fbccd291df5dcd9dd1c3c70da02e15f4f6621",
    edits: [
      ["const { command, commandId, needsNetworkRestriction, httpSocketPath,",
        "const { sessionNetwork, command, commandId, needsNetworkRestriction, httpSocketPath,"],
      ["            bwrapArgs.push('--unshare-net');",
        "            if (!sessionNetwork) bwrapArgs.push('--unshare-net');"],
      ["if (needsNetworkRestriction && httpSocketPath && socksSocketPath) {\n            const sandboxCommand = buildSandboxCommand",
        "if (!sessionNetwork && needsNetworkRestriction && httpSocketPath && socksSocketPath) {\n            const sandboxCommand = buildSandboxCommand"],
      ["        return wrappedCommand;\n    }\n    catch (error) {",
        "        // Namespace handles belong to the trusted session host. Enter before\n" +
        "        // bwrap creates the workload's private user/PID/mount namespaces.\n" +
        "        return sessionNetwork ? quote(['nsenter', '--user=' + sessionNetwork.user,\n" +
        "            '--net=' + sessionNetwork.net, '--preserve-credentials', '--',\n" +
        "            shell, '-c', wrappedCommand]) : wrappedCommand;\n    }\n    catch (error) {"],
    ],
  },
];

export function patchSandboxRuntime(root = dependencyRoot, check = false) {
  const manifest = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
  if (manifest.version !== "0.0.81") throw new Error("Sandbox patch requires exact sandbox-runtime 0.0.81");
  // Validate every complete upstream file before writing any of them. Recognize
  // both pristine sources and our older wildcard-only patch, never other edits.
  const changes = patches.map(patch => {
    const target = new URL(patch.path, root);
    const source = readFileSync(target, "utf8");
    let original = source;
    for (const [before, after] of [...patch.edits].reverse()) {
      if (original.includes(after)) {
        if (original.split(after).length !== 2) throw new Error(`Ambiguous sandbox patch: ${patch.path}`);
        original = original.replace(after, before);
      }
    }
    if (hash(original) !== patch.hash) throw new Error(`Sandbox patch source mismatch: ${patch.path}`);
    let patched = original;
    for (const [before, after] of patch.edits) {
      if (patched.split(before).length !== 2) throw new Error(`Ambiguous sandbox patch: ${patch.path}`);
      patched = patched.replace(before, after);
    }
    return { target, source, patched };
  });
  if (check && changes.some(({ source, patched }) => source !== patched)) {
    throw new Error("Sandbox patch missing; run npm install in pi/ with lifecycle scripts enabled");
  }
  if (!check) for (const { target, source, patched } of changes) if (source !== patched) writeFileSync(target, patched);
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
