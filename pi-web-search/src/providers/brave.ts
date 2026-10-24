import { braveApiKey } from "../env.ts";
import { getJson, type FetchLike } from "./http.ts";
import type { SearchRequest } from "./index.ts";
import { jinaFetch } from "./jina.ts";
import { mergeStreamResults, sourcesFromResults } from "./results.ts";
import { isProviderError, providerError, type SearchResultDetail, type StreamResult } from "./types.ts";

export const BRAVE_SEARCH_URL = "https://api.search.brave.com/res/v1/web/search";

/** Raw ranked snippets only: no generated answer, extra snippets, or new tool schema. */
export async function braveSearch(req: SearchRequest, options: { fetchImpl?: FetchLike } = {}): Promise<StreamResult> {
	if (req.fetchOnly) return jinaFetch(req, options);
	const key = braveApiKey();
	if (!key) throw providerError("missing_credentials", "Brave requires BRAVE_API_KEY or a stored brave key.");
	if (!req.query.trim() || req.query.length > 400 || req.query.trim().split(/\s+/u).length > 50) throw providerError("unknown", "Brave queries must contain 1–400 characters and at most 50 words.");
	const url = new URL(BRAVE_SEARCH_URL);
	url.searchParams.set("q", req.query);
	url.searchParams.set("count", String(req.settings.maxResults));
	url.searchParams.set("text_decorations", "false");
	const [search, fetched] = await Promise.allSettled([
		getJson<unknown>(url.href, { headers: { Accept: "application/json", "X-Subscription-Token": key },
			signal: req.signal, timeoutMs: req.settings.timeoutMs, maxResponseBytes: 1024 * 1024, fetchImpl: options.fetchImpl }),
		req.urls?.length ? jinaFetch(req, options) : Promise.resolve(undefined),
	]);
	if (search.status === "rejected") {
		if (search.reason instanceof Error) search.reason.message = search.reason.message.replaceAll(key, "[redacted]");
		throw search.reason;
	}
	const body = record(search.value);
	const web = record(body?.web);
	const items = web?.results ?? (body?.type === "search" && body.web === undefined ? [] : undefined);
	if (!Array.isArray(items)) throw providerError("parse_error", "Brave returned an invalid result envelope.", { retryable: true });
	const searchResults = items.flatMap((value): SearchResultDetail[] => {
		const hit = record(value);
		if (!hit || typeof hit.url !== "string") return [];
		try {
			const parsed = new URL(hit.url);
			if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) return [];
		} catch { return []; }
		return [{ url: hit.url, source: "brave", title: typeof hit.title === "string" ? plainText(hit.title) : undefined,
			citedText: typeof hit.description === "string" ? plainText(hit.description) : "",
			pageAge: typeof hit.page_age === "string" ? hit.page_age : null }];
	}).slice(0, req.settings.maxResults);
	if (items.length && !searchResults.length) throw providerError("parse_error", "Brave returned no valid public result URLs.", { retryable: true });
	const result: StreamResult = { text: "", providerKind: "brave", searchResults, sources: sourcesFromResults(searchResults) };
	if (fetched.status === "rejected") {
		if (req.signal?.aborted || (isProviderError(fetched.reason) && fetched.reason.code === "aborted")) throw fetched.reason;
		return { ...result, warnings: [`Jina URL extraction failed (${isProviderError(fetched.reason) ? fetched.reason.code : "unknown"}).`] };
	}
	return fetched.value ? mergeStreamResults([{ kind: "brave", result }, { kind: "jina", result: fetched.value }]) : result;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function plainText(text: string): string {
	const named: Record<string, string> = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " " };
	return text.replace(/<\/?(?:b|strong|em|mark)\b[^>]*>/gi, "").replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi, (entity, value: string) => {
		if (!value.startsWith("#")) return named[value.toLowerCase()] ?? entity;
		const code = value[1].toLowerCase() === "x" ? parseInt(value.slice(2), 16) : Number(value.slice(1));
		return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : entity;
	});
}
