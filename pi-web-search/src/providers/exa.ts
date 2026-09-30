import { type FetchLike, postJson } from "./http.ts";
import type { SearchRequest } from "./index.ts";
import { createMcpClient } from "./mcp.ts";
import {
	type SearchResultDetail,
	type Source,
	type StreamResult,
	isProviderError,
	providerError,
} from "./types.ts";

export const EXA_SEARCH_URL = "https://api.exa.ai/search";
export const EXA_CONTENTS_URL = "https://api.exa.ai/contents";
export const EXA_MCP_URL = "https://mcp.exa.ai/mcp";
/** Sentences per REST result highlight, as the `/search` body requires. */
export const EXA_HIGHLIGHT_SENTENCES = 3;
/** `web_fetch_exa` truncates each URL to this many characters. */
export const EXA_FETCH_MAX_CHARACTERS = 3000;
/** Keyless results carry no upstream request id, so the transport names it. */
export const EXA_MCP_REQUEST_ID = "mcp";

const PROVIDER_NAME = "exa";
const FETCH_RESULT_TYPE = "content";

export interface ExaSearchOptions {
	/** Defaults to `globalThis.fetch`; injected by the offline test suite. */
	fetchImpl?: FetchLike;
}

interface ExaRestResult {
	title?: string;
	url?: string;
	publishedDate?: string | null;
	highlights?: string[];
}

interface ExaSearchResponse {
	requestId?: string;
	results?: ExaRestResult[];
}

interface ExaContentsResult {
	title?: string;
	url?: string;
	text?: string;
}

interface ExaContentsResponse {
	requestId?: string;
	results?: ExaContentsResult[];
}

/**
 * Exa transport. `EXA_API_KEY` selects the REST API; without it the transport
 * uses the keyless hosted MCP server. Never raises `missing_credentials`.
 */
export async function exaSearch(
	req: SearchRequest,
	options: ExaSearchOptions = {},
): Promise<StreamResult> {
	// Read at call time so the key can be toggled without reloading the module.
	const apiKey = readApiKey();
	return apiKey === undefined
		? keylessSearch(req, options)
		: keyedSearch(req, apiKey, options);
}

/** `web_search_exa` requires an objective; the user query alone is not enough. */
export function exaObjective(query: string): string {
	return `Find the most relevant web pages that answer: ${query}`;
}

/**
 * Parses the concatenated text of `web_search_exa` into results.
 *
 * Line-anchored on purpose: a group is opened by its `Title:`/`URL:` anchor and
 * only the `Highlights:` block after that anchor becomes its cited text, so
 * highlights can never bleed into the next result. A group without a `URL:` is
 * unusable and skipped; `Published:` and `Author:` are optional.
 *
 * Two highlight spellings are accepted, because the hosted server emits both:
 * `> `-prefixed blockquote lines and bare lines under `Highlights:`.
 */
export function parseExaSearchText(text: string): SearchResultDetail[] {
	const results: SearchResultDetail[] = [];
	let group: ExaGroup | undefined;
	let inHighlights = false;

	for (const rawLine of text.split("\n")) {
		const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
		const title = TITLE_LINE.exec(line);
		if (title) {
			pushGroup(group, results);
			group = { title: normalizeOptionalField(title[1]), highlights: [] };
			inHighlights = false;
			continue;
		}
		const url = URL_LINE.exec(line);
		if (url) {
			// A second URL closes the previous group: the anchor is one per result.
			if (group?.url !== undefined) {
				pushGroup(group, results);
				group = undefined;
			}
			group ??= { highlights: [] };
			group.url = url[1].trim();
			inHighlights = false;
			continue;
		}
		const published = PUBLISHED_LINE.exec(line);
		if (published) {
			group ??= { highlights: [] };
			group.published = normalizeOptionalField(published[1]);
			inHighlights = false;
			continue;
		}
		if (AUTHOR_LINE.test(line)) {
			// Present in the payload but not part of SearchResultDetail.
			inHighlights = false;
			continue;
		}
		if (HIGHLIGHTS_MARKER.test(line)) {
			group ??= { highlights: [] };
			inHighlights = true;
			continue;
		}
		if (!inHighlights || !group) {
			continue;
		}
		const quoted = HIGHLIGHT_LINE.exec(line);
		const highlight = (quoted ? quoted[1] : line).trim();
		// `...` is the server's separator between highlight chunks, not content.
		if (highlight.length === 0 || highlight === "...") {
			continue;
		}
		group.highlights.push(highlight);
	}
	pushGroup(group, results);

	return results;
}

// --- path 1: REST with an API key --------------------------------------------

async function keyedSearch(
	req: SearchRequest,
	apiKey: string,
	options: ExaSearchOptions,
): Promise<StreamResult> {
	const headers = { "x-api-key": apiKey, "Content-Type": "application/json" };
	const response = await postJson<unknown>(EXA_SEARCH_URL, {
		headers,
		body: {
			query: req.query,
			numResults: req.settings.maxResults,
			type: "auto",
			contents: {
				highlights: { numSentences: EXA_HIGHLIGHT_SENTENCES },
				text: false,
				summary: false,
			},
		},
		timeoutMs: req.settings.timeoutMs,
		signal: req.signal,
		fetchImpl: options.fetchImpl,
	});

	const body = asObject(response, EXA_SEARCH_URL);
	const results = toSearchResults(body.results).map((result) => {
		const detail: SearchResultDetail = {
			title: result.title,
			url: result.url,
			source: PROVIDER_NAME,
			pageAge: result.publishedDate ?? null,
			citedText: joinHighlights(result.highlights),
		};
		return detail;
	});

	const { results: allResults, warnings } = await withUrlFetch(
		req,
		results,
		(urls, warn) => keyedUrlFetch(req, urls, headers, options, warn),
	);

	return {
		text: "",
		providerKind: "exa",
		searchQueries: [req.query],
		sources: toSources(results),
		searchResults: allResults,
		requestId: typeof body.requestId === "string" ? body.requestId : undefined,
		...(warnings.length > 0 ? { warnings } : {}),
	};
}

async function keyedUrlFetch(
	req: SearchRequest,
	urls: string[],
	headers: Record<string, string>,
	options: ExaSearchOptions,
	warn: (message: string) => void,
): Promise<SearchResultDetail[]> {
	try {
		const response = await postJson<unknown>(EXA_CONTENTS_URL, {
			headers,
			body: { urls, text: true },
			timeoutMs: req.settings.timeoutMs,
			signal: req.signal,
			fetchImpl: options.fetchImpl,
		});
		const body = asObject(response, EXA_CONTENTS_URL);
		return toContentsResults(body.results).map((result) => {
			const detail: SearchResultDetail = {
				title: result.title,
				url: result.url,
				source: PROVIDER_NAME,
				citedText: typeof result.text === "string" ? result.text : "",
				type: FETCH_RESULT_TYPE,
			};
			return detail;
		});
	} catch (error) {
		warn(describeError("URL fetch", error));
		return [];
	}
}

// --- path 2: keyless hosted MCP ----------------------------------------------

async function keylessSearch(
	req: SearchRequest,
	options: ExaSearchOptions,
): Promise<StreamResult> {
	const client = createMcpClient({
		url: EXA_MCP_URL,
		fetchImpl: options.fetchImpl,
		timeoutMs: req.settings.timeoutMs,
		signal: req.signal,
	});
	await client.initialize();
	const text = await client.callTool("web_search_exa", {
		query: req.query,
		numResults: req.settings.maxResults,
		objective: exaObjective(req.query),
	});

	let results = parseExaSearchText(text);
	if (results.length === 0) {
		// The model still needs the content the server did return.
		results = [{ source: PROVIDER_NAME, citedText: text, type: FETCH_RESULT_TYPE }];
	}

	const { results: allResults, warnings } = await withUrlFetch(
		req,
		results,
		(urls, warn) => keylessUrlFetch(req, urls, options, warn),
	);

	return {
		text: "",
		providerKind: "exa",
		searchQueries: [req.query],
		sources: toSources(results),
		searchResults: allResults,
		requestId: EXA_MCP_REQUEST_ID,
		...(warnings.length > 0 ? { warnings } : {}),
	};
}

async function keylessUrlFetch(
	req: SearchRequest,
	urls: string[],
	options: ExaSearchOptions,
	warn: (message: string) => void,
): Promise<SearchResultDetail[]> {
	try {
		const client = createMcpClient({
			url: EXA_MCP_URL,
			fetchImpl: options.fetchImpl,
			timeoutMs: req.settings.timeoutMs,
			signal: req.signal,
		});
		await client.initialize();
		const text = await client.callTool("web_fetch_exa", {
			urls,
			maxCharacters: EXA_FETCH_MAX_CHARACTERS,
		});
		return [{ source: PROVIDER_NAME, citedText: text, type: FETCH_RESULT_TYPE }];
	} catch (error) {
		warn(describeError("URL fetch", error));
		return [];
	}
}

/**
 * Fetching the supplied URLs is best effort: a failure is reported through
 * `warnings` and never discards the search results.
 */
async function withUrlFetch(
	req: SearchRequest,
	results: SearchResultDetail[],
	fetchUrls: (
		urls: string[],
		warn: (message: string) => void,
	) => Promise<SearchResultDetail[]>,
): Promise<{ results: SearchResultDetail[]; warnings: string[] }> {
	const urls = (req.urls ?? []).filter((url) => url.length > 0);
	if (urls.length === 0) {
		return { results, warnings: [] };
	}
	const warnings: string[] = [];
	const fetched = await fetchUrls(urls, (message) => warnings.push(message));
	return { results: [...results, ...fetched], warnings };
}

// --- helpers -----------------------------------------------------------------

interface ExaGroup {
	title?: string;
	url?: string;
	published?: string;
	highlights: string[];
}

const TITLE_LINE = /^\s*Title:\s*(.*)$/;
const URL_LINE = /^\s*URL:\s*(.*)$/;
const PUBLISHED_LINE = /^\s*Published:\s*(.*)$/;
const AUTHOR_LINE = /^\s*Author:/;
const HIGHLIGHTS_MARKER = /^\s*Highlights:/;
const HIGHLIGHT_LINE = /^\s*>\s?(.*)$/;

/**
 * The hosted server answers `N/A` (or nothing) for fields it has no value for.
 * That sentinel must not reach the model as a literal title or date.
 */
function normalizeOptionalField(value: string): string | undefined {
	const trimmed = value.trim();
	if (trimmed.length === 0) {
		return undefined;
	}
	return trimmed.toLowerCase() === "n/a" ? undefined : trimmed;
}

function pushGroup(
	group: ExaGroup | undefined,
	results: SearchResultDetail[],
): void {
	// No URL means the fragment is not a result; skip it instead of guessing.
	if (!group?.url) {
		return;
	}
	results.push({
		title: group.title,
		url: group.url,
		source: PROVIDER_NAME,
		pageAge: group.published,
		citedText: group.highlights.join("\n"),
	});
}

/**
 * `Source.title` is required, so an untitled page falls back to its URL rather
 * than rendering as a bare `[undefined](url)` or the literal `N/A`.
 */
function toSources(results: SearchResultDetail[]): Source[] {
	const sources: Source[] = [];
	for (const result of results) {
		if (result.url) {
			sources.push({ title: result.title || result.url, url: result.url });
		}
	}
	return sources;
}

function toSearchResults(value: unknown): ExaRestResult[] {
	// An absent or empty `results` array is a successful search with no hits.
	return toResultList(value) as ExaRestResult[];
}

function toContentsResults(value: unknown): ExaContentsResult[] {
	return toResultList(value) as ExaContentsResult[];
}

function toResultList(value: unknown): Record<string, unknown>[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value.filter((entry): entry is Record<string, unknown> =>
		typeof entry === "object" && entry !== null && !Array.isArray(entry)
	);
}

function asObject(value: unknown, url: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw providerError(
			"parse_error",
			`Response from ${url} was not a JSON object.`,
		);
	}
	return value as Record<string, unknown>;
}

function joinHighlights(highlights: unknown): string {
	if (!Array.isArray(highlights)) {
		return "";
	}
	return highlights
		.filter((highlight): highlight is string => typeof highlight === "string")
		.join("\n");
}

function describeError(prefix: string, error: unknown): string {
	if (isProviderError(error)) {
		return `${prefix} failed (${error.code}): ${error.message}`;
	}
	const message = error instanceof Error ? error.message : String(error);
	return `${prefix} failed: ${message}`;
}

function readApiKey(): string | undefined {
	const key = process.env.EXA_API_KEY;
	if (typeof key !== "string") {
		return undefined;
	}
	const trimmed = key.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}
