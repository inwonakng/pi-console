import { constants as osConstants } from "node:os";
import { type BashOperations } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { beginEpoch, managedSpawn, managedStarted, managedResult, stopManaged, type ManagedExit } from "../../scripts/managed-process.mjs";

export type ManagedBashHooks = {
  /** Called at the synchronous launch boundary; turn cancellation ends here. */
  onSpawn?: () => void;
  onStarted?: (identity: string) => void;
  onStdout?: (data: Buffer) => void;
  onStderr?: (data: Buffer) => void;
  onDeadline?: () => void;
  onExit?: (result: ManagedExit & { timedOut: boolean }) => void;
};

/** Await workload AND descendant cleanup in service and ordinary sessions. */
export const createManagedBash = (hooks: ManagedBashHooks = {}): BashOperations => ({
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
    let child: ReturnType<typeof managedSpawn>;
    try {
      child = managedSpawn("/bin/bash", ["-c", command], {
        cwd, env, stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      // Synchronous refusal happens before a supervisor can receive launch IPC.
      if (registryRoot) rmSync(registryRoot, { recursive: true, force: true });
      throw error;
    }
    let hookError: unknown;
    try { hooks.onSpawn?.(); }
    catch (error) { hookError = error; stopManaged(child); }
    const started = managedStarted(child).then(identity => hooks.onStarted?.(identity), () => {});
    void started.catch(error => { hookError = error; stopManaged(child); });
    let timedOut = false;
    const abort = () => { stopManaged(child); };
    const timeout = options.timeout === undefined ? undefined : setTimeout(() => {
      timedOut = true;
      try { hooks.onDeadline?.(); } catch (error) { hookError = error; }
      abort();
    }, options.timeout * 1000);
    child.stdout.on("data", hooks.onStdout ?? options.onData);
    child.stderr.on("data", hooks.onStderr ?? options.onData);
    child.stdin.on("error", () => {});
    child.stdin.end();
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    let cleanupProven = false;
    try {
      const code = await new Promise<number | null>((resolve) => {
        // A spawn error still closes its stdio. The managed registry decides
        // whether no launch occurred or ownership remains unresolved.
        child.once("close", (code) => resolve(code));
      });
      await started.catch(() => {});
      const result = managedResult(child);
      if (result) hooks.onExit?.({ ...result, timedOut });
      if (!result || result.managedUnresolved) throw new Error(`Bash managed cleanup remains unresolved${registryRoot ? `; recovery registry: ${registryRoot}` : ""}`);
      cleanupProven = true;
      if (registryRoot) rmSync(registryRoot, { recursive: true, force: true });
      if (hookError) throw hookError;
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
});

export const managedBash = createManagedBash();
