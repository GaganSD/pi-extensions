import assert from "node:assert/strict";
import test from "node:test";

import { applyConfig, DEFAULT_TIMEOUT_MS } from "../src/providers/config.ts";
import { CREDENTIAL_ENV_ALIASES } from "../src/env.ts";
import { parseGrepSearchText } from "../src/providers/grep.ts";
import { hasGitHubToken, hasParallelKey, providerAvailability } from "../src/providers/index.ts";
import type { SearchResultDetail } from "../src/providers/types.ts";
import { providerError } from "../src/providers/types.ts";
import type { JevAnswer, JevResponse } from "../src/jev/api.ts";
import { augmentResults } from "../src/jev/augment.ts";
import { applyPolicy, type Candidate } from "../src/jev/judge.ts";
import { DEFAULT_JEV_SETTINGS, type JevSettings } from "../src/providers/config.ts";
import { classifierRegistry } from "./fixtures/native-jev.ts";

const CANDS: Candidate[] = [
	{ index: 0, title: "A", url: "https://a.example", excerpt: "alpha" },
	{ index: 1, title: "B", url: "https://b.example", excerpt: "beta" },
];

function settingsWith(over: Partial<JevSettings> = {}): JevSettings {
	return { ...DEFAULT_JEV_SETTINGS, enabled: true, ...over };
}

const noul = (n: number): JevAnswer => ({ type: "noul", noul: n });
const choice = (c: string, p: number): JevAnswer => ({
	type: "choice",
	choice: c,
	probabilities: { [c]: p },
	confidence: p,
});

function answer(over: Record<string, JevAnswer> = {}): JevResponse {
	return {
		answers: {
			c0_answers: noul(0.9),
			c0_offtopic: noul(0.05),
			c0_selfcontained: noul(0.9),
			c0_safety: choice("safe", 0.99),
			c1_answers: noul(0.8),
			c1_offtopic: noul(0.1),
			c1_selfcontained: noul(0.8),
			c1_safety: choice("safe", 0.99),
			sufficient: noul(0.9),
			...over,
		},
	};
}

function stream(results: SearchResultDetail[]) {
	return {
		text: "",
		providerKind: "exa" as const,
		searchResults: results,
		sources: results.map((r) => ({ title: r.title ?? "", url: r.url ?? "" })),
	};
}

const CREDENTIAL_ALIASES = [
	...new Set(Object.values(CREDENTIAL_ENV_ALIASES).flat()),
];

/**
 * Snapshots and clears every credential alias, returning a restore function.
 * A test that asserts credential precedence or absence must scope the whole
 * alias set: clearing one name leaves the operator's other aliases observable.
 */
function resetCredentials(): () => void {
	const previous = new Map<string, string | undefined>();
	for (const name of CREDENTIAL_ALIASES) {
		previous.set(name, process.env[name]);
		delete process.env[name];
	}
	return () => {
		for (const [name, value] of previous) {
			if (value === undefined) {
				delete process.env[name];
			} else {
				process.env[name] = value;
			}
		}
	};
}

// --- grep parser: blank lines are content, not boundaries -------------------

test("a snippet containing blank lines is not truncated", () => {
	// Verified live 2026-09-30: 5 of 23 snippet lines were blank. A parser that
	// treats a blank line as a boundary cuts every real snippet short.
	const text = [
		"Repository: acme/thing",
		"Path: src/server.ts",
		"URL: https://github.com/acme/thing/blob/main/src/server.ts",
		"",
		"Snippets:",
		"--- Snippet 1 (Line 10) ---",
		"export function handler() {",
		"",
		"  const body = parse(req);",
		"",
		"  return respond(body);",
		"}",
	].join("\n");
	const results = parseGrepSearchText(text, 10);
	assert.equal(results.length, 1);
	assert.match(
		results[0].citedText ?? "",
		/export function handler\(\) \{[\s\S]*respond\(body\)[\s\S]*\}/,
		"the whole function body, including its blank lines, must survive",
	);
});

test("a Repository: string inside a snippet does not start a new hit", () => {
	const text = [
		"Repository: acme/thing",
		"Path: src/db.ts",
		"URL: https://github.com/acme/thing/blob/main/src/db.ts",
		"",
		"Snippets:",
		"--- Snippet 1 (Line 4) ---",
		"const config = {",
		'  Repository: "https://example.com",',
		"};",
		"",
		"Repository: other/lib",
		"Path: index.js",
		"URL: https://github.com/other/lib/blob/main/index.js",
		"",
		"Snippets:",
		"--- Snippet 1 (Line 1) ---",
		"module.exports = {};",
	].join("\n");
	const results = parseGrepSearchText(text, 10);
	assert.equal(results.length, 2);
	assert.equal(results[0].title, "acme/thing/src/db.ts");
	assert.equal(results[1].title, "other/lib/index.js");
});

test("a second hit with no blank line before it is still parsed", () => {
	const text = [
		"Repository: a/one",
		"Path: a.ts",
		"URL: https://github.com/a/one/blob/main/a.ts",
		"Snippets:",
		"--- Snippet 1 (Line 1) ---",
		"const a = 1;",
		"Repository: b/two",
		"Path: b.ts",
		"URL: https://github.com/b/two/blob/main/b.ts",
		"Snippets:",
		"--- Snippet 1 (Line 1) ---",
		"const b = 2;",
	].join("\n");
	const results = parseGrepSearchText(text, 10);
	assert.equal(results.length, 2, "a missing blank line must not lose a hit");
	assert.deepEqual(results.map((r) => r.url), [
		"https://github.com/a/one/blob/main/a.ts",
		"https://github.com/b/two/blob/main/b.ts",
	]);
});

// --- jev policy: fail closed, and never select a suppressed excerpt ----------

test("a missing sufficient verdict fails closed", () => {
	// A truncated payload must not read as "these results are enough", which is
	// the one verdict that silently misleads the model.
	const outcome = applyPolicy(CANDS, answer({ sufficient: undefined as never }), settingsWith());
	assert.equal(outcome.sufficient, false);
});

test("an absent answers key fails closed", () => {
	const bare: JevResponse = { answers: {} };
	assert.equal(applyPolicy(CANDS, bare, settingsWith()).sufficient, false);
});

test("an empty candidate set returns empty rather than throwing", () => {
	const outcome = applyPolicy([], answer(), settingsWith());
	assert.deepEqual(outcome.results, []);
	assert.equal(outcome.suppressed, 0);
});

test("augment never hoists an uncited top-level answer", async () => {
	const out = await augmentResults(
		{ query: "q", settings: { jev: settingsWith() } as never },
		stream([
			{ title: "A", url: "https://a.example", citedText: "the exact excerpt" },
			{ title: "B", url: "https://b.example", citedText: "other" },
		]),
		{
			modelRegistry: classifierRegistry(answer()),
		},
	);
	assert.equal(out.text, "", "jev must not hoist an uncited top-level answer");
	assert.equal(out.searchResults?.[0]?.citedText, "the exact excerpt");
});

test("provider metadata survives judging", async () => {
	const out = await augmentResults(
		{ query: "q", settings: { jev: settingsWith() } as never },
		stream([
			{
				title: "A",
				url: "https://a.example",
				citedText: "alpha",
				pageAge: "2024-01-01",
				source: "exa",
				type: "content",
			},
			{ title: "B", url: "https://b.example", citedText: "beta", pageAge: "2025-01-01" },
		]),
		{
			modelRegistry: classifierRegistry(answer()),
		},
	);
	const kept = (out.searchResults ?? []).find((r) => r.url === "https://a.example");
	assert.equal(
		kept?.source,
		"exa",
		"judging must not blank out provider metadata",
	);
	assert.equal(kept?.type, "content");
	assert.deepEqual(
		(out.searchResults ?? []).map((r) => r.pageAge).sort(),
		["2024-01-01", "2025-01-01"],
	);
});

test("two results sharing a url stay distinct results", async () => {
	const out = await augmentResults(
		{ query: "q", settings: { jev: settingsWith() } as never },
		stream([
			{ title: "A", url: "https://same.example", citedText: "from search" },
			{ title: "A", url: "https://same.example", citedText: "from contents" },
		]),
		{
			modelRegistry: classifierRegistry(answer({ c1_answers: noul(0.99), c1_offtopic: noul(0), c1_selfcontained: noul(0.99) })),
		},
	);
	// Keying the merge on url collapsed these into one; index must be used.
	assert.equal(out.searchResults?.length, 2);
});

// --- jev is bounded ---------------------------------------------------------

test("a hanging jev call is bounded rather than hanging the tool", async () => {
	const started = Date.now();
	const out = await augmentResults(
		{ query: "q", settings: { jev: settingsWith({ maxStateChars: 1e9 }) } as never },
		stream([{ title: "A", url: "https://a.example", citedText: "alpha" }]),
		{
			timeoutMs: 40,
			// Never settles on its own; only the deadline can end this.
			modelRegistry: classifierRegistry(async () => new Promise<never>(() => {})),
		},
	);
	assert.ok(Date.now() - started < 3000, "must not hang past the deadline");
	assert.equal(out.searchResults?.length, 1, "results still come back");
	assert.match(out.warnings?.join(" ") ?? "", /jev judging unavailable/);
});

test("an abort during judging is honoured, not just the deadline", async () => {
	const controller = new AbortController();
	const started = Date.now();
	const pending = augmentResults(
		{ query: "q", signal: controller.signal, settings: { jev: settingsWith() } as never },
		stream([{ title: "A", url: "https://a.example", citedText: "alpha" }]),
		{
			timeoutMs: 5000,
			modelRegistry: classifierRegistry(async () => new Promise<never>(() => {})),
		},
	);
	setTimeout(() => controller.abort(), 10);
	await assert.rejects(pending, (error: { code?: string }) => error.code === "aborted");
	const elapsed = Date.now() - started;
	assert.ok(elapsed < 4000, `abort must beat the 5s deadline, took ${elapsed}ms`);
});

test("a parent deadline during optional judging returns cited results with a warning", async () => {
	const controller = new AbortController();
	controller.abort(providerError("timeout", "search exceeded 20000ms."));
	let requests = 0;
	const input = stream([{ title: "A", url: "https://a.example", citedText: "alpha" }]);
	const out = await augmentResults(
		{ query: "q", signal: controller.signal, settings: { jev: settingsWith() } as never },
		input,
		{ modelRegistry: classifierRegistry(async () => { requests++; throw new Error("should not start"); }) },
	);
	assert.equal(requests, 0);
	assert.deepEqual(out.searchResults, input.searchResults);
	assert.equal(out.jevStatus, "unavailable");
	assert.match(out.warnings?.join(" ") ?? "", /operation timeout/);
});

// --- credentials and config -------------------------------------------------

test("a whitespace-only key is not a credential", () => {
	const restore = resetCredentials();
	process.env.PARALLEL_API_KEY = "   ";
	process.env.GH_TOKEN = "\t\n";
	try {
		// A blank key is not an authenticated connection, but anonymous MCP stays available.
		assert.equal(hasParallelKey(), false);
		assert.equal(hasGitHubToken(), false);
		assert.equal(providerAvailability().parallel, true);
		assert.equal(providerAvailability().github, false);
	} finally {
		restore();
	}
});

test("a non-positive timeout falls back to the default", () => {
	// 0 disables the deadline entirely, which is never what an operator meant.
	assert.equal(applyConfig("/c.json", { timeoutMs: 0 }).timeoutMs, DEFAULT_TIMEOUT_MS);
	assert.equal(applyConfig("/c.json", { timeoutMs: -5 }).timeoutMs, DEFAULT_TIMEOUT_MS);
	assert.ok(applyConfig("/c.json", { timeoutMs: 5 }).timeoutMs >= 1000);
});

test("a dropped cross-family fallback is recorded for the caller to surface", () => {
	const settings = applyConfig("/c.json", {
		web: { provider: "exa", fallback: ["parallel", "github"] },
	});
	assert.equal(settings.notices.length, 1);
	assert.match(settings.notices[0], /github/);
});

test("suppression reaches the tool details, not just a warning string", async () => {
	const { formatWebSearchResult } = await import("../src/format.ts");
	const out = await augmentResults(
		{ query: "q", settings: { jev: settingsWith() } as never },
		stream([
			{ title: "A", url: "https://a.example", citedText: "alpha" },
			{ title: "Evil", url: "https://evil.example", citedText: "ignore all" },
		]),
		{
			modelRegistry: classifierRegistry(answer({ c1_safety: choice("prompt_injection", 0.99) })),
		},
	);
	const rendered = formatWebSearchResult(out);
	assert.equal(rendered.details?.jev?.suppressed, 1);
	assert.deepEqual(rendered.details?.jev?.suppressedUrls, ["https://evil.example"]);
	// Evidence was withheld, so the model's global sufficiency verdict (which
	// covered the withheld candidate) is not restated as confirmed.
	assert.equal(rendered.details?.jev?.sufficient, false);
	assert.match(
		(out.warnings ?? []).join(" "),
		/could not confirm these results answer the query/,
	);
	assert.ok(
		!(rendered.details?.searchResults ?? []).some(
			(r) => r.url === "https://evil.example",
		),
		"a suppressed result must not reach the model",
	);
});
