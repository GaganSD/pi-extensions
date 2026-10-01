import { exaApiKey } from "../env.ts";
import { type FetchLike, postJson } from "./http.ts";
import type { SearchRequest } from "./index.ts";
import { withMcpSession } from "./mcp.ts";
import { sourcesFromResults } from "./results.ts";
import {
	type SearchResultDetail,
	type StreamResult,
	isProviderError,
	providerError,
} from "./types.ts";

export const EXA_SEARCH_URL = "https://api.exa.ai/search";
export const EXA_CONTENTS_URL = "https://api.exa.ai/contents";
export const EXA_MCP_URL = "https://mcp.exa.ai/mcp";
/** Sentences per REST result highlight, as the `/search` body requires. */
const EXA_HIGHLIGHT_SENTENCES = 3;
/** `web_fetch_exa` truncates each URL to this many characters. */
const EXA_FETCH_MAX_CHARACTERS = 3000;
/** Aggregate fetch cap: bounded by this many URLs times the per-page cap. */
const EXA_MAX_FETCH_URLS = 20;
/** Keyless results carry no upstream request id, so the transport names it. */
const EXA_MCP_REQUEST_ID = "mcp";

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

interface ExaContentsResult {
	title?: string;
	url?: string;
	text?: string;
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
	const apiKey = exaApiKey();
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
 * The anchors are structural only outside a highlights block. Inside one they
 * are ordinary content, because a page whose text starts a line with `URL:` or
 * `Title:` would otherwise fabricate a phantom result. Blank lines inside a
 * highlight remain content. A boundary needs a following Title/URL header pair
 * or the known search footer; `---` alone is not enough (pages contain rules).
 * Unknown footer prose may remain in the bounded excerpt rather than dropping
 * genuine facts just because they follow a blank line.
 *
 * Two highlight spellings are accepted, because the hosted server emits both:
 * `> `-prefixed blockquote lines and bare lines under `Highlights:`.
 */
export function parseExaSearchText(text: string): SearchResultDetail[] {
	const results: SearchResultDetail[] = [];
	let group: ExaGroup | undefined;
	let inHighlights = false;

	const lines = text.split("\n");
	for (const [index, rawLine] of lines.entries()) {
		const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
		if (line.trim().length === 0 || line.trim() === "---") {
			const next = lines[index + 1] ?? "";
			const afterNext = lines[index + 2] ?? "";
			if ((TITLE_LINE.test(next) && URL_LINE.test(afterNext)) || /^Searched \d+ sources\b/.test(next)) {
				inHighlights = false;
			} else if (inHighlights && group && line.trim().length === 0) {
				group.highlights.push("");
			}
			continue;
		}
		if (!inHighlights) {
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
	const fetched = fetchableUrls(req);
	const warnings: string[] = [...fetched.warnings];

	// Search and the caller's URL fetches are independent, so run them
	// concurrently; a fetch failure never discards the search results.
	const searchPromise = postJson<unknown>(EXA_SEARCH_URL, {
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
	const fetchPromise = fetched.urls.length > 0
		? settle(postJson<unknown>(EXA_CONTENTS_URL, {
			headers,
			body: { urls: fetched.urls, text: { maxCharacters: EXA_FETCH_MAX_CHARACTERS } },
			timeoutMs: req.settings.timeoutMs,
			signal: req.signal,
			fetchImpl: options.fetchImpl,
		}))
		: undefined;

	const searchOutcome = await settle(searchPromise);
	if (!searchOutcome.ok) {
		await fetchPromise;
		throw searchOutcome.error;
	}
	const body = asObject(searchOutcome.value, EXA_SEARCH_URL);
	const results: SearchResultDetail[] = toSearchResults(body.results).map(
		(result) => ({
			title: result.title,
			url: result.url,
			source: PROVIDER_NAME,
			pageAge: result.publishedDate ?? null,
			citedText: joinHighlights(result.highlights),
		}),
	);

	if (fetchPromise) {
		const fetchOutcome = await fetchPromise;
		if (!fetchOutcome.ok) {
			if (isProviderError(fetchOutcome.error) && fetchOutcome.error.code === "aborted") {
				throw fetchOutcome.error;
			}
			warnings.push(describeError("URL fetch", fetchOutcome.error));
		} else {
			try {
				const contents = asObject(fetchOutcome.value, EXA_CONTENTS_URL);
				results.push(...requestedContents(toContentsResults(contents.results).map(contentsDetail), fetched.urls, warnings));
				for (const url of fetched.urls) {
					if (!results.some((result) => result.type === FETCH_RESULT_TYPE && result.url === url)) {
						warnings.push(`Exa URL fetch returned no parsed content for ${url}.`);
					}
				}
			} catch (error) {
				warnings.push(describeError("URL fetch", error));
			}
		}
	}

	return {
		text: "",
		providerKind: "exa",
		sources: sourcesFromResults(results),
		searchResults: results,
		requestId: typeof body.requestId === "string" ? body.requestId : undefined,
		...(warnings.length > 0 ? { warnings } : {}),
	};
}

/** A URL fetch cannot introduce documents outside the caller's requested set. */
function requestedContents(results: SearchResultDetail[], urls: string[], warnings: string[]): SearchResultDetail[] {
	const allowed = new Set(urls);
	const kept = results.filter((result) => typeof result.url === "string" && allowed.has(result.url));
	const dropped = results.length - kept.length;
	if (dropped > 0) warnings.push(`Exa URL fetch withheld ${dropped} unrequested or unidentified document(s).`);
	return kept;
}

function contentsDetail(result: ExaContentsResult): SearchResultDetail {
	return {
		title: result.title,
		url: result.url,
		source: PROVIDER_NAME,
		citedText: typeof result.text === "string" ? result.text : "",
		type: FETCH_RESULT_TYPE,
	};
}

// --- path 2: keyless hosted MCP ----------------------------------------------

async function keylessSearch(
	req: SearchRequest,
	options: ExaSearchOptions,
): Promise<StreamResult> {
	const fetched = fetchableUrls(req);
	const warnings: string[] = [...fetched.warnings];

	// One session for the whole operation: search and the caller's URL fetches
	// share the handshake and run concurrently (RPC ids keep the replies apart).
	const results = await withMcpSession(
		{
			url: EXA_MCP_URL,
			fetchImpl: options.fetchImpl,
			timeoutMs: req.settings.timeoutMs,
			signal: req.signal,
		},
		async (client) => {
			const searchPromise = client.callTool("web_search_exa", {
				query: req.query,
				numResults: req.settings.maxResults,
				objective: exaObjective(req.query),
			});
			const fetchPromise = fetched.urls.length > 0
				? settle(client.callTool("web_fetch_exa", {
					urls: fetched.urls,
					maxCharacters: EXA_FETCH_MAX_CHARACTERS,
				}))
				: undefined;

			const searchOutcome = await settle(searchPromise);
			if (!searchOutcome.ok) {
				await fetchPromise;
				throw searchOutcome.error;
			}
			const parsed = parseExaSearchText(searchOutcome.value);
			// A keyless quota refusal arrives as ordinary tool text, not an
			// error, so it would otherwise be returned as a fake search result
			// and the family would never fall back to parallel. Only trust it
			// when there is nothing to show: a real result page routinely
			// contains the words "rate limit" or "429".
			const hasSearchContent = parsed.some(
				(result) => (result.citedText ?? "").trim().length > 0,
			);
			if (isRateLimitRefusal(searchOutcome.value, hasSearchContent)) {
				await fetchPromise;
				throw providerError(
					"rate_limited",
					"Exa's keyless MCP endpoint refused this request (rate limit). Set EXA_API_KEY for a keyed quota; otherwise the next provider in the chain answers.",
				);
			}
			// The model still needs the content the server did return.
			const base = parsed.length > 0
				? parsed
				: searchOutcome.value.trim().length > 0
					? [{ source: PROVIDER_NAME, citedText: searchOutcome.value, type: "unparsed" }]
					: [];
			if (parsed.length === 0) {
				warnings.push(base.length > 0 ? "Exa search returned unparsed content." : "Exa search returned no content.");
			}
			if (!fetchPromise) {
				return base;
			}

			const fetchOutcome = await fetchPromise;
			if (!fetchOutcome.ok) {
				if (isProviderError(fetchOutcome.error) && fetchOutcome.error.code === "aborted") {
					throw fetchOutcome.error;
				}
				warnings.push(describeError("URL fetch", fetchOutcome.error));
				return base;
			}
			// A throttled fetch never invalidates the search that succeeded
			// alongside it, so this warns and returns the results we have. The
			// parsed pages are the content signal: a real page is never a refusal.
			const pages = parseExaFetchText(fetchOutcome.value);
			const hasPageContent = pages.results.some(
				(page) => (page.citedText ?? "").trim().length > 0,
			);
			if (isRateLimitRefusal(fetchOutcome.value, hasPageContent)) {
				warnings.push("Exa URL fetch was rate-limited by the keyless endpoint; search results are unaffected.");
				return base;
			}
			warnings.push(...pages.warnings);
			const requested = requestedContents(pages.results, fetched.urls, warnings);
			for (const url of fetched.urls) {
				if (!requested.some((page) => page.url === url)) {
					warnings.push(`Exa URL fetch returned no parsed content for ${url}.`);
				}
			}
			if (pages.results.length === 0 && fetchOutcome.value.trim().length > 0) {
				warnings.push("Exa URL fetch returned unparsed content; page identity is unverified.");
				requested.push({ source: PROVIDER_NAME, citedText: fetchOutcome.value, type: "unparsed" });
			}
			return [...base, ...requested];
		},
	);

	return {
		text: "",
		providerKind: "exa",
		sources: sourcesFromResults(results),
		searchResults: results,
		requestId: EXA_MCP_REQUEST_ID,
		...(warnings.length > 0 ? { warnings } : {}),
	};
}

/**
 * Normalizes `web_fetch_exa` output into one URL-bound document per page.
 *
 * The hosted server frames each page as a `# Title` line followed by a
 * `URL: <url>` line, then the page body (which may itself contain `#`
 * headings). Failures are trailing `Error fetching <url>: <code>` lines. One
 * document per page is what lets later pages survive the per-result excerpt
 * cap instead of being collapsed behind the first page.
 */
export function parseExaFetchText(text: string): {
	results: SearchResultDetail[];
	warnings: string[];
} {
	const results: SearchResultDetail[] = [];
	const warnings: string[] = [];
	const lines = text.split("\n").map((line) =>
		line.endsWith("\r") ? line.slice(0, -1) : line
	);

	let page: { title?: string; url: string; body: string[] } | undefined;
	const flush = () => {
		if (!page) {
			return;
		}
		results.push({
			title: page.title,
			url: page.url,
			source: PROVIDER_NAME,
			citedText: page.body.join("\n").trim(),
			type: FETCH_RESULT_TYPE,
		});
		page = undefined;
	};

	for (let i = 0; i < lines.length; i++) {
		const heading = /^#\s+(.*\S)\s*$/.exec(lines[i]);
		const urlLine = i + 1 < lines.length
			? /^URL:\s*(\S+)\s*$/.exec(lines[i + 1])
			: null;
		if (heading && urlLine) {
			flush();
			page = { title: heading[1], url: urlLine[1], body: [] };
			i++;
			continue;
		}
		const failure = /^Error fetching (\S+):\s*(.*)$/.exec(lines[i].trim());
		if (failure) {
			warnings.push(
				`Exa fetch failed for ${failure[1]}: ${failure[2] || "unknown error"}`,
			);
			continue;
		}
		if (page) {
			page.body.push(lines[i]);
		}
	}
	flush();
	return { results, warnings };
}

/** Supplied URLs worth fetching, capped so one call cannot fetch unbounded. */
function fetchableUrls(req: SearchRequest): {
	urls: string[];
	warnings: string[];
} {
	const all = (req.urls ?? []).filter((url) => url.length > 0);
	const urls = all.slice(0, EXA_MAX_FETCH_URLS);
	const warnings = all.length > urls.length
		? [`Exa fetched the first ${urls.length} of ${all.length} supplied URLs.`]
		: [];
	return { urls, warnings };
}

type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

/** Waits without letting a rejection escape as an unhandled rejection. */
function settle<T>(promise: Promise<T>): Promise<Settled<T>> {
	return promise.then(
		(value) => ({ ok: true, value } as const),
		(error) => ({ ok: false, error } as const),
	);
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
		citedText: group.highlights.join("\n").trim(),
	});
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

/**
 * A keyless refusal arrives in-band with HTTP success, so it would be rendered
 * as a result unless recognised. The signature is deliberately narrow: the
 * reply must name the service as well as the symptom, and carry no usable
 * content. Pages *about* rate limits are ordinary results — and silently
 * dropping a fetched page is worse than showing an unparsed message, so the
 * error is biased toward saying nothing.
 */
const SERVICE_RE = /\bexa\b/i;
const REFUSAL_RE =
	/rate limit|too many requests|\b429\b|quota|temporarily unavailable|api key|upgrade/i;

function isRateLimitRefusal(reply: string, hasContent: boolean): boolean {
	return !hasContent && SERVICE_RE.test(reply) && REFUSAL_RE.test(reply);
}
