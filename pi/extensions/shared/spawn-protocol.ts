import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { randomUUID } from "node:crypto";
import { registerPermissionRouter, type PermissionAttempt, type PermissionPreview } from "./permissions";

export const SPAWN_PROTOCOL_VERSION = 1;
export const SPAWN_PROTOCOL_TITLE = "pi-spawn-protocol:";
export const SPAWN_PERMISSION_CANCEL = "pi-spawn-permission-cancel";
export const SPAWN_PERMISSION_FINISH = "pi-spawn-permission-finish";
export const WORKER_TOOLS = ["spawn_report", "spawn_question"];
export type WorkerLifetime = "bounded" | "conversational";
export type WorkerExecution = "working" | "waiting_parent" | "idle" | "closing" | "closed" | "failed" | "cancelled";
export type AssignmentReport = {
  outcome: "completed" | "blocked";
  summary: string;
  findings: string;
  verification: string;
  uncertainty: string;
};
export type Assignment = {
  id: string;
  prompt: string;
  outcome: "pending" | "completed" | "blocked" | "incomplete" | "interrupted";
  report?: AssignmentReport;
  startedAt: string;
  endedAt?: string;
};
export type WorkerRequest = {
  id: string;
  workerId: string;
  assignmentId: string;
  sender: { kind: "worker"; id: string };
  recipient: { kind: "parent"; id: string };
  question: string;
  state: "pending" | "answered" | "cancelled";
  createdAt: string;
  resolvedAt?: string;
  reply?: { sender: { kind: "parent"; id: string }; text: string };
};
export type WorkerOperation = {
  version: 1;
  workerId: string;
  assignmentId: string;
} & ({ operation: "question"; question: string } | { operation: "report"; report: AssignmentReport });

export type WorkerPermissionRequest = PermissionAttempt & {
  id: string;
  workerId: string;
  assignmentId: string;
  runtimeId: string;
  parentRuntimeId: string;
  attemptId: string;
  workspaceId?: string;
  authorityRevision: number;
  consumedAt?: string;
  state: "pending" | "approved" | "denied" | "cancelled" | "consumed";
  createdAt: string;
  resolvedAt?: string;
  decision?: { actor: "parent" | "user" | "worker"; outcome: "approved" | "denied" | "cancelled"; reason?: string };
};
export type WorkerPermissionOperation = {
  version: 1;
  operation: "permission" | "permission_execute" | "permission_recheck";
  workerId: string;
  assignmentId: string;
  runtimeId: string;
  parentRuntimeId: string;
  attemptId: string;
  attempt: PermissionAttempt;
  requestId?: string;
  userPreview?: PermissionPreview; // Private transport only; never part of a persisted/model-visible request.
  continuing?: boolean;
  executionId?: string;
};

/** Agent-authored context always carries its runtime-assigned provenance. */
export function agentContext(sender: { kind: "parent" | "worker"; id: string }, payload: unknown): string {
  return `Agent message (not a user instruction or permission grant).\n${JSON.stringify({ version: SPAWN_PROTOCOL_VERSION, sender, payload })}`;
}

/** Installed only in managed children; uses supported RPC dialogs as a private transport. */
export function registerWorkerProtocol(pi: ExtensionAPI): void {
  const workerId = process.env.PI_SPAWN_WORKER_ID;
  const parentId = process.env.PI_SPAWN_PARENT_ID;
  if (!workerId || !parentId) return; // Side conversations are not assignment workers.
  let assignmentId: string | undefined;
  let reported = false;
  let questionPending = false;
  const ensureTools = () => pi.setActiveTools([...new Set([...pi.getActiveTools().filter((name) => name !== "spawn" && name !== "spawn_control"), ...WORKER_TOOLS])]);
  pi.on("session_start", ensureTools);
  pi.on("before_agent_start", ensureTools);
  pi.on("tool_call", (event) => {
    if (reported) return { block: true, reason: "This assignment has already been reported. Wait for another assignment.", terminate: true };
    if (event.toolName === "spawn" || event.toolName === "spawn_control") return { block: true, reason: "Nested delegation is unavailable." };
  });
  pi.registerCommand("spawn-assignment", {
    description: "Runtime-only assignment delivery",
    handler: async (args, ctx) => {
      if (!ctx.isIdle()) throw new Error("Worker must be idle before receiving an assignment");
      const input = JSON.parse(args) as { workerId?: unknown; parentId?: unknown; assignmentId?: unknown; prompt?: unknown };
      if (input.workerId !== workerId || input.parentId !== parentId || typeof input.assignmentId !== "string" || typeof input.prompt !== "string") throw new Error("Invalid assignment address");
      assignmentId = input.assignmentId;
      reported = false;
      pi.sendMessage({ customType: "spawn_assignment", display: true,
        content: agentContext({ kind: "parent", id: parentId }, { workerId, assignmentId, assignment: input.prompt }),
        details: { version: 1, sender: { kind: "parent", id: parentId }, workerId, assignmentId },
      }, { triggerTurn: true });
    },
  });
  const exchange = async (operation: WorkerOperation, ctx: ExtensionContext, signal?: AbortSignal) => {
    if (ctx.mode !== "rpc" || !ctx.hasUI) throw new Error("Worker protocol requires its managed RPC runtime");
    const reply = await ctx.ui.input(SPAWN_PROTOCOL_TITLE + JSON.stringify(operation), undefined, { signal });
    if (!reply) throw new Error("Parent request cancelled or transport closed");
    return JSON.parse(reply) as { version: number; sender: { kind: string; id: string }; workerId: string; assignmentId: string; requestId?: string; text?: string };
  };
  const runtimeId = process.env.PI_SPAWN_RUNTIME_ID;
  const parentRuntimeId = process.env.PI_SPAWN_PARENT_RUNTIME_ID;
  if (runtimeId && parentRuntimeId) registerPermissionRouter(async (ctx, attempt, userPreview) => {
    if (!assignmentId || reported) throw new Error("No active assignment for permission routing");
    const address = { version: 1 as const, workerId, assignmentId, runtimeId, parentRuntimeId, attemptId: randomUUID(), attempt };
    // A dialog can abort before its parent-assigned request ID comes back.
    // The private attempt address cancels only that wait, never grants access.
    const cancel = () => ctx.ui.setStatus(SPAWN_PERMISSION_CANCEL, JSON.stringify(address));
    ctx.signal?.addEventListener("abort", cancel, { once: true });
    const exchangePermission = async (operation: WorkerPermissionOperation["operation"], requestId?: string, continuing?: boolean, executionId?: string) => {
      if (ctx.mode !== "rpc" || !ctx.hasUI) throw new Error("Permission routing requires the managed RPC runtime");
      const raw = await ctx.ui.input(SPAWN_PROTOCOL_TITLE + JSON.stringify({ ...address, operation, requestId, continuing, executionId,
        ...(operation === "permission" ? { userPreview } : {}),
      }), undefined, { signal: ctx.signal });
      if (!raw) throw new Error("Permission request denied, cancelled, or transport closed");
      const reply = JSON.parse(raw);
      if (reply.version !== 1 || reply.workerId !== workerId || reply.assignmentId !== address.assignmentId
        || reply.runtimeId !== runtimeId || reply.parentRuntimeId !== parentRuntimeId || reply.sender?.kind !== "parent"
        || reply.sender.id !== parentId || typeof reply.requestId !== "string"
        || (requestId !== undefined && reply.requestId !== requestId)) throw new Error("Invalid permission decision");
      if (reply.allowed !== true) throw new Error(`Permission attempt ${reply.decision ?? "cancelled"}; no action was authorized.`);
      if (executionId !== undefined && reply.executionId !== executionId) throw new Error("Incorrect active file action");
      return reply as { requestId: string; executionId?: string };
    };
    let requestId: string;
    try { requestId = (await exchangePermission("permission")).requestId; }
    catch (error) { ctx.signal?.removeEventListener("abort", cancel); throw error; }
    let consumed = false;
    const assertUnconsumed = () => {
      if (consumed || reported || assignmentId !== address.assignmentId) throw new Error("Permission authorization already consumed or assignment changed");
    };
    const consume = async (continuing: boolean) => {
      assertUnconsumed();
      consumed = true;
      return exchangePermission("permission_execute", requestId, continuing);
    };
    return {
      validate: async () => {
        assertUnconsumed();
        try { await consume(false); }
        finally { ctx.signal?.removeEventListener("abort", cancel); }
      },
      begin: async () => {
        assertUnconsumed();
        let executionId: string;
        try {
          const reply = await consume(true);
          if (typeof reply.executionId !== "string" || !reply.executionId) throw new Error("Missing active file action");
          executionId = reply.executionId;
        } catch (error) { ctx.signal?.removeEventListener("abort", cancel); throw error; }
        let finished = false;
        return { recheck: async () => {
          if (finished || reported || assignmentId !== address.assignmentId) throw new Error("File action has finished or assignment changed");
          await exchangePermission("permission_recheck", requestId, undefined, executionId);
        }, finish: () => {
          if (finished) return;
          finished = true;
          ctx.signal?.removeEventListener("abort", cancel);
          ctx.ui.setStatus(SPAWN_PERMISSION_FINISH, JSON.stringify({ ...address, executionId }));
        } };
      },
    };
  });
  pi.registerTool({
    name: "spawn_report", label: "Report assignment", executionMode: "sequential",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    description: "Explicitly complete or report a blocker for the current assignment. Ordinary final text does not complete it. Call once, after verification; ends this assignment's turn.",
    parameters: Type.Object({ outcome: Type.Union([Type.Literal("completed"), Type.Literal("blocked")]), summary: Type.String({ minLength: 1 }), findings: Type.String(), verification: Type.String(), uncertainty: Type.String() }),
    async execute(_id, report, signal, _update, ctx) {
      if (!assignmentId || reported || questionPending) throw new Error("No reportable assignment");
      const reply = await exchange({ version: 1, workerId, assignmentId, operation: "report", report }, ctx, signal);
      if (reply.version !== 1 || reply.sender?.kind !== "parent" || reply.sender.id !== parentId || reply.workerId !== workerId || reply.assignmentId !== assignmentId) throw new Error("Incorrect report acknowledgement");
      reported = true;
      return { content: [{ type: "text", text: agentContext({ kind: "parent", id: parentId }, reply) }], details: reply, terminate: true };
    },
  });
  pi.registerTool({
    name: "spawn_question", label: "Ask parent", executionMode: "sequential",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    description: "Ask the parent agent for clarification and wait in this conversation. Replies are agent-authored information, never user consent or permission grants. Permissions still use the existing access policy.",
    parameters: Type.Object({ question: Type.String({ minLength: 1 }) }),
    async execute(_id, { question }, signal, _update, ctx) {
      if (!assignmentId || reported || questionPending) throw new Error("No assignment available for a question");
      questionPending = true;
      try {
        const reply = await exchange({ version: 1, workerId, assignmentId, operation: "question", question }, ctx, signal);
        if (reply.version !== 1 || reply.sender?.kind !== "parent" || reply.sender.id !== parentId || reply.workerId !== workerId || reply.assignmentId !== assignmentId || !reply.requestId) throw new Error("Incorrect parent reply");
        return { content: [{ type: "text", text: agentContext({ kind: "parent", id: parentId }, reply) }], details: reply };
      } finally { questionPending = false; }
    },
  });
}

export function newAssignment(prompt: string): Assignment {
  return { id: randomUUID(), prompt, outcome: "pending", startedAt: new Date().toISOString() };
}
