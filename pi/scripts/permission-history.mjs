import { createHash } from "node:crypto";

export const PERMISSION_HISTORY = "pi-permission-history";

/** A reference to observed content, never submitted prompt text. */
export function messageKey(message) {
  const content = [message.role, "timestamp" in message ? message.timestamp : null,
    "content" in message ? message.content : message];
  return createHash("sha256").update(JSON.stringify(content, (_key, value) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value)).digest("hex");
}

export function updatePermissionHistory(items, data, afterMessage) {
  if (!data || typeof data !== "object" || data.version !== 1 || typeof data.id !== "string") return items;
  if (data.state === "pending") {
    if (!["tool", "mode", "scope", "request", "directory", "preview", "previewFiletype", "requestedAt"]
      .every(key => typeof data[key] === "string") || !Array.isArray(data.options)
      || !data.options.every(option => typeof option === "string") || items.some(item => item.id === data.id)) return items;
    return [...items, { ...data, afterMessage }];
  }
  if (data.state !== "allowed" && data.state !== "denied" && data.state !== "cancelled") return items;
  return items.map(item => item.id === data.id ? {
    ...item, state: data.state,
    choice: typeof data.choice === "string" ? data.choice : undefined,
    reason: typeof data.reason === "string" ? data.reason : undefined,
    answeredAt: typeof data.answeredAt === "string" ? data.answeredAt : undefined,
  } : item);
}

/** Callers supply one branch, never every entry in the session tree. */
export function permissionHistory(branch) {
  let items = [], anchor = null;
  for (const entry of branch) {
    if (entry.type === "message") anchor = messageKey(entry.message);
    else if (entry.type === "custom" && entry.customType === PERMISSION_HISTORY) {
      items = updatePermissionHistory(items, entry.data, anchor);
    }
  }
  return items;
}

/** Keep lifecycle status frames below the RPC limit even after JSON escaping.
 * Full records always remain in the owner's saved transcript. */
export function permissionSnapshot(branch) {
  const history = permissionHistory(branch);
  const items = [];
  let bytes = 0;
  for (let index = history.length - 1; index >= 0 && items.length < 128; index--) {
    const record = history[index];
    // Pre-separation audit records can contain user-only file diffs. Status
    // frames are not a read-authorized channel for those contents.
    const next = record.previewAudience === "model" ? record : {
      ...record, preview: `${record.tool}: ${record.scope}`, previewFiletype: "text",
    };
    const length = Buffer.byteLength(JSON.stringify(next));
    if (bytes + length > 4 * 1024 * 1024) break;
    items.unshift(next);
    bytes += length;
  }
  return { version: 1, items, omitted: history.length - items.length };
}
