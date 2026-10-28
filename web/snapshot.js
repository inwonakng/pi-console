// A response replaces each included section, including cleared optional fields.
const fields = {
  history: ["messages", "messageKeys", "omittedMessages", "historyRevision", "hydrated"],
  tools: ["tools"],
  activity: ["partialAssistant", "diagnostics", "permissions", "omittedPermissions", "work", "queue", "execution"],
  status: ["statuses", "widgets", "title", "piState", "stats"],
};
// Finish one immutable owner snapshot before replacing the rendered baseline.
// Each request is bounded; the accumulated transcript has no message/byte cap.
export async function loadSnapshotHistory(result, read) {
  const value = result?.snapshot || result;
  const sources = [value?.conversation, value?.conversationSections?.history, value?.preview];
  for (const source of sources) {
    if (!source?.historyPage) continue;
    const { id, count } = source.historyPage;
    if (typeof id !== "string" || !Number.isSafeInteger(count) || count < 1
      || !Array.isArray(source.messages) || !Array.isArray(source.messageKeys)) throw new Error("Invalid snapshot history");
    while (source.historyPage) {
      const cursor = source.historyPage;
      if (cursor.id !== id || cursor.count !== count || cursor.offset !== source.messages.length) throw new Error("Invalid snapshot history cursor");
      const page = await read({ id, offset: cursor.offset });
      if (!Array.isArray(page?.messages) || !page.messages.length || !Array.isArray(page.messageKeys)
        || page.messageKeys.length !== page.messages.length || source.messages.length + page.messages.length > count) throw new Error("Invalid snapshot history page");
      for (let index = 0; index < page.messages.length; index++) {
        source.messages.push(page.messages[index]);
        source.messageKeys.push(page.messageKeys[index]);
      }
      if (page.historyPage) source.historyPage = page.historyPage;
      else delete source.historyPage;
    }
    if (source.messages.length !== count || source.messageKeys.length !== count) throw new Error("Incomplete snapshot history");
  }
  return result;
}

export function snapshotQuery(snapshot, hello) {
  return snapshot?.conversationRevisions && hello?.capabilities.includes("snapshot.sections")
    ? { known: { sessionId: snapshot.sessionId, serviceEpoch: snapshot.serviceEpoch, runtimeRevision: snapshot.runtimeRevision,
      conversationRevisions: snapshot.conversationRevisions } } : {};
}
export function mergeSnapshot(previous, value) {
  if (value.conversation) return value;
  if (!previous || previous.sessionId !== value.sessionId || previous.serviceEpoch !== value.serviceEpoch
    || previous.runtimeRevision !== value.runtimeRevision || !value.conversationSections || !value.conversationRevisions) {
    throw new Error("Snapshot sections require a matching baseline");
  }
  const conversation = { ...previous.conversation };
  for (const [section, keys] of Object.entries(fields)) {
    const changed = value.conversationSections[section];
    if (changed) {
      for (const key of keys) {
        delete conversation[key];
        if (Object.hasOwn(changed, key)) conversation[key] = changed[key];
      }
    } else if (previous.conversationRevisions[section] !== value.conversationRevisions[section]) {
      throw new Error("Snapshot section baseline changed");
    }
  }
  const { conversationSections, ...state } = value;
  return { ...state, conversation };
}
