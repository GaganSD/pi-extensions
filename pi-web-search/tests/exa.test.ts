import assert from "node:assert/strict";
import test from "node:test";

import { applyConfig } from "../src/providers/config.ts";
import {
	EXA_CONTENTS_URL,
	EXA_MCP_URL,
	EXA_SEARCH_URL,
	type ExaSearchOptions,
	exaObjective,
	exaSearch,
	parseExaFetchText,
	parseExaSearchText,
} from "../src/providers/exa.ts";
import { type FetchLike, type ResponseLike } from "../src/providers/http.ts";
import { MCP_PROTOCOL_VERSION } from "../src/providers/mcp.ts";
import type { SearchRequest } from "../src/providers/index.ts";

const maxResults = 5;
const settings = applyConfig("/tmp/web-search.json", {
	web: { provider: "exa" },
	maxResults,
});

function request(overrides: Partial<SearchRequest> = {}): SearchRequest {
	return { query: "who invented the transistor", settings, ...overrides };
}

function fakeResponse(
	body: string,
	init: { status?: number; headers?: Record<string, string> } = {},
): ResponseLike {
	return new Response(body, init);
}

interface RecordedRequest {
	url: string;
	body: Record<string, unknown>;
	headers?: Record<string, string>;
	method?: string;
}

interface QueuedResponse {
	body: string;
	status?: number;
	headers?: Record<string, string>;
}

/** Replies with each queued body in order; records every request it served. */
function queueFetch(
	bodies: QueuedResponse[],
): { fetchImpl: FetchLike; requests: RecordedRequest[] } {
	const requests: RecordedRequest[] = [];
	const queue = [...bodies];
	const fetchImpl: FetchLike = (url, init) => {
		requests.push({
			url,
			body: JSON.parse(init.body ?? "{}") as Record<string, unknown>,
			headers: init.headers,
		});
		const next = queue.shift() ?? { body: "{}" };
		return Promise.resolve(fakeResponse(next.body, next));
	};
	return { fetchImpl, requests };
}

/** Serves the MCP handshake plus one text answer per `tools/call`. */
function mcpFetch(answers: string[]): {
	fetchImpl: FetchLike;
	requests: RecordedRequest[];
} {
	const requests: RecordedRequest[] = [];
	const queue = [...answers];
	const fetchImpl: FetchLike = (url, init) => {
		const body = JSON.parse(init.body ?? "{}") as Record<string, unknown>;
		requests.push({ url, body, headers: init.headers, method: init.method });
		if (body.method === "notifications/initialized") {
			return Promise.resolve(fakeResponse("", { status: 202 }));
		}
		const text = body.method === "tools/call"
			? (queue.shift() ?? "")
			: `{"protocolVersion":"${MCP_PROTOCOL_VERSION}"}`;
		const payload = body.method === "tools/call"
			? { content: [{ type: "text", text }] }
			: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {} };
		return Promise.resolve(
			fakeResponse(
				`event: message\ndata: ${JSON.stringify({
					jsonrpc: "2.0",
					id: body.id ?? 1,
					result: payload,
				})}\n\n`,
				{ headers: { "mcp-session-id": "sess-1" } },
			),
		);
	};
	return { fetchImpl, requests };
}

function withKey<T>(value: string, run: () => Promise<T>): Promise<T> {
	const previous = process.env.EXA_API_KEY;
	process.env.EXA_API_KEY = value;
	return run().finally(() => {
		if (previous === undefined) {
			delete process.env.EXA_API_KEY;
		} else {
			process.env.EXA_API_KEY = previous;
		}
	});
}

function withoutKey<T>(run: () => Promise<T>): Promise<T> {
	const previous = process.env.EXA_API_KEY;
	delete process.env.EXA_API_KEY;
	return run().finally(() => {
		if (previous !== undefined) {
			process.env.EXA_API_KEY = previous;
		}
	});
}

const SEARCH_FIXTURE = {
	requestId: "req-123",
	searchType: "auto",
	results: [
		{
			title: "Transistor history",
			url: "https://example.com/transistor",
			publishedDate: "2024-01-02T00:00:00.000Z",
			author: "A. Physicist",
			score: 0.9,
			highlights: ["Bardeen invented the transistor.", "It was 1947."],
		},
		{
			title: "Bell Labs notes",
			url: "https://example.com/bell-labs",
			publishedDate: "2023-05-06",
			highlights: ["Bell Labs hosted the transistor team."],
		},
	],
};

const MCP_SEARCH_TEXT = [
	"Title: Transistor history",
	"URL: https://example.com/transistor",
	"Published: 2024-01-02",
	"Author: A. Physicist",
	"Highlights:",
	"> Bardeen invented the transistor.",
	"> It was 1947.",
	"",
	"Title: Bell Labs notes",
	"URL: https://example.com/bell-labs",
	"Published: 2023-05-06",
	"Highlights:",
	"> Bell Labs hosted the transistor team.",
	"",
].join("\n");

// --- path 1: REST ------------------------------------------------------------

test("keyed path posts the exact URL, header, and body to /search", async () => {
	const { fetchImpl, requests } = queueFetch([
		{ body: JSON.stringify(SEARCH_FIXTURE) },
	]);
	const options: ExaSearchOptions = { fetchImpl };

	await withKey("exa-secret", () => exaSearch(request(), options));

	assert.equal(requests.length, 1);
	assert.equal(requests[0].url, EXA_SEARCH_URL);
	assert.equal(requests[0].url, "https://api.exa.ai/search");
	assert.equal(requests[0].headers?.["x-api-key"], "exa-secret");
	assert.equal(requests[0].headers?.["Content-Type"], "application/json");
	assert.deepEqual(requests[0].body, {
		query: "who invented the transistor",
		numResults: maxResults,
		type: "auto",
		contents: {
			highlights: { numSentences: 3 },
			text: false,
			summary: false,
		},
	});
});

test("keyed path maps a fixture response to a StreamResult", async () => {
	const { fetchImpl } = queueFetch([{ body: JSON.stringify(SEARCH_FIXTURE) }]);

	const result = await withKey("exa-secret", () =>
		exaSearch(request(), { fetchImpl })
	);

	assert.equal(result.providerKind, "exa");
	assert.equal(result.requestId, "req-123");
	assert.equal(result.text, "");
	assert.equal(result.searchResults?.length, 2);
	assert.deepEqual(result.sources, [
		{ title: "Transistor history", url: "https://example.com/transistor" },
		{ title: "Bell Labs notes", url: "https://example.com/bell-labs" },
	]);
	assert.deepEqual(result.searchResults?.[0], {
		title: "Transistor history",
		url: "https://example.com/transistor",
		source: "exa",
		pageAge: "2024-01-02T00:00:00.000Z",
		citedText: "Bardeen invented the transistor.\nIt was 1947.",
	});
	assert.equal(result.warnings, undefined);
});

test("an empty results array is a success with zero results, not a parse error", async () => {
	const { fetchImpl } = queueFetch([
		{ body: JSON.stringify({ requestId: "r", results: [] }) },
	]);

	const result = await withKey("exa-secret", () =>
		exaSearch(request(), { fetchImpl })
	);

	assert.deepEqual(result.searchResults, []);
	assert.deepEqual(result.sources, []);
	assert.equal(result.requestId, "r");
});

test("a non-JSON body raises parse_error", async () => {
	const { fetchImpl } = queueFetch([{ body: "<html>gateway</html>" }]);

	await assert.rejects(
		withKey("exa-secret", () => exaSearch(request(), { fetchImpl })),
		(error: unknown) => {
			assert.equal((error as { code: string }).code, "parse_error");
			return true;
		},
	);
});

test("401 becomes http_error with the status preserved", async () => {
	const { fetchImpl } = queueFetch([
		{ body: "invalid key", status: 401 },
	]);

	await assert.rejects(
		withKey("bad-key", () => exaSearch(request(), { fetchImpl })),
		(error: unknown) => {
			assert.equal((error as { code: string }).code, "http_error");
			assert.equal((error as { status?: number }).status, 401);
			return true;
		},
	);
});

test("exa never raises missing_credentials", async () => {
	const { fetchImpl } = queueFetch([
		{ body: "nope", status: 403 },
	]);
	const error = await withKey("bad-key", () =>
		exaSearch(request(), { fetchImpl })).then(
		() => undefined,
		(e: unknown) => e,
	);
	assert.equal((error as { code: string }).code, "http_error");
	assert.equal((error as { status?: number }).status, 403);
});

// --- path 2: keyless hosted MCP ----------------------------------------------

test("the keyless MCP session is closed, not stranded on Exa's server", async () => {
	// Regression: initialize hands out a session id that only a DELETE releases.
	// Without the teardown every search leaks a session on a third-party server.
	const { fetchImpl, requests } = mcpFetch([MCP_SEARCH_TEXT]);

	await withoutKey(() => exaSearch(request(), { fetchImpl }));

	const teardown = requests.at(-1);
	assert.equal(teardown?.method, "DELETE");
	assert.equal(teardown?.headers?.["Mcp-Session-Id"], "sess-1");
});

test("a failing session teardown does not discard the search results", async () => {
	// The DELETE is cleanup, not the operation: its failure must not mask a good answer.
	const { fetchImpl } = mcpFetch([MCP_SEARCH_TEXT]);
	const failing: FetchLike = (url, init) =>
		init.method === "DELETE"
			? Promise.reject(new Error("teardown refused"))
			: fetchImpl(url, init);

	const result = await withoutKey(() => exaSearch(request(), { fetchImpl: failing }));

	assert.ok(result.searchResults?.length);
	assert.equal(result.providerKind, "exa");
});

test("keyless path initializes then calls web_search_exa with a derived objective", async () => {
	const { fetchImpl, requests } = mcpFetch([MCP_SEARCH_TEXT]);

	const result = await withoutKey(() => exaSearch(request(), { fetchImpl }));

	// The trailing `undefined` is the session teardown: a DELETE carries no
	// JSON-RPC body, so there is no `body.method` to read.
	assert.deepEqual(
		requests.map((r) => r.body.method),
		["initialize", "notifications/initialized", "tools/call", undefined],
	);
	assert.equal(requests[3].method, "DELETE");
	assert.equal(requests[0].url, EXA_MCP_URL);
	const params = requests[2].body.params as {
		name: string;
		arguments: Record<string, unknown>;
	};
	assert.equal(params.name, "web_search_exa");
	assert.deepEqual(params.arguments, {
		query: "who invented the transistor",
		numResults: maxResults,
		objective:
			"Find the most relevant web pages that answer: who invented the transistor",
	});
	assert.equal(
		params.arguments.objective,
		exaObjective("who invented the transistor"),
	);

	assert.equal(result.providerKind, "exa");
	assert.equal(result.requestId, "mcp");
	assert.equal(result.text, "");
	assert.equal(result.searchResults?.length, 2);
	assert.deepEqual(result.sources?.map((s) => s.url), [
		"https://example.com/transistor",
		"https://example.com/bell-labs",
	]);
});

test("a blank EXA_API_KEY is treated as keyless", async () => {
	const { fetchImpl, requests } = mcpFetch([MCP_SEARCH_TEXT]);

	await withKey("   ", () => exaSearch(request(), { fetchImpl }));

	assert.equal(requests[0].url, EXA_MCP_URL);
	assert.equal(requests[0].body.method, "initialize");
});

// --- parseExaSearchText ------------------------------------------------------

test("parseExaSearchText splits two groups and stops highlights at the next anchor", () => {
	const parsed = parseExaSearchText(MCP_SEARCH_TEXT);

	assert.equal(parsed.length, 2);
	assert.equal(parsed[0].title, "Transistor history");
	assert.equal(parsed[0].url, "https://example.com/transistor");
	assert.equal(parsed[0].pageAge, "2024-01-02");
	assert.equal(parsed[0].source, "exa");
	assert.equal(
		parsed[0].citedText,
		"Bardeen invented the transistor.\nIt was 1947.",
	);
	// The second group must not inherit the first group's highlights.
	assert.equal(parsed[1].title, "Bell Labs notes");
	assert.equal(parsed[1].url, "https://example.com/bell-labs");
	assert.equal(
		parsed[1].citedText,
		"Bell Labs hosted the transistor team.",
	);
	assert.equal(parsed[1].citedText?.includes("Bardeen"), false);
});

test("parseExaSearchText normalizes the N/A sentinel to undefined, not a literal title", () => {
	// Regression: the hosted server answers "Title: N/A" for untitled pages,
	// which used to render as "1. [N/A](url)" in the source list.
	const parsed = parseExaSearchText(
		[
			"Title: N/A",
			"URL: https://exa.ai/docs/reference/search",
			"Published: N/A",
			"Author: N/A",
			"Highlights:",
			"> A highlight from an untitled page.",
		].join("\n"),
	);

	assert.equal(parsed.length, 1);
	assert.equal(parsed[0].title, undefined);
	assert.equal(parsed[0].url, "https://exa.ai/docs/reference/search");
	assert.equal(parsed[0].pageAge, undefined);
	assert.equal(parsed[0].citedText, "A highlight from an untitled page.");
});

test("an untitled page falls back to its url in the Source list", async () => {
	// format.ts renders `Source.title` verbatim, so the fallback must live in
	// the transport: asserted end-to-end through exaSearch's real source normalization.
	const { fetchImpl } = mcpFetch([
		[
			"Title: N/A",
			"URL: https://exa.ai/docs",
			"Highlights:",
			"> Body.",
		].join("\n"),
	]);

	const result = await withoutKey(() => exaSearch(request(), { fetchImpl }));

	assert.equal(result.searchResults?.[0].title, undefined);
	assert.deepEqual(result.sources, [
		{ title: "https://exa.ai/docs", url: "https://exa.ai/docs" },
	]);
	assert.equal(result.sources?.[0].title.includes("N/A"), false);
	assert.equal(result.sources?.[0].title.includes("undefined"), false);
});

test("a group with a real title keeps it in both the result and the source", async () => {
	const { fetchImpl } = mcpFetch([
		["Title: Real title", "URL: https://exa.ai/x", "Highlights:", "> B."].join(
			"\n",
		),
	]);

	const result = await withoutKey(() => exaSearch(request(), { fetchImpl }));

	assert.equal(result.searchResults?.[0].title, "Real title");
	assert.deepEqual(result.sources, [
		{ title: "Real title", url: "https://exa.ai/x" },
	]);
});

test("parseExaSearchText tolerates a group with no Published: or Author:", () => {
	const parsed = parseExaSearchText(
		[
			"Title: No dates here",
			"URL: https://example.com/nodates",
			"Author: Nobody",
			"Highlights:",
			"> Only a highlight.",
		].join("\n"),
	);

	assert.equal(parsed.length, 1);
	assert.equal(parsed[0].url, "https://example.com/nodates");
	assert.equal(parsed[0].pageAge, undefined);
	assert.equal(parsed[0].citedText, "Only a highlight.");
});

test("parseExaSearchText skips a fragment with no URL:", () => {
	const parsed = parseExaSearchText(
		[
			"Title: Orphan title",
			"Highlights:",
			"> A highlight without an anchor.",
			"",
			"Title: Real result",
			"URL: https://example.com/real",
			"Highlights:",
			"> The real highlight.",
		].join("\n"),
	);

	assert.equal(parsed.length, 1);
	assert.equal(parsed[0].url, "https://example.com/real");
	assert.equal(parsed[0].citedText, "The real highlight.");
});

test("parseExaSearchText returns nothing for prose that is not a result group", () => {
	assert.deepEqual(parseExaSearchText("The model could not be reached."), []);
	assert.deepEqual(parseExaSearchText(""), []);
});

// Regression: a highlight whose text happens to start with `URL:` used to hit
// the URL anchor, fabricate a phantom result and drop the next real highlight.
test("a highlight starting with URL: stays highlight content, not a new result", () => {
	const parsed = parseExaSearchText(
		[
			"Title: Rate limits",
			"URL: https://example.com/rate-limits",
			"Highlights:",
			"> Bardeen invented the transistor.",
			"URL: https://not-a-real.example.com is rate-limited",
			"> It was 1947.",
		].join("\n"),
	);

	assert.equal(parsed.length, 1);
	assert.equal(parsed[0].url, "https://example.com/rate-limits");
	assert.equal(
		parsed[0].citedText,
		"Bardeen invented the transistor.\n" +
			"URL: https://not-a-real.example.com is rate-limited\n" +
			"It was 1947.",
	);
});

test("a highlight starting with Title: does not split the result", () => {
	const parsed = parseExaSearchText(
		[
			"Title: Naming",
			"URL: https://example.com/naming",
			"Highlights:",
			"Title: an excerpt that opens with the word Title.",
		].join("\n"),
	);

	assert.equal(parsed.length, 1);
	assert.equal(parsed[0].title, "Naming");
	assert.equal(
		parsed[0].citedText,
		"Title: an excerpt that opens with the word Title.",
	);
});

test("footer text after the last blank line stays out of the final citedText", () => {
	const parsed = parseExaSearchText(
		[
			"Title: Bell Labs notes",
			"URL: https://example.com/bell-labs",
			"Highlights:",
			"> Bell Labs hosted the transistor team.",
			"",
			"Searched 4 sources in 1.2s",
		].join("\n"),
	);

	assert.equal(parsed.length, 1);
	assert.equal(parsed[0].citedText, "Bell Labs hosted the transistor team.");
});

test("unparseable keyless text degrades to one synthetic result", async () => {
	const { fetchImpl } = mcpFetch(["Plain prose with no anchors at all."]);

	const result = await withoutKey(() => exaSearch(request(), { fetchImpl }));

	assert.equal(result.searchResults?.length, 1);
	assert.equal(result.searchResults?.[0].url, undefined);
	assert.equal(
		result.searchResults?.[0].citedText,
		"Plain prose with no anchors at all.",
	);
	assert.equal(result.requestId, "mcp");
	assert.deepEqual(result.sources, []);
});

// --- default fetch fallback --------------------------------------------------

test("with no options.fetchImpl the transport falls back to globalThis.fetch", async () => {
	const previous = globalThis.fetch;
	// Stubbed, so this exercises the default-fetch path without any network.
	globalThis.fetch = ((url: string) => {
		if (url !== EXA_SEARCH_URL) {
			return Promise.reject(new Error(`unexpected url ${url}`));
		}
		return Promise.reject(new TypeError("fetch failed"));
	}) as typeof globalThis.fetch;

	try {
		const error = await withKey("exa-secret", () =>
			exaSearch(request())).then(
			() => undefined,
			(e: unknown) => e,
		);
		assert.equal((error as { code: string }).code, "network_error");
		assert.equal((error as { retryable?: boolean }).retryable, true);
		assert.match((error as Error).message, /fetch failed/);
	} finally {
		globalThis.fetch = previous;
	}
});

// --- urls --------------------------------------------------------------------

test("keyed URL fetches withhold unrequested and unidentified documents", async () => {
	const { fetchImpl } = queueFetch([
		{ body: JSON.stringify(SEARCH_FIXTURE) },
		{ body: JSON.stringify({ results: [
			{ url: "https://example.com/requested", text: "Requested evidence" },
			{ url: "https://evil.example/x", text: "Unexpected document" },
			{ text: "Unidentified document" },
		] }) },
	]);
	const result = await withKey("dummy-exa", () =>
		exaSearch(request({ urls: ["https://example.com/requested", "https://example.com/missing"] }), { fetchImpl }));
	assert.deepEqual(result.searchResults?.filter((entry) => entry.type === "content").map((entry) => entry.url), ["https://example.com/requested"]);
	assert.match(result.warnings?.join(" ") ?? "", /withheld 2 unrequested or unidentified/);
	assert.match(result.warnings?.join(" ") ?? "", /no parsed content for https:\/\/example.com\/missing/);
	assert.doesNotMatch(JSON.stringify(result), /Unexpected document|Unidentified document|evil\.example/);
});

test("keyless URL fetches cannot recast unrequested pages as unparsed evidence", async () => {
	const { fetchImpl } = mcpFetch(["", "# Unexpected\nURL: https://evil.example/x\n\nUnexpected document"]);
	const result = await withoutKey(() => exaSearch(request({ urls: ["https://example.com/requested"] }), { fetchImpl }));
	assert.deepEqual(result.searchResults, []);
	assert.match(result.warnings?.join(" ") ?? "", /withheld 1 unrequested or unidentified/);
	assert.match(result.warnings?.join(" ") ?? "", /no parsed content for/);
	assert.doesNotMatch(JSON.stringify(result), /Unexpected document|evil\.example/);
});

test("keyed urls hit /contents and append content results after the search", async () => {
	const { fetchImpl, requests } = queueFetch([
		{ body: JSON.stringify(SEARCH_FIXTURE) },
		{
			body: JSON.stringify({
				requestId: "req-456",
				status: { "https://example.com/transistor": { status: "success" } },
				results: [
					{
						id: "1",
						title: "Transistor history",
						url: "https://example.com/transistor",
						text: "Full page text.",
						summary: "A summary",
					},
				],
			}),
		},
	]);

	const result = await withKey("exa-secret", () =>
		exaSearch(
			request({ urls: ["https://example.com/transistor"] }),
			{ fetchImpl },
		)
	);

	assert.deepEqual(requests.map((r) => r.url), [EXA_SEARCH_URL, EXA_CONTENTS_URL]);
	assert.equal(requests[1].url, "https://api.exa.ai/contents");
	assert.equal(requests[1].headers?.["x-api-key"], "exa-secret");
	assert.deepEqual(requests[1].body, {
		urls: ["https://example.com/transistor"],
		// A documented per-document cap, not an unbounded `text: true`.
		text: { maxCharacters: 3000 },
	});

	assert.equal(result.searchResults?.length, 3);
	assert.deepEqual(result.searchResults?.[2], {
		title: "Transistor history",
		url: "https://example.com/transistor",
		source: "exa",
		citedText: "Full page text.",
		type: "content",
	});
	// The search requestId is the one the caller gets back.
	assert.equal(result.requestId, "req-123");
	assert.equal(result.warnings, undefined);
});

const FETCH_PAGES_TEXT = [
	"# First page",
	"URL: https://example.com/first",
	"",
	"first body ".repeat(60),
	"# Second page",
	"URL: https://example.com/second",
	"",
	"LATE EVIDENCE that must survive the per-result excerpt cap.",
].join("\n");

test("keyless urls become one URL-bound document per fetched page", async () => {
	const { fetchImpl, requests } = mcpFetch([MCP_SEARCH_TEXT, FETCH_PAGES_TEXT]);

	const result = await withoutKey(() =>
		exaSearch(
			request({
				urls: ["https://example.com/first", "https://example.com/second"],
			}),
			{ fetchImpl },
		)
	);

	const toolCalls = requests.filter((r) => r.body.method === "tools/call");
	assert.equal(toolCalls.length, 2);
	const fetchParams = toolCalls[1].body.params as {
		name: string;
		arguments: Record<string, unknown>;
	};
	assert.equal(fetchParams.name, "web_fetch_exa");
	assert.deepEqual(fetchParams.arguments, {
		urls: ["https://example.com/first", "https://example.com/second"],
		maxCharacters: 3000,
	});

	// Two search hits plus two per-page fetch documents.
	assert.equal(result.searchResults?.length, 4);
	assert.equal(result.searchResults?.[2].url, "https://example.com/first");
	assert.equal(result.searchResults?.[2].title, "First page");
	assert.equal(result.searchResults?.[3].url, "https://example.com/second");
	// The later page's evidence is its own document, not buried behind page 1.
	assert.match(result.searchResults?.[3].citedText ?? "", /LATE EVIDENCE/);
	assert.equal(result.warnings, undefined);
});

test("parseExaFetchText preserves per-URL failures as warnings", () => {
	const parsed = parseExaFetchText(
		[
			"# Ok",
			"URL: https://example.com/ok",
			"",
			"body",
			"Error fetching https://example.com/broken: CRAWL_UNKNOWN_ERROR",
		].join("\n"),
	);
	assert.equal(parsed.results.length, 1);
	assert.equal(parsed.results[0].url, "https://example.com/ok");
	assert.equal(parsed.warnings.length, 1);
	assert.match(parsed.warnings[0], /https:\/\/example\.com\/broken/);
	assert.match(parsed.warnings[0], /CRAWL_UNKNOWN_ERROR/);
});

test("a throwing URL fetch keeps the search results and lands in warnings", async () => {
	const { fetchImpl } = queueFetch([
		{ body: JSON.stringify(SEARCH_FIXTURE) },
		{ body: "upstream exploded", status: 500 },
	]);

	const result = await withKey("exa-secret", () =>
		exaSearch(
			request({ urls: ["https://example.com/transistor"] }),
			{ fetchImpl },
		)
	);

	assert.equal(result.searchResults?.length, 2);
	assert.equal(result.requestId, "req-123");
	assert.equal(result.warnings?.length, 1);
	assert.match(result.warnings?.[0] ?? "", /URL fetch failed \(http_error\)/);
	assert.match(result.warnings?.[0] ?? "", /HTTP 500/);
});

test("a rejecting keyless fetch is reported as a warning too", async () => {
	const { fetchImpl } = mcpFetch([MCP_SEARCH_TEXT]);
	let calls = 0;
	const flaky: FetchLike = (url, init) => {
		calls += 1;
		// Fail only the second client (the web_fetch_exa handshake).
		if (calls > 3) {
			return Promise.reject(new Error("socket hang up"));
		}
		return fetchImpl(url, init);
	};

	const result = await withoutKey(() =>
		exaSearch(
			request({ urls: ["https://example.com/transistor"] }),
			{ fetchImpl: flaky },
		)
	);

	assert.equal(result.searchResults?.length, 2);
	assert.equal(result.warnings?.length, 1);
	assert.match(result.warnings?.[0] ?? "", /URL fetch failed \(network_error\)/);
	assert.match(result.warnings?.[0] ?? "", /socket hang up/);
});

test("a keyless rate-limit refusal raises rate_limited so the family can fall back", async () => {
	// The refusal arrives in-band with HTTP success, so without this the text
	// became a fake search result and parallel was never consulted.
	const { fetchImpl } = mcpFetch([
		"You've hit Exa's free MCP rate limit. To continue using without limits, create your own Exa API key.",
	]);

	await assert.rejects(
		withoutKey(() => exaSearch(request(), { fetchImpl })),
		(error: { code?: string; retryable?: boolean }) => {
			assert.equal(error.code, "rate_limited");
			assert.equal(error.retryable, true, "must be retryable so the chain moves on");
			return true;
		},
	);
});

test("a 429 phrased fetch refusal also raises rate_limited", async () => {
	const { fetchImpl } = mcpFetch([
		MCP_SEARCH_TEXT,
		"HTTP 429 too many requests",
	]);

	await assert.rejects(
		withoutKey(() =>
			exaSearch(
				{ ...request(), urls: ["https://example.com/a"] },
				{ fetchImpl },
			),
		),
		(error: { code?: string }) => {
			assert.equal(error.code, "rate_limited");
			return true;
		},
	);
});
