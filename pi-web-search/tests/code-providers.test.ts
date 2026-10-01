import assert from "node:assert/strict";
import test from "node:test";

import { applyConfig } from "../src/providers/config.ts";
import { githubSearch, parseGithubResults } from "../src/providers/github.ts";
import { parseCodeQuery, parseGrepSearchText } from "../src/providers/grep.ts";
import { type FetchLike, extractSseData } from "../src/providers/http.ts";
import { resolveProviderChain } from "../src/providers/index.ts";
import {
	DEFAULT_CHAIN,
	PROVIDER_FAMILY,
	providerFamily,
} from "../src/providers/types.ts";

const GRIP_TEXT = [
	"Repository: microsoft/terminal",
	"Path: src/host/args.cpp",
	"URL: https://github.com/microsoft/terminal/blob/main/src/host/args.cpp",
	"License: MIT",
	"",
	"Snippets:",
	"--- Snippet 1 (Line 76) ---",
	"  const bool createServer = true;",
	"",
	"--- Snippet 2 (Line 90) ---",
	"  // createServer again",
	"",
	"Repository: vercel/next.js",
	"Path: server.ts",
	"URL: https://github.com/vercel/next.js/blob/main/server.ts",
	"License: MIT",
	"",
	"Snippets:",
	"--- Snippet 1 (Line 12) ---",
	"createServer(port)",
].join("\n");

// --- families ---------------------------------------------------------------

test("each provider belongs to exactly one family", () => {
	assert.equal(providerFamily("exa"), "web");
	assert.equal(providerFamily("parallel"), "web");
	assert.equal(providerFamily("grep"), "code");
	assert.equal(providerFamily("github"), "code");
	assert.deepEqual(DEFAULT_CHAIN.web, ["exa", "parallel"]);
	assert.deepEqual(DEFAULT_CHAIN.code, ["grep", "github"]);
});

test("a web fallback never resolves to a code provider", () => {
	const settings = applyConfig("/tmp/c.json", {
		web: { provider: "exa", fallback: ["parallel", "grep"] },
	});
	const availability = {
		exa: true,
		parallel: true,
		grep: true,
		github: true,
	};
	const chain = resolveProviderChain(settings, availability, "web");
	assert.deepEqual(chain, ["exa", "parallel"]);
	assert.ok(
		chain.every((kind) => PROVIDER_FAMILY[kind] === "web"),
		"code providers must never enter a web chain",
	);
});

test("routing to code falls back to the code family even when config is web-only", () => {
	const settings = applyConfig("/tmp/c.json", { web: { provider: "exa" } });
	const chain = resolveProviderChain(
		settings,
		{ exa: true, grep: true, github: true },
		"code",
	);
	assert.deepEqual(chain, ["grep", "github"]);
});

test("a cross-family fallback entry is dropped with a visible notice", () => {
	// Silently dropping it would leave the operator believing a fallback exists.
	const settings = applyConfig("/tmp/c.json", {
		web: { provider: "exa", fallback: ["parallel", "grep"] },
	});
	assert.equal(settings.notices.length, 1);
	assert.match(settings.notices[0], /grep/);
	assert.match(settings.notices[0], /code/);
	assert.deepEqual(settings.web.fallback, ["parallel"]);
});

test("config accepts scoped provider chains and a jev block", () => {
	const settings = applyConfig("/tmp/c.json", {
		code: { provider: "github" },
		jev: { enabled: true, safetyThreshold: 0.9 },
	});
	assert.equal(settings.code.provider, "github");
	assert.equal(settings.jev.enabled, true);
	assert.equal(settings.jev.safetyThreshold, 0.9);
	// Unspecified weights keep their defaults.
	assert.equal(settings.jev.weights.answers, 0.45);
});

test("jev stays off unless explicitly enabled", () => {
	const settings = applyConfig("/tmp/c.json", { jev: {} });
	assert.equal(settings.jev.enabled, false);
	assert.equal(applyConfig("/tmp/c.json", {}).jev.enabled, false);
});

test("a bad jev value is a notice, not a thrown error", () => {
	const settings = applyConfig("/tmp/c.json", {
		jev: { safetyThreshold: "high" as unknown as number },
	});
	assert.equal(settings.jev.safetyThreshold, 0.75);
	assert.match(settings.notices[0], /safetyThreshold/);
});

// --- grep parser ------------------------------------------------------------

test("grep text parses into hits with urls and snippets", () => {
	const results = parseGrepSearchText(GRIP_TEXT, 10);
	assert.equal(results.length, 2);
	assert.equal(results[0].title, "microsoft/terminal/src/host/args.cpp");
	assert.equal(
		results[0].url,
		"https://github.com/microsoft/terminal/blob/main/src/host/args.cpp",
	);
	assert.match(results[0].citedText ?? "", /createServer = true/);
	assert.match(results[0].citedText ?? "", /createServer again/);
	assert.equal(results[1].title, "vercel/next.js/server.ts");
});

test("a code line that looks like an anchor stays snippet content", () => {
	// Regression guard for the same bug class fixed in parseExaSearchText: a
	// snippet containing "Path:" or "Repository:" must not open a new hit.
	const text = [
		"Repository: acme/thing",
		"Path: src/index.ts",
		"URL: https://github.com/acme/thing/blob/main/src/index.ts",
		"",
		"Snippets:",
		"--- Snippet 1 (Line 3) ---",
		"const config = {",
		'  Path: "/etc/passwd",',
		"};",
		"// Repository: not a real hit",
		"",
	].join("\n");
	const results = parseGrepSearchText(text, 10);
	assert.equal(results.length, 1, "must not fabricate a hit from snippet text");
	assert.equal(results[0].title, "acme/thing/src/index.ts");
	assert.match(results[0].citedText ?? "", /Path: "\/etc\/passwd"/);
	assert.match(results[0].citedText ?? "", /Repository: not a real hit/);
});

test("grep respects maxResults", () => {
	assert.equal(parseGrepSearchText(GRIP_TEXT, 1).length, 1);
});

test("empty grep text yields no hits", () => {
	assert.deepEqual(parseGrepSearchText("", 10), []);
	assert.deepEqual(parseGrepSearchText("No results found for your query.", 10), []);
});

// --- github REST contract ---------------------------------------------------

const GITHUB_RESULTS = {
	incomplete_results: false,
	items: [{
		path: "index.ts",
		sha: "99dcf13dca4aef074b51609df6b11f69ae78056e",
		html_url: "https://github.com/vercel/next.js/blob/main/index.ts",
		repository: { full_name: "vercel/next.js", private: false },
		text_matches: [{ fragment: "createServer(port)" }],
	}, {
		path: "lib/util.ts",
		sha: "blob-not-a-commit",
		repository: { full_name: "acme/thing", private: false },
		text_matches: [],
	}],
};

test("GitHub REST results use upstream URLs, never a blob SHA as a ref", () => {
	const { results } = parseGithubResults(GITHUB_RESULTS, 10);
	assert.equal(results.length, 2);
	assert.equal(results[0].url, GITHUB_RESULTS.items[0].html_url);
	assert.equal(results[0].citedText, "createServer(port)");
	assert.equal(results[1].url, "https://github.com/acme/thing/blob/HEAD/lib/util.ts");
	assert.equal(results[0].url?.includes(GITHUB_RESULTS.items[0].sha), false);
});

test("verified public repositories with missing URLs use an encoded branch/path", () => {
	const { results } = parseGithubResults({ items: [{
		path: "src/a b.ts",
		repository: { full_name: "acme/thing", private: false, default_branch: "release/1.x" },
	}] }, 10);
	assert.equal(results[0].url, "https://github.com/acme/thing/blob/release/1.x/src/a%20b.ts");
});

test("private, internal and unknown visibility are withheld, including minimal MCP items", () => {
	const { results, withheldPrivate } = parseGithubResults({ items: [
		{ path: "secret.ts", repository: { full_name: "acme/private", private: true }, text_matches: [{ fragment: "SECRET=abc" }] },
		{ path: "internal.ts", repository: { full_name: "acme/internal", private: false, visibility: "internal" } },
		{ path: "unknown.ts", repository: "acme/unverifiable", text_matches: [{ fragment: "SECRET=unknown" }] },
		{ path: "unspecified.ts", repository: { full_name: "acme/unspecified" } },
		{ path: "public.ts", repository: { full_name: "acme/public", private: false }, text_matches: [{ fragment: "export const ok = true" }] },
	] }, 10);
	assert.equal(withheldPrivate, 4);
	assert.equal(results.length, 1);
	assert.equal(results[0].url, "https://github.com/acme/public/blob/HEAD/public.ts");
	assert.equal(JSON.stringify(results).includes("SECRET="), false);
});

test("malformed GitHub item shapes do not fabricate code matches", () => {
	for (const raw of [null, {}, { items: "nope" }, { items: [null, {}, { repository: { private: false } }] }]) {
		assert.deepEqual(parseGithubResults(raw, 10).results, []);
	}
	assert.equal(parseGithubResults(GITHUB_RESULTS, 1).results.length, 1);
});

test("GitHub performs one bounded REST GET and never echoes private raw payloads", async () => {
	const previous = { GH_TOKEN: process.env.GH_TOKEN, GITHUB_TOKEN: process.env.GITHUB_TOKEN };
	process.env.GH_TOKEN = "dummy-github-token";
	delete process.env.GITHUB_TOKEN;
	let calls = 0;
	const fetchImpl: FetchLike = async (rawUrl, init) => {
		calls++;
		const url = new URL(rawUrl);
		assert.equal(url.origin + url.pathname, "https://api.github.com/search/code");
		assert.equal(url.searchParams.get("q"), "q repo:acme/thing");
		assert.equal(url.searchParams.get("per_page"), "10");
		assert.equal(init.method, "GET");
		assert.equal(init.body, undefined);
		assert.equal(init.headers?.Authorization, "Bearer dummy-github-token");
		assert.equal(init.headers?.Accept, "application/vnd.github.text-match+json");
		assert.ok(init.signal);
		return new Response(JSON.stringify({
			incomplete_results: true,
			items: [{ path: "s.ts", repository: { full_name: "acme/private", private: true }, text_matches: [{ fragment: "SECRET_TOKEN=abc" }] }],
		}), { headers: { "x-github-request-id": "gh-request" } });
	};
	try {
		const result = await githubSearch({ query: "q repo:acme/thing", settings: applyConfig("/tmp/c.json", { code: { provider: "github" }, maxResults: 10 }) }, { fetchImpl });
		assert.equal(calls, 1);
		assert.equal(result.requestId, "gh-request");
		assert.equal(result.searchResults?.length, 0);
		assert.equal(JSON.stringify(result).includes("SECRET_TOKEN=abc"), false);
		assert.match(result.warnings?.join(" ") ?? "", /withheld 1 non-public/);
		assert.match(result.warnings?.join(" ") ?? "", /incomplete results/);
		await assert.rejects(githubSearch({ query: "q", settings: applyConfig("/tmp/c.json", {}) }, {
			fetchImpl: async () => new Response("{}"),
		}), (error: { code?: string }) => error.code === "parse_error");
	} finally {
		for (const [name, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
});

// --- grep query qualifiers --------------------------------------------------

test("repo:/language: qualifiers are stripped from the literal pattern", () => {
	const parsed = parseCodeQuery("useState( repo:facebook/react language:TypeScript");
	assert.equal(parsed.literal, "useState(");
	assert.equal(parsed.repo, "facebook/react");
	assert.deepEqual(parsed.languages, ["TypeScript"]);
});

test("quoted code literals are never mistaken for qualifiers", () => {
	const parsed = parseCodeQuery('search("repo:x") repo:acme/thing');
	assert.equal(parsed.literal, 'search("repo:x")');
	assert.equal(parsed.repo, "acme/thing");
});

test("a quoted language value is unquoted and preserved as a filter", () => {
	const parsed = parseCodeQuery('Console.Write language:"C#"');
	assert.equal(parsed.literal, "Console.Write");
	assert.deepEqual(parsed.languages, ["C#"]);
});

test("a query without qualifiers is left untouched", () => {
	const parsed = parseCodeQuery("export function useThing");
	assert.equal(parsed.literal, "export function useThing");
	assert.equal(parsed.repo, undefined);
	assert.deepEqual(parsed.languages, []);
});

// --- sse framing ------------------------------------------------------------

test("sse data accepts both data: and GitHub's bare json framing", () => {
	const prefixed = extractSseData(
		'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n\n',
	);
	assert.equal(prefixed.length, 1);
	assert.match(prefixed[0], /"id":1/);

	// Verified live: GitHub uses this shape for tools/list.
	const bare = extractSseData(
		'event: message\n{"jsonrpc":"2.0","id":2,"result":{}}\n\n',
	);
	assert.equal(bare.length, 1);
	assert.match(bare[0], /"id":2/);
});

test("sse comments and multi-line data still join", () => {
	assert.deepEqual(extractSseData(": keep-alive\n\n"), []);
	const joined = extractSseData("data: one\ndata: two\n\n");
	assert.deepEqual(joined, ["one\ntwo"]);
});

