import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
	AgentToolResult,
	AgentToolUpdateCallback,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { WebSearchDetails } from "../src/format.ts";
import {
	CONFIG_PATH_ENV_VAR,
} from "../src/providers/config.ts";
import type { SearchTransport } from "../src/providers/index.ts";
import { type StreamResult, providerError } from "../src/providers/types.ts";
import { CodeSearchSchema, codeSearch } from "../src/code_search.ts";
import { ResearchSearchSchema, researchSearch } from "../src/research_search.ts";
import { WebSearchSchema, type WebSearchInput, webSearch } from "../src/web_search.ts";

const VALID_CONFIG = JSON.stringify({ provider: "exa", fallback: [] });

const SEARCH_RESULT: StreamResult = {
	text: "",
	providerKind: "exa",
	requestId: "req_1",
	searchResults: [{ title: "Exa", url: "https://exa.ai", citedText: "search infra" }],
	sources: [{ title: "Exa", url: "https://exa.ai" }],
};

/** Context is unused by search; the tool only needs the provider settings. */
const ctx = {} as unknown as ExtensionContext;

async function withConfigFile(
	contents: string,
	run: (configPath: string) => Promise<void>,
): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "pi-web-search-"));
	const configPath = join(dir, "web-search.json");
	const previous = process.env[CONFIG_PATH_ENV_VAR];
	try {
		await writeFile(configPath, contents, "utf-8");
		process.env[CONFIG_PATH_ENV_VAR] = configPath;
		await run(configPath);
	} finally {
		if (previous === undefined) {
			delete process.env[CONFIG_PATH_ENV_VAR];
		} else {
			process.env[CONFIG_PATH_ENV_VAR] = previous;
		}
		await rm(dir, { recursive: true, force: true });
	}
}

function textOf(result: AgentToolResult<WebSearchDetails>): string {
	const part = result.content[0];
	return part?.type === "text" ? part.text : "";
}

function recordingTransport(
	result: StreamResult,
	calls: { query: string; urls?: string[]; maxResults: number }[],
): SearchTransport {
	return async (req) => {
		calls.push({
			query: req.query,
			urls: req.urls,
			maxResults: req.settings.maxResults,
		});
		return result;
	};
}

test("the tool schema exposes only query and urls", () => {
	const urls = WebSearchSchema.properties.urls as { maxItems?: number };
	assert.deepEqual(Object.keys(WebSearchSchema.properties), ["query", "urls"]);
	assert.equal(WebSearchSchema.required?.includes("query"), true);
	assert.equal(urls.maxItems, 20);
});

test("an invalid config file returns invalid_config without touching the network", async () => {
	let transportCalls = 0;
	await withConfigFile("{ not json", async (configPath) => {
		const result = await webSearch(
			"call_1",
			{ query: "hi" },
			undefined,
			undefined,
			ctx,
			{ transports: { exa: async () => { transportCalls++; return SEARCH_RESULT; } } },
		);

		assert.equal(result.details.error, "invalid_config");
		assert.equal(result.details.configPath, configPath);
		assert.match(textOf(result), /^web_search failed \(invalid_config\): /);
	});
	assert.equal(transportCalls, 0);
});

test("a search failure is returned as an error result", async () => {
	await withConfigFile(VALID_CONFIG, async () => {
		const result = await webSearch(
			"call_1",
			{ query: "hi" },
			undefined,
			undefined,
			ctx,
			{
				transports: {
					exa: async () => {
						throw providerError("http_error", "Exa is down.", { status: 503 });
					},
				},
			},
		);

		assert.equal(result.details.error, "http_error");
		assert.equal(result.details.code, "http_error");
		assert.equal(result.details.status, 503);
		assert.equal(
			textOf(result),
			"web_search failed (http_error): Exa is down.",
		);
	});
});

test("a non-provider throw becomes an unknown error result", async () => {
	await withConfigFile(VALID_CONFIG, async () => {
		const result = await webSearch(
			"call_1",
			{ query: "hi" },
			undefined,
			undefined,
			ctx,
			{
				transports: {
					exa: async () => {
						throw "not an error";
					},
				},
			},
		);

		assert.equal(result.details.error, "unknown");
		assert.equal(textOf(result), "web_search failed (unknown): not an error");
	});
});

test("a successful search returns the formatted result and forwards the request", async () => {
	await withConfigFile(VALID_CONFIG, async () => {
		const calls: { query: string; urls?: string[]; maxResults: number }[] = [];
		const updates: string[] = [];
		const onUpdate: AgentToolUpdateCallback<WebSearchDetails> = (partial) => {
			const part = partial.content[0];
			updates.push(part?.type === "text" ? part.text : "");
		};
		const params: WebSearchInput = { query: "what is exa", urls: ["https://exa.ai"] };

		const result = await webSearch(
			"call_1",
			params,
			undefined,
			onUpdate,
			ctx,
			{ transports: { exa: recordingTransport(SEARCH_RESULT, calls) } },
		);

		assert.equal(result.details.error, undefined);
		assert.equal(result.details.provider, "exa");
		assert.equal(result.details.requestId, "req_1");
		assert.equal(result.details.grounded, true);
		assert.equal(result.details.resultCount, 1);
		assert.equal(result.details.scope, "web");
		assert.equal(result.details.jevStatus, "disabled");
		assert.match(textOf(result), /## Results/);
		assert.match(textOf(result), /\[Exa\]\(https:\/\/exa\.ai\)/);
		assert.match(textOf(result), /> search infra/);
		assert.deepEqual(calls, [
			{ query: "what is exa", urls: ["https://exa.ai"], maxResults: 8 },
		]);
		assert.deepEqual(updates, ["Searching and analyzing 1 URL(s)..."]);
	});
});

test("the progress update names the query when no URLs are given", async () => {
	await withConfigFile(VALID_CONFIG, async () => {
		const calls: { query: string; urls?: string[]; maxResults: number }[] = [];
		const updates: string[] = [];
		const onUpdate: AgentToolUpdateCallback<WebSearchDetails> = (partial) => {
			const part = partial.content[0];
			updates.push(part?.type === "text" ? part.text : "");
		};

		await webSearch("call_1", { query: "pi" }, undefined, onUpdate, ctx, {
			transports: { exa: recordingTransport(SEARCH_RESULT, calls) },
		});

		assert.deepEqual(updates, ['Searching for "pi"...']);
		assert.deepEqual(calls, [{ query: "pi", urls: undefined, maxResults: 8 }]);
	});
});

test("code_search is query-only and stays in the code family", async () => {
	assert.deepEqual(Object.keys(CodeSearchSchema.properties), ["query"]);
	await withConfigFile(VALID_CONFIG, async () => {
		const result = await codeSearch(
			"call_1",
			{ query: "AbortSignal.timeout" },
			undefined,
			undefined,
			ctx,
			{
				availability: { grep: true, github: false },
				transports: {
					grep: async () => ({
						text: "",
						providerKind: "grep",
						searchResults: [
							{ title: "node/abort", url: "https://github.com/n/a", citedText: "timeout", source: "grep" },
						],
						sources: [{ title: "node/abort", url: "https://github.com/n/a" }],
					}),
					exa: async () => SEARCH_RESULT,
				},
			},
		);
		assert.equal(result.details.error, undefined);
		assert.equal(result.details.scope, "code");
		assert.equal(result.details.provider, "grep");
		assert.equal(result.details.jevStatus, "disabled");
	});
});

test("research_search fans out in the requested scope", async () => {
	assert.ok("scope" in ResearchSearchSchema.properties);
	await withConfigFile(
		JSON.stringify({ research: { enabled: true }, provider: "exa", fallback: [] }),
		async () => {
			const result = await researchSearch(
				"call_1",
				{ query: "AbortSignal.any", scope: "both" },
				undefined,
				undefined,
				ctx,
				{
					availability: { exa: true, grep: true },
					transports: {
						exa: recordingTransport(SEARCH_RESULT, []),
						grep: async () => ({
							text: "",
							providerKind: "grep",
							searchResults: [
								{ title: "code", url: "https://grep.example", citedText: "fn", source: "grep" },
							],
							sources: [{ title: "code", url: "https://grep.example" }],
						}),
					},
				},
			);
			assert.equal(result.details.error, undefined);
			assert.equal(result.details.scope, "both");
			assert.deepEqual(result.details.providers, ["exa", "grep"]);
			assert.equal(result.details.resultCount, 2);
			assert.match(textOf(result), /parallel skipped|github skipped/);
		},
	);
});
