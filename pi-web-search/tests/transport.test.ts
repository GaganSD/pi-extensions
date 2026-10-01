import assert from "node:assert/strict";
import test from "node:test";

import {
	type FetchLike,
	type ResponseLike,
	postJson,
	withTimeout,
} from "../src/providers/http.ts";
import { MCP_PROTOCOL_VERSION, createMcpClient } from "../src/providers/mcp.ts";
import { providerError } from "../src/providers/types.ts";

// --- signals: operation timeout vs user abort -------------------------------

test("withTimeout preserves a parent ProviderError('timeout') reason", () => {
	const parent = new AbortController();
	parent.abort(providerError("timeout", "operation deadline reached", {
		retryable: true,
	}));

	const composed = withTimeout(parent.signal, 5000);
	const reason = composed.signal.reason as { code?: string; message?: string };
	assert.equal(composed.signal.aborted, true);
	assert.equal(reason.code, "timeout");
	assert.equal(reason.message, "operation deadline reached");
	composed.dispose();
});

test("a parent timeout is reported as timeout, not as a user abort", async () => {
	const parent = new AbortController();
	const fetchImpl: FetchLike = (_url, init) =>
		new Promise((_resolve, reject) => {
			init.signal?.addEventListener("abort", () => {
				reject(init.signal?.reason);
			});
			parent.abort(providerError("timeout", "deadline", { retryable: true }));
		});

	const error = await postJson("https://x.test", {
		body: {},
		signal: parent.signal,
		fetchImpl,
	}).then(() => undefined, (e: unknown) => e);
	assert.equal((error as { code: string }).code, "timeout");
});

// --- http: bounded response body --------------------------------------------

test("postJson rejects a response body over the byte cap", async () => {
	await assert.rejects(
		postJson("https://x.test", {
			body: {},
			maxResponseBytes: 8,
			fetchImpl: () =>
				Promise.resolve(fakeResponse("0123456789")),
		}),
		(error: unknown) => {
			assert.equal((error as { code: string }).code, "parse_error");
			assert.match((error as Error).message, /byte response cap/);
			return true;
		},
	);
});

test("postJson streams and caps a real Response body", async () => {
	const big = "x".repeat(64);
	await assert.rejects(
		postJson("https://x.test", {
			body: {},
			maxResponseBytes: 16,
			fetchImpl: () => Promise.resolve(new Response(big) as ResponseLike),
		}),
		(error: unknown) => {
			assert.equal((error as { code: string }).code, "parse_error");
			return true;
		},
	);
});

test("postJson still parses a body under the cap", async () => {
	const value = await postJson<{ ok: boolean }>("https://x.test", {
		body: {},
		maxResponseBytes: 1024,
		fetchImpl: () => Promise.resolve(new Response('{"ok":true}') as ResponseLike),
	});
	assert.equal(value.ok, true);
});

// --- mcp: JSON-RPC correlation and result handling --------------------------

interface McpCall {
	method?: string;
	headers?: Record<string, string>;
}

/** Serves one SSE frame per fetch call, in order, and records the requests. */
function mcpFetch(
	frames: (call: McpCall) => string,
): { fetchImpl: FetchLike; calls: McpCall[] } {
	const calls: McpCall[] = [];
	const fetchImpl: FetchLike = (_url, init) => {
		const body = JSON.parse(init.body ?? "{}") as Record<string, unknown>;
		calls.push({ method: body.method as string | undefined, headers: init.headers });
		return Promise.resolve(
			fakeResponse(frames(calls[calls.length - 1]), {
				headers: { "mcp-session-id": "sess-1" },
			}),
		);
	};
	return { fetchImpl, calls };
}

function frame(message: unknown): string {
	return `event: message\ndata: ${JSON.stringify(message)}\n\n`;
}

const INIT_FRAME = frame({
	jsonrpc: "2.0",
	id: 1,
	result: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {} },
});

async function initializedClient(
	fetchImpl: FetchLike,
): Promise<ReturnType<typeof createMcpClient>> {
	const client = createMcpClient({ url: "https://mcp.test", fetchImpl });
	await client.initialize();
	return client;
}

test("mcp correlates the reply id and tolerates a trailing notification", async () => {
	const { fetchImpl } = mcpFetch(({ method }) => {
		if (method === "initialize") return INIT_FRAME;
		if (method === "notifications/initialized") return "";
		// tools/call: a progress notification follows the real reply.
		return frame({ jsonrpc: "2.0", method: "notifications/progress", params: {} }) +
			frame({
				jsonrpc: "2.0",
				id: 2,
				result: { content: [{ type: "text", text: "the answer" }] },
			});
	});

	const client = await initializedClient(fetchImpl);
	assert.equal(await client.callTool("t", {}), "the answer");
});

test("mcp fails as parse_error when no reply matches the request id", async () => {
	const { fetchImpl } = mcpFetch(({ method }) => {
		if (method === "initialize") return INIT_FRAME;
		if (method === "notifications/initialized") return "";
		return frame({ jsonrpc: "2.0", id: 999, result: { content: [] } });
	});

	const client = await initializedClient(fetchImpl);
	await assert.rejects(client.callTool("t", {}), (error: unknown) => {
		assert.equal((error as { code: string }).code, "parse_error");
		assert.match((error as Error).message, /matching the request id/);
		return true;
	});
});

test("mcp rejects a null result as parse_error", async () => {
	const { fetchImpl } = mcpFetch(({ method }) => {
		if (method === "initialize") return INIT_FRAME;
		if (method === "notifications/initialized") return "";
		return frame({ jsonrpc: "2.0", id: 2, result: null });
	});

	const client = await initializedClient(fetchImpl);
	await assert.rejects(client.callTool("t", {}), (error: unknown) => {
		assert.equal((error as { code: string }).code, "parse_error");
		return true;
	});
});

test("mcp retains a structured-only tool result", async () => {
	const { fetchImpl } = mcpFetch(({ method }) => {
		if (method === "initialize") return INIT_FRAME;
		if (method === "notifications/initialized") return "";
		return frame({
			jsonrpc: "2.0",
			id: 2,
			result: { structuredContent: { hits: 2 } },
		});
	});

	const client = await initializedClient(fetchImpl);
	assert.equal(await client.callTool("t", {}), JSON.stringify({ hits: 2 }));
});

test("a tool-level error is a retryable tool_error, not a parse_error", async () => {
	const { fetchImpl } = mcpFetch(({ method }) => {
		if (method === "initialize") return INIT_FRAME;
		if (method === "notifications/initialized") return "";
		return frame({
			jsonrpc: "2.0",
			id: 2,
			result: { isError: true, content: [{ type: "text", text: "rate limited" }] },
		});
	});

	const client = await initializedClient(fetchImpl);
	await assert.rejects(client.callTool("t", {}), (error: unknown) => {
		assert.equal((error as { code: string }).code, "tool_error");
		assert.equal((error as { retryable?: boolean }).retryable, true);
		assert.match((error as Error).message, /rate limited/);
		return true;
	});
});

test("a JSON-RPC error keeps its code on rpcCode, never on HTTP status", async () => {
	const { fetchImpl } = mcpFetch(({ method }) => {
		if (method === "initialize") return INIT_FRAME;
		if (method === "notifications/initialized") return "";
		return frame({
			jsonrpc: "2.0",
			id: 2,
			error: { code: -32603, message: "internal error" },
		});
	});

	const client = await initializedClient(fetchImpl);
	await assert.rejects(client.callTool("t", {}), (error: unknown) => {
		assert.equal((error as { code: string }).code, "rpc_error");
		assert.equal((error as { status?: number }).status, undefined);
		assert.equal((error as { rpcCode?: number }).rpcCode, -32603);
		assert.equal((error as { retryable?: boolean }).retryable, true);
		return true;
	});
});

test("a non-transient JSON-RPC error is not retryable", async () => {
	const { fetchImpl } = mcpFetch(({ method }) => {
		if (method === "initialize") return INIT_FRAME;
		if (method === "notifications/initialized") return "";
		return frame({
			jsonrpc: "2.0",
			id: 2,
			error: { code: -32602, message: "invalid params" },
		});
	});

	const client = await initializedClient(fetchImpl);
	await assert.rejects(client.callTool("t", {}), (error: unknown) => {
		assert.equal((error as { code: string }).code, "rpc_error");
		assert.equal((error as { retryable?: boolean }).retryable, false);
		return true;
	});
});

test("mcp replays the negotiated protocol version header after initialize", async () => {
	const negotiated = "2025-06-18";
	const { fetchImpl, calls } = mcpFetch(({ method }) => {
		if (method === "initialize") {
			return frame({
				jsonrpc: "2.0",
				id: 1,
				result: { protocolVersion: negotiated, capabilities: {} },
			});
		}
		if (method === "notifications/initialized") return "";
		return frame({ jsonrpc: "2.0", id: 2, result: { content: [] } });
	});

	const client = await initializedClient(fetchImpl);
	await client.callTool("t", {});

	assert.equal(calls[0].headers?.["MCP-Protocol-Version"], undefined);
	assert.equal(calls[2].headers?.["MCP-Protocol-Version"], negotiated);
});

test("mcp close is idempotent and survives a caller abort", async () => {
	const controller = new AbortController();
	const deletes: { method?: string; aborted?: boolean }[] = [];
	const { fetchImpl } = mcpFetch(({ method }) => {
		if (method === "initialize") return INIT_FRAME;
		if (method === "notifications/initialized") return "";
		return frame({ jsonrpc: "2.0", id: 2, result: { content: [] } });
	});
	const client = createMcpClient({
		url: "https://mcp.test",
		fetchImpl: (url, init) => {
			if (init.method === "DELETE") {
				// The cleanup signal must be fresh, not the aborted caller signal.
				deletes.push({ method: init.method, aborted: init.signal?.aborted });
				return Promise.resolve(fakeResponse("", { status: 202 }));
			}
			return fetchImpl(url, init);
		},
		signal: controller.signal,
	});
	await client.initialize();
	controller.abort();

	await client.close();
	await client.close();

	assert.equal(deletes.length, 1);
	assert.equal(deletes[0].aborted, false);
});

function fakeResponse(
	body: string,
	init: { status?: number; headers?: Record<string, string> } = {},
): ResponseLike {
	const status = init.status ?? 200;
	const headers = new Map(
		Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
	);
	return {
		ok: status >= 200 && status < 300,
		status,
		headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
		text: () => Promise.resolve(body),
	};
}
