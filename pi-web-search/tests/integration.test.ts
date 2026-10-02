import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { exaSearch, parseExaFetchText, parseExaSearchText } from "../src/providers/exa.ts";
import { type FetchLike, postJson } from "../src/providers/http.ts";
import { applyConfig } from "../src/providers/config.ts";
import { createMcpClient } from "../src/providers/mcp.ts";
import { systemOne } from "../src/jev/api.ts";
import { multiSearch } from "../src/multi_search.ts";
import { webSearch } from "../src/web_search.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { classifierRegistry } from "./fixtures/native-jev.ts";

const ctx = {} as ExtensionContext;
const document = { text: "", providerKind: "exa" as const, searchResults: [{ title: "Evidence", url: "https://example.com", citedText: "Retrieved evidence" }], sources: [{ title: "Evidence", url: "https://example.com" }] };

async function withSettings(settings: unknown, run: () => Promise<void>) {
	const dir = await mkdtemp(join(tmpdir(), "search-integration-"));
	const previous = process.env.PI_WEB_SEARCH_CONFIG;
	try {
		const path = join(dir, "web-search.json");
		await writeFile(path, JSON.stringify(settings));
		process.env.PI_WEB_SEARCH_CONFIG = path;
		await run();
	} finally {
		if (previous === undefined) delete process.env.PI_WEB_SEARCH_CONFIG;
		else process.env.PI_WEB_SEARCH_CONFIG = previous;
		await rm(dir, { recursive: true, force: true });
	}
}

function mcpFetch(search: string, fetchText: string): FetchLike {
	return async (_url, init) => {
		const message = JSON.parse(init.body ?? "{}");
		if (message.method === "notifications/initialized") return new Response(null, { status: 202 });
		return new Response(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: message.method === "initialize"
			? { protocolVersion: "2024-11-05", capabilities: {} }
			: { content: [{ type: "text", text: message.params.name === "web_fetch_exa" ? fetchText : search }] } }));
	};
}

async function withoutExaKey(run: () => Promise<void>) {
	const previous = process.env.EXA_API_KEY;
	delete process.env.EXA_API_KEY;
	try { await run(); }
	finally {
		if (previous === undefined) delete process.env.EXA_API_KEY;
		else process.env.EXA_API_KEY = previous;
	}
}

// Captured anonymously from web_fetch_exa, rather than a made-up response shape.
test("captured Exa fetch framing retains both pages, including nested page headings", () => {
	const raw = readFileSync(new URL("./fixtures/exa-fetch.txt", import.meta.url), "utf8");
	const pages = parseExaFetchText(raw);
	assert.deepEqual(pages.results.map((page) => page.url), ["https://example.com", "https://www.iana.org/help/example-domains"]);
	assert.match(pages.results[1].citedText ?? "", /RFC 2606/);
	assert.match(pages.results[0].citedText ?? "", /# Example Domain/);
	assert.deepEqual(pages.warnings, []);
});

test("Exa highlights retain facts after blank lines without treating anchors inside snippets as headers", () => {
	const pages = parseExaSearchText([
		"Title: Exa Search", "URL: https://exa.ai/products/search", "Highlights:",
		"## Search API for your agents", "", "$7/1k requests", "", "deep 4-12s", "", "Agentic research at 4-12s",
		"Title: still excerpt content", "URL: not a header inside an excerpt",
		"", "---", "", "Title: Second", "URL: https://example.com", "Highlights:", "Second result",
	].join("\n"));
	assert.equal(pages.length, 2);
	assert.match(pages[0].citedText ?? "", /Agentic research at 4-12s/);
	assert.match(pages[0].citedText ?? "", /Title: still excerpt content/);
	assert.equal(pages[1].citedText, "Second result");
});

test("unknown Exa fetch framing is retained with explicit per-URL evidence warnings", () => withoutExaKey(async () => {
	const result = await exaSearch({ query: "example", urls: ["https://example.com", "https://www.iana.org/help/example-domains"], settings: applyConfig("/unused", {}) }, {
		fetchImpl: mcpFetch("Title: Search\nURL: https://example.com\nHighlights:\nSearch evidence", "New upstream framing with otherwise useful content"),
	});
	assert.equal(result.searchResults?.length, 2);
	assert.match(result.searchResults?.[1].citedText ?? "", /useful content/);
	assert.equal(result.searchResults?.[1].url, undefined);
	assert.match(result.warnings?.join(" ") ?? "", /page identity is unverified/);
	assert.match(result.warnings?.join(" ") ?? "", /https:\/\/www.iana.org/);
}));

test("empty Exa search content does not fabricate a match", () => withoutExaKey(async () => {
	const result = await exaSearch({ query: "empty", settings: applyConfig("/unused", {}) }, { fetchImpl: mcpFetch("", "") });
	assert.deepEqual(result.searchResults, []);
	assert.match(result.warnings?.join(" ") ?? "", /no content/);
}));

test("a URL request that rejects before slower search is immediately observed", () => withoutExaKey(async () => {
	const base = mcpFetch("Title: Search\nURL: https://example.com\nHighlights:\nSearch evidence", "");
	const result = await exaSearch({ query: "example", urls: ["https://example.com"], settings: applyConfig("/unused", {}) }, {
		fetchImpl: async (url, init) => {
			const message = JSON.parse(init.body ?? "{}");
			if (message.params?.name === "web_fetch_exa") throw new Error("fetch rejected early");
			if (message.params?.name === "web_search_exa") await new Promise((resolve) => setTimeout(resolve, 20));
			return base(url, init);
		},
	});
	assert.equal(result.searchResults?.length, 1);
	assert.match(result.warnings?.join(" ") ?? "", /fetch rejected early/);
}));

test("independent code configuration cannot narrow both-scope research", () => withSettings({ code: { provider: "grep" }, research: { enabled: true } }, async () => {
	const calls: string[] = [];
	const result = await multiSearch("id", { query: "snippet", scope: "both" }, undefined, undefined, ctx, {
		availability: { exa: true, grep: true },
		transports: {
			exa: async () => { calls.push("exa"); return document; },
			grep: async () => { calls.push("grep"); return { ...document, providerKind: "grep" }; },
		},
	});
	assert.deepEqual(calls.sort(), ["exa", "grep"]);
	assert.equal(result.details.scope, "both");
}));

test("progress observers cannot fail retrieval or emit after completion/cancellation", () => withSettings({}, async () => {
	let providerCalls = 0;
	let lateUpdate: (() => void) | undefined;
	const options = { availability: { exa: true }, transports: { exa: async (req: import("../src/providers/index.ts").SearchRequest) => {
		providerCalls++;
		lateUpdate = () => req.onUpdate?.({ content: [{ type: "text", text: "provider progress" }], details: {} });
		lateUpdate();
		return document;
	} } };
	let updates = 0;
	const result = await webSearch("id", { query: "test" }, undefined, () => { updates++; throw new Error("observer failure"); }, ctx, options);
	assert.equal(result.details.resultCount, 1);
	assert.equal(providerCalls, 1);
	assert.equal(updates, 2);
	lateUpdate?.();
	assert.equal(updates, 2);
	const cancelled = new AbortController();
	cancelled.abort();
	const failed = await webSearch("id", { query: "test" }, cancelled.signal, () => { updates++; }, ctx, options);
	assert.equal(failed.isError, true);
	assert.equal(failed.details.error?.code, "aborted");
	assert.equal(providerCalls, 1);
	assert.equal(updates, 2);
}));

test("operation budget exhausted only during optional judging preserves retrieved evidence", () => withSettings({ timeoutMs: 1000, research: { enabled: true }, jev: { enabled: true } }, async () => {
	const judgeContext = { modelRegistry: classifierRegistry(async () => new Promise<never>(() => {})) } as ExtensionContext;
	const result = await multiSearch("id", { query: "example", scope: "web" }, undefined, undefined, judgeContext, {
		availability: { exa: true },
		transports: { exa: async () => { await new Promise((resolve) => setTimeout(resolve, 850)); return document; } },
	});
	assert.equal(result.details.resultCount, 1);
	assert.equal(result.details.grounded, true);
	assert.equal(result.details.jevStatus, "unavailable");
	assert.match(result.details.warnings?.join(" ") ?? "", /operation timeout/);
}));

test("JSON as well as SSE replies must match the MCP request id and protocol", async () => {
	for (const envelope of [
		{ jsonrpc: "2.0", id: 999, result: { content: [{ type: "text", text: "wrong request" }] } },
		{ id: 1, result: { content: [{ type: "text", text: "not JSON-RPC 2.0" }] } },
	]) {
		const client = createMcpClient({ url: "https://fake.example", fetchImpl: async () => new Response(JSON.stringify(envelope)) });
		await assert.rejects(client.callTool("test", {}), (error: { code?: string }) => error.code === "parse_error");
	}
});

test("optional judgment bounds a native classifier that ignores abort", async () => {
	const keepAlive = setTimeout(() => {}, 1000);
	try {
		await assert.rejects(systemOne({ query: "q", candidates: [] }, {}, {
			modelRegistry: classifierRegistry(async () => new Promise<never>(() => {})), timeoutMs: 20,
		}), /deadline exceeded/);
	} finally { clearTimeout(keepAlive); }
});

test("HTTP also bounds a body reader that ignores the fetch signal", async () => {
	const keepAlive = setTimeout(() => {}, 1000);
	try {
		await assert.rejects(postJson("https://fake.example", { body: {}, timeoutMs: 20, fetchImpl: async () => ({
			ok: true, status: 200, headers: new Headers(), text: async () => new Promise(() => {}),
		}) }), (error: { code?: string }) => error.code === "timeout");
		await assert.rejects(postJson("https://fake.example", { body: {}, maxResponseBytes: 10, fetchImpl: async () => ({
			ok: true, status: 200, headers: new Headers(), text: async () => '"😀😀😀"',
		}) }), (error: { code?: string }) => error.code === "parse_error");
	} finally { clearTimeout(keepAlive); }
});
