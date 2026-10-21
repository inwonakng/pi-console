import { serviceUi } from "./shared/service-ui";
import { hasTrustRequiringProjectResources, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  canonical, chooseProjectTrust, conversationTrust, frontendTrust, resolveProjectTrust,
  saveConversationTrust, sessionHeaderCwd, trustScope, trustSessionFile, trustState,
} from "./shared/project-trust";

const STATUS = "pi-project-trust";

function cancelTransition(ctx: ExtensionContext, error: unknown): { cancel: true } {
  // Even a stale/unavailable UI must not turn a failed check into permission:
  // Pi reports thrown lifecycle errors but otherwise continues the transition.
  try { ctx.ui.notify(String(error), "error"); } catch { /* Still cancel. */ }
  return { cancel: true };
}

export default function projectTrustExtension(pi: ExtensionAPI) {
  pi.registerFlag("pi-console-trust-ui", {
    description: "Enable pi-console's RPC trust setup handshake",
    type: "boolean",
    default: false,
  });
  const publish = (ctx: ExtensionContext, state: "pending" | "ready" | "restart" | "error", error?: string) => {
    ctx.ui.setStatus(STATUS, JSON.stringify({ state, error, cwd: ctx.cwd, sessionFile: ctx.sessionManager.getSessionFile() }));
  };

  pi.on("project_trust", (event) => {
    // Native Pi keeps its own prompt. Managed child workspaces can still inherit
    // their parent's recorded decision without enabling the frontend handshake.
    if (!frontendTrust() && !process.env.PI_WORKSPACE_ID) return { trusted: "undecided" };
    if (frontendTrust()) trustState.ready = false;
    try {
      const decision = resolveProjectTrust(event.cwd, trustSessionFile());
      trustState.applied.set(canonical(event.cwd), { trusted: decision ?? false });
      return { trusted: decision === true ? "yes" : "no" };
    } catch (error) {
      trustState.applied.set(canonical(event.cwd), { trusted: false, error: String(error) });
      return { trusted: "no" };
    }
  });

  pi.on("session_start", (event, ctx) => {
    if (frontendTrust()) trustState.ready = false;
    trustState.sessionFile = ctx.sessionManager.getSessionFile();
    if (event.reason === "fork" && trustState.forkDecision && trustState.sessionFile) {
      saveConversationTrust(trustState.forkDecision.cwd, trustState.sessionFile, trustState.forkDecision.trusted);
    }
    trustState.forkDecision = undefined;
    trustState.destination = undefined;
    if (!frontendTrust()) return;
    const applied = trustState.applied.get(canonical(ctx.cwd));
    // Initial binding precedes RPC stdin: never wait for a dialog here, and
    // never let automatic workspace restoration run before the setup command.
    if (event.reason !== "startup" && !applied?.error) {
      try {
        trustState.ready = resolveProjectTrust(ctx.cwd, trustState.sessionFile) === (applied?.trusted ?? true);
      } catch { /* The setup command reports the error while work remains blocked. */ }
    }
    publish(ctx, trustState.ready ? "ready" : "pending");
  });

  pi.registerCommand("pi-trust-setup", {
    description: "Complete pi-console project trust setup before releasing agent work",
    handler: async (_args, ctx) => {
      if (!frontendTrust()) return;
      trustState.ready = false;
      publish(ctx, "pending");
      try {
        const applied = trustState.applied.get(canonical(ctx.cwd));
        if (applied?.error) throw new Error(applied.error);
        // If another personal handler decided before ours, leave its decision alone.
        const owned = applied !== undefined || !hasTrustRequiringProjectResources(ctx.cwd);
        const decision = owned ? await chooseProjectTrust(ctx, ctx.cwd, ctx.sessionManager.getSessionFile()) : undefined;
        if (owned && decision !== (applied?.trusted ?? true)) {
          publish(ctx, "restart");
          return;
        }
        trustState.ready = true;
        publish(ctx, "ready");
      } catch (error) {
        publish(ctx, "error", String(error));
      }
    },
  });

  pi.on("session_before_switch", async (event, ctx) => {
    if (!frontendTrust()) return;
    if (!trustState.ready) return { cancel: true };
    const file = event.targetSessionFile;
    if (!file) {
      return cancelTransition(ctx, "Use pi-console's new-session action so Pi starts with fresh project trust.");
    }
    try {
      const cwd = trustState.destination?.cwd ?? sessionHeaderCwd(file, ctx.cwd);
      const decision = await chooseProjectTrust(ctx, cwd, file);
      const cached = trustState.applied.get(canonical(cwd));
      if (cached && cached.trusted !== decision) {
        throw new Error("This directory has a different cached trust decision. Reopen the conversation through pi-console to restart Pi.");
      }
      trustState.destination = { cwd, sessionFile: file };
    } catch (error) {
      trustState.destination = undefined;
      return cancelTransition(ctx, error);
    }
  });

  pi.on("session_before_fork", async (_event, ctx) => {
    if (!frontendTrust()) return;
    if (!trustState.ready) return { cancel: true };
    trustState.forkDecision = undefined;
    try {
      const decision = conversationTrust(ctx.cwd, ctx.sessionManager.getSessionFile());
      if (decision === undefined) return;
      // Pi caches trust by cwd across forks. Authorize carrying a temporary
      // choice before the new runtime can load any project resources.
      const approved = await serviceUi(ctx).confirm(
        JSON.stringify({ kind: "pi_confirmation", prompt: "Copy conversation-only project trust to the fork?", notify: false }),
        `The new conversation will start ${decision ? "trusted" : "untrusted"} for this project and its managed workspaces.`);
      if (!approved) return { cancel: true };
      trustState.forkDecision = { cwd: trustScope(ctx.cwd, ctx.sessionManager.getSessionFile()).cwd, trusted: decision };
    } catch (error) {
      return cancelTransition(ctx, error);
    }
  });

  pi.on("input", (event, ctx) => {
    if (frontendTrust() && !trustState.ready && event.text.trim() !== "/pi-trust-setup") {
      ctx.ui.notify("Resolve project trust before sending prompts or commands.", "warning");
      return { action: "handled" };
    }
  });
  pi.on("before_agent_start", () => {
    if (frontendTrust() && !trustState.ready) throw new Error("Project trust setup is not complete");
  });
  pi.on("tool_call", () => {
    if (frontendTrust() && !trustState.ready) return { block: true, reason: "Project trust setup is not complete" };
  });
}
