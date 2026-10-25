import { constants as osConstants } from "node:os";
import { type BashOperations } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { beginEpoch, managedSpawn, managedResult, stopManaged } from "../../scripts/managed-process.mjs";

/** Await workload AND descendant cleanup in service and ordinary sessions. */
export const managedBash: BashOperations = {
  async exec(command, cwd, options) {
    if (options.signal?.aborted) throw new Error("aborted");
    if (options.timeout !== undefined && (!Number.isFinite(options.timeout) || options.timeout <= 0 || options.timeout * 1000 > 2147483647)) throw new Error("Invalid Bash timeout");
    const env = { ...process.env, ...options.env };
    let registryRoot: string | undefined;
    if (!env.PI_CONSOLE_PROCESS_REGISTRY || !env.PI_CONSOLE_OWNER_EPOCH) {
      registryRoot = mkdtempSync(join(tmpdir(), "pi-bash-process-"));
      env.PI_CONSOLE_PROCESS_REGISTRY = join(registryRoot, "processes.sqlite");
      env.PI_CONSOLE_OWNER_EPOCH = randomUUID();
      delete env.PI_CONSOLE_PROCESS_JOB;
      beginEpoch(env.PI_CONSOLE_PROCESS_REGISTRY, env.PI_CONSOLE_OWNER_EPOCH);
    }
    const child = managedSpawn("/bin/bash", ["-c", command], {
      cwd, env, stdio: ["pipe", "pipe", "pipe"],
    });
    let timedOut = false;
    const abort = () => { stopManaged(child); };
    const timeout = options.timeout === undefined ? undefined : setTimeout(() => {
      timedOut = true;
      abort();
    }, options.timeout * 1000);
    child.stdout.on("data", options.onData);
    child.stderr.on("data", options.onData);
    child.stdin.on("error", () => {});
    child.stdin.end();
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    let cleanupProven = false;
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) => resolve(code));
      });
      const result = managedResult(child);
      if (!result || result.managedUnresolved) throw new Error(`Bash managed cleanup remains unresolved${registryRoot ? `; recovery registry: ${registryRoot}` : ""}`);
      cleanupProven = true;
      if (registryRoot) rmSync(registryRoot, { recursive: true, force: true });
      if (options.signal?.aborted) throw new Error("aborted");
      if (timedOut) throw new Error(`timeout:${options.timeout}`);
      if (result.error) throw new Error(result.error);
      return { exitCode: result.code ?? (result.signal ? 128 + (osConstants.signals[result.signal] ?? 0) : code ?? 1) };
    } catch (error) {
      if (!cleanupProven) throw Object.assign(new Error(`Bash managed cleanup remains unresolved: ${error instanceof Error ? error.message : String(error)}`), { managedUnresolved: true });
      throw error;
    } finally {
      if (timeout) clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abort);
    }
  },
};
