import assert from "node:assert/strict";
import test from "node:test";

import { applyConfig } from "../src/providers/config.ts";
import {
	listRunnableProviders,
	runParallelSearch,
} from "../src/providers/index.ts";
import { mergeStreamResults } from "../src/providers/results.ts";
import {
	type ProviderKind,
	type StreamResult,
	providerError,
} from "../src/providers/types.ts";

const settings = applyConfig("/tmp/web-search.json", {
	web: { provider: "exa", fallback: ["parallel"] },
});

function hit(kind: ProviderKind, marker: string): StreamResult {
	return {
		text: "",
		providerKind: kind,
		searchResults: [
			{ title: marker, url: `https://${kind}.example/${marker}`, citedText: marker, source: kind },
		],
		sources: [{ title: marker, url: `https://${kind}.example/${marker}` }],
	};
}

const allUp = { exa: true, parallel: true, grep: true, github: true };

test("research lists every available source, not just the fallback chain", () => {
	assert.deepEqual(listRunnableProviders(settings, allUp), [
		"exa",
		"parallel",
		"grep",
		"github",
	]);
});

test("a family pin still confines the parallel set", () => {
	assert.deepEqual(listRunnableProviders(settings, allUp, "code"), [
		"grep",
		"github",
	]);
});

test("unavailable sources are omitted rather than failing the fan-out", () => {
	assert.deepEqual(
		listRunnableProviders(settings, { exa: true, grep: true }),
		["exa", "grep"],
	);
});

test("successful providers are merged and failures become warnings", async () => {
	const result = await runParallelSearch(
		{ query: "q", settings },
		{
			availability: allUp,
			transports: {
				exa: async () => hit("exa", "exa-hit"),
				parallel: async () => {
					throw providerError("http_error", "Parallel is down.", { status: 503 });
				},
				grep: async () => hit("grep", "grep-hit"),
				github: async () => ({
					text: "",
					providerKind: "github",
					searchResults: [],
					sources: [],
				}),
			},
		},
	);

	assert.deepEqual(result.providers, ["exa", "grep", "github"]);
	assert.equal(result.searchResults?.length, 2);
	assert.match(result.warnings?.join("\n") ?? "", /parallel failed \(http_error\)/);
	assert.match(result.warnings?.join("\n") ?? "", /github returned no results/);
});

test("one empty provider does not discard the others", async () => {
	const result = await runParallelSearch(
		{ query: "q", settings },
		{
			availability: { exa: true, grep: true },
			transports: {
				exa: async () => ({ text: "", providerKind: "exa", searchResults: [], sources: [] }),
				grep: async () => hit("grep", "code"),
			},
		},
	);
	assert.equal(result.searchResults?.length, 1);
	assert.equal(result.searchResults?.[0].source, "grep");
});

test("if every provider fails the last error surfaces", async () => {
	await assert.rejects(
		runParallelSearch(
			{ query: "q", settings },
			{
				availability: { exa: true, parallel: true },
				transports: {
					exa: async () => {
						throw providerError("timeout", "exa timed out");
					},
					parallel: async () => {
						throw providerError("rate_limited", "parallel 429", { status: 429 });
					},
				},
			},
		),
		(error: unknown) => {
			assert.equal((error as { code: string }).code, "rate_limited");
			return true;
		},
	);
});

test("a missing transport is skipped when another source still works", async () => {
	const result = await runParallelSearch(
		{ query: "q", settings },
		{
			availability: { exa: true, grep: true },
			transports: { grep: async () => hit("grep", "only") },
		},
	);
	assert.equal(result.searchResults?.[0].source, "grep");
	assert.match(result.warnings?.join(" ") ?? "", /No transport is registered for exa/);
});

test("user abort fails the fan-out even if a provider already resolved", async () => {
	const controller = new AbortController();
	await assert.rejects(
		runParallelSearch(
			{ query: "q", settings, signal: controller.signal },
			{
				availability: { exa: true, grep: true },
				transports: {
					exa: async () => {
						controller.abort();
						return hit("exa", "late");
					},
					grep: async () => hit("grep", "also"),
				},
			},
		),
		(error: unknown) => {
			assert.equal((error as { code: string }).code, "aborted");
			return true;
		},
	);
});

test("an already-aborted signal never starts a provider", async () => {
	const controller = new AbortController();
	controller.abort();
	let called = 0;
	await assert.rejects(
		runParallelSearch(
			{ query: "q", settings, signal: controller.signal },
			{
				availability: { exa: true },
				transports: {
					exa: async () => {
						called++;
						return hit("exa", "nope");
					},
				},
			},
		),
		(error: unknown) => {
			assert.equal((error as { code: string }).code, "aborted");
			return true;
		},
	);
	assert.equal(called, 0);
});

test("no available provider is missing_credentials, not an empty merge", async () => {
	await assert.rejects(
		runParallelSearch(
			{ query: "q", settings },
			{ availability: { exa: false, parallel: false, grep: false, github: false } },
		),
		(error: unknown) => {
			assert.equal((error as { code: string }).code, "missing_credentials");
			return true;
		},
	);
});

test("the merger preserves text-only contributions and dedups citations", () => {
	const merged = mergeStreamResults([
		{
			kind: "exa",
			result: {
				text: "exa prose",
				providerKind: "exa",
				sources: [{ title: "A", url: "https://a.test" }],
			},
		},
		{
			kind: "parallel",
			result: {
				text: "parallel prose",
				providerKind: "parallel",
				// Distinct evidence (a second hit) with a shared citation URL.
				searchResults: [
					{ title: "A again", url: "https://a.test", source: "parallel" },
				],
				sources: [{ title: "A again", url: "https://a.test" }],
			},
		},
	]);
	assert.equal(merged.text, "exa prose\n\nparallel prose");
	assert.equal(merged.searchResults?.length, 1);
	assert.deepEqual(merged.sources, [{ title: "A", url: "https://a.test" }]);
});
