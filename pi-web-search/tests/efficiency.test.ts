import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { EvidenceStore, evidenceStore } from "../src/evidence.ts";
import { searchRead } from "../src/search_read.ts";
import { uniqueEvidence, previewEvidence } from "../src/providers/results.ts";
import { applyConfig } from "../src/providers/config.ts";
import { reuseTransport, clearRetrievalCache } from "../src/providers/reuse.ts";
import { normalizeHttpError, retryAfterMs } from "../src/providers/http.ts";
import { providerError, type StreamResult } from "../src/providers/types.ts";
import type { SearchRequest } from "../src/providers/index.ts";
import { parallelSearch } from "../src/providers/parallel.ts";
import { exaSearch } from "../src/providers/exa.ts";

const result: StreamResult = { text: "", providerKind: "exa", searchResults: [{ url: "https://example.com/doc", citedText: "prefix " + "text ".repeat(200) + "NEEDLE useful detail" }] };
const ctx = (id: string) => ({ sessionManager: { getSessionId: () => id } }) as ExtensionContext;
const request = (extra: Partial<SearchRequest> = {}): SearchRequest => ({ query: "fixture", settings: applyConfig("fixture", {}), ...extra });

test("stored evidence is bounded, expires, isolates sessions and never mutates input", () => {
	let now = 0;
	const store = new EvidenceStore(() => now);
	const value = { ...result, searchResults: [{ citedText: "x".repeat(300_000) }] };
	const handle = store.put("one", value)!;
	assert.equal(handle.storedClipped, true);
	assert.equal(store.get("two", handle.resultId), undefined);
	const read = store.get("one", handle.resultId)!;
	assert.equal(read.result.searchResults![0].citedText!.length, 64_000);
	read.result.searchResults![0].citedText = "mutated";
	assert.equal(value.searchResults[0].citedText.length, 300_000);
	assert.notEqual(store.get("one", handle.resultId)!.result.searchResults![0].citedText, "mutated");
	for (let i = 0; i < 32; i++) store.put("one", result);
	assert.equal(store.get("one", handle.resultId), undefined, "oldest entry evicted");
	const latest = store.put("one", result)!;
	now = 600_001;
	assert.equal(store.get("one", latest.resultId), undefined);
});

test("search_read lists, pages and finds original evidence locally with truthful offsets", () => {
	const handle = evidenceStore.put("reader", result)!;
	const list = searchRead(handle, ctx("reader"));
	assert.equal(list.details.storedCount, 1);
	const page = searchRead({ ...handle, index: 0, limit: 30 }, ctx("reader"));
	assert.equal(page.details.searchResults![0].citedText!.length, 30);
	assert.equal(page.details.passage!.nextOffset, 30);
	const found = searchRead({ ...handle, index: 0, find: "needle" }, ctx("reader"));
	assert.equal(found.details.passage!.matches, 1);
	assert.match(found.details.searchResults![0].citedText!, /NEEDLE useful detail/);
	assert.equal(searchRead({ ...handle, index: 0, find: "missing" }, ctx("reader")).details.passage!.matches, 0);
	assert.equal(searchRead(handle, ctx("other")).isError, true);
	assert.equal(searchRead({ ...handle, index: 0, find: "needle", offset: 1 }, ctx("reader")).isError, true);
	assert.equal(searchRead({ ...handle, index: 99 }, ctx("reader")).isError, true);
	evidenceStore.clear("reader");
	assert.equal(searchRead(handle, ctx("reader")).isError, true);
});

test("passage paging preserves Unicode and always advances; find is literal", () => {
	const handle = evidenceStore.put("unicode", { ...result, searchResults: [{ url: "https://example.com", citedText: "😀 .* more evidence" }] })!;
	const page = searchRead({ ...handle, index: 0, limit: 2 }, ctx("unicode"));
	assert.equal(page.details.searchResults![0].citedText, "😀");
	assert.equal(page.details.passage!.nextOffset, 2);
	const found = searchRead({ ...handle, index: 0, limit: 2, find: ".*" }, ctx("unicode"));
	assert.equal(found.details.searchResults![0].citedText, ".*");
	assert.equal(found.details.passage!.matches, 1);
	evidenceStore.clear("unicode");
});

test("preview deduplicates exact evidence but retains distinct passages, queries and code anchors", () => {
	const a = { url: "https://example.com/a?q=1#L1", citedText: "same", source: "grep" };
	const unique = uniqueEvidence({ ...result, searchResults: [a, { ...a, source: "sourcegraph" }, { ...a, citedText: "other" }, { ...a, url: "https://example.com/a?q=2#L1" }, { ...a, url: "https://example.com/a?q=1#L2" }, { url: "https://example.com/requested", type: "extract", citedText: "requested" }] });
	assert.equal(unique.searchResults!.length, 5);
	assert.equal(unique.searchResults![0].source, "grep, sourcegraph");
	const preview = previewEvidence(unique, 2, ["https://example.com/requested"]);
	assert.equal(preview.searchResults!.length, 2);
	assert.equal(preview.searchResults![0].citedText, "requested");
	assert.match(preview.warnings!.join(), /3 additional/);
});

test("reuse coalesces work, isolates caller cancellation, clones results and skips native permissions", async () => {
	clearRetrievalCache();
	let calls = 0;
	let resolve!: (value: StreamResult) => void;
	let sharedSignal: AbortSignal | undefined;
	const transport = async (req: SearchRequest) => { calls++; sharedSignal = req.signal; return new Promise<StreamResult>((done) => { resolve = done; }); };
	const controller = new AbortController();
	const req = request({ reuseScope: "reuse" });
	const one = reuseTransport("exa", { ...req, signal: controller.signal }, transport);
	const two = reuseTransport("exa", req, transport);
	await new Promise((done) => setImmediate(done));
	controller.abort(providerError("aborted", "one cancelled"));
	await assert.rejects(one, /one cancelled/);
	assert.equal(sharedSignal!.aborted, false);
	resolve(result);
	const value = await two;
	value.searchResults![0].citedText = "mutated";
	const cached = await reuseTransport("exa", req, transport);
	assert.equal(calls, 1);
	assert.notEqual(cached.searchResults![0].citedText, "mutated");
	assert.match(cached.warnings!.join(), /Reused session/);
	let native = 0;
	for (let i = 0; i < 2; i++) await reuseTransport("parallel", req, async () => { native++; return result; });
	assert.equal(native, 2);
	clearRetrievalCache();
});

test("rate-limit cooldown honors headers; errors are never stored as search evidence", async () => {
	clearRetrievalCache();
	assert.equal(retryAfterMs("12"), 12_000);
	assert.equal(retryAfterMs("invalid"), undefined);
	assert.equal(retryAfterMs("900"), 60_000);
	assert.equal(retryAfterMs(new Date(20_000).toUTCString(), 10_000), 10_000);
	const err = normalizeHttpError({ ok: false, status: 429, headers: { get: () => "12" }, text: async () => "" }, "");
	assert.equal(err.retryAfterMs, 12_000);
	let calls = 0;
	const transport = async () => { calls++; throw err; };
	const req = request({ reuseScope: "cooldown" });
	await assert.rejects(reuseTransport("exa", req, transport), /429/);
	await assert.rejects(reuseTransport("exa", req, transport), /cooling down/);
	assert.equal(calls, 1);
	clearRetrievalCache("cooldown");
	await assert.rejects(reuseTransport("exa", req, transport), /429/);
	assert.equal(calls, 2);
	clearRetrievalCache();
});

test("reuse expires and invalidates on config, session or credential changes", async () => {
	clearRetrievalCache();
	const priorNow = Date.now;
	const priorKey = process.env.EXA_API_KEY;
	let now = priorNow();
	Date.now = () => now;
	let calls = 0;
	const transport = async () => { calls++; return result; };
	try {
		delete process.env.EXA_API_KEY;
		const req = request({ reuseScope: "expiry" });
		await reuseTransport("exa", req, transport);
		await reuseTransport("exa", req, transport);
		assert.equal(calls, 1);
		now += 30_001;
		await reuseTransport("exa", req, transport);
		assert.equal(calls, 2);
		await reuseTransport("exa", { ...req, settings: { ...req.settings, maxResults: 1 } }, transport);
		await reuseTransport("exa", { ...req, reuseScope: "other" }, transport);
		process.env.EXA_API_KEY = "rotated-test-key";
		await reuseTransport("exa", req, transport);
		assert.equal(calls, 5);
	} finally {
		Date.now = priorNow;
		if (priorKey === undefined) delete process.env.EXA_API_KEY; else process.env.EXA_API_KEY = priorKey;
		clearRetrievalCache();
	}
});

test("all cancelled coalesced callers abort shared work and cannot cache late success", async () => {
	clearRetrievalCache();
	const a = new AbortController();
	const b = new AbortController();
	let shared: AbortSignal | undefined;
	let resolve!: (value: StreamResult) => void;
	const req = request({ reuseScope: "cancel-all" });
	const transport = async (value: SearchRequest) => { shared = value.signal; return new Promise<StreamResult>((done) => { resolve = done; }); };
	const one = reuseTransport("exa", { ...req, signal: a.signal }, transport);
	const two = reuseTransport("exa", { ...req, signal: b.signal }, transport);
	await new Promise((done) => setImmediate(done));
	a.abort(providerError("aborted", "cancelled A")); b.abort(providerError("aborted", "cancelled B"));
	await Promise.all([assert.rejects(one, /cancelled A/), assert.rejects(two, /cancelled B/)]);
	assert.equal(shared!.aborted, true);
	resolve(result);
	await new Promise((done) => setImmediate(done));
	let fresh = 0;
	await reuseTransport("exa", req, async () => { fresh++; return result; });
	assert.equal(fresh, 1);
	clearRetrievalCache();
});

test("credential and configuration failures do not create cached failures or cooldowns", async () => {
	clearRetrievalCache();
	let calls = 0;
	for (const code of ["missing_credentials", "invalid_config"] as const) {
		for (let i = 0; i < 2; i++) await assert.rejects(reuseTransport("exa", request({ reuseScope: "errors" }), async () => { calls++; throw providerError(code, "not cached"); }), /not cached/);
	}
	assert.equal(calls, 4);
	clearRetrievalCache();
});

test("keyed Exa URL-only retrieval calls contents without search", async () => {
	const priorKey = process.env.EXA_API_KEY;
	process.env.EXA_API_KEY = "fixture-key";
	const urls: string[] = [];
	try {
		const output = await exaSearch(request({ query: "", fetchOnly: true, urls: ["https://example.com/doc"] }), { fetchImpl: async (url) => {
			urls.push(url);
			return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ results: [{ url: "https://example.com/doc", title: "Doc", text: "evidence" }] }) };
		} });
		assert.deepEqual(urls, ["https://api.exa.ai/contents"]);
		assert.equal(output.searchResults![0].citedText, "evidence");
	} finally { if (priorKey === undefined) delete process.env.EXA_API_KEY; else process.env.EXA_API_KEY = priorKey; }
});

test("keyless Exa URL-only retrieval makes no search RPC", async () => {
	const names: string[] = [];
	const old = process.env.EXA_API_KEY;
	delete process.env.EXA_API_KEY;
	try {
		const output = await exaSearch(request({ query: "", fetchOnly: true, urls: ["https://example.com/doc"] }), { fetchImpl: async (_url, init) => {
			const body = init.body ? JSON.parse(init.body) : {};
			if (body.method === "tools/call") names.push(body.params.name);
			const payload = body.method === "initialize" ? { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "fixture", version: "1" } } : { content: [{ type: "text", text: "URL: https://example.com/doc\nTitle: Doc\nContent:\nUseful evidence" }] };
			return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ jsonrpc: "2.0", id: body.id, result: payload }) };
		} });
		assert.deepEqual(names, ["web_fetch_exa"]);
		assert.ok(output.searchResults?.length);
		assert.ok(!output.warnings?.includes("Exa search returned no content."));
	} finally { if (old === undefined) delete process.env.EXA_API_KEY; else process.env.EXA_API_KEY = old; }
});

test("Parallel URL-only calls only fetch; combined operations start concurrently", async () => {
	const calls: string[] = [];
	let release!: () => void;
	let gate = new Promise<void>((done) => { release = done; });
	const runtime = { executeTool: async (name: string) => {
		calls.push(name);
		if (name.endsWith("web_search")) await gate;
		else release();
		return { isError: false, result: { structuredContent: { structuredContent: { results: [{ url: "https://example.com/doc", title: "Doc", excerpts: ["evidence"] }] } } } };
	} } as unknown as SearchRequest["runtime"];
	await parallelSearch(request({ query: "", fetchOnly: true, urls: ["https://example.com/doc"], runtime }));
	assert.deepEqual(calls, ["mcp__pi_web_search_parallel__web_fetch"]);
	calls.length = 0;
	gate = new Promise<void>((done) => { release = done; });
	await parallelSearch(request({ urls: ["https://example.com/doc"], runtime }));
	assert.equal(calls.length, 2);
});
