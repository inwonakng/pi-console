import { isAbsolute } from "node:path";
import { completeFiles, type ResourceContext } from "./resource-reads.js";
import { CommandError } from "./session-commands.js";

/** Filename discovery needs only the selected host directory, not a worker,
 * session file, project trust decision, or permission to read file contents. */
export async function completeHostFiles(cwd: unknown, input: unknown, check: () => void): Promise<Awaited<ReturnType<typeof completeFiles>>> {
  check();
  if (typeof cwd !== "string" || !isAbsolute(cwd) || Buffer.byteLength(cwd) > 4096
    || /[\u0000-\u001f\u007f]/.test(cwd) || cwd.split(/[\\/]/).includes("..")) {
    throw new CommandError("invalid_command", "Host file completion requires an absolute selected directory");
  }
  // completeFiles uses cwd/workspaceRoot/check only. Leave session-only roots
  // empty; this context is never passed to readResource or provenance helpers.
  const context: ResourceContext = { cwd, workspaceRoot: cwd, check, sessionFile: "",
    workspacesRoot: "", tempRoot: "", skillPaths: [], liveOutputPaths: [] };
  return completeFiles(context, input);
}
