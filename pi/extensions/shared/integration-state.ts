export type IntegrationMode = "ask" | "allowed";

const INTEGRATION_MODES: IntegrationMode[] = ["ask", "allowed"];

export function parseIntegrationMode(input: string | undefined): IntegrationMode | undefined {
  if (!input) {
    return undefined;
  }
  const value = input.trim().toLowerCase();
  return INTEGRATION_MODES.find((mode) => mode === value);
}

type IntegrationState = {
  integrationMode: IntegrationMode;
};

const INTEGRATION_STATE_KEY = Symbol.for("pi.agent.extensions.integration-state");
const globalIntegrationState = globalThis as typeof globalThis & Record<symbol, IntegrationState | undefined>;

// Session replacement reloads extension entrypoints. Keep the selected mode in
// a process-global slot so it survives workspace transitions and /reload.
const existingState = globalIntegrationState[INTEGRATION_STATE_KEY];
const state: IntegrationState = existingState && parseIntegrationMode(existingState.integrationMode)
  ? existingState
  : { integrationMode: "ask" };
globalIntegrationState[INTEGRATION_STATE_KEY] = state;

export function getIntegrationMode(): IntegrationMode {
  return state.integrationMode;
}

export function setIntegrationMode(mode: IntegrationMode): void {
  state.integrationMode = mode;
}
