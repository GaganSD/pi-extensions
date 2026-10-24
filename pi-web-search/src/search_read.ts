import { Type, type Static } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { evidenceOwner, evidenceStore, sliceText } from "./evidence.ts";
import { formatResult } from "./format.ts";
import { providerError } from "./providers/types.ts";
import { formatSearchError } from "./utils.ts";

export const SearchReadSchema = Type.Object({
	resultId: Type.String({ maxLength: 100, description: "Stored search result handle" }),
	index: Type.Optional(Type.Integer({ minimum: 0, maximum: 255, description: "Zero-based result index; omit to list stored results" })),
	offset: Type.Optional(Type.Integer({ minimum: 0 })),
	limit: Type.Optional(Type.Integer({ minimum: 2, maximum: 4000 })),
	find: Type.Optional(Type.String({ minLength: 1, maxLength: 200, description: "Case-insensitive literal passage search; cannot combine with offset" })),
});

export function searchRead(params: Static<typeof SearchReadSchema>, ctx: ExtensionContext, signal?: AbortSignal) {
	try {
		if (signal?.aborted) throw providerError("aborted", "Reading evidence was aborted.");
		const owner = evidenceOwner(ctx);
		const entry = owner ? evidenceStore.get(owner, params.resultId) : undefined;
		if (!entry) throw providerError("unknown", "Evidence is unavailable: expired, evicted, reloaded, or from another session. Retrieve the URL again.");
		const hits = entry.result.searchResults ?? [];
		if (params.index === undefined) {
			if (params.find !== undefined || params.offset !== undefined) throw providerError("unknown", "Supply index to read or find a passage.");
			const list = hits.map((hit, index) => `${index}. ${hit.url ?? "(no URL)"} — ${(hit.title ?? "").slice(0, 100)}`);
			const full = list.join("\n");
			return formatResult(sliceText(full, 8000) + (full.length > 8000 ? "\n[List truncated; select a known index to read evidence.]" : ""), {
				resultId: params.resultId, storedCount: hits.length, storedClipped: entry.clipped,
				resultCount: hits.length, grounded: hits.some((hit) => !!hit.url),
			});
		}
		const hit = hits[params.index];
		if (!hit) throw providerError("unknown", `No stored result at index ${params.index}.`);
		const text = hit.citedText ?? "";
		const limit = Math.max(2, Math.min(4000, params.limit ?? 2000));
		let offset = Math.max(0, params.offset ?? 0);
		let matches: number | undefined;
		if (params.find !== undefined) {
			if (params.offset !== undefined || !params.find.trim()) throw providerError("unknown", "find must be nonblank and cannot combine with offset.");
			// JS /iu matching keeps offsets in the original string (lowercasing can change length).
			const pattern = new RegExp(params.find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
			matches = 0;
			let first = 0;
			for (const match of text.matchAll(pattern)) { if (matches === 0) first = match.index; matches++; }
			const contextChars = Math.min(200, Math.floor(Math.max(0, limit - params.find.length) / 2));
			offset = matches ? Math.max(0, first - contextChars) : 0;
		}
		if (offset > 0 && /[\uDC00-\uDFFF]/u.test(text[offset] ?? "")) offset--;
		const passage = matches === 0 ? "" : sliceText(text.slice(offset), limit);
		const nextOffset = offset + passage.length;
		return formatResult(`${hit.url ?? hit.title ?? "Stored evidence"}\n\n${matches === 0 ? "No matching passage." : passage}\n\n${entry.clipped ? "Local storage limits clipped evidence. " : ""}Provider-returned evidence; not guaranteed to be a full page.`, {
			resultId: params.resultId, storedCount: hits.length, storedClipped: entry.clipped,
			provider: entry.result.providerKind, resultCount: 1, grounded: !!hit.url,
			sources: hit.url ? [{ title: hit.title ?? hit.url, url: hit.url }] : [],
			searchResults: [{ ...hit, citedText: passage }],
			passage: { index: params.index, offset, totalChars: text.length, ...(matches === undefined ? {} : { matches }), ...(matches !== 0 && nextOffset < text.length ? { nextOffset } : {}) },
		});
	} catch (error) { return formatSearchError("search_read", error); }
}
