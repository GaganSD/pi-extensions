import { open } from "node:fs/promises";

const PAGE_BYTES = 65536;
export interface ConversationMessage { offset: number; label: string; text: string; tool: boolean }
export interface ConversationPage { messages: ConversationMessage[]; before?: number; omitted: boolean }
export function conversationText(value: string, max = 16384): string {
  const safe = value.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e-\u200f\u202a-\u202e\u2066-\u2069]/g, "");
  return safe.length > max ? `${safe.slice(0, max)}\n[message clipped; original available in Details]` : safe;
}
/** On-demand bounded pages of finalized SDK messages, not execution authority. */
export async function readConversation(path: string, before?: number): Promise<ConversationPage> {
  const file = await open(path, "r");
  try {
    const size = (await file.stat()).size;
    const end = Math.min(size, before ?? size), start = Math.max(0, end - PAGE_BYTES);
    const bytes = Buffer.alloc(end - start);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, start);
    const data = bytes.subarray(0, bytesRead);
    let from = start ? data.indexOf(0x0a) + 1 : 0;
    if (start && from === 0) return { messages: [], before: start, omitted: true };
    const cursor = start + from;
    const messages: ConversationMessage[] = [];
    let invalid = false;
    while (from < data.length) {
      const next = data.indexOf(0x0a, from);
      if (next < 0) break; // Incomplete writer tail is not a finalized message.
      const offset = start + from;
      try {
        const entry = JSON.parse(data.subarray(from, next).toString("utf8"));
        const message = entry.type === "message" ? entry.message : undefined;
        const role = message?.role;
        if (["user", "assistant", "toolResult"].includes(role)) {
          const parts: string[] = [];
          for (const block of Array.isArray(message.content) ? message.content : [{ type: "text", text: message.content }]) {
            if (block?.type === "text" && typeof block.text === "string") parts.push(conversationText(block.text));
            else if (block?.type === "toolCall") parts.push(`Tool · ${conversationText(String(block.name), 80)}\n${conversationText(JSON.stringify(block.arguments ?? {}), 8192)}`);
          }
          if (parts.length) messages.push({ offset, label: role === "user" ? "Instruction" : role === "assistant" ? "Sub-agent" : `Tool output · ${conversationText(message.toolName ?? "tool", 80)}`,
            text: conversationText(parts.join("\n\n")), tool: role === "toolResult" || (Array.isArray(message.content) && message.content.some((block: { type?: string }) => block?.type === "toolCall")) });
        }
      } catch { invalid = true; /* Torn/invalid entries never become terminal controls. */ }
      from = next + 1;
    }
    const retained = messages.slice(-128);
    const previous = retained.length < messages.length ? retained[0]!.offset : cursor;
    return { messages: retained, ...(previous ? { before: previous } : {}), omitted: start > 0 || retained.length < messages.length || invalid || from < data.length };
  } finally { await file.close(); }
}
