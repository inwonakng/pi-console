import { pathInside } from "./paths";

type SubagentRuntime = {
  owner: symbol;
  hasRunning: () => boolean;
  historyBlockReason: () => string | undefined;
  protectedRoots: () => string[];
};

const STATE_KEY = Symbol.for("pi.agent.extensions.subagent-state");
const globalState = globalThis as typeof globalThis & Record<symbol, SubagentRuntime | undefined>;

// Entrypoints are evaluated independently by Pi's cache-disabled loader.
export function registerSubagentRuntime(owner: symbol, hasRunning: () => boolean, historyBlockReason: () => string | undefined, protectedRoots: () => string[]): void {
  globalState[STATE_KEY] = { owner, hasRunning, historyBlockReason, protectedRoots };
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

export function subagentProtectedRoots(): string[] {
  return globalState[STATE_KEY]?.protectedRoots() ?? [];
}

export function subagentWriteBlock(path: string): string | undefined {
  return subagentProtectedRoots().some((root) => pathInside(root, path))
    ? "A child owns an unresolved contribution in this repository. Accept or explicitly discard it before parent repository writes."
    : undefined;
}

// Admission and execution share this synchronous registry, including nested
// codemode calls. A writer cannot race an already admitted parent mutation.
const MUTATIONS_KEY = Symbol.for("pi.agent.extensions.repository-mutations");
type Mutation = { roots: string[]; denied: string[] };
const mutationsGlobal = globalThis as typeof globalThis & { [MUTATIONS_KEY]?: Set<Mutation> };
const mutations = mutationsGlobal[MUTATIONS_KEY] ??= new Set<Mutation>();

export function assertRepositoryIdle(roots: string[]): void {
  for (const mutation of mutations) {
    if (roots.some((root) => !mutation.denied.some((denied) => pathInside(denied, root))
      && mutation.roots.some((write) => pathInside(write, root) || pathInside(root, write)))) {
      throw new Error("Parent filesystem operations are still active. Wait for their cleanup before starting a writer.");
    }
  }
}

export async function withRepositoryMutation<T>(roots: string[], denied: string[], execute: () => Promise<T>): Promise<T> {
  const release = beginRepositoryMutation(roots, denied);
  let unresolved = false;
  try { return await execute(); }
  catch (error) {
    unresolved = !!error && typeof error === "object" && "managedUnresolved" in error && error.managedUnresolved === true;
    throw error;
  } finally { if (!unresolved) release(); }
}

export function beginRepositoryMutation(roots: string[], denied: string[] = []): () => void {
  const mutation = { roots, denied };
  mutations.add(mutation);
  return () => { mutations.delete(mutation); };
}
