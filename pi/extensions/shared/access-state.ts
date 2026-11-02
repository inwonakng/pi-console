export type AccessMode = "readonly" | "ask" | "edit" | "full";

const ACCESS_MODES: AccessMode[] = ["readonly", "ask", "edit", "full"];

export function parseAccessMode(input: string | undefined): AccessMode | undefined {
  if (!input) {
    return undefined;
  }
  const value = input.trim().toLowerCase();
  return ACCESS_MODES.find((mode) => mode === value);
}

export type AccessChange = "mode" | "grant" | "runtime";

type AccessState = {
  accessMode: AccessMode;
  workerCeiling?: AccessMode;
  scratchDirectory?: string;
  revision?: number;
  generation?: number;
  runtimeGeneration?: number;
  parentRevision?: number;
  parentMode?: AccessMode;
  invalidators?: Set<() => void>;
  observers?: Set<(reason: AccessChange) => void>;
};

const ACCESS_STATE_KEY = Symbol.for("pi.agent.extensions.access-mode-state");
const globalAccessState = globalThis as typeof globalThis & Record<symbol, AccessState | undefined>;

// Pi loads each extension entrypoint independently. Keep access mode and scratch
// space in a process-global slot so the extensions share the same live state
// even when their shared imports are evaluated as separate module instances.
const state = globalAccessState[ACCESS_STATE_KEY] ??= {
  accessMode: process.env.PI_SIDE_AGENT === "1" ? "ask" : parseAccessMode(process.env.PI_SPAWN_ACCESS_MODE) ?? "ask",
  workerCeiling: process.env.PI_SPAWN_WORKER_ID ? parseAccessMode(process.env.PI_SPAWN_ACCESS_MODE) : undefined,
};

export function getAccessMode(): AccessMode {
  return process.env.PI_SIDE_AGENT === "1" ? "ask" : state.accessMode;
}

export function setAccessMode(mode: AccessMode): void {
  if (process.env.PI_SIDE_AGENT === "1" && mode !== "ask") {
    throw new Error("Side conversations have fixed ask access mode.");
  }
  const ceiling = workerAccessCeiling();
  if ((ceiling && effectiveWorkerMode(mode, ceiling) !== mode)
    || (state.parentMode && effectiveWorkerMode(mode, state.parentMode) !== mode)) {
    throw new Error("Worker access mode exceeds its immutable ceiling or current parent authority.");
  }
  if (state.accessMode === mode) return;
  state.accessMode = mode;
  invalidateAccessAuthority("mode");
}

/** In-memory only: history and summaries never recreate live authority. */
export function accessRevision(): number { return state.revision ?? 0; }

/** Mode/runtime changes cancel pending authority; additive grants do not. */
export function accessGeneration(): number { return state.generation ?? 0; }

/** Teardown remains a cancellation fence even after a parent admits an action. */
export function accessRuntimeGeneration(): number { return state.runtimeGeneration ?? 0; }

export function advanceAccessRevision(reason: AccessChange = "grant"): void {
  state.revision = accessRevision() + 1;
  for (const observe of state.observers ?? []) observe(reason);
}

export function invalidateAccessAuthority(reason: "mode" | "runtime" = "runtime"): void {
  state.generation = accessGeneration() + 1;
  if (reason === "runtime") state.runtimeGeneration = accessRuntimeGeneration() + 1;
  advanceAccessRevision(reason);
  for (const invalidate of state.invalidators ?? []) invalidate();
}

export function onAccessChanged(observe: (reason: AccessChange) => void): () => void {
  (state.observers ??= new Set()).add(observe);
  return () => state.observers?.delete(observe);
}

export function workerAccessCeiling(): AccessMode | undefined {
  return state.workerCeiling;
}

export function effectiveWorkerMode(parent: AccessMode, ceiling: AccessMode): AccessMode {
  return ACCESS_MODES[Math.min(ACCESS_MODES.indexOf(parent), ACCESS_MODES.indexOf(ceiling))];
}

export function parentAccessRevision(): number | undefined { return state.parentRevision; }

/** Only the addressed private parent protocol calls this, never session history. */
export function synchronizeWorkerAccess(mode: AccessMode, revision: number): void {
  const ceiling = workerAccessCeiling();
  if (!ceiling || !Number.isSafeInteger(revision) || revision < 0
    || state.parentRevision !== undefined && revision < state.parentRevision) throw new Error("Stale worker authority synchronization");
  state.parentMode = mode;
  state.parentRevision = revision;
  const effective = effectiveWorkerMode(mode, ceiling);
  if (state.accessMode !== effective) { state.accessMode = effective; invalidateAccessAuthority("mode"); }
}

export function onAccessInvalidated(invalidate: () => void): () => void {
  (state.invalidators ??= new Set()).add(invalidate);
  return () => state.invalidators?.delete(invalidate);
}

export function getScratchDirectory(): string | undefined {
  return state.scratchDirectory;
}

export function setScratchDirectory(path: string | undefined): void {
  state.scratchDirectory = path;
}
