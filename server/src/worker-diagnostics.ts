import type { PiExit } from "./pi-process.js";

export type WorkerFailure = {
  timestamp: string;
  serviceEpoch: string;
  runtimeRevision: number;
  phase: string;
  message: string;
  cleanupRequired?: true;
  exit?: Pick<PiExit, "code" | "signal" | "descendantsUnresolved">;
};

/** Never retain stdout records or provider stderr: either can contain credentials.
 * Bound and redact exception messages before storing them in the catalog/log. */
function errorText(error: unknown): string {
  const messages: string[] = [];
  for (let current = error, depth = 0; current instanceof Error && depth < 3; current = current.cause, depth++) {
    messages.push(current.message);
  }
  return (messages.join(": ") || "Unknown worker failure")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\b(Bearer|Basic)\s+\S+/gi, "$1 [redacted]")
    .replace(/((?:api[-_]?key|access[-_]?token|refresh[-_]?token|authorization|password|secret|token)["']?\s*[:=]\s*["']?)[^\s"',;&}]+/gi, "$1[redacted]")
    .replace(/\b(?:sk|sess|ghp|github_pat|xox[baprs])[-_][\w-]+/g, "[redacted]")
    .replace(/(?:https?|wss?):\/\/[^\s"'<>]+/g, value => {
      try { const url = new URL(value); url.username = ""; url.password = ""; url.search = ""; url.hash = ""; return url.toString(); }
      catch { return "[redacted URL]"; }
    }).slice(0, 1024);
}

export function workerFailure(error: unknown, fields: Omit<WorkerFailure, "timestamp" | "message" | "exit">, exit?: PiExit): WorkerFailure {
  return { ...fields, timestamp: new Date().toISOString(), message: errorText(error),
    ...(exit ? { exit: { code: exit.code, signal: exit.signal, descendantsUnresolved: exit.descendantsUnresolved } } : {}) };
}

export function logWorkerFailure(hostId: string, sessionId: string, failure: WorkerFailure, persisted: boolean): void {
  try {
    console.error(JSON.stringify({ type: "worker_failure", pid: process.pid, hostId, sessionId, ...failure, persisted }));
  } catch { /* Diagnostics must not affect ownership cleanup. */ }
}
