import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export type ReadItem = {
  id: string;
  path: string;
  range: string;
};

export type ReadGroup = {
  leadId: string;
  leadMessageId?: string;
  items: ReadItem[];
};

/** Consecutive-read groups. Every mutator is O(1); restore is one O(N) pass. */
export class ReadGrouper {
  private last: ReadGroup | null = null;
  private readonly byId = new Map<string, ReadGroup>();
  private readonly invalidateById = new Map<string, () => void>();

  reset(): void {
    this.last = null;
    this.byId.clear();
    this.invalidateById.clear();
  }

  seeOther(): void {
    this.last = null;
  }

  /** Break the streak unless this text belongs to the message that opened it. */
  seeText(messageId: string): void {
    if (this.last && this.last.leadMessageId === messageId) return;
    this.last = null;
  }

  seeRead(item: ReadItem, messageId?: string): ReadGroup {
    const existing = this.byId.get(item.id);
    if (existing) return existing;
    if (this.last) {
      this.last.items.push(item);
      this.byId.set(item.id, this.last);
      this.invalidateById.get(this.last.leadId)?.();
      this.invalidateById.get(item.id)?.();
      return this.last;
    }
    const group: ReadGroup = { leadId: item.id, leadMessageId: messageId, items: [item] };
    this.last = group;
    this.byId.set(item.id, group);
    return group;
  }

  groupFor(id: string): ReadGroup | undefined {
    return this.byId.get(id);
  }

  bind(id: string, invalidate: () => void): void {
    this.invalidateById.set(id, invalidate);
  }
}

export function sanitizeReadText(text: string): string {
  return text.replace(/\t/g, "    ").replace(/[\x00-\x1f\x7f-\x9f]/g, (char) => {
    return `\\x${char.charCodeAt(0).toString(16).padStart(2, "0")}`;
  });
}

export function formatReadRange(offset: unknown, limit: unknown): string {
  if (offset == null && limit == null) return "";
  const start = typeof offset === "number" ? offset : 1;
  const end = typeof limit === "number" ? start + limit - 1 : "";
  return `:${start}${end === "" ? "" : `-${end}`}`;
}

export function readItemFromArgs(id: string, args: unknown): ReadItem {
  const input = args && typeof args === "object" ? args as Record<string, unknown> : {};
  const raw = typeof input.path === "string" ? input.path
    : typeof input.file_path === "string" ? input.file_path
    : "";
  return { id, path: sanitizeReadText(raw), range: formatReadRange(input.offset, input.limit) };
}

export function readCallText(group: ReadGroup | undefined, fallback: ReadItem): string {
  const items = group?.items ?? [fallback];
  if (items.length > 1) return `read ${items.length} files`;
  const item = items[0] ?? fallback;
  return `read ${item.path}${item.range}`.trimEnd();
}

export function readResultLines(group: ReadGroup | undefined, expanded: boolean): string[] {
  if (!expanded || !group || group.items.length < 2) return [];
  return group.items.map((item) => `  ${item.path}${item.range}`);
}

export function isHiddenRead(group: ReadGroup | undefined, id: string): boolean {
  return !!group && group.leadId !== id;
}

export function replaySessionReads(grouper: ReadGrouper, entries: readonly SessionEntry[]): void {
  grouper.reset();
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role === "user") {
      grouper.seeOther();
      continue;
    }
    if (message.role !== "assistant") continue;
    const messageId = String(message.timestamp);
    for (const part of message.content) {
      if (part.type === "text" && part.text.length > 0) grouper.seeText(messageId);
      else if (part.type === "toolCall" && part.name === "read") {
        grouper.seeRead(readItemFromArgs(part.id, part.arguments), messageId);
      } else if (part.type === "toolCall") {
        grouper.seeOther();
      }
    }
  }
}
