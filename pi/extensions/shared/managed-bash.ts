import { constants as osConstants } from "node:os";
import { createLocalBashOperations, type BashOperations } from "@earendil-works/pi-coding-agent";
import { managedSpawn, managedResult, stopManaged } from "../../scripts/managed-process.mjs";

const local = createLocalBashOperations();

/** Same local Bash boundary/permissions, with durable launch registration in service mode. */
export const managedBash: BashOperations = {
  async exec(command, cwd, options) {
    if (!process.env.PI_CONSOLE_PROCESS_REGISTRY) return local.exec(command, cwd, options);
    if (options.signal?.aborted) throw new Error("aborted");
    if (options.timeout !== undefined && (!Number.isFinite(options.timeout) || options.timeout <= 0 || options.timeout * 1000 > 2147483647)) throw new Error("Invalid Bash timeout");
    const child = managedSpawn("/bin/bash", ["-c", command], {
      cwd, env: options.env ?? { ...process.env }, stdio: ["pipe", "pipe", "pipe"],
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
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) => resolve(code));
      });
      const result = managedResult(child);
      if (!result || result.managedUnresolved) throw new Error("Bash managed cleanup remains unresolved");
      if (options.signal?.aborted) throw new Error("aborted");
      if (timedOut) throw new Error(`timeout:${options.timeout}`);
      if (result.error) throw new Error(result.error);
      return { exitCode: result.code ?? (result.signal ? 128 + (osConstants.signals[result.signal] ?? 0) : code ?? 1) };
    } finally {
      if (timeout) clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abort);
    }
  },
};
