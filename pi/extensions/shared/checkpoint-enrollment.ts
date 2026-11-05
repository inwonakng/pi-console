import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type SnapshotState =
  | { kind: "missing" }
  | { kind: "file"; blob: string; mode: number }
  | { kind: "symlink"; target: string }
  | { kind: "unsupported"; reason: string };

export type BashCheckpointChange = { canonicalPath: string; before: SnapshotState };

// Extension entrypoints have separate loader caches. Admission must reach the
// current history runtime, not a second module-local observer.
const key = Symbol.for("pi.agent.extensions.checkpoint-enrollment");
type Observer = (ctx: ExtensionContext, canonicalPath: string) => void;
const state = globalThis as typeof globalThis & { [key]?: Observer };
export function registerCheckpointEnrollment(observer: Observer): () => void {
  state[key] = observer;
  return () => { if (state[key] === observer) delete state[key]; };
}
export function enrollCheckpointPath(ctx: ExtensionContext, canonicalPath: string): void {
  state[key]?.(ctx, canonicalPath);
}

const bashKey = Symbol.for("pi.agent.extensions.bash-checkpoint-changes");
type BashObserver = (ctx: ExtensionContext, changes: BashCheckpointChange[]) => void;
const bashState = globalThis as typeof globalThis & { [bashKey]?: BashObserver };
export function registerBashFileChanges(observer: BashObserver): () => void {
  bashState[bashKey] = observer;
  return () => { if (bashState[bashKey] === observer) delete bashState[bashKey]; };
}
export function reportBashFileChanges(ctx: ExtensionContext, changes: BashCheckpointChange[]): void {
  bashState[bashKey]?.(ctx, changes);
}
