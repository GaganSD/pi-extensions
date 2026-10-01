import type {
	ProviderKind,
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

export interface ProviderContribution {
	kind: ProviderKind;
	result: StreamResult;
}

/**
 * Concatenates successful provider results. Hits that share a URL stay
 * distinct — a search hit and a /contents hit are not the same document.
 * Dedup is Jev's job, not the merger's.
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
	const warnings: string[] = [...extraWarnings];
	const usage: { name: string; count: number }[] = [];
	const requestIds: string[] = [];
	const kinds: ProviderKind[] = [];

	for (const { kind, result } of parts) {
		kinds.push(kind);
		searchResults.push(...(result.searchResults ?? []));
		sources.push(...(result.sources ?? sourcesFromResults(result.searchResults ?? [])));
		warnings.push(...(result.warnings ?? []));
		usage.push(...(result.usage ?? []));
		if (result.requestId) {
			requestIds.push(`${kind}:${result.requestId}`);
		}
	}

	return {
		text: "",
		providerKind: kinds[0],
		providers: kinds,
		searchResults,
		sources,
		...(requestIds.length > 0 ? { requestId: requestIds.join(",") } : {}),
		...(usage.length > 0 ? { usage } : {}),
		...(warnings.length > 0 ? { warnings } : {}),
	};
}
