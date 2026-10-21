import type { ExtensionContext, ExtensionUIDialogOptions, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";

export const SERVICE_RUNTIME_STATUS = "pi-console-runtime";
export const SERVICE_DIALOG_STATUS = "pi-console-dialog";

export type ServiceDialogTag = { id: string; runtimeId: string; deadline?: number };

type Runtime = {
  id: string;
  manager: ExtensionContext["sessionManager"];
  lifetime: AbortController;
  publish: (state: "started" | "stopped") => void;
};

// A managed Pi process owns one conversation. Keep this across extension reloads,
// like the existing access/workspace state, but replace it at each runtime start.
const key = Symbol.for("pi-console.service-ui");
const globals = globalThis as typeof globalThis & { [key]?: Runtime };

export function serviceManaged(ctx: ExtensionContext): boolean {
  return process.env.PI_CONSOLE_SERVICE === "1" && ctx.mode === "rpc";
}

/** Read the existing identity; command validation must never start a runtime. */
export function serviceRuntimeId(ctx: ExtensionContext): string | undefined {
  const runtime = globals[key];
  return serviceManaged(ctx) && runtime?.manager === ctx.sessionManager && !runtime.lifetime.signal.aborted
    ? runtime.id : undefined;
}

export function startServiceRuntime(ctx: ExtensionContext): void {
  if (!serviceManaged(ctx)) return;
  const previous = globals[key];
  // Pi may bind the same runtime twice. Do not turn that into a new revision.
  if (previous?.manager === ctx.sessionManager && !previous.lifetime.signal.aborted) return;
  previous?.lifetime.abort();
  const ui = ctx.ui;
  const id = randomUUID();
  const metadata = { runtimeId: id, sessionId: ctx.sessionManager.getSessionId(), sessionFile: ctx.sessionManager.getSessionFile(), cwd: ctx.cwd };
  const runtime: Runtime = {
    id, manager: ctx.sessionManager, lifetime: new AbortController(),
    publish: (state) => ui.setStatus(SERVICE_RUNTIME_STATUS, JSON.stringify({ ...metadata, state })),
  };
  globals[key] = runtime;
  runtime.publish("started");
}

export function stopServiceRuntime(): void {
  const runtime = globals[key];
  if (!runtime || runtime.lifetime.signal.aborted) return;
  runtime.lifetime.abort();
  runtime.publish("stopped");
}

export function serviceDialogTag(title: string): ServiceDialogTag | undefined {
  let value: unknown;
  try { value = JSON.parse(title); } catch { return; }
  if (!value || typeof value !== "object" || !("serviceDialog" in value)) return;
  const tag = value.serviceDialog;
  if (!tag || typeof tag !== "object" || !("id" in tag) || typeof tag.id !== "string"
    || !("runtimeId" in tag) || typeof tag.runtimeId !== "string") return;
  const deadline = "deadline" in tag ? tag.deadline : undefined;
  if (deadline !== undefined && (typeof deadline !== "number" || !Number.isFinite(deadline))) return;
  return { id: tag.id, runtimeId: tag.runtimeId, deadline };
}

function taggedTitle(title: string, tag: ServiceDialogTag): string {
  let data: unknown;
  try { data = JSON.parse(title); } catch { /* Plain titles remain visible inside the envelope. */ }
  const payload = data && typeof data === "object" && !Array.isArray(data)
    ? data : { kind: "pi_service_dialog", title };
  return JSON.stringify({ ...payload, serviceDialog: tag });
}

function dialog<T>(
  ctx: ExtensionContext,
  title: string,
  options: ExtensionUIDialogOptions | undefined,
  cancelled: T,
  run: (title: string, options: ExtensionUIDialogOptions) => Promise<T>,
): Promise<T> {
  if (!globals[key]) startServiceRuntime(ctx);
  const runtime = globals[key];
  if (!runtime || runtime.manager !== ctx.sessionManager || runtime.lifetime.signal.aborted || options?.signal?.aborted) {
    return Promise.resolve(cancelled);
  }
  const ui = ctx.ui;
  const tag: ServiceDialogTag = {
    id: randomUUID(), runtimeId: runtime.id,
    deadline: options?.timeout ? Date.now() + options.timeout : serviceDialogTag(title)?.deadline,
  };
  const signal = options?.signal
    ? AbortSignal.any([runtime.lifetime.signal, options.signal]) : runtime.lifetime.signal;
  return new Promise<T>((resolve, reject) => {
    let closed = false;
    const finish = (reason: "resolved" | "aborted" | "runtime-ended" | "error"): boolean => {
      if (closed) return false;
      closed = true;
      signal.removeEventListener("abort", abort);
      try { ui.setStatus(SERVICE_DIALOG_STATUS, JSON.stringify({ ...tag, state: "closed", reason })); }
      catch (error) { reject(error); return false; }
      return true;
    };
    const abort = () => {
      if (finish(runtime.lifetime.signal.aborted ? "runtime-ended" : "aborted")) resolve(cancelled);
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      run(taggedTitle(title, tag), { ...options, signal }).then(
        (value) => { if (finish("resolved")) resolve(value); },
        (error: unknown) => { if (finish("error")) reject(error); },
      );
    } catch (error) {
      if (finish("error")) reject(error);
    }
  });
}

/** Instrument bundled dialogs only; never replace or mutate Pi's UI context. */
export function serviceUi(ctx: ExtensionContext, lifetime?: AbortSignal): ExtensionUIContext {
  const ui = ctx.ui;
  if (!serviceManaged(ctx)) return ui;
  const optionsFor = (options?: ExtensionUIDialogOptions): ExtensionUIDialogOptions | undefined => lifetime
    ? { ...options, signal: options?.signal ? AbortSignal.any([lifetime, options.signal]) : lifetime } : options;
  return {
    ...ui,
    select: (title, choices, options) => dialog(ctx, title, optionsFor(options), undefined, (tagged, opts) => ui.select(tagged, choices, opts)),
    confirm: (title, message, options) => dialog(ctx, title, optionsFor(options), false, (tagged, opts) => ui.confirm(tagged, message, opts)),
    input: (title, placeholder, options) => dialog(ctx, title, optionsFor(options), undefined, (tagged, opts) => ui.input(tagged, placeholder, opts)),
    // The wrapper retires its wait on runtime invalidation. The service can then
    // cancel the raw RPC editor callback, whose API has no AbortSignal option.
    editor: (title, prefill) => dialog(ctx, title, optionsFor(), undefined, (tagged) => ui.editor(tagged, prefill)),
  };
}
