const exact = (p, keys) => Object.keys(p).length === keys.length && keys.every((key) => key in p);
const entry = (v) => typeof v === "string" && /^[\w-]{1,128}$/.test(v);

// Shared payload checks for public operations; each caller validates its own envelope.
export function validPublicBundled(operation, p) {
  switch (operation) {
    case "access.set": return exact(p, ["mode"]) && typeof p.mode === "string" && ["readonly", "ask", "edit", "full"].includes(p.mode);
    case "integration.set": return exact(p, ["mode"]) && typeof p.mode === "string" && ["ask", "allowed"].includes(p.mode);
    case "access.cycle": case "integration.cycle": {
      const allowed = operation === "access.cycle" ? ["readonly", "ask", "edit", "full"] : ["ask", "allowed"];
      return exact(p, ["modes"]) && Array.isArray(p.modes) && p.modes.length > 0 && p.modes.length <= allowed.length
        && new Set(p.modes).size === p.modes.length && p.modes.every((mode) => typeof mode === "string" && allowed.includes(mode));
    }
    case "session.handoff": return exact(p, ["instructions"]) && typeof p.instructions === "string" && Buffer.byteLength(p.instructions) <= 65536;
    case "history.navigate": return exact(p, ["entryId", "summarize"]) && entry(p.entryId) && typeof p.summarize === "boolean";
    case "history.clone": case "history.fork": case "history.delete": return exact(p, ["entryId"]) && entry(p.entryId);
    case "workspace.enter": case "workspace.integrate": case "workspace.discard":
      return Object.keys(p).every((key) => key === "id" || operation === "workspace.enter" && key === "ignoredFiles" || operation === "workspace.integrate" && key === "commitMessage")
        && (p.commitMessage === undefined || typeof p.commitMessage === "string" && !!p.commitMessage.trim() && !p.commitMessage.includes("\0") && Buffer.byteLength(p.commitMessage) <= 16384)
        && (p.id === undefined || entry(p.id))
        && (p.ignoredFiles === undefined || Array.isArray(p.ignoredFiles) && p.ignoredFiles.length <= 128 && p.ignoredFiles.every((v) => typeof v === "string" && v.length <= 4096));
    case "workspace.undo": case "workspace.revert": return exact(p, ["id", "reason"]) && entry(p.id)
      && typeof p.reason === "string" && !!p.reason.trim() && !p.reason.includes("\0") && Buffer.byteLength(p.reason) <= 8192;
    case "history.prune": case "usage.refresh": case "title.generate": case "side.open": return exact(p, []);
    case "notifications.set": return exact(p, ["enabled"]) && typeof p.enabled === "boolean";
    case "side.reset": return exact(p, ["fromId", "abort"]) && entry(p.fromId) && typeof p.abort === "boolean";
    case "side.select": return exact(p, ["id", "fromId", "abort"]) && entry(p.id) && entry(p.fromId) && typeof p.abort === "boolean";
    case "side.delete": case "side.abort": return exact(p, ["id"]) && entry(p.id);
    case "side.prompt": return exact(p, ["id", "text"]) && entry(p.id) && typeof p.text === "string" && !!p.text.trim() && Buffer.byteLength(p.text) <= 1024 * 1024;
    case "side.draft": return exact(p, ["id", "text"]) && entry(p.id) && typeof p.text === "string" && Buffer.byteLength(p.text) <= 1024 * 1024;
    case "bash.list": return Object.keys(p).every(key => key === "offset") && (p.offset === undefined || Number.isSafeInteger(p.offset) && Number(p.offset) >= 0);
    case "bash.status": case "bash.join": case "bash.stop": return exact(p, ["jobId"]) && typeof p.jobId === "string" && /^[A-Za-z0-9_-]{22}$/.test(p.jobId);
    case "bash.cancel-wait": return exact(p, ["invocationId"]) && entry(p.invocationId);
    case "spawn.join": case "spawn.stop": return exact(p, ["id"]) && entry(p.id);
    default: return false;
  }
}
