import assert from "node:assert/strict";
import test from "node:test";

import { applyConfig } from "../src/providers/config.ts";
import { type FetchLike } from "../src/providers/http.ts";
import {
	buildSourcegraphQuery,
	parseSourcegraphStream,
	sourcegraphSearch,
	toSourcegraphRepo,
} from "../src/providers/sourcegraph.ts";

test("owner/name repos are scoped to github.com on Sourcegraph", () => {
	assert.equal(toSourcegraphRepo("facebook/react"), "github.com/facebook/react");
	assert.equal(toSourcegraphRepo("vercel/next.js"), "github.com/vercel/next.js");
	assert.equal(toSourcegraphRepo("github.com/vercel/next.js"), "github.com/vercel/next.js");
	assert.equal(
		buildSourcegraphQuery("useState( repo:acme/thing language:TypeScript", 5),
		"useState( repo:github.com/acme/thing lang:TypeScript count:5",
	);
});

test("Sourcegraph stream matches become public file hits", () => {
	const body = [
		"event: matches",
		`data: ${JSON.stringify([{
			type: "content",
			repository: "github.com/vercel/next.js",
			path: "packages/next/index.ts",
			commit: "abc",
			lineMatches: [{ line: "export function useState(", lineNumber: 10 }],
		}])}`,
		"",
		"event: done",
		"data: {}",
		"",
	].join("\n");
	const parsed = parseSourcegraphStream(body, 8);
	assert.equal(parsed.results.length, 1);
	assert.equal(parsed.results[0].title, "vercel/next.js/packages/next/index.ts");
	assert.equal(
		parsed.results[0].url,
		"https://github.com/vercel/next.js/blob/abc/packages/next/index.ts",
	);
	assert.match(parsed.results[0].citedText ?? "", /useState/);
});

test("Sourcegraph alerts are warnings; fatal errors stay retryable", async () => {
	const alert = parseSourcegraphStream([
		"event: alert",
		`data: ${JSON.stringify({ title: "No repositories found", description: "try another repo" })}`,
		"",
	].join("\n"), 8);
	assert.equal(alert.results.length, 0);
	assert.match(alert.warnings.join(" "), /No repositories found/);

	const fetchImpl: FetchLike = async () => new Response(
		["event: error", `data: ${JSON.stringify({ message: "shard failed" })}`, ""].join("\n"),
		{ headers: { "content-type": "text/event-stream" } },
	);
	await assert.rejects(sourcegraphSearch({
		query: "useState(",
		settings: applyConfig("/tmp/c.json", { maxResults: 3 }),
	}, { fetchImpl }), (error: { code?: string; retryable?: boolean }) => {
		assert.equal(error.code, "tool_error");
		assert.equal(error.retryable, true);
		return true;
	});
});
