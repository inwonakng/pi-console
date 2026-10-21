import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { managedBash } from "./shared/managed-bash";
import { assertManagedResources } from "../scripts/managed-process.mjs";
import { startServiceRuntime, stopServiceRuntime } from "./shared/service-ui";

/** Extra lifecycle status for service-owned RPC workers; ordinary Pi is unchanged. */
export default function serviceExtension(pi: ExtensionAPI): void {
  if (process.env.PI_CONSOLE_SERVICE !== "1") return;
  // User-entered/RPC Bash keeps its existing unrestricted-shell semantics;
  // only ownership changes. Model-facing sandbox permissions remain separate.
  pi.on("user_bash", () => ({ operations: managedBash }));
  pi.on("session_before_switch", (_event, ctx) => {
    try { assertManagedResources(); }
    catch (error) { ctx.ui.notify(String(error), "error"); return { cancel: true }; }
  });
  pi.on("session_start", (_event, ctx) => startServiceRuntime(ctx));
  pi.on("session_shutdown", () => stopServiceRuntime());
}
