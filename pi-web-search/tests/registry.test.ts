import assert from "node:assert/strict";
import test from "node:test";

import { applyConfig } from "../src/providers/config.ts";
import {
	DEFAULT_REQUEST_TIMEOUT_MS,
	type FetchLike,
	type ResponseLike,
	extractSseData,
	normalizeHttpError,
	postJson,
	postSseJson,
	withTimeout,
} from "../src/providers/http.ts";
import { MCP_PROTOCOL_VERSION, createMcpClient } from "../src/providers/mcp.ts";
import {
	providerAvailability,
	resolveProviderChain,
	runSearch,
} from "../src/providers/index.ts";
import {
	type ProviderKind,
	type StreamResult,
	isProviderError,
	providerError,
} from "../src/providers/types.ts";

const settings = applyConfig("/tmp/web-search.json", {
	web: { provider: "exa", fallback: ["parallel"] },
});

function result(kind: ProviderKind, marker: string): StreamResult {
	return { text: marker, providerKind: kind, sources: [] };
}

/** Explicit availability overrides isolate routing tests from native host state. */
const bothAvailable = { exa: true, parallel: true };

function fakeResponse(
	body: string,
	init: { status?: number; headers?: Record<string, string> } = {},
): ResponseLike {
	return new Response(body, init);
}

test("chain order is [provider, ...fallback]", () => {
	const chain = resolveProviderChain(settings, { exa: true, parallel: true });
	assert.deepEqual(chain, ["exa", "parallel"]);

	const parallelFirst = applyConfig("/tmp/web-search.json", {
		web: { provider: "parallel", fallback: ["exa"] },
	});
	assert.deepEqual(resolveProviderChain(parallelFirst, {
		exa: true,
		parallel: true,
	}), ["parallel", "exa"]);
});

test("a missing PARALLEL_API_KEY retains the keyless native Parallel fallback", () => {
	// Snapshot the whole credential alias set this assertion depends on, so an
	// operator's populated environment cannot change the result.
	const previousParallel = process.env.PARALLEL_API_KEY;
	const previousGitHub = process.env.GITHUB_TOKEN;
	const previousGh = process.env.GH_TOKEN;
	delete process.env.PARALLEL_API_KEY;
	delete process.env.GITHUB_TOKEN;
	delete process.env.GH_TOKEN;
	try {
		assert.deepEqual(providerAvailability(), {
			exa: true,
			parallel: true,
			// grep.app is keyless; GitHub needs a token that is absent here.
			grep: true,
			github: false,
		});
		// Code sources are keyless/available but must never join a web chain.
		assert.deepEqual(resolveProviderChain(settings), ["exa", "parallel"]);
	} finally {
		restoreEnv("PARALLEL_API_KEY", previousParallel);
		restoreEnv("GITHUB_TOKEN", previousGitHub);
		restoreEnv("GH_TOKEN", previousGh);
	}
});

/** Restores a process.env entry, deleting it when it was originally absent. */
function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[name];
	} else {
		process.env[name] = value;
	}
}

test("fallback happens on a retryable error", async () => {
	const attempted: ProviderKind[] = [];
	const found = await runSearch(
		{ query: "q", settings },
		{
			availability: bothAvailable,
			transports: {
				exa: () => {
					attempted.push("exa");
					throw providerError("timeout", "exa timed out");
				},
				parallel: () => {
					attempted.push("parallel");
					return Promise.resolve(result("parallel", "from parallel"));
				},
			},
		},
	);
	assert.deepEqual(attempted, ["exa", "parallel"]);
	assert.equal(found.providerKind, "parallel");
	assert.equal(found.text, "from parallel");
});

test("no fallback on missing_credentials", async () => {
	const attempted: ProviderKind[] = [];
	await assert.rejects(
		runSearch({ query: "q", settings }, {
			availability: bothAvailable,
			transports: {
				exa: () => {
					attempted.push("exa");
					throw providerError("missing_credentials", "no key");
				},
				parallel: () => {
					attempted.push("parallel");
					return Promise.resolve(result("parallel", "should not run"));
				},
			},
		}),
		(error: unknown) => {
			assert.equal(isProviderError(error), true);
			assert.equal((error as { code: string }).code, "missing_credentials");
			return true;
		},
	);
	assert.deepEqual(attempted, ["exa"]);
});

test("abort propagates immediately and is never retried", async () => {
	const controller = new AbortController();
	const attempted: ProviderKind[] = [];
	const promise = runSearch({ query: "q", signal: controller.signal, settings }, {
		availability: bothAvailable,
		transports: {
			exa: () => {
				attempted.push("exa");
				controller.abort();
				throw providerError("aborted", "aborted mid-flight");
			},
			parallel: () => {
				attempted.push("parallel");
				return Promise.resolve(result("parallel", "should not run"));
			},
		},
	});
	await assert.rejects(promise, (error: unknown) => {
		assert.equal((error as { code: string }).code, "aborted");
		return true;
	});
	assert.deepEqual(attempted, ["exa"]);

	// A signal already aborted short-circuits before any transport runs.
	attempted.length = 0;
	const already = new AbortController();
	already.abort();
	await assert.rejects(
		runSearch({ query: "q", signal: already.signal, settings }, {
			availability: bothAvailable,
			transports: {
				exa: () => {
					attempted.push("exa");
					return Promise.resolve(result("exa", "should not run"));
				},
			},
		}),
		(error: unknown) => {
			assert.equal((error as { code: string }).code, "aborted");
			return true;
		},
	);
	assert.deepEqual(attempted, []);
});

test("the LAST error surfaces when every attempt fails", async () => {
	const first = providerError("network_error", "exa network down");
	const second = providerError("rate_limited", "parallel rate limited", {
		status: 429,
	});
	await assert.rejects(
		runSearch({ query: "q", settings }, {
			availability: bothAvailable,
			transports: {
				exa: () => Promise.reject(first),
				parallel: () => Promise.reject(second),
			},
		}),
		(error: unknown) => {
			assert.equal((error as { message: string }).message, "parallel rate limited");
			assert.equal((error as { code: string }).code, "rate_limited");
			assert.equal((error as { status?: number }).status, 429);
			return true;
		},
	);
});

test("a chain with no available provider reports missing_credentials", async () => {
	await assert.rejects(
		runSearch({ query: "q", settings }, {
			availability: { exa: false, parallel: false },
			transports: {
				exa: () => Promise.resolve(result("exa", "should not run")),
			},
		}),
		(error: unknown) => {
			assert.equal((error as { code: string }).code, "missing_credentials");
			return true;
		},
	);
});

test("a non-ProviderError rejection surfaces as unknown and stops the walk", async () => {
	const attempted: ProviderKind[] = [];
	await assert.rejects(
		runSearch({ query: "q", settings }, {
			availability: bothAvailable,
			transports: {
				exa: () => Promise.reject(new Error("boom")),
				parallel: () => {
					attempted.push("parallel");
					return Promise.resolve(result("parallel", "should not run"));
				},
			},
		}),
		(error: unknown) => {
			assert.equal((error as { code: string }).code, "unknown");
			assert.equal((error as { message: string }).message, "boom");
			return true;
		},
	);
	assert.deepEqual(attempted, []);
});

// --- transport loading -------------------------------------------------------

test("a transport left absent by its loader is skipped and the next chain entry runs", async () => {
	// Simulates exa.ts failing to import while parallel.ts loads fine.
	const found = await runSearch({ query: "q", settings }, {
		availability: bothAvailable,
		loadTransports: () =>
			Promise.resolve({
				parallel: () => Promise.resolve(result("parallel", "from parallel")),
			}),
	});
	assert.equal(found.providerKind, "parallel");
	assert.equal(found.text, "from parallel");
});

test("a transport loader that rejects degrades instead of throwing out of runSearch", async () => {
	await assert.rejects(
		runSearch({ query: "q", settings }, {
			availability: bothAvailable,
			loadTransports: () => Promise.reject(new Error("cannot load exa")),
		}),
		(error: unknown) => {
			assert.equal((error as { code: string }).code, "missing_credentials");
			assert.match((error as Error).message, /No transport is registered/);
			return true;
		},
	);
});

test("an empty transport map reports the no-transport-available error", async () => {
	await assert.rejects(
		runSearch({ query: "q", settings }, {
			availability: bothAvailable,
			loadTransports: () => Promise.resolve({}),
		}),
		(error: unknown) => {
			assert.equal((error as { code: string }).code, "missing_credentials");
			assert.match((error as Error).message, /No transport is registered/);
			return true;
		},
	);
});

// --- http seam (offline, injected fetch) -------------------------------------

function jsonFetch(
	bodies: string[],
	init: { status?: number; headers?: Record<string, string> } = {},
): { fetchImpl: FetchLike; requests: { url: string; init: { body?: string; headers?: Record<string, string> } }[] } {
	const requests: { url: string; init: { body?: string; headers?: Record<string, string> } }[] = [];
	const queue = [...bodies];
	const fetchImpl: FetchLike = (url, requestInit) => {
		requests.push({ url, init: requestInit });
		const body = queue.shift() ?? "{}";
		return Promise.resolve(fakeResponse(body, init));
	};
	return { fetchImpl, requests };
}

test("postJson sends JSON, merges headers, and parses the body", async () => {
	const { fetchImpl, requests } = jsonFetch([
		JSON.stringify({ requestId: "r1", results: [] }),
	]);
	const data = await postJson<{ requestId: string }>("https://api.exa.ai/search", {
		body: { query: "hi" },
		headers: { "x-api-key": "secret" },
		fetchImpl,
	});
	assert.equal(data.requestId, "r1");
	assert.equal(requests.length, 1);
	assert.equal(requests[0].url, "https://api.exa.ai/search");
	assert.equal(requests[0].init.headers?.["x-api-key"], "secret");
	assert.equal(
		requests[0].init.headers?.["Content-Type"],
		"application/json",
	);
	assert.deepEqual(JSON.parse(requests[0].init.body ?? "{}"), { query: "hi" });
});

test("postJson normalizes 429 to rate_limited and 4xx to http_error", async () => {
	const limited = await postJson("https://x.test", {
		body: {},
		fetchImpl: jsonFetch(["slow down"], { status: 429 }).fetchImpl,
	}).then(
		() => undefined,
		(error: unknown) => error,
	);
	assert.equal(isProviderError(limited), true);
	assert.equal((limited as { code: string }).code, "rate_limited");
	assert.equal((limited as { status?: number }).status, 429);
	assert.equal((limited as { retryable?: boolean }).retryable, true);

	const unauthorized = await postJson("https://x.test", {
		body: {},
		fetchImpl: jsonFetch(["bad key"], { status: 401 }).fetchImpl,
	}).then(
		() => undefined,
		(error: unknown) => error,
	);
	assert.equal((unauthorized as { code: string }).code, "http_error");
	assert.equal((unauthorized as { retryable?: boolean }).retryable, false);
});

test("normalizeHttpError is directly usable for 5xx and 429", () => {
	assert.equal(
		normalizeHttpError(fakeResponse("", { status: 503 }), "nope").code,
		"http_error",
	);
	assert.equal(
		normalizeHttpError(fakeResponse("", { status: 503 }), "nope").retryable,
		true,
	);
	assert.equal(
		normalizeHttpError(fakeResponse("", { status: 429 }), "").code,
		"rate_limited",
	);
	assert.equal(
		normalizeHttpError(fakeResponse("", { status: 404 }), "missing").message,
		"HTTP 404: missing",
	);
});

test("postSseJson parses the event: message / data: {...} framing", async () => {
	const frame =
		'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05"}}\n\n';
	const data = await postSseJson<{ result: { protocolVersion: string } }>(
		"https://mcp.exa.ai/mcp",
		{ body: {}, fetchImpl: jsonFetch([frame]).fetchImpl },
	);
	assert.equal(data.result.protocolVersion, "2024-11-05");
	assert.deepEqual(extractSseData(frame), [
		'{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05"}}',
	]);
});

test("postSseJson also accepts a plain JSON body and multi-line data frames", async () => {
	const plain = await postSseJson<{ ok: boolean }>("https://x.test", {
		body: {},
		fetchImpl: jsonFetch([JSON.stringify({ ok: true })]).fetchImpl,
	});
	assert.equal(plain.ok, true);

	const multiline = await postSseJson<{ a: number }>("https://x.test", {
		body: {},
		fetchImpl: jsonFetch(['event: message\r\ndata: {"a":\r\ndata: 7}\r\n\r\n'])
			.fetchImpl,
	});
	assert.equal(multiline.a, 7);
});

test("postSseJson raises parse_error on a body that is neither JSON nor SSE", async () => {
	await assert.rejects(
		postSseJson("https://x.test", {
			body: {},
			fetchImpl: jsonFetch(["<html>nope</html>"]).fetchImpl,
		}),
		(error: unknown) => {
			assert.equal((error as { code: string }).code, "parse_error");
			return true;
		},
	);
});

test("a timeout produces code: timeout and never leaks the timer", async () => {
	const fetchImpl: FetchLike = (_url, init) =>
		new Promise((_resolve, reject) => {
			init.signal?.addEventListener("abort", () => {
				const reason = init.signal?.reason;
				reject(reason instanceof Error ? reason : new Error("aborted"));
			});
		});

	const error = await postJson("https://x.test", {
		body: {},
		timeoutMs: 5,
		fetchImpl,
	}).then(
		() => undefined,
		(e: unknown) => e,
	);
	assert.equal((error as { code: string }).code, "timeout");
	assert.equal((error as { retryable?: boolean }).retryable, true);
	assert.equal(DEFAULT_REQUEST_TIMEOUT_MS, 20000);
});

test("a caller abort produces code: aborted, not timeout", async () => {
	const controller = new AbortController();
	const fetchImpl: FetchLike = (_url, init) =>
		new Promise((_resolve, reject) => {
			init.signal?.addEventListener("abort", () => {
				const reason = init.signal?.reason;
				reject(reason instanceof Error ? reason : new Error("aborted"));
			});
			setTimeout(() => {
				controller.abort();
			}, 1);
		});

	const error = await postJson("https://x.test", {
		body: {},
		timeoutMs: 5000,
		signal: controller.signal,
		fetchImpl,
	}).then(
		() => undefined,
		(e: unknown) => e,
	);
	assert.equal((error as { code: string }).code, "aborted");
	assert.equal((error as { retryable?: boolean }).retryable, false);
});

test("withTimeout aborts immediately for an already-aborted signal and can be disposed", () => {
	const controller = new AbortController();
	controller.abort();
	const composed = withTimeout(controller.signal, 1000);
	assert.equal(composed.signal.aborted, true);
	composed.dispose();

	const live = withTimeout(undefined, 0);
	assert.equal(live.signal.aborted, false);
	live.dispose();
});

// --- mcp seam (offline, injected fetch) --------------------------------------

test("createMcpClient handshakes then calls a tool, threading the session id", async () => {
	const requests: { url: string; body: Record<string, unknown>; headers?: Record<string, string> }[] = [];
	const bodies = [
		`event: message\ndata: ${JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			result: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {} },
		})}\n\n`,
		// notifications/initialized -> 202 with an empty body
		"",
		`event: message\ndata: ${JSON.stringify({
			jsonrpc: "2.0",
			id: 2,
			result: {
				content: [
					{ type: "text", text: "Title: A\nURL: https://a.test" },
					{ type: "text", text: "Title: B\nURL: https://b.test" },
				],
			},
		})}\n\n`,
	];

	const fetchImpl: FetchLike = (url, init) => {
		const body = JSON.parse(init.body ?? "{}") as Record<string, unknown>;
		requests.push({ url, body, headers: init.headers });
		const next = bodies.shift() ?? "";
		// The session id only exists on the initialize response.
		const headers: Record<string, string> = body.method === "initialize"
			? { "mcp-session-id": "sess-1" }
			: {};
		return Promise.resolve(fakeResponse(next, { headers }));
	};

	const client = createMcpClient({
		url: "https://mcp.exa.ai/mcp",
		fetchImpl,
		timeoutMs: 1000,
	});
	await client.initialize();
	const text = await client.callTool("web_search_exa", { query: "q" });

	assert.equal(
		text,
		"Title: A\nURL: https://a.test\nTitle: B\nURL: https://b.test",
	);
	assert.deepEqual(
		requests.map((r) => r.body.method),
		["initialize", "notifications/initialized", "tools/call"],
	);
	const initialize = requests[0];
	assert.equal(initialize.body.jsonrpc, "2.0");
	const params = initialize.body.params as {
		protocolVersion: string;
		clientInfo: { name: string };
	};
	assert.equal(params.protocolVersion, "2024-11-05");
	assert.equal(params.clientInfo.name, "pi-web-search");
	// The session id is captured on initialize and replayed afterwards.
	assert.equal(initialize.headers?.["Mcp-Session-Id"], undefined);
	assert.equal(requests[1].headers?.["Mcp-Session-Id"], "sess-1");
	assert.equal(requests[2].headers?.["Mcp-Session-Id"], "sess-1");
	assert.deepEqual(requests[2].body.params, {
		name: "web_search_exa",
		arguments: { query: "q" },
	});
});

test("createMcpClient raises http_error for a non-2xx handshake", async () => {
	const fetchImpl: FetchLike = () =>
		Promise.resolve(fakeResponse("unauthorized", { status: 401 }));
	const client = createMcpClient({ url: "https://mcp.exa.ai/mcp", fetchImpl });
	await assert.rejects(client.initialize(), (error: unknown) => {
		assert.equal((error as { code: string }).code, "http_error");
		assert.equal((error as { status?: number }).status, 401);
		return true;
	});
});

test("createMcpClient raises parse_error when the tool result has no result field", async () => {
	const bodies = [
		`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} })}\n\n`,
		"",
		`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 2 })}\n\n`,
	];
	const fetchImpl: FetchLike = () =>
		Promise.resolve(fakeResponse(bodies.shift() ?? ""));
	const client = createMcpClient({ url: "https://mcp.exa.ai/mcp", fetchImpl });
	await client.initialize();
	await assert.rejects(
		client.callTool("web_search_exa", { query: "q" }),
		(error: unknown) => {
			assert.equal((error as { code: string }).code, "parse_error");
			return true;
		},
	);
});

test("createMcpClient raises network_error when the transport throws", async () => {
	const fetchImpl: FetchLike = () =>
		Promise.reject(new Error("socket hang up"));
	const client = createMcpClient({ url: "https://mcp.exa.ai/mcp", fetchImpl });
	await assert.rejects(client.initialize(), (error: unknown) => {
		assert.equal((error as { code: string }).code, "network_error");
		assert.match((error as Error).message, /socket hang up/);
		return true;
	});
});
