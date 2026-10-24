import { sliceText } from "../evidence.ts";
import { getJson, type FetchLike } from "./http.ts";
import type { SearchRequest } from "./index.ts";
import { sourcesFromResults } from "./results.ts";
import { isProviderError, providerError, type SearchResultDetail, type StreamResult } from "./types.ts";

export const JINA_READER_URL = "https://r.jina.ai/";
const MAX_DOCUMENT_CHARS = 64_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const CONCURRENCY = 3;

/** Extraction only. No search, model call, key lookup, or direct target fetch. */
export async function jinaFetch(req: SearchRequest, options: { fetchImpl?: FetchLike } = {}): Promise<StreamResult> {
	const urls = [...new Set(req.urls ?? [])].slice(0, 20);
	if (!urls.length) throw providerError("unknown", "Jina Reader requires URLs.");
	const results: Array<SearchResultDetail | undefined> = new Array(urls.length);
	const errors: unknown[] = new Array(urls.length);
	let cursor = 0;
	await Promise.all(Array.from({ length: Math.min(CONCURRENCY, urls.length) }, async () => {
		while (cursor < urls.length) {
			if (req.signal?.aborted) throw req.signal.reason;
			const index = cursor++;
			try {
				const url = new URL(urls[index]);
				if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw providerError("unknown", "Jina Reader requires public HTTP(S) URLs without credentials.");
				url.hash = "";
				const body = await getJson<unknown>(JINA_READER_URL + url.href, {
					headers: { Accept: "application/json", "X-Respond-With": "markdown", "X-Retain-Images": "none", "X-Retain-Links": "none" },
					signal: req.signal, timeoutMs: req.settings.timeoutMs,
					maxResponseBytes: MAX_RESPONSE_BYTES, fetchImpl: options.fetchImpl,
				});
				const data = record(record(body)?.data);
				if (!data || typeof data.content !== "string" || !data.content.trim() || typeof data.url !== "string") throw providerError("parse_error", "Jina Reader returned no identified page content.", { retryable: true });
				if (typeof data.httpStatus === "number" && data.httpStatus >= 400) throw providerError("http_error", `Jina target returned HTTP ${data.httpStatus}.`, { status: data.httpStatus });
				let returned: URL;
				try { returned = new URL(data.url); } catch { throw providerError("parse_error", "Jina Reader returned an invalid page URL.", { retryable: true }); }
				returned.hash = "";
				if (returned.href !== url.href) throw providerError("parse_error", "Jina Reader returned a different page; content withheld.", { retryable: true });
				const citedText = sliceText(data.content, MAX_DOCUMENT_CHARS);
				results[index] = { url: urls[index], title: typeof data.title === "string" ? data.title : undefined,
					source: "jina", type: "content", citedText,
					...(citedText.length < data.content.length ? { status: "provider_excerpt_clipped" } : {}),
				};
			} catch (error) {
				if (req.signal?.aborted) throw req.signal.reason;
				errors[index] = error;
			}
		}
	}));
	const searchResults = results.filter((hit): hit is SearchResultDetail => hit !== undefined);
	if (!searchResults.length) throw errors.find((error) => error !== undefined) ?? providerError("parse_error", "Jina Reader returned no pages.");
	const warnings = errors.flatMap((error, index) => error ? [`Jina URL ${index + 1} failed (${isProviderError(error) ? error.code : "unknown"}).`] : []);
	if (searchResults.some((hit) => hit.status === "provider_excerpt_clipped")) warnings.push("Jina evidence clipped to 64000 characters per page.");
	return { text: "", providerKind: "jina", searchResults, sources: sourcesFromResults(searchResults), ...(warnings.length ? { warnings } : {}) };
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
