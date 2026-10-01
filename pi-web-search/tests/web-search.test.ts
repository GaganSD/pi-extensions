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
	MAX_QUERY_CHARS,
} from "../src/providers/config.ts";
import type { SearchTransport } from "../src/providers/index.ts";
import { type StreamResult, providerError } from "../src/providers/types.ts";
import { CodeSearchSchema, codeSearch } from "../src/code_search.ts";
import { MCP_PROTOCOL_VERSION } from "../src/providers/mcp.ts";
import type { FetchLike } from "../src/providers/http.ts";
import { exaObjective } from "../src/providers/exa.ts";
import { ResearchSearchSchema, researchSearch } from "../src/research_search.ts";
import { WebSearchSchema, type WebSearchInput, webSearch } from "../src/web_search.ts";

const VALID_CONFIG = JSON.stringify({ web: { provider: "exa", fallback: [] } });

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

async function assertToolError(
	promise: Promise<AgentToolResult<WebSearchDetails>>,
	check: (error: NonNullable<WebSearchDetails["error"]>) => boolean,
) {
	const result = await promise;
	assert.equal(result.isError, true);
	assert.ok(result.details.error);
	assert.equal(check(result.details.error), true);
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

test("the tool schema exposes only query and urls, and bounds the query", () => {
	const urls = WebSearchSchema.properties.urls as { maxItems?: number };
	const query = WebSearchSchema.properties.query as { maxLength?: number };
	assert.deepEqual(Object.keys(WebSearchSchema.properties), ["query", "urls"]);
	assert.equal(WebSearchSchema.required?.includes("query"), true);
	assert.equal(urls.maxItems, 20);
	assert.equal(query.maxLength, MAX_QUERY_CHARS);
	// The crafted Exa objective must stay below the server's 4096-char limit.
	assert.ok(
		exaObjective("x".repeat(MAX_QUERY_CHARS)).length <= 4096,
		exaObjective("x".repeat(MAX_QUERY_CHARS)).length.toString(),
	);
});

test("an invalid config file returns structured failure with invalid_config without touching the network", async () => {
	let transportCalls = 0;
	await withConfigFile("{ not json", async (configPath) => {
		await assertToolError(
			webSearch(
				"call_1",
				{ query: "hi" },
				undefined,
				undefined,
				ctx,
				{ transports: { exa: async () => { transportCalls++; return SEARCH_RESULT; } } },
			),
			(error: { code?: string; configPath?: string; message?: string }) => {
				assert.equal(error.code, "invalid_config");
				assert.equal(error.configPath, configPath);
				assert.match(String(error.message), /^web_search failed \(invalid_config\): /);
				return true;
			},
		);
	});
	assert.equal(transportCalls, 0);
});

test("a search failure returns structured failure naming the originating tool", async () => {
	await withConfigFile(VALID_CONFIG, async () => {
		await assertToolError(
			webSearch(
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
			),
			(error: { code?: string; status?: number; message?: string }) => {
				assert.equal(error.code, "http_error");
				assert.equal(error.status, 503);
				assert.equal(error.message, "web_search failed (http_error): Exa is down.");
				return true;
			},
		);
	});
});

test("a non-provider throw returns structured failure as unknown under the tool name", async () => {
	await withConfigFile(VALID_CONFIG, async () => {
		await assertToolError(
			webSearch(
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
			),
			(error: { code?: string; message?: string }) => {
				assert.equal(error.code, "unknown");
				assert.equal(error.message, "web_search failed (unknown): not an error");
				return true;
			},
		);
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
		assert.equal(result.details.scope, "code");
		assert.equal(result.details.provider, "grep");
		assert.equal(result.details.jevStatus, "disabled");
	});
});

test("research_search returns structured failure when research is not enabled", async () => {
	await withConfigFile(VALID_CONFIG, async () => {
		await assertToolError(
			researchSearch(
				"call_1",
				{ query: "AbortSignal.any", scope: "web" },
				undefined,
				undefined,
				ctx,
				{ transports: { exa: recordingTransport(SEARCH_RESULT, []) } },
			),
			(error: { code?: string; message?: string }) => {
				assert.equal(error.code, "invalid_config");
				assert.match(String(error.message), /^research_search failed \(invalid_config\): /);
				assert.match(String(error.message), /research_search is disabled/);
				return true;
			},
		);
	});
});

test("research_search fans out in the requested scope", async () => {
	assert.ok("scope" in ResearchSearchSchema.properties);
	await withConfigFile(
		JSON.stringify({ research: { enabled: true }, web: { provider: "exa", fallback: [] } }),
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
			assert.equal(result.details.scope, "both");
			assert.deepEqual(result.details.providers, ["exa", "grep"]);
			assert.equal(result.details.resultCount, 2);
			assert.match(textOf(result), /parallel skipped|github skipped/);
		},
	);
});

test("a hallucinated parameter is rejected by name instead of silently dropped", async () => {
	await withConfigFile(VALID_CONFIG, async () => {
		let called = false;
		await assertToolError(
			codeSearch(
				"call_1",
				{ query: "parseArgs", top_n: 20, path: "/" } as unknown as { query: string },
				undefined,
				undefined,
				ctx,
				{ transports: { grep: async () => { called = true; return SEARCH_RESULT; } } },
			),
			(error) => error.code === "invalid_arguments",
		);
		assert.equal(called, false, "must not reach the network");
		const result = await codeSearch(
			"call_2",
			{ query: "parseArgs", top_n: 20 } as unknown as { query: string },
			undefined,
			undefined,
			ctx,
			{ transports: { grep: async () => SEARCH_RESULT } },
		);
		assert.match(textOf(result), /code_search received unknown parameter `top_n`.*accepts only: `query`/s);
	});
});

test("web_search names its own parameters when one is unknown", async () => {
	await withConfigFile(VALID_CONFIG, async () => {
		const result = await webSearch(
			"call_1",
			{ query: "pi", limit: 5 } as unknown as WebSearchInput,
			undefined,
			undefined,
			ctx,
			{ transports: { exa: async () => SEARCH_RESULT } },
		);
		assert.equal(result.details.error?.code, "invalid_arguments");
		assert.match(textOf(result), /web_search received unknown parameter `limit`.*`query`, `urls`/s);
	});
});

/** Drives the real grep provider: the no-match warning lives there, not in the transport stub. */
async function runGrepProvider(query: string, reply: string) {
	const { grepSearch } = await import("../src/providers/grep.ts");
	const frame = (m: unknown) => `event: message\ndata: ${JSON.stringify(m)}\n\n`;
	const fetchImpl: FetchLike = (_url, init) => {
		const method = (JSON.parse(init.body ?? "{}") as { method?: string }).method;
		if (method === "initialize") {
			return Promise.resolve(new Response(frame({
				jsonrpc: "2.0", id: 1, result: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {} },
			})) as Response);
		}
		if (method === "notifications/initialized") {
			return Promise.resolve(new Response("") as Response);
		}
		return Promise.resolve(new Response(frame({
			jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: reply }] },
		})) as Response);
	};
	return grepSearch(
		{
			query,
			settings: { timeoutMs: 5000, maxResults: 5, researchEnabled: false },
			signal: undefined,
			onUpdate: undefined,
		} as unknown as Parameters<typeof grepSearch>[0],
		{ fetchImpl },
	);
}

test("zero code hits are a warning, not a rendered result", async () => {
	const result = await runGrepProvider(
		"sync_fs_poll repo:torvalds/linux",
		"No results found for your query.",
	);
	assert.deepEqual(result.searchResults, [], "an empty search reports no hits");
	assert.equal(result.sources?.length, 0);
	assert.match(
		result.warnings?.join(" ") ?? "",
		/repo:torvalds\/linux\. That repository may not be indexed/,
	);
	assert.doesNotMatch(result.warnings?.join(" ") ?? "", /No results found for your query/);
});

test("zero code hits without a repo qualifier suggest a shorter pattern", async () => {
	const result = await runGrepProvider(
		"import parseArgs from node:util",
		"No results found for your query.",
	);
	assert.match(result.warnings?.join(" ") ?? "", /shorter literal identifier/);
});

test("an upstream grep error is preserved instead of being read as a no-match", async () => {
	const result = await runGrepProvider("parseArgs", "500: Internal Server Error");
	assert.match(result.warnings?.join(" ") ?? "", /grep\.app returned: 500: Internal Server Error/);
});
