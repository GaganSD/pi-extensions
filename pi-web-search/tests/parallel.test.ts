import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { applyConfig } from "../src/providers/config.ts";
import type { SearchRequest } from "../src/providers/index.ts";
import { parallelSearch, PARALLEL_MCP_SERVER } from "../src/providers/parallel.ts";
import { providerError } from "../src/providers/types.ts";

const query = "history of MCP native search";
const searchResult = {
	search_id: "search-123",
	results: [
		{ url: "https://example.test/one", title: "One", publish_date: null, excerpts: ["one excerpt"] },
		{ url: "https://example.test/two", title: "Two", publish_date: "2026-01-02", excerpts: ["two excerpt"] },
	],
	usage: [{ name: "search", count: 1 }],
};
type NativeCall = { name: string; args: Record<string, unknown>; signal?: AbortSignal };
function fixture(
	handler: (call: NativeCall) => unknown | Promise<unknown> = () => searchResult,
	sessionId = "conversation-one",
	modelId?: string,
) {
	const calls: NativeCall[] = [];
	const ctx = {
		sessionManager: { getSessionId: () => sessionId },
		model: modelId ? { id: modelId } : undefined,
		async executeTool(name: string, args: Record<string, unknown>, options?: { signal?: AbortSignal }) {
			const call = { name, args, signal: options?.signal };
			calls.push(call);
			const response = await handler(call);
			if (response && typeof response === "object" && "isError" in response) return response;
			return {
				isError: false,
				result: {
					content: [], details: {},
					structuredContent: { content: [{ type: "text", text: JSON.stringify(response) }] },
				},
			};
		},
	} as unknown as ExtensionToolContext;
	return { ctx, calls };
}
function request(ctx?: ExtensionToolContext, extra: Partial<SearchRequest> = {}): SearchRequest {
	return {
		query,
		settings: applyConfig("/tmp/web-search.json", { web: { provider: "parallel", fallback: [] } }),
		...(ctx ? { runtime: ctx } : {}),
		...extra,
	};
}

// Outcome.result.structuredContent is the MCP CallToolResult, not the payload itself.
test("anonymous native search uses the Pi nested permission pipeline without a key", async () => {
	const { ctx, calls } = fixture();
	const result = await parallelSearch(request(ctx));
	assert.equal(calls[0].name, `mcp__${PARALLEL_MCP_SERVER}__web_search`);
	assert.deepEqual(Object.keys(calls[0].args).sort(), ["objective", "search_queries", "session_id"]);
	assert.equal(calls[0].args.objective, query);
	assert.deepEqual(calls[0].args.search_queries, [query]);
	assert.equal(result.providerKind, "parallel");
	assert.equal(result.requestId, "search-123");
	assert.equal(result.searchResults?.[0].citedText, "one excerpt");
	assert.deepEqual(result.sources?.[0], { url: "https://example.test/one", title: "One" });
	assert.deepEqual(result.usage, [{ name: "search", count: 1 }]);
});

test("native absence gives actionable failure; never uses a private fallback", async () => {
	await assert.rejects(parallelSearch(request()), (error: { code: string; message: string }) => {
		assert.equal(error.code, "tool_error");
		assert.match(error.message, /built-in MCP.*\/mcp.*\/reload/);
		return true;
	});
	const { ctx } = fixture(() => ({ isError: true, result: { content: [{ type: "text", text: "Tool not found" }] } }));
	await assert.rejects(parallelSearch(request(ctx)), (error: { code: string; retryable: boolean; message: string }) =>
		error.code === "tool_error" && error.retryable === false && /Tool not found.*Check \/mcp/.test(error.message));
});

test("stable conversation hash survives separate calls and reload; new conversation changes it", async () => {
	const a = fixture();
	const b = fixture();
	const c = fixture(undefined, "conversation-two", "gpt-5.6-sol");
	await parallelSearch(request(a.ctx));
	await parallelSearch(request(a.ctx));
	await parallelSearch(request(b.ctx));
	await parallelSearch(request(c.ctx));
	const id = a.calls[0].args.session_id as string;
	assert.match(id, /^[a-f0-9]{64}$/);
	assert.equal(a.calls[1].args.session_id, id);
	assert.equal(b.calls[0].args.session_id, id);
	assert.notEqual(c.calls[0].args.session_id, id);
	assert.equal(c.calls[0].args.model_name, "gpt-5.6-sol");
	const oversized = fixture(undefined, "conversation-one", "x".repeat(101));
	await parallelSearch(request(oversized.ctx));
	assert.equal(oversized.calls[0].args.model_name, undefined);
	const unknown = fixture(undefined, "conversation-one", "unknown");
	await parallelSearch(request(unknown.ctx));
	assert.equal(unknown.calls[0].args.model_name, undefined);
});

test("fetch reuses search queries, session and model, clips objective and URL count, preserves requested evidence", async () => {
	const fetched = { results: [{ url: "https://example.test/page", title: "Page", excerpts: ["page excerpt"], full_content: "do not use" }, { url: "https://example.test/redirected", excerpts: ["redirected"] }], errors: [{ url: "https://example.test/gone" }] };
	const { ctx, calls } = fixture(({ name }) => name.endsWith("web_fetch") ? fetched : searchResult, "conversation-one", "gpt-5.6-sol");
	const urls = ["https://example.test/page", "https://example.test/gone", ...Array.from({ length: 20 }, (_, i) => `https://example.test/${i}`)];
	const output = await parallelSearch(request(ctx, { query: "x".repeat(300), urls }));
	assert.equal(calls.length, 2);
	assert.equal(calls[1].name, `mcp__${PARALLEL_MCP_SERVER}__web_fetch`);
	assert.equal((calls[1].args.urls as string[]).length, 20);
	assert.equal((calls[1].args.objective as string).length, 200);
	assert.deepEqual(calls[1].args.search_queries, calls[0].args.search_queries);
	assert.equal(calls[1].args.session_id, calls[0].args.session_id);
	assert.equal(calls[1].args.model_name, calls[0].args.model_name);
	assert.equal(calls[1].args.full_content, false);
	assert.equal(output.searchResults?.[2].type, "extract");
	assert.equal(output.searchResults?.[2].citedText, "page excerpt");
	assert.ok(output.warnings?.includes("https://example.test/gone"));
	// Preserve the provider's structured extract evidence, including canonical redirects.
	assert.equal(output.searchResults?.at(-1)?.url, "https://example.test/redirected");
});

test("confirmed anonymous JSON-in-text search and fetch envelopes normalize without using full_content", async () => {
	// Reduced from the successful protocol-shape probe in /tmp/pi-parallel-live-envelope.json.
	const liveSearch = JSON.stringify({ search_id: "search_29a6a2ef56337a3e5dfe89c8248acf21", results: [
		{ url: "https://nodejs.org/api/globals.html", title: "Global objects | Node.js", publish_date: null, excerpts: ["AbortSignal.timeout(delay)"] },
	], warnings: null, metadata: null, session_id: "probe-conversation" });
	const liveFetch = JSON.stringify({ extract_id: "extract_0bc59fb78273baa902cd554a5fde8eb1", results: [
		{ url: "https://nodejs.org/api/globals.html", title: "Global objects | Node.js", publish_date: "2026-09-21", excerpts: ["Static method: AbortSignal.timeout(delay)"], full_content: null },
	], errors: [], warnings: null, metadata: null, session_id: "probe-conversation" });
	const { ctx } = fixture(({ name }) => ({ isError: false, result: { content: [], details: {}, structuredContent: {
		content: [{ type: "text", text: name.endsWith("web_fetch") ? liveFetch : liveSearch }],
	} } }));
	const result = await parallelSearch(request(ctx, { urls: ["https://nodejs.org/api/globals.html"] }));
	assert.equal(result.requestId, "search_29a6a2ef56337a3e5dfe89c8248acf21");
	assert.deepEqual(result.searchResults?.map((hit) => hit.citedText), ["AbortSignal.timeout(delay)", "Static method: AbortSignal.timeout(delay)"]);
	assert.equal(result.searchResults?.[1].pageAge, "2026-09-21");
	assert.equal(result.warnings, undefined);
});

test("structured-only MCP results work and maxResults limits search presentation", async () => {
	const { ctx } = fixture(() => ({ isError: false, result: {
		content: [], details: {}, structuredContent: { content: [], structuredContent: searchResult },
	} }));
	const settings = applyConfig("/tmp/web-search.json", { maxResults: 1 });
	const result = await parallelSearch(request(ctx, { settings }));
	assert.equal(result.searchResults?.length, 1);
});

test("a nonempty array of malformed results is a provider failure, not an empty success", async () => {
	const { ctx } = fixture(() => ({ results: [{ title: "uncited" }] }));
	await assert.rejects(parallelSearch(request(ctx)), (e: { code: string }) => e.code === "parse_error");
});

test("malformed prose cannot invent citations or count as success", async () => {
	const { ctx } = fixture(() => ({ isError: false, result: { content: [], details: {}, structuredContent: { content: [{ type: "text", text: "Title: Invented URL: https://fake.test" }] } } }));
	await assert.rejects(parallelSearch(request(ctx)), (e: { code: string }) => e.code === "parse_error");
});

test("MCP server errors retain auth and retryable 429/5xx classifications", async () => {
	for (const [text, code, retryable] of [
		["Tool execution was blocked: permission denied", "tool_error", false],
		["HTTP 429 permission denied: too many requests", "rate_limited", true],
		["HTTP 503 temporarily unavailable", "http_error", true],
		["HTTP 401 unauthorized", "http_error", false],
		["HTTP 422 invalid objective", "http_error", false],
	] as const) {
		const { ctx } = fixture(() => ({ isError: true, result: { content: [{ type: "text", text }], details: {}, structuredContent: { content: [{ type: "text", text }], isError: true } } }));
		await assert.rejects(parallelSearch(request(ctx)), (e: { code: string; retryable: boolean }) => e.code === code && e.retryable === retryable);
	}
});

test("Pi host failures without an MCP error envelope cannot trigger fallback from arbitrary reason text", async () => {
	for (const text of ["No thanks", "HTTP 429 too many requests", "Tool execution was blocked: permission denied"]) {
		const { ctx } = fixture(() => ({ isError: true, result: { content: [{ type: "text", text }], details: {} } }));
		await assert.rejects(parallelSearch(request(ctx)), (error: { code: string; retryable: boolean; message: string }) => {
			assert.equal(error.code, "tool_error");
			assert.equal(error.retryable, false);
			assert.match(error.message, /Pi's tool pipeline:.*Check \/mcp/);
			assert.ok(error.message.includes(text));
			return true;
		});
	}
});

test("inner MCP isError without outer isError is still an actionable failure", async () => {
	const { ctx } = fixture(() => ({ isError: false, result: { content: [], details: {}, structuredContent: {
		content: [{ type: "text", text: "HTTP 429 too many requests" }], isError: true,
	} } }));
	await assert.rejects(parallelSearch(request(ctx)), (e: { code: string; status: number }) => e.code === "rate_limited" && e.status === 429);
});

test("failed fetch keeps search citations but caller abort is fatal", async () => {
	const { ctx } = fixture(({ name }) => name.endsWith("web_fetch") ? { isError: true, result: { content: [{ type: "text", text: "connection dropped" }] } } : searchResult);
	const result = await parallelSearch(request(ctx, { urls: ["https://example.test/page"] }));
	assert.equal(result.searchResults?.length, 2);
	assert.match(result.warnings?.join(" ") ?? "", /parallel fetch failed/);
	const controller = new AbortController();
	const stuck = fixture(() => new Promise(() => {}));
	const pending = parallelSearch(request(stuck.ctx, { signal: controller.signal }));
	assert.equal(stuck.calls[0]?.signal, controller.signal);
	controller.abort(providerError("timeout", "deadline passed"));
	await assert.rejects(pending, (e: { code: string }) => e.code === "timeout");
	const fetchAbort = new AbortController();
	const halfStuck = fixture(({ name }) => name.endsWith("web_fetch") ? new Promise(() => {}) : searchResult);
	const fetchPending = parallelSearch(request(halfStuck.ctx, { urls: ["https://example.test/one"], signal: fetchAbort.signal }));
	while (halfStuck.calls.length < 2) await new Promise((resolve) => setImmediate(resolve));
	fetchAbort.abort();
	await assert.rejects(fetchPending, (e: { code: string }) => e.code === "aborted");
});
