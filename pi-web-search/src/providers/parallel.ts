import { type FetchLike, postJson } from "./http.ts";
import type { SearchRequest } from "./index.ts";
import {
	type SearchResultDetail,
	type Source,
	type StreamResult,
	isProviderError,
	providerError,
} from "./types.ts";

const PROVIDER_NAME = "parallel";

/** GA endpoints. `/v1beta/*` is legacy and reserved for existing integrations. */
const SEARCH_URL = "https://api.parallel.ai/v1/search";
const EXTRACT_URL = "https://api.parallel.ai/v1/extract";

/**
 * Mode is pinned to `fast`: $1 per 1,000 requests, the same unit price as
 * `turbo` (which is that same price at roughly 200ms latency). `basic` costs
 * $5 per 1,000. The API default is `advanced`.
 */
const SEARCH_MODE = "fast";
const MAX_CHARS_TOTAL = 20000;
const MAX_CHARS_PER_RESULT = 2500;
const MAX_EXTRACT_URLS = 20;

export interface ParallelSearchOptions {
	/** Defaults to `globalThis.fetch`; injected by the offline test suite. */
	fetchImpl?: FetchLike;
}

interface ParallelResult {
	url: string;
	title: string | null;
	publish_date: string | null;
	excerpts: string[];
}

interface RequestContext {
	headers: Record<string, string>;
	signal: AbortSignal | undefined;
	timeoutMs: number;
	fetchImpl: FetchLike | undefined;
}

/**
 * Searches Parallel and, when `req.urls` is set, extracts those pages too.
 *
 * The second parameter is a test seam for the injected `fetch`; the registry
 * calls this with `SearchRequest` alone, so the one-argument form is the
 * contract that `SearchTransport` depends on.
 */
export async function parallelSearch(
	req: SearchRequest,
	options: ParallelSearchOptions = {},
): Promise<StreamResult> {
	const context: RequestContext = {
		headers: buildHeaders(readApiKey()),
		signal: req.signal,
		timeoutMs: req.settings.timeoutMs,
		fetchImpl: options.fetchImpl,
	};

	let raw: unknown;
	try {
		raw = await postJson<unknown>(SEARCH_URL, {
			headers: context.headers,
			body: searchRequestBody(req),
			signal: context.signal,
			timeoutMs: context.timeoutMs,
			fetchImpl: context.fetchImpl,
		});
	} catch (error) {
		throw withApiMessage(error);
	}

	const searchResults: SearchResultDetail[] = [];
	const sources: Source[] = [];
	for (const result of normalizeResults(readField(raw, "results"))) {
		searchResults.push(toSearchResultDetail(result));
		sources.push(toSource(result));
	}

	const usage = normalizeUsage(readField(raw, "usage"));
	const warnings = normalizeWarnings(readField(raw, "warnings"));

	if (req.urls && req.urls.length > 0) {
		// Extract returns excerpts only, never `full_content`. That is a deliberate
		// choice, not an omission: full-page markdown for up to 20 URLs is a token
		// bomb, and the objective-aligned excerpt is the more useful signal when the
		// model is answering a question. The per-result excerpt budget is set
		// explicitly so a URL fetch is not left on an undocumented API default.
		try {
			const extracted: unknown = await postJson<unknown>(EXTRACT_URL, {
				headers: context.headers,
				body: {
					urls: req.urls.slice(0, MAX_EXTRACT_URLS),
					objective: req.query,
					max_chars_total: MAX_CHARS_TOTAL,
					advanced_settings: {
						excerpt_settings: { max_chars_per_result: MAX_CHARS_PER_RESULT },
					},
				},
				signal: context.signal,
				timeoutMs: context.timeoutMs,
				fetchImpl: context.fetchImpl,
			});
			for (const result of normalizeResults(readField(extracted, "results"))) {
				searchResults.push(toSearchResultDetail(result, "extract"));
				sources.push(toSource(result));
			}
			warnings.push(...normalizeExtractErrorUrls(readField(extracted, "errors")));
		} catch (error) {
			// A failed extract must not discard the search results.
			warnings.push(`parallel extract failed: ${errorText(error)}`);
		}
	}

	const result: StreamResult = {
		text: "",
		providerKind: PROVIDER_NAME,
		searchQueries: [req.query],
		searchResults,
		sources,
	};

	const searchId = readField(raw, "search_id");
	if (typeof searchId === "string" && searchId.length > 0) {
		result.requestId = searchId;
	}
	if (usage.length > 0) {
		result.usage = usage;
	}
	if (warnings.length > 0) {
		result.warnings = warnings;
	}
	return result;
}

function readApiKey(): string {
	const key = process.env.PARALLEL_API_KEY?.trim() ?? "";
	if (key.length === 0) {
		throw providerError(
			"missing_credentials",
			"PARALLEL_API_KEY is not set; the parallel transport needs a Parallel API key.",
		);
	}
	return key;
}

/** Parallel authenticates with `x-api-key`; it takes no Authorization header. */
function buildHeaders(apiKey: string): Record<string, string> {
	return { "x-api-key": apiKey };
}

/**
 * `search_queries` is required by the API and `objective` is a
 * natural-language goal, so the user's query is sent as both. The request
 * schema is `additionalProperties: false`; only documented keys are sent.
 */
function searchRequestBody(req: SearchRequest): Record<string, unknown> {
	return {
		objective: req.query,
		search_queries: [req.query],
		mode: SEARCH_MODE,
		max_chars_total: MAX_CHARS_TOTAL,
		advanced_settings: {
			max_results: req.settings.maxResults,
			excerpt_settings: { max_chars_per_result: MAX_CHARS_PER_RESULT },
		},
	};
}

function toSearchResultDetail(
	result: ParallelResult,
	type?: string,
): SearchResultDetail {
	const detail: SearchResultDetail = {
		title: result.title ?? undefined,
		url: result.url,
		source: PROVIDER_NAME,
		pageAge: result.publish_date,
		citedText: result.excerpts.join("\n"),
	};
	if (type !== undefined) {
		detail.type = type;
	}
	return detail;
}

function toSource(result: ParallelResult): Source {
	return { title: result.title ?? result.url, url: result.url };
}

function readField(value: unknown, field: string): unknown {
	if (typeof value !== "object" || value === null) {
		return undefined;
	}
	return (value as Record<string, unknown>)[field];
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return undefined;
	}
	return value as Record<string, unknown>;
}

/** `title` and `publish_date` are nullable; entries without a url are dropped. */
function normalizeResults(value: unknown): ParallelResult[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const results: ParallelResult[] = [];
	for (const entry of value) {
		const record = readRecord(entry);
		if (!record || typeof record.url !== "string") {
			continue;
		}
		results.push({
			url: record.url,
			title: typeof record.title === "string" ? record.title : null,
			publish_date: typeof record.publish_date === "string"
				? record.publish_date
				: null,
			excerpts: normalizeStrings(record.excerpts),
		});
	}
	return results;
}

function normalizeStrings(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value.filter((entry): entry is string => typeof entry === "string");
}

function normalizeWarnings(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const messages: string[] = [];
	for (const entry of value) {
		if (typeof entry === "string") {
			messages.push(entry);
			continue;
		}
		const message = readRecord(entry)?.message;
		if (typeof message === "string" && message.length > 0) {
			messages.push(message);
		}
	}
	return messages;
}

function normalizeUsage(
	value: unknown,
): { name: string; count: number }[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const usage: { name: string; count: number }[] = [];
	for (const entry of value) {
		const record = readRecord(entry);
		if (!record || typeof record.name !== "string") {
			continue;
		}
		usage.push({
			name: record.name,
			count: typeof record.count === "number" ? record.count : 0,
		});
	}
	return usage;
}

function normalizeExtractErrorUrls(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const urls: string[] = [];
	for (const entry of value) {
		const url = readRecord(entry)?.url;
		if (typeof url === "string" && url.length > 0) {
			urls.push(url);
		}
	}
	return urls;
}

/**
 * 422 responses carry the API's own `message`; keep that text in the error so
 * the model can see what to correct. Every other error is passed through
 * untouched, so 401/403 keep their status and 429 stays retryable.
 */
function withApiMessage(error: unknown): unknown {
	if (!isProviderError(error) || error.code !== "http_error" || error.status !== 422) {
		return error;
	}
	const message = apiMessage(error.message);
	if (!message) {
		return error;
	}
	return providerError("http_error", `HTTP 422: ${message}`, {
		status: error.status,
	});
}

/** Reads `"message": "..."` back out of the summarized response body. */
function apiMessage(bodySummary: string): string | undefined {
	const match = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(bodySummary);
	if (!match) {
		return undefined;
	}
	try {
		const parsed: unknown = JSON.parse(`"${match[1]}"`);
		return typeof parsed === "string" && parsed.length > 0 ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
