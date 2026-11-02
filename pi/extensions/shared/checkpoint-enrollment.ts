import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

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
