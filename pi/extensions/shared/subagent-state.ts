type SubagentRuntime = {
  owner: symbol;
  hasRunning: () => boolean;
  historyBlockReason: () => string | undefined;
};

const STATE_KEY = Symbol.for("pi.agent.extensions.subagent-state");
const globalState = globalThis as typeof globalThis & Record<symbol, SubagentRuntime | undefined>;

// Entrypoints are evaluated independently by Pi's cache-disabled loader.
export function registerSubagentRuntime(owner: symbol, hasRunning: () => boolean, historyBlockReason: () => string | undefined): void {
  globalState[STATE_KEY] = { owner, hasRunning, historyBlockReason };
}

export function retireSubagentRuntime(owner: symbol): boolean {
  if (globalState[STATE_KEY]?.owner !== owner) return false;
  delete globalState[STATE_KEY];
  return true;
}

export function hasRunningSubagents(): boolean {
  return globalState[STATE_KEY]?.hasRunning() ?? false;
}

export function subagentHistoryBlockReason(): string | undefined {
  return globalState[STATE_KEY]?.historyBlockReason();
}
