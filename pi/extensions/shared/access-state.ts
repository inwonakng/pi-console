export type AccessMode = "readonly" | "ask" | "edit" | "full";

const ACCESS_MODES: AccessMode[] = ["readonly", "ask", "edit", "full"];

export function parseAccessMode(input: string | undefined): AccessMode | undefined {
  if (!input) {
    return undefined;
  }
  const value = input.trim().toLowerCase();
  return ACCESS_MODES.find((mode) => mode === value);
}

type AccessState = {
  accessMode: AccessMode;
  scratchDirectory?: string;
  revision?: number;
  invalidators?: Set<() => void>;
};

const ACCESS_STATE_KEY = Symbol.for("pi.agent.extensions.access-mode-state");
const globalAccessState = globalThis as typeof globalThis & Record<symbol, AccessState | undefined>;

// Pi loads each extension entrypoint independently. Keep access mode and scratch
// space in a process-global slot so the extensions share the same live state
// even when their shared imports are evaluated as separate module instances.
const state = globalAccessState[ACCESS_STATE_KEY] ??= {
  accessMode: process.env.PI_SIDE_AGENT === "1" ? "ask" : parseAccessMode(process.env.PI_SPAWN_ACCESS_MODE) ?? "ask",
};

export function getAccessMode(): AccessMode {
  return process.env.PI_SIDE_AGENT === "1" ? "ask" : state.accessMode;
}

export function setAccessMode(mode: AccessMode): void {
  if (process.env.PI_SIDE_AGENT === "1" && mode !== "ask") {
    throw new Error("Side conversations have fixed ask access mode.");
  }
  const childMode = parseAccessMode(process.env.PI_SPAWN_ACCESS_MODE);
  if (process.env.PI_SPAWN_WORKER_ID && childMode === "readonly" && mode !== "readonly") {
    throw new Error("Readonly workers have fixed readonly access mode.");
  }
  if (state.accessMode === mode) return;
  state.accessMode = mode;
  invalidateAccessAuthority();
}

/** In-memory only: history and summaries never recreate live authority. */
export function accessRevision(): number { return state.revision ?? 0; }

export function invalidateAccessAuthority(): void {
  state.revision = accessRevision() + 1;
  for (const invalidate of state.invalidators ?? []) invalidate();
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
