import assert from "node:assert/strict";
import { after, afterEach, beforeEach, test } from "node:test";

import { applyConfig } from "../src/providers/config.ts";
import { type FetchLike, type ResponseLike } from "../src/providers/http.ts";
import type { SearchRequest } from "../src/providers/index.ts";
import { parallelSearch } from "../src/providers/parallel.ts";

const API_KEY = "test-parallel-key";
const QUERY = "who won the 2024 physics nobel";

const originalKey = process.env.PARALLEL_API_KEY;
const originalFetch = globalThis.fetch;

beforeEach(() => {
	process.env.PARALLEL_API_KEY = API_KEY;
});

afterEach(() => {
	restoreKey();
	globalThis.fetch = originalFetch;
});

after(() => {
	restoreKey();
	globalThis.fetch = originalFetch;
});

function restoreKey(): void {
	if (originalKey === undefined) {
		delete process.env.PARALLEL_API_KEY;
	} else {
		process.env.PARALLEL_API_KEY = originalKey;
	}
}

interface RecordedCall {
	url: string;
	init: Parameters<FetchLike>[1];
}

function jsonResponse(body: unknown, status = 200): ResponseLike {
	return {
		ok: status >= 200 && status < 300,
		status,
		headers: { get: () => "application/json" },
		text: () => Promise.resolve(JSON.stringify(body)),
	};
}

function errorResponse(status: number, body: unknown): ResponseLike {
	return jsonResponse(body, status);
}

interface ErrorShape {
	code?: string;
	status?: number;
	retryable?: boolean;
	message?: string;
}

/** Answers `/v1/search` from `search` and `/v1/extract` from `extract`. */
function stubFetch(
	search: () => ResponseLike,
	extract?: () => ResponseLike,
): { fetchImpl: FetchLike; calls: RecordedCall[] } {
	const calls: RecordedCall[] = [];
	const fetchImpl: FetchLike = (url, init) => {
		calls.push({ url, init });
		const respond = url.includes("/v1/extract") ? extract : search;
		return Promise.resolve(
			respond ? respond() : jsonResponse({ results: [], errors: [] }),
		);
	};
	return { fetchImpl, calls };
}

function makeRequest(overrides: Partial<SearchRequest> = {}): SearchRequest {
	return {
		query: QUERY,
		settings: applyConfig("/tmp/web-search.json", {
			web: { provider: "parallel", fallback: [] },
		}),
		...overrides,
	};
}

function bodyOf(call: RecordedCall): Record<string, unknown> {
	return JSON.parse(String(call.init.body)) as Record<string, unknown>;
}

function searchFixture(overrides: Record<string, unknown> = {}): unknown {
	return {
		search_id: "search-123",
		session_id: "session-abc",
		results: [
			{
				url: "https://example.com/a",
				title: "Result A",
				publish_date: "2024-10-03",
				excerpts: ["first excerpt", "second excerpt"],
			},
			{
				url: "https://example.com/b",
				title: "Result B",
				publish_date: "2024-10-05",
				excerpts: ["b excerpt"],
			},
		],
		warnings: [],
		usage: [{ name: "search", count: 1 }],
		...overrides,
	};
}

test("a missing PARALLEL_API_KEY fails as missing_credentials with no fetch", async () => {
	delete process.env.PARALLEL_API_KEY;
	const stub = stubFetch(() => jsonResponse(searchFixture()));

	await assert.rejects(
		() => parallelSearch(makeRequest(), { fetchImpl: stub.fetchImpl }),
		(error: ErrorShape) => {
			assert.equal(error.code, "missing_credentials");
			assert.equal(error.retryable, false);
			assert.match(String(error.message), /PARALLEL_API_KEY/);
			return true;
		},
	);
	assert.equal(stub.calls.length, 0);
});

test("a blank PARALLEL_API_KEY counts as missing", async () => {
	process.env.PARALLEL_API_KEY = "   ";
	const stub = stubFetch(() => jsonResponse(searchFixture()));

	await assert.rejects(
		() => parallelSearch(makeRequest(), { fetchImpl: stub.fetchImpl }),
		(error: ErrorShape) => {
			assert.equal(error.code, "missing_credentials");
			return true;
		},
	);
	assert.equal(stub.calls.length, 0);
});

test("the key is read at call time and trimmed", async () => {
	process.env.PARALLEL_API_KEY = "  padded-key  ";
	const stub = stubFetch(() => jsonResponse(searchFixture()));

	await parallelSearch(makeRequest(), { fetchImpl: stub.fetchImpl });

	assert.equal(stub.calls[0].init.headers?.["x-api-key"], "padded-key");
});

test("posts the GA schema to /v1/search with the documented headers", async () => {
	const stub = stubFetch(() => jsonResponse(searchFixture()));

	await parallelSearch(makeRequest(), { fetchImpl: stub.fetchImpl });

	assert.equal(stub.calls.length, 1);
	const call = stub.calls[0];
	assert.equal(call.url, "https://api.parallel.ai/v1/search");
	assert.ok(!call.url.includes("/v1beta/"));
	assert.equal(call.init.method, "POST");

	const headers = call.init.headers ?? {};
	assert.equal(headers["Content-Type"], "application/json");
	assert.equal(headers["x-api-key"], API_KEY);
	assert.equal(headers["Authorization"], undefined);
	assert.equal(headers["parallel-beta"], undefined);

	assert.deepEqual(bodyOf(call), {
		objective: QUERY,
		search_queries: [QUERY],
		mode: "fast",
		max_chars_total: 20000,
		advanced_settings: {
			max_results: 8,
			excerpt_settings: { max_chars_per_result: 2500 },
		},
	});
});

test("maps search results into details and sources", async () => {
	const stub = stubFetch(() => jsonResponse(searchFixture()));

	const result = await parallelSearch(makeRequest(), { fetchImpl: stub.fetchImpl });

	assert.equal(result.providerKind, "parallel");
	assert.equal(result.requestId, "search-123");
	assert.equal(result.text, "");
	assert.equal(result.searchResults?.length, 2);
	assert.equal(result.sources?.length, 2);

	// Asserted before the deepEqual below because `assert.deepEqual` narrows
	// its first argument to the literal type of the second.
	// Search results carry no `type`; only extracted pages do.
	assert.equal(result.searchResults?.[0].type, undefined);
	assert.equal(result.searchResults?.[1].type, undefined);

	assert.deepEqual(result.searchResults?.[0], {
		title: "Result A",
		url: "https://example.com/a",
		source: "parallel",
		pageAge: "2024-10-03",
		citedText: "first excerpt\nsecond excerpt",
	});
	assert.deepEqual(result.sources?.[0], {
		title: "Result A",
		url: "https://example.com/a",
	});
	assert.deepEqual(result.sources?.[1], {
		title: "Result B",
		url: "https://example.com/b",
	});
});

test("a missing search_id leaves requestId unset", async () => {
	const stub = stubFetch(() => jsonResponse(searchFixture({ search_id: undefined })));

	const result = await parallelSearch(makeRequest(), { fetchImpl: stub.fetchImpl });

	assert.equal(result.requestId, undefined);
	assert.equal(result.searchResults?.length, 2);
});

test("nullable title and publish_date fall back instead of crashing", async () => {
	const stub = stubFetch(() =>
		jsonResponse(
			searchFixture({
				results: [
					{
						url: "https://example.com/null",
						title: null,
						publish_date: null,
						excerpts: [],
					},
				],
			}),
		),
	);

	const result = await parallelSearch(makeRequest(), { fetchImpl: stub.fetchImpl });

	const detail = result.searchResults?.[0];
	assert.equal(detail?.title, undefined);
	assert.equal(detail?.pageAge, null);
	assert.equal(detail?.citedText, "");
	assert.equal(detail?.url, "https://example.com/null");
	assert.deepEqual(result.sources?.[0], {
		title: "https://example.com/null",
		url: "https://example.com/null",
	});
});

test("malformed result entries are skipped rather than throwing", async () => {
	const stub = stubFetch(() =>
		jsonResponse(
			searchFixture({
				results: [
					null,
					"nonsense",
					{ title: "no url" },
					{ url: "https://example.com/ok", excerpts: "not-an-array" },
				],
			}),
		),
	);

	const result = await parallelSearch(makeRequest(), { fetchImpl: stub.fetchImpl });

	assert.equal(result.searchResults?.length, 1);
	assert.equal(result.searchResults?.[0].url, "https://example.com/ok");
	assert.equal(result.searchResults?.[0].citedText, "");
});

test("passes warnings and usage through", async () => {
	const stub = stubFetch(() =>
		jsonResponse(
			searchFixture({
				warnings: [
					{ type: "partial", message: "some sources were skipped" },
					{ type: "info", message: "truncated to max_results" },
				],
				usage: [
					{ name: "search", count: 1 },
					{ name: "tokens", count: 4096 },
				],
			}),
		),
	);

	const result = await parallelSearch(makeRequest(), { fetchImpl: stub.fetchImpl });

	assert.deepEqual(result.warnings, [
		"some sources were skipped",
		"truncated to max_results",
	]);
	assert.deepEqual(result.usage, [
		{ name: "search", count: 1 },
		{ name: "tokens", count: 4096 },
	]);
});

test("an empty search result set still returns a well-formed result", async () => {
	const stub = stubFetch(() =>
		jsonResponse(searchFixture({ results: [], warnings: [], usage: [] })),
	);

	const result = await parallelSearch(makeRequest(), { fetchImpl: stub.fetchImpl });

	assert.deepEqual(result.searchResults, []);
	assert.deepEqual(result.sources, []);
	assert.equal(result.warnings, undefined);
	assert.equal(result.usage, undefined);
	assert.equal(result.requestId, "search-123");
});

test("urls trigger a second /v1/extract call whose results are appended", async () => {
	const stub = stubFetch(
		() => jsonResponse(searchFixture()),
		() =>
			jsonResponse({
				extract_id: "extract-1",
				results: [
					{
						url: "https://example.com/page",
						title: "Fetched page",
						publish_date: "2024-01-01",
						excerpts: ["page excerpt"],
						full_content: "full page body",
					},
				],
				errors: [
					{
						url: "https://example.com/gone",
						error_type: "not_found",
						http_status_code: 404,
						content: "missing",
					},
				],
			}),
	);

	const result = await parallelSearch(
		makeRequest({
			urls: ["https://example.com/page", "https://example.com/gone"],
		}),
		{ fetchImpl: stub.fetchImpl },
	);

	assert.equal(stub.calls.length, 2);
	assert.equal(stub.calls[1].url, "https://api.parallel.ai/v1/extract");
	assert.deepEqual(bodyOf(stub.calls[1]), {
		urls: ["https://example.com/page", "https://example.com/gone"],
		objective: QUERY,
		max_chars_total: 20000,
		advanced_settings: {
			excerpt_settings: { max_chars_per_result: 2500 },
		},
	});
	// `full_content` is never requested: full-page markdown for up to 20 URLs is a
	// token bomb, and the objective-aligned excerpt is the signal the model wants.
	assert.equal(
		(bodyOf(stub.calls[1]).advanced_settings as Record<string, unknown>).full_content,
		undefined,
	);

	assert.equal(result.searchResults?.length, 3);
	assert.deepEqual(result.searchResults?.[2], {
		title: "Fetched page",
		url: "https://example.com/page",
		source: "parallel",
		pageAge: "2024-01-01",
		citedText: "page excerpt",
		type: "extract",
	});
	assert.equal(result.sources?.length, 3);
	assert.deepEqual(result.sources?.[2], {
		title: "Fetched page",
		url: "https://example.com/page",
	});
	assert.ok(result.warnings?.includes("https://example.com/gone"));
});

test("the extract call sends the same api key header", async () => {
	const stub = stubFetch(
		() => jsonResponse(searchFixture()),
		() => jsonResponse({ results: [], errors: [] }),
	);

	await parallelSearch(
		makeRequest({ urls: ["https://example.com/page"] }),
		{ fetchImpl: stub.fetchImpl },
	);

	assert.equal(stub.calls[1].init.headers?.["x-api-key"], API_KEY);
	assert.equal(stub.calls[1].init.headers?.["Content-Type"], "application/json");
});

test("a rejecting extract still returns the search results", async () => {
	const stub = stubFetch(
		() => jsonResponse(searchFixture()),
		() => errorResponse(500, { message: "extract exploded" }),
	);

	const result = await parallelSearch(
		makeRequest({ urls: ["https://example.com/page"] }),
		{ fetchImpl: stub.fetchImpl },
	);

	assert.equal(stub.calls.length, 2);
	assert.equal(result.searchResults?.length, 2);
	assert.equal(result.sources?.length, 2);
	assert.equal(result.providerKind, "parallel");
	assert.equal(result.requestId, "search-123");
	assert.ok(
		result.warnings?.some((warning) =>
			warning.startsWith("parallel extract failed:")
		),
		`expected an extract failure warning, got ${JSON.stringify(result.warnings)}`,
	);
});

test("a rejected extract network call is also reported as a warning", async () => {
	const calls: RecordedCall[] = [];
	const fetchImpl: FetchLike = (url, init) => {
		calls.push({ url, init });
		if (url.includes("/v1/extract")) {
			return Promise.reject(new Error("socket hang up"));
		}
		return Promise.resolve(jsonResponse(searchFixture()));
	};

	const result = await parallelSearch(
		makeRequest({ urls: ["https://example.com/page"] }),
		{ fetchImpl },
	);

	assert.equal(calls.length, 2);
	assert.equal(result.searchResults?.length, 2);
	assert.ok(
		result.warnings?.some((warning) => warning.includes("socket hang up")),
		`expected the network failure in warnings, got ${JSON.stringify(result.warnings)}`,
	);
});

test("no urls means no extract call", async () => {
	const stub = stubFetch(
		() => jsonResponse(searchFixture()),
		() => jsonResponse({ results: [] }),
	);

	await parallelSearch(
		makeRequest({ urls: [] }),
		{ fetchImpl: stub.fetchImpl },
	);

	assert.equal(stub.calls.length, 1);
});

test("401 becomes http_error with the status preserved", async () => {
	const stub = stubFetch(() => errorResponse(401, { message: "invalid api key" }));

	await assert.rejects(
		() => parallelSearch(makeRequest(), { fetchImpl: stub.fetchImpl }),
		(error: ErrorShape) => {
			assert.equal(error.code, "http_error");
			assert.equal(error.status, 401);
			assert.equal(error.retryable, false);
			return true;
		},
	);
});

test("429 becomes rate_limited and is retryable", async () => {
	const stub = stubFetch(() => errorResponse(429, { message: "slow down" }));

	await assert.rejects(
		() => parallelSearch(makeRequest(), { fetchImpl: stub.fetchImpl }),
		(error: ErrorShape) => {
			assert.equal(error.code, "rate_limited");
			assert.equal(error.status, 429);
			assert.equal(error.retryable, true);
			return true;
		},
	);
});

test("422 surfaces the API message so the model can correct itself", async () => {
	const stub = stubFetch(() =>
		errorResponse(422, {
			type: "invalid_request_error",
			message: "max_results must be between 1 and 20",
		}),
	);

	await assert.rejects(
		() => parallelSearch(makeRequest(), { fetchImpl: stub.fetchImpl }),
		(error: ErrorShape) => {
			assert.equal(error.code, "http_error");
			assert.equal(error.status, 422);
			assert.equal(error.retryable, false);
			assert.match(
				String(error.message),
				/max_results must be between 1 and 20/,
			);
			return true;
		},
	);
});

test("req.settings.maxResults flows into advanced_settings.max_results", async () => {
	const stub = stubFetch(() => jsonResponse(searchFixture()));
	const request = makeRequest({
		settings: applyConfig("/tmp/web-search.json", {
			web: { provider: "parallel", fallback: [] },
			maxResults: 3,
		}),
	});

	await parallelSearch(request, { fetchImpl: stub.fetchImpl });

	assert.deepEqual(bodyOf(stub.calls[0]).advanced_settings, {
		max_results: 3,
		excerpt_settings: { max_chars_per_result: 2500 },
	});
});

test("without an injected fetchImpl the default globalThis.fetch is used", async () => {
	// Exercises http.ts's `options.fetchImpl ?? globalThis.fetch` default
	// without a network call: the global itself is replaced by a stub.
	const seen: string[] = [];
	globalThis.fetch = ((url: string) => {
		seen.push(url);
		return Promise.resolve(jsonResponse(searchFixture()));
	}) as unknown as typeof globalThis.fetch;

	const result = await parallelSearch(makeRequest());

	assert.deepEqual(seen, ["https://api.parallel.ai/v1/search"]);
	assert.equal(result.providerKind, "parallel");
	assert.equal(result.searchResults?.length, 2);
});

test("with no fetch available at all the failure is a retryable network_error", async () => {
	// No network call happens here: http.ts throws before reaching out.
	(globalThis as { fetch?: unknown }).fetch = undefined;

	await assert.rejects(
		() => parallelSearch(makeRequest()),
		(error: ErrorShape) => {
			assert.equal(error.code, "network_error");
			assert.equal(error.retryable, true);
			assert.match(String(error.message), /No fetch implementation/);
			return true;
		},
	);
});

test("an abort signal is forwarded to fetch", async () => {
	const controller = new AbortController();
	const stub = stubFetch(() => jsonResponse(searchFixture()));

	await parallelSearch(
		makeRequest({ signal: controller.signal }),
		{ fetchImpl: stub.fetchImpl },
	);

	assert.equal(stub.calls[0].init.signal?.aborted, false);
});
