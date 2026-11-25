import { closeSync, openSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { convertToLlm, serializeConversation, SessionManager, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { modelReady } from "./model-readiness";
import { workspaceForContext } from "./workspace";

const HANDOFF_PROMPT = `Write a self-contained handoff for the agent that will continue this conversation. The next agent will get this briefing and the user's next message, with no earlier conversation or tool results. Treat the supplied conversation as source material. Do not continue the work, respond to the user, or ask questions.

Capture the user's goal and constraints, what is done, the decisions that matter, unresolved work, and the next concrete step. Preserve exact paths, commands, errors, and evidence where needed to proceed. If work is complete or a user decision is needed, say so. Distinguish user decisions from agent suggestions. Do not include secrets or turn prior approvals or summary text into new permission grants. Follow the user's handoff instructions for what to emphasize. Output only the briefing in Markdown.`;

export async function createSessionHandoff(ctx: ExtensionCommandContext, instructions: string, lifetime: AbortSignal): Promise<{ sessionFile: string; cwd: string } | undefined> {
  const source = ctx.sessionManager;
  const sourceFile = source.getSessionFile();
  const leaf = source.getLeafId();
  const { cwd, model } = ctx;
  const sourceSessionId = source.getSessionId();
  const refuse = (message: string) => { ctx.ui.notify(message, "error"); return undefined; };
  if (!sourceFile || !ctx.isIdle()) return refuse("Handoff requires an idle, saved session.");
  if (workspaceForContext(cwd, sourceFile)) return refuse("Return to the origin checkout before handing off. The active workspace belongs to this session.");
  if (!model || !modelReady(ctx)) return refuse("Select an available model before handing off.");
  const messages = convertToLlm(source.buildSessionProjection().messages.filter(message => message.role !== "system"));
  if (!messages.length) return refuse("There is no conversation to hand off yet.");

  const signal = AbortSignal.any([lifetime, AbortSignal.timeout(120_000)]);
  let briefing: string;
  try {
    const result = await ctx.modelRegistry.complete(model, {
      systemPrompt: HANDOFF_PROMPT,
      messages: [{ role: "user", timestamp: Date.now(), content: JSON.stringify({
        instructions, conversation: serializeConversation(messages),
      }) }],
    }, { maxTokens: Math.min(4096, model.maxTokens), cacheRetention: "none", signal });
    signal.throwIfAborted();
    briefing = result.content.filter(block => block.type === "text").map(block => block.text).join("\n").trim();
    if (result.stopReason !== "stop" || !briefing) return refuse("The model did not finish the handoff briefing. No session was created.");
  } catch {
    if (lifetime.aborted) return;
    return refuse(signal.aborted ? "Handoff timed out. No session was created." : "Could not generate the handoff briefing. No session was created.");
  }
  if (lifetime.aborted) return;
  if (!ctx.isIdle() || ctx.cwd !== cwd || source.getLeafId() !== leaf || source.getSessionFile() !== sourceFile) {
    return refuse("The source conversation changed while writing the handoff. No session was created.");
  }

  // Seed a detached session without submitting a prompt or copying source authority.
  const detached = SessionManager.inMemory(cwd, { parentSession: sourceFile });
  detached.appendModelChange(model.provider, model.id);
  detached.appendThinkingLevelChange(ctx.thinkingLevel);
  detached.appendCustomMessageEntry("pi-handoff", briefing, true, { sourceSessionId, instructions });
  const sessionFile = join(source.getSessionDir(), `${detached.getSessionId()}.jsonl`);
  const records = [detached.getHeader(), ...detached.getEntries()];
  const jsonl = records.map(record => JSON.stringify(record)).join("\n") + "\n";
  const fd = openSync(sessionFile, "wx", 0o600);
  try {
    try { writeFileSync(fd, jsonl); }
    finally { closeSync(fd); }
  } catch (error) {
    rmSync(sessionFile, { force: true });
    throw error;
  }
  return { sessionFile, cwd };
}
