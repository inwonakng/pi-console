import { randomUUID } from "node:crypto";
import { object } from "./pi-records.js";
import { CommandError } from "./session-commands.js";

const PAGE_BYTES = 1024 * 1024;
type History = { messages: unknown[]; messageKeys: unknown[] };
type Transfer = History & { offset: number; done: () => void };

/** Immutable snapshot history, paged within one attachment. No total history cap. */
export class SnapshotPages {
  private readonly transfers = new Map<string, Transfer>();

  clear(): void {
    for (const transfer of this.transfers.values()) transfer.done();
    this.transfers.clear();
  }

  prepare(record: unknown): Promise<void> {
    if (!object(record) || record.type !== "response" || !record.success || !object(record.result)) return Promise.resolve();
    const completed: Promise<void>[] = [];
    const value = object(record.result.snapshot) ? record.result.snapshot : record.result;
    const sources = [value.conversation, object(value.conversationSections) ? value.conversationSections.history : undefined, value.preview];
    for (const source of sources) {
      if (!object(source) || !Array.isArray(source.messages) || !Array.isArray(source.messageKeys)) continue;
      const history = { messages: source.messages, messageKeys: source.messageKeys };
      if (this.end(history, 0) === history.messages.length) continue;
      if (this.transfers.size >= 32) throw new CommandError("resource_limit", "Too many unfinished snapshot histories");
      const id = randomUUID();
      completed.push(new Promise<void>((done) => this.transfers.set(id, { ...history, offset: 0, done })));
      source.messages = [];
      source.messageKeys = [];
      source.historyPage = { id, offset: 0, count: history.messages.length };
    }
    return Promise.all(completed).then(() => undefined);
  }

  read(value: unknown): History & { historyPage?: { id: string; offset: number; count: number } } {
    if (!object(value) || Object.keys(value).length !== 2 || typeof value.id !== "string"
      || !Number.isSafeInteger(value.offset) || Number(value.offset) < 0) {
      throw new CommandError("invalid_command", "Invalid snapshot history cursor");
    }
    const transfer = this.transfers.get(value.id);
    if (!transfer || value.offset !== transfer.offset) throw new CommandError("stale_runtime", "Snapshot history cursor expired or attachment changed");
    const end = this.end(transfer, transfer.offset);
    const page = { messages: transfer.messages.slice(transfer.offset, end), messageKeys: transfer.messageKeys.slice(transfer.offset, end) };
    transfer.offset = end;
    if (end === transfer.messages.length) { this.transfers.delete(value.id); transfer.done(); return page; }
    return { ...page, historyPage: { id: value.id, offset: end, count: transfer.messages.length } };
  }

  private end(history: History, start: number): number {
    let bytes = 0, end = start;
    while (end < history.messages.length) {
      const next = Buffer.byteLength(JSON.stringify(history.messages[end])) + Buffer.byteLength(JSON.stringify(history.messageKeys[end])) + 2;
      // A single large message still fits the existing 16-MiB record budget.
      if (end > start && bytes + next > PAGE_BYTES) break;
      bytes += next;
      end++;
    }
    return end;
  }
}
