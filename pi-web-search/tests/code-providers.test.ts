import assert from "node:assert/strict";
import test from "node:test";

import { applyConfig, DEFAULT_PROVIDER } from "../src/providers/config.ts";
import { parseGrepSearchText } from "../src/providers/grep.ts";
import { parseSearchCodeText } from "../src/providers/github.ts";
import { extractSseData } from "../src/providers/http.ts";
import { resolveProviderChain } from "../src/providers/index.ts";
import {
	DEFAULT_CHAIN,
	PROVIDER_FAMILY,
	type ProviderFamily,
	type ProviderKind,
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
		provider: "exa",
		fallback: ["parallel", "grep"],
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
	const settings = applyConfig("/tmp/c.json", { provider: "exa" });
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
		provider: "exa",
		fallback: ["parallel", "grep"],
	});
	assert.equal(settings.notices.length, 1);
	assert.match(settings.notices[0], /grep/);
	assert.match(settings.notices[0], /code/);
	assert.deepEqual(settings.fallback, ["parallel"]);
});

test("config accepts the new providers, family and jev block", () => {
	const settings = applyConfig("/tmp/c.json", {
		provider: "github",
		family: "code",
		jev: { enabled: true, safetyThreshold: 0.9 },
	});
	assert.equal(settings.provider, "github");
	assert.equal(settings.family, "code");
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

// --- github parser ----------------------------------------------------------

const GITHUB_JSON = JSON.stringify({
	incomplete_results: false,
	items: [
		{
			path: "index.ts",
			sha: "99dcf13dca4aef074b51609df6b11f69ae78056e",
			repository: "vercel/next.js",
			text_matches: [{ fragment: "createServer(port)" }],
		},
		{
			path: "lib/util.ts",
			sha: "abc123",
			repository: "acme/thing",
			text_matches: [],
		},
	],
});

test("github json yields citable blob urls", () => {
	const results = parseSearchCodeText(GITHUB_JSON, 10);
	assert.equal(results.length, 2);
	assert.equal(
		results[0].url,
		"https://github.com/vercel/next.js/blob/99dcf13dca4aef074b51609df6b11f69ae78056e/index.ts",
	);
	assert.equal(results[0].citedText, "createServer(port)");
	assert.equal(results[1].url, "https://github.com/acme/thing/blob/abc123/lib/util.ts");
});

test("a hit without a sha still cites the default branch", () => {
	const json = JSON.stringify({
		items: [{ path: "a.ts", repository: "acme/thing" }],
	});
	assert.equal(
		parseSearchCodeText(json, 10)[0].url,
		"https://github.com/acme/thing/blob/HEAD/a.ts",
	);
});

test("non-json and unexpected shapes degrade to no results", () => {
	assert.deepEqual(parseSearchCodeText("rate limit exceeded", 10), []);
	assert.deepEqual(parseSearchCodeText("{}", 10), []);
	assert.deepEqual(parseSearchCodeText('{"items":"nope"}', 10), []);
});

test("github respects maxResults", () => {
	assert.equal(parseSearchCodeText(GITHUB_JSON, 1).length, 1);
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

// --- helpers ----------------------------------------------------------------

test("the default provider is still web-scoped", () => {
	assert.equal(providerFamily(DEFAULT_PROVIDER), "web");
	assert.equal(PROVIDER_FAMILY[DEFAULT_PROVIDER], "web");
});

test("every provider kind is covered by a family map", () => {
	const kinds: ProviderKind[] = ["exa", "parallel", "grep", "github"];
	const families = new Set<ProviderFamily>();
	for (const kind of kinds) {
		families.add(providerFamily(kind));
	}
	assert.deepEqual([...families].sort(), ["code", "web"]);
});
