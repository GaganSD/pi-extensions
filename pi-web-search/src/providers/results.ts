import type {
	EvidenceProvider,
	SearchResultDetail,
	Source,
	StreamResult,
} from "./types.ts";

/** `Source.title` is required, so an untitled page falls back to its URL. */
export function sourcesFromResults(results: SearchResultDetail[]): Source[] {
	const sources: Source[] = [];
	for (const result of results) {
		if (result.url) {
			sources.push({ title: result.title || result.url, url: result.url });
		}
	}
	return sources;
}

/** Exact evidence deduplication, not URL-only dedup: distinct passages stay distinct. */
export function uniqueEvidence(result: StreamResult): StreamResult {
	const seen = new Map<string, SearchResultDetail>();
	const searchResults: SearchResultDetail[] = [];
	for (const hit of result.searchResults ?? []) {
		// Keep fragments and query strings: they can identify code lines or different pages.
		const key = JSON.stringify([hit.url, hit.citedText, hit.type]);
		if (!hit.url || !seen.has(key)) {
			searchResults.push({ ...hit });
			if (hit.url) seen.set(key, searchResults[searchResults.length - 1]);
		} else {
			const existing = seen.get(key)!;
			const providers = new Set([...(existing.source ?? "").split(", "), ...(hit.source ?? "").split(", ")].filter(Boolean));
			existing.source = [...providers].join(", ");
		}
	}
	return { ...result, searchResults };
}

/** One global preview count; URL evidence is prioritized rather than silently lost. */
export function previewEvidence(result: StreamResult, maxResults: number, urls: string[] = [], continuation = false): StreamResult {
	const all = result.searchResults ?? [];
	const requested = new Set(urls.map(documentKey));
	const priority = all.filter((hit) => hit.url && requested.has(documentKey(hit.url)) && ["extract", "content"].includes(hit.type ?? ""));
	const prioritized = new Set(priority);
	const rest = all.filter((hit) => !prioritized.has(hit));
	const searchResults = [...priority, ...rest].slice(0, maxResults);
	const selected = new Set(searchResults.flatMap((hit) => hit.url ? [hit.url] : []));
	const omitted = all.length - searchResults.length;
	return {
		...result, searchResults,
		sources: all.length ? (result.sources ?? []).filter((source) => selected.has(source.url)) : result.sources,
		warnings: [...(result.warnings ?? []), ...(omitted ? [`${omitted} additional result(s) omitted from the preview; ${continuation ? "use search_read with the resultId for stored evidence" : "retrieve cited URLs again for more evidence"}.`] : [])],
	};
}

function documentKey(value: string): string {
	try { const url = new URL(value); url.hash = ""; return url.href; } catch { return value; }
}

export interface ProviderContribution {
	kind: EvidenceProvider;
	result: StreamResult;
}

/**
 * Concatenates successful provider results. Hits that share a URL stay
 * distinct — a search hit and a /contents hit are not the same document.
 * Citations (the `sources` index) are deduplicated by URL so the same page is
 * not listed once per provider, and text-only contributions are preserved
 * rather than silently dropped.
 */
export function mergeStreamResults(
	parts: ProviderContribution[],
	extraWarnings: string[] = [],
): StreamResult {
	if (parts.length === 0) {
		throw new Error("mergeStreamResults requires at least one contribution");
	}

	const searchResults: SearchResultDetail[] = [];
	const sources: Source[] = [];
	const seenSourceUrls = new Set<string>();
	const texts: string[] = [];
	const warnings: string[] = [...extraWarnings];
	const usage: { name: string; count: number }[] = [];
	const requestIds: string[] = [];
	const kinds: EvidenceProvider[] = [];

	for (const { kind, result } of parts) {
		kinds.push(kind);
		searchResults.push(...(result.searchResults ?? []));
		const contributed = result.sources?.length
			? result.sources
			: sourcesFromResults(result.searchResults ?? []);
		for (const source of contributed) {
			if (seenSourceUrls.has(source.url)) {
				continue;
			}
			seenSourceUrls.add(source.url);
			sources.push(source);
		}
		if (result.text.length > 0) {
			texts.push(result.text);
		}
		warnings.push(...(result.warnings ?? []));
		usage.push(...(result.usage ?? []));
		if (result.requestId) {
			requestIds.push(`${kind}:${result.requestId}`);
		}
	}

	return {
		text: texts.join("\n\n"),
		providerKind: kinds[0],
		providers: kinds,
		searchResults,
		sources,
		...(requestIds.length > 0 ? { requestId: requestIds.join(",") } : {}),
		...(usage.length > 0 ? { usage } : {}),
		...(warnings.length > 0 ? { warnings } : {}),
	};
}
