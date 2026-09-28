export type AccessMode = "readonly" | "ask" | "edit";

const ACCESS_MODES: AccessMode[] = ["readonly", "ask", "edit"];

export function parseAccessMode(input: string | undefined): AccessMode | undefined {
  if (!input) {
    return undefined;
  }
  const value = input.trim().toLowerCase();
  return ACCESS_MODES.find((mode) => mode === value);
}

type AccessState = {
  accessMode: AccessMode;
};

const ACCESS_STATE_KEY = Symbol.for("pi.agent.extensions.access-mode-state");
const globalAccessState = globalThis as typeof globalThis & Record<symbol, AccessState | undefined>;

// Pi loads each extension entrypoint independently. Keep access mode in a
// process-global slot so access-mode.ts and spawn.ts share the same live state
// even when their shared imports are evaluated as separate module instances.
const state = globalAccessState[ACCESS_STATE_KEY] ??= {
  accessMode: parseAccessMode(process.env.PI_SPAWN_ACCESS_MODE) ?? "ask",
};

export function getAccessMode(): AccessMode {
  return state.accessMode;
}

export function setAccessMode(mode: AccessMode): void {
  state.accessMode = mode;
}
