import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { StreamResult } from "./providers/types.ts";

const TTL_MS = 10 * 60_000;
const MAX_ENTRIES = 32;
const MAX_BYTES = 8 * 1024 * 1024;
const ENTRY_CHARS = 256_000;
const PASSAGE_CHARS = 64_000;

interface Entry { owner: string; expires: number; result: StreamResult; bytes: number; clipped: boolean }

/** Memory only: no documents in session JSONL, no cross-session handles. */
export class EvidenceStore {
	private entries = new Map<string, Entry>();
	private bytes = 0;
	private now: () => number;
	constructor(now = Date.now) { this.now = now; }

	put(owner: string, result: StreamResult): { resultId: string; storedCount: number; storedClipped: boolean } | undefined {
		this.prune();
		if (!result.searchResults?.length) return undefined;
		let remaining = ENTRY_CHARS;
		let clipped = false;
		const searchResults = result.searchResults.slice(0, 256).map((hit) => {
			const text = hit.citedText ?? "";
			const citedText = sliceText(text, Math.min(PASSAGE_CHARS, remaining));
			remaining -= citedText.length;
			clipped ||= citedText.length < text.length;
			const stored = { ...hit, citedText };
			for (const field of ["title", "query", "source", "pageAge", "status", "type"] as const) {
				const value = stored[field];
				if (typeof value === "string") {
					stored[field] = sliceText(value, 1000);
					clipped ||= value.length > 1000;
				}
			}
			return stored;
		});
		clipped ||= searchResults.length < result.searchResults.length;
		const stored = structuredClone({ ...result, text: "", searchResults, sources: [], warnings: [] });
		const bytes = Buffer.byteLength(JSON.stringify(stored));
		if (bytes > MAX_BYTES) return undefined;
		while (this.entries.size >= MAX_ENTRIES || this.bytes + bytes > MAX_BYTES) this.remove(this.entries.keys().next().value!);
		const resultId = randomUUID();
		this.entries.set(resultId, { owner, expires: this.now() + TTL_MS, result: stored, bytes, clipped });
		this.bytes += bytes;
		return { resultId, storedCount: searchResults.length, storedClipped: clipped };
	}

	get(owner: string, id: string): { result: StreamResult; clipped: boolean } | undefined {
		this.prune();
		const entry = this.entries.get(id);
		return entry?.owner === owner ? { result: structuredClone(entry.result), clipped: entry.clipped } : undefined;
	}

	clear(owner?: string): void {
		for (const [id, entry] of this.entries) if (owner === undefined || entry.owner === owner) this.remove(id);
	}
	private remove(id: string): void { const entry = this.entries.get(id); if (entry) this.bytes -= entry.bytes; this.entries.delete(id); }
	private prune(): void { for (const [id, entry] of this.entries) if (entry.expires <= this.now()) this.remove(id); }
}

export function sliceText(text: string, limit: number): string {
	let end = Math.max(0, Math.min(text.length, limit));
	if (end < text.length && end > 0 && /[\uD800-\uDBFF]/u.test(text[end - 1])) end--;
	return text.slice(0, end);
}

export function evidenceOwner(ctx: ExtensionContext): string | undefined {
	return ctx.sessionManager?.getSessionId?.();
}

export const evidenceStore = new EvidenceStore();
