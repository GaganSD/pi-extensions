import { open } from "node:fs/promises";
import { plain } from "./ui.ts";
import { PREVIEW_LINES } from "./types.ts";
const TAIL_BYTES = 65536;

/** Bounded, terminal-safe summary; original content remains in the SDK transcript. */
export function formatMessage(message: unknown): string | undefined {
  if (!message || typeof message !== "object" || Array.isArray(message)) return undefined;
  const row = message as { role?: string; content?: unknown };
  const labels: Record<string, string> = { user: "you", assistant: "sub-agent", toolResult: "out" };
  const label = typeof row.role === "string" ? labels[row.role] : undefined;
  if (!label) return undefined;
  const blocks = Array.isArray(row.content) ? row.content : [{ type: "text", text: row.content }];
  const parts: string[] = [];
  let length = 0;
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    const item = block as { type?: string; text?: string; name?: string };
    let value = "";
    if (item.type === "text" && typeof item.text === "string") value = item.text;
    else if (item.type === "toolCall" && typeof item.name === "string") value = `tool ${item.name}`;
    if (!value) continue;
    const text = plain(value.slice(0, 4096), 512).replace(/\s+/g, " ").trim();
    if (text) { parts.push(text); length += text.length; }
    if (length >= 512) break;
  }
  return parts.length ? plain(`${label.padEnd(5)} ${parts.join(" · ")}`, 512) : undefined;
}

export function formatEntry(entry: unknown): string | undefined {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
  const row = entry as { type?: string; message?: unknown };
  return row.type === "message" ? formatMessage(row.message) : undefined;
}

/** One bounded async fallback read. Never read files from terminal rendering. */
export async function readTranscript(path: string | undefined, maxLines = PREVIEW_LINES): Promise<string[]> {
  if (!path) return ["(no transcript yet)"];
  const limit = Math.max(1, Math.min(PREVIEW_LINES, maxLines));
  // Only file I/O maps to "unavailable"; parse/format errors stay visible as skipped lines.
  const readWindow = async () => {
    const file = await open(path, "r");
    try {
      const { size } = await file.stat();
      const start = Math.max(0, size - TAIL_BYTES);
      const buffer = Buffer.alloc(Math.min(size, TAIL_BYTES));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
      return { size, start, bytes: buffer.subarray(0, bytesRead) };
    } finally { try { await file.close(); } catch { /* Closing a UI fallback never determines run success. */ } }
  };
  let size: number, start: number, bytes: Buffer;
  try { ({ size, start, bytes } = await readWindow()); } catch { return ["(transcript unavailable)"]; }
  let from = 0;
  if (start) {
    const newline = bytes.indexOf(0x0a); // Discard a partial first JSONL entry.
    if (newline === -1) return ["(earlier/oversized entries omitted; read the full transcript)"];
    from = newline + 1;
  }
  const lines: string[] = [];
  for (const line of bytes.subarray(from).toString("utf8").split("\n")) {
    if (!line) continue;
    try {
      const formatted = formatEntry(JSON.parse(line));
      if (formatted) lines.push(formatted);
    } catch { /* A writer may not have finished its last entry yet. */ }
  }
  const notice = start ? "(earlier/oversized entries omitted; read the full transcript)" : undefined;
  if (!lines.length) {
    const empty = size ? "(no complete displayable messages yet)" : "(no messages yet)";
    return notice ? [notice, empty] : [empty];
  }
  if (notice) return [notice, ...lines.slice(-(limit - 1))];
  return lines.slice(-limit);
}
