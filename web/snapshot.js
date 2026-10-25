// A response replaces each included section, including cleared optional fields.
const fields = {
  history: ["messages", "messageKeys", "omittedMessages", "historyRevision", "hydrated"],
  tools: ["tools"],
  activity: ["partialAssistant", "diagnostics", "permissions", "omittedPermissions", "work", "queue", "execution"],
  status: ["statuses", "widgets", "title", "piState", "stats"],
};
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
