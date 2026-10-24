import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { braveApiKey, disableStoredCredentials, enableStoredCredentials, resolveCredential } from "../src/env.ts";
import { applyConfig, parseWebSearchConfig } from "../src/providers/config.ts";
import { BRAVE_SEARCH_URL, braveSearch } from "../src/providers/brave.ts";
import { JINA_READER_URL, jinaFetch } from "../src/providers/jina.ts";
import { listRunnableProviders, providerAvailability, resolveProviderChain, type SearchRequest } from "../src/providers/index.ts";
import type { FetchLike, RequestInitLike } from "../src/providers/http.ts";
import { clearRetrievalCache, reuseTransport } from "../src/providers/reuse.ts";
import { providerError, type StreamResult } from "../src/providers/types.ts";
import { webSearch } from "../src/web_search.ts";

const request = (extra: Partial<SearchRequest> = {}): SearchRequest => ({ query: "fixture query", settings: applyConfig("fixture", { maxResults: 2 }), ...extra });
const reply = (value: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => JSON.stringify(value) });
const page = (url = "https://example.com/", content = "useful page") => ({ code: 200, data: { url, title: "Page", content, httpStatus: 200 } });

async function withKey(key: string | undefined, run: () => Promise<void> | void) {
	const prior = { key: process.env.BRAVE_API_KEY, alias: process.env.BRAVE_SEARCH_API_KEY };
	delete process.env.BRAVE_SEARCH_API_KEY;
	if (key === undefined) delete process.env.BRAVE_API_KEY; else process.env.BRAVE_API_KEY = key;
	try { await run(); } finally {
		if (prior.key === undefined) delete process.env.BRAVE_API_KEY; else process.env.BRAVE_API_KEY = prior.key;
		if (prior.alias === undefined) delete process.env.BRAVE_SEARCH_API_KEY; else process.env.BRAVE_SEARCH_API_KEY = prior.alias;
	}
}

test("Brave uses one bounded REST GET with a header key and compact snippets only", async () => {
	await withKey("fixture-secret", async () => {
		const calls: Array<{ url: string; init: RequestInitLike }> = [];
		const result = await braveSearch(request(), { fetchImpl: async (url, init) => {
			calls.push({ url, init });
			return reply({ web: { results: [
				{ title: "<strong>A &amp; B</strong>", url: "https://example.com/a", description: "Use <b>GET</b> &quot;path&quot; &#x1f600;", extra_snippets: ["DO NOT COPY EXTRA"], page_age: "2026-01-01" },
				{ title: "B", url: "https://example.com/b", description: "short" },
				{ title: "C", url: "https://example.com/c" },
			] } });
		} });
		assert.equal(calls.length, 1);
		const url = new URL(calls[0].url);
		assert.equal(url.origin + url.pathname, BRAVE_SEARCH_URL);
		assert.deepEqual(Object.fromEntries(url.searchParams), { q: "fixture query", count: "2", text_decorations: "false" });
		assert.equal(calls[0].init.method, "GET");
		assert.equal(calls[0].init.redirect, "error");
		assert.equal(calls[0].init.headers!["X-Subscription-Token"], "fixture-secret");
		assert.equal(calls[0].url.includes("fixture-secret"), false);
		assert.equal(result.searchResults!.length, 2);
		assert.equal(result.searchResults![0].title, "A & B");
		assert.equal(result.searchResults![0].citedText, 'Use GET "path" 😀');
		assert.equal(JSON.stringify(result).includes("DO NOT COPY EXTRA"), false);
	});
});

test("Brave is key-required, respects stored key rotation and both environment aliases", async () => {
	await withKey(undefined, async () => {
		let calls = 0;
		await assert.rejects(braveSearch(request(), { fetchImpl: async () => { calls++; return reply({}); } }), (error: Error & { code?: string }) => error.code === "missing_credentials");
		assert.equal(calls, 0);
		assert.equal(resolveCredential("brave", { env: { BRAVE_API_KEY: " primary ", BRAVE_SEARCH_API_KEY: "secondary" }, readCredential: () => ({ key: "stored" }) })!.key, "primary");
		assert.equal(braveApiKey({ env: { BRAVE_SEARCH_API_KEY: " alias " }, readCredential: () => undefined }), "alias");
		const dir = await mkdtemp(join(tmpdir(), "brave-auth-"));
		const path = join(dir, "auth.json");
		try {
			await writeFile(path, JSON.stringify({ brave: { key: "old" } })); enableStoredCredentials(path);
			assert.equal(braveApiKey(), "old");
			await writeFile(path, JSON.stringify({ brave: { key: "new" } }));
			assert.equal(braveApiKey(), "new");
		} finally { disableStoredCredentials(); await rm(dir, { recursive: true, force: true }); }
	});
});

test("Brave rejects bad envelopes and unsafe URLs, but accepts a genuine empty result", async () => {
	await withKey("key", async () => {
		for (const body of [{}, { web: { results: "wrong" } }, { web: { results: [{ url: "file:///secret" }, { url: "https://user:pass@example.com/" }] } }]) {
			await assert.rejects(braveSearch(request(), { fetchImpl: async () => reply(body) }), (error: Error & { code?: string }) => error.code === "parse_error");
		}
		const empty = await braveSearch(request(), { fetchImpl: async () => reply({ type: "search", query: {} }) });
		assert.equal(empty.searchResults!.length, 0);
	});
});

test("Brave preserves HTTP rate/auth failures without echoing the key", async () => {
	await withKey("never-print-key", async () => {
		for (const status of [401, 429, 503]) {
			await assert.rejects(braveSearch(request(), { fetchImpl: async () => reply({ message: "never-print-key" }, status) }), (error: Error & { status?: number; retryable?: boolean }) => {
				assert.equal(error.status, status);
				assert.equal(error.retryable, status !== 401);
				assert.equal(error.message.includes("never-print-key"), false);
				return true;
			});
		}
	});
});

test("Brave cache identity changes when its key rotates", async () => {
	await withKey("old-key", async () => {
		clearRetrievalCache();
		const req = request({ reuseScope: "brave-rotation" });
		let calls = 0;
		const transport = async (): Promise<StreamResult> => { calls++; return { text: "", providerKind: "brave", searchResults: [{ url: "https://example.com/", citedText: "evidence" }] }; };
		try {
			await reuseTransport("brave", req, transport); await reuseTransport("brave", req, transport);
			assert.equal(calls, 1);
			process.env.BRAVE_API_KEY = "new-key";
			await reuseTransport("brave", req, transport);
			assert.equal(calls, 2);
		} finally { clearRetrievalCache(); }
	});
});

test("Brave rejects oversized queries without silently clipping or calling the API", async () => {
	await withKey("key", async () => {
		let calls = 0;
		for (const query of ["x".repeat(401), "word ".repeat(51), " "]) await assert.rejects(braveSearch(request({ query }), { fetchImpl: async () => { calls++; return reply({}); } }), /400 characters.*50 words/);
		assert.equal(calls, 0);
	});
});

test("Jina is keyless, strips bulky page media and keeps requested URL identity", async () => {
	const calls: Array<{ url: string; init: RequestInitLike }> = [];
	const result = await jinaFetch(request({ urls: ["https://EXAMPLE.com:443/#part"] }), { fetchImpl: async (url, init) => {
		calls.push({ url, init }); return reply(page());
	} });
	assert.equal(calls[0].url, JINA_READER_URL + "https://example.com/");
	assert.equal(calls[0].init.method, "GET");
	assert.equal(calls[0].init.redirect, "error");
	assert.deepEqual(calls[0].init.headers, { Accept: "application/json", "X-Respond-With": "markdown", "X-Retain-Images": "none", "X-Retain-Links": "none" });
	assert.equal(result.providerKind, "jina");
	assert.equal(result.searchResults![0].url, "https://EXAMPLE.com:443/#part");
	assert.equal(result.searchResults![0].type, "content");
	assert.equal(result.searchResults![0].citedText, "useful page");
});

test("Jina withholds unrelated, unidentified, empty and failed target content", async () => {
	for (const body of [{}, page("https://other.example/"), page("not-a-url"), page("https://example.com/", ""), { ...page(), data: { ...page().data, httpStatus: 404 } }]) {
		await assert.rejects(jinaFetch(request({ urls: ["https://example.com/"] }), { fetchImpl: async () => reply(body) }));
	}
	let calls = 0;
	for (const url of ["file:///tmp/secret", "https://user:pass@example.com"]) await assert.rejects(jinaFetch(request({ urls: [url] }), { fetchImpl: async () => { calls++; return reply(page()); } }));
	assert.equal(calls, 0);
});

test("Jina caps body bytes and retained evidence, preserving explicit clipping markers", async () => {
	const output = await jinaFetch(request({ urls: ["https://example.com/"] }), { fetchImpl: async () => reply(page(undefined, "x".repeat(80_000))) });
	assert.equal(output.searchResults![0].citedText!.length, 64_000);
	assert.equal(output.searchResults![0].status, "provider_excerpt_clipped");
	assert.match(output.warnings!.join(), /clipped/);
	await assert.rejects(jinaFetch(request({ urls: ["https://example.com/"] }), { fetchImpl: async () => reply(page(undefined, "x".repeat(2 * 1024 * 1024))) }), /exceed|large|cap|limit/i);
});

test("Jina bounds concurrency, preserves input order, deduplicates URLs and reports partial failures", async () => {
	let active = 0, peak = 0, calls = 0;
	const urls = Array.from({ length: 6 }, (_, i) => `https://example.com/${i}`);
	const output = await jinaFetch(request({ urls: [...urls, urls[0]] }), { fetchImpl: async (url) => {
		calls++; active++; peak = Math.max(peak, active);
		await new Promise((done) => setImmediate(done)); active--;
		if (url.endsWith("/2")) return reply({}, 503);
		return reply(page(url.slice(JINA_READER_URL.length)));
	} });
	assert.equal(peak, 3); assert.equal(calls, 6);
	assert.deepEqual(output.searchResults!.map((hit) => hit.url), urls.filter((url) => !url.endsWith("/2")));
	assert.equal(output.warnings!.length, 1);
	assert.match(output.warnings![0], /URL 3 failed/);
});

test("Jina cancellation starts no additional URLs", async () => {
	const controller = new AbortController();
	let calls = 0;
	await assert.rejects(jinaFetch(request({ urls: Array.from({ length: 10 }, (_, i) => `https://example.com/${i}`), signal: controller.signal }), { fetchImpl: async () => {
		calls++; controller.abort(providerError("aborted", "cancelled")); return reply(page());
	} }), /cancelled/);
	assert.ok(calls <= 3);
});

test("Brave search and Jina extraction run concurrently with compact independent results", async () => {
	await withKey("key", async () => {
		let release!: () => void;
		const gate = new Promise<void>((done) => { release = done; });
		const calls: string[] = [];
		const fetchImpl: FetchLike = async (url) => {
			calls.push(url);
			if (url.startsWith(BRAVE_SEARCH_URL)) { await gate; return reply({ web: { results: [{ url: "https://search.example/", description: "snippet" }] } }); }
			release(); return reply(page());
		};
		const output = await braveSearch(request({ urls: ["https://example.com/"] }), { fetchImpl });
		assert.equal(calls.length, 2);
		assert.deepEqual(output.providers, ["brave", "jina"]);
		assert.equal(output.searchResults!.length, 2);
		const partial = await braveSearch(request({ urls: ["https://example.com/"] }), { fetchImpl: async (url) => url.startsWith(BRAVE_SEARCH_URL) ? reply({ web: { results: [{ url: "https://search.example/" }] } }) : reply({}, 503) });
		assert.equal(partial.searchResults!.length, 1);
		assert.match(partial.warnings!.join(), /Jina.*http_error/);
	});
});

test("only Brave joins search routing; keyless defaults and code-family isolation remain unchanged", async () => {
	await withKey(undefined, async () => {
		const settings = applyConfig("fixture", {});
		assert.equal(providerAvailability().brave, false);
		assert.deepEqual(resolveProviderChain(settings), ["exa", "parallel"]);
		assert.equal(listRunnableProviders(settings).includes("brave"), false);
		process.env.BRAVE_API_KEY = "key";
		assert.equal(listRunnableProviders(settings, providerAvailability("web"), "web").includes("brave"), true);
		assert.equal(listRunnableProviders(settings, providerAvailability("code"), "code").includes("brave"), false);
		assert.equal(parseWebSearchConfig({ web: { provider: "brave" } }, "fixture").status, "ok");
		assert.equal(parseWebSearchConfig({ web: { provider: "jina" } }, "fixture").status, "invalid");
	});
});

test("URL-only prefers Jina independently of search config and falls back without retrying Jina through Brave", async () => {
	const dir = await mkdtemp(join(tmpdir(), "jina-execute-"));
	const old = process.env.PI_WEB_SEARCH_CONFIG;
	process.env.PI_WEB_SEARCH_CONFIG = join(dir, "config.json");
	const context = {} as ExtensionContext;
	const extracted: StreamResult = { text: "", providerKind: "jina", searchResults: [{ url: "https://example.com/", type: "content", citedText: "page" }] };
	try {
		await writeFile(process.env.PI_WEB_SEARCH_CONFIG, JSON.stringify({ web: { provider: "brave", fallback: ["exa"] } }));
		let searches = 0, extracts = 0;
		const output = await webSearch("url-only", { urls: ["https://example.com/"] }, undefined, undefined, context, {
			fetchUrls: async () => { extracts++; return extracted; },
			availability: { brave: true, exa: true },
			transports: { brave: async () => { searches++; throw new Error("must not run"); }, exa: async () => { searches++; return { ...extracted, providerKind: "exa" }; } },
		});
		assert.equal(output.details.provider, "jina"); assert.equal(extracts, 1); assert.equal(searches, 0);
		const fallback = await webSearch("url-fallback", { urls: ["https://example.com/"] }, undefined, undefined, context, {
			fetchUrls: async () => { throw providerError("rate_limited", "quota"); }, availability: { brave: true, exa: true },
			transports: { brave: async () => { throw new Error("must not retry Jina"); }, exa: async () => ({ ...extracted, providerKind: "exa" }) },
		});
		assert.equal(fallback.details.provider, "exa");
		assert.match(fallback.details.warnings!.join(), /Jina.*fallback/);
		await writeFile(process.env.PI_WEB_SEARCH_CONFIG!, JSON.stringify({ web: { provider: "brave", fallback: [] } }));
		const strict = await webSearch("strict-url", { urls: ["https://example.com/"] }, undefined, undefined, context, {
			fetchUrls: async () => { throw providerError("rate_limited", "quota"); },
			transports: { exa: async () => { throw new Error("must not invent an unconfigured extraction chain"); } },
		});
		assert.equal(strict.details.error?.code, "rate_limited");
	} finally { if (old === undefined) delete process.env.PI_WEB_SEARCH_CONFIG; else process.env.PI_WEB_SEARCH_CONFIG = old; await rm(dir, { recursive: true, force: true }); }
});
