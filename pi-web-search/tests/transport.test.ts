import assert from "node:assert/strict";
import test from "node:test";

import {
	type FetchLike,
	type ResponseLike,
	postJson,
	postSseJson,
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

// --- SSE: correlated replies need not wait for the stream to close ----------

function openSseResponse(chunks: string[], onCancel: () => void | Promise<void>): ResponseLike {
	const encoder = new TextEncoder();
	return new Response(new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
		},
		cancel() { return onCancel(); },
	}), { headers: { "Content-Type": "text/event-stream" } });
}

test("postSseJson completes a framed correlated reply without waiting for SSE EOF", async () => {
	let cancelled = false;
	const expected = { jsonrpc: "2.0", id: 7, result: { text: "café" } };
	const body = frame({ jsonrpc: "2.0", method: "notifications/progress" }) +
		frame({ jsonrpc: "2.0", id: 99, result: {} }) + frame(expected);
	const encoded = new TextEncoder().encode(body.replaceAll("\n", "\r\n"));
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			// Single bytes exercise split UTF-8 characters and CRLF delimiters.
			for (const byte of encoded) controller.enqueue(Uint8Array.of(byte));
		},
		cancel() { cancelled = true; },
	});
	const result = await postSseJson("https://mcp.test", {
		body: {},
		timeoutMs: 500,
		selectMessage: (value) => (value as { id?: number })?.id === 7,
		fetchImpl: async () => new Response(stream, { headers: { "Content-Type": "text/event-stream" } }),
	});
	assert.deepEqual(result, expected);
	assert.equal(cancelled, true, "unused SSE tail must be cancelled");
});

function fragmentedSseResponse(body: string, chunkSize: number, onCancel: () => void = () => {}): ResponseLike {
	const bytes = new TextEncoder().encode(body);
	let offset = 0;
	return new Response(new ReadableStream<Uint8Array>({
		pull(controller) {
			if (offset >= bytes.length) { controller.close(); return; }
			controller.enqueue(bytes.subarray(offset, offset += chunkSize));
		},
		cancel: onCancel,
	}), { headers: { "Content-Type": "text/event-stream" } });
}

test("postSseJson preserves a representative fragmented UTF-8/CRLF response", async () => {
	const expected = { id: 7, result: { text: "café".repeat(256 * 1024) } };
	const body = (frame({ id: 99, result: {} }) + "data: malformed\n\n" + frame(expected) + ": unused tail\n".repeat(10)).replaceAll("\n", "\r\n");
	let cancelled = false;
	const result = await postSseJson("https://mcp.test", {
		body: {},
		selectMessage: (value) => (value as { id?: number })?.id === 7,
		fetchImpl: async () => fragmentedSseResponse(body, 32, () => { cancelled = true; }),
	});
	assert.deepEqual(result, expected);
	assert.equal(cancelled, true);
});

test("postSseJson retains full fragmented EOF fallback for an unterminated frame", async () => {
	const expected = { id: 7, result: { text: "café".repeat(256 * 1024) } };
	const result = await postSseJson("https://mcp.test", {
		body: {},
		selectMessage: (value) => (value as { id?: number })?.id === 7,
		fetchImpl: async () => fragmentedSseResponse(`data: ${JSON.stringify(expected)}\r\n`, 32),
	});
	assert.deepEqual(result, expected);
});

test("postSseJson immediately-ready chunks yield to request deadlines with and without selection", async () => {
	for (const select of [false, true]) {
		let cancelled = false;
		await assert.rejects(postSseJson("https://mcp.test", {
			body: {}, timeoutMs: 1,
			...(select ? { selectMessage: (value: unknown) => (value as { id?: number })?.id === 7 } : {}),
			fetchImpl: async () => fragmentedSseResponse(frame({ id: 7, result: { text: "x".repeat(64 * 1024) } }), 16,
				() => { cancelled = true; }),
		}), (error: unknown) => {
			assert.equal((error as { code: string }).code, "timeout");
			return true;
		});
		assert.equal(cancelled, true);
	}
});

test("postSseJson immediately-ready chunks yield to caller aborts with and without selection", async () => {
	for (const select of [false, true]) {
		const caller = new AbortController();
		const reason = providerError("timeout", "operation deadline", { retryable: true });
		let cancelled = false;
		const timer = setTimeout(() => caller.abort(reason), 0);
		try {
			await assert.rejects(postSseJson("https://mcp.test", {
				body: {}, signal: caller.signal,
				...(select ? { selectMessage: (value: unknown) => (value as { id?: number })?.id === 7 } : {}),
				fetchImpl: async () => fragmentedSseResponse(frame({ id: 7, result: { text: "x".repeat(64 * 1024) } }), 16,
					() => { cancelled = true; }),
			}), (error: unknown) => { assert.equal(error, reason); return true; });
			assert.equal(cancelled, true);
		} finally { clearTimeout(timer); }
	}
});

test("postSseJson waits for a full frame rather than accepting partial SSE data", async () => {
	let cancelled = false;
	await assert.rejects(postSseJson("https://mcp.test", {
		body: {},
		timeoutMs: 20,
		selectMessage: (value) => (value as { id?: number })?.id === 7,
		fetchImpl: async () => openSseResponse([
			`data: ${JSON.stringify({ jsonrpc: "2.0", id: 7, result: {} })}\n`,
		], () => { cancelled = true; }),
	}), (error: unknown) => {
		assert.equal((error as { code: string }).code, "timeout");
		return true;
	});
	assert.equal(cancelled, true);
});

test("postSseJson handles comments, malformed frames and multiline or bare JSON replies", async () => {
	for (const reply of [
		'event: message\ndata: {"id":7,\ndata: "result":{}}\n\n',
		'event: message\n{"id":7,"result":{}}\n\n',
	]) {
		const result = await postSseJson("https://mcp.test", {
			body: {},
			timeoutMs: 500,
			selectMessage: (value) => (value as { id?: number })?.id === 7,
			fetchImpl: async () => openSseResponse([
				": keepalive\n\n", "data: broken JSON\n\n", reply,
			], () => {}),
		});
		assert.deepEqual(result, { id: 7, result: {} });
	}
});

test("postSseJson cancels a waiting SSE reader on a caller operation deadline", async () => {
	const controller = new AbortController();
	const reason = providerError("timeout", "operation deadline", { retryable: true });
	let cancelled = false;
	const pending = postSseJson("https://mcp.test", {
		body: {},
		signal: controller.signal,
		selectMessage: () => true,
		fetchImpl: async () => openSseResponse([": still working\n\n"], () => { cancelled = true; }),
	});
	const timer = setTimeout(() => controller.abort(reason), 10);
	try {
		await assert.rejects(pending, (error: unknown) => {
			assert.equal(error, reason);
			return true;
		});
		assert.equal(cancelled, true);
	} finally { clearTimeout(timer); }
});

test("postSseJson does not let correlated SSE data override an HTTP failure", async () => {
	await assert.rejects(postSseJson("https://mcp.test", {
		body: {},
		selectMessage: () => { assert.fail("an HTTP error must not be selected as a reply"); },
		fetchImpl: async () => new Response(frame({ id: 7, result: {} }), {
			status: 429, headers: { "Content-Type": "text/event-stream" },
		}),
	}), (error: unknown) => {
		assert.equal((error as { code: string }).code, "rate_limited");
		assert.equal((error as { status: number }).status, 429);
		return true;
	});
});

test("postSseJson without a selector retains last-frame-at-EOF behavior", async () => {
	const result = await postSseJson("https://mcp.test", {
		body: {},
		fetchImpl: async () => new Response(frame({ id: 1 }) + frame({ id: 2 }), {
			headers: { "Content-Type": "text/event-stream" },
		}),
	});
	assert.deepEqual(result, { id: 2 });
});

test("postSseJson retains the byte cap while seeking a correlated SSE reply", async () => {
	let cancelled = false;
	await assert.rejects(postSseJson("https://mcp.test", {
		body: {},
		timeoutMs: 80,
		maxResponseBytes: 64,
		selectMessage: (value) => (value as { id?: number })?.id === 7,
		fetchImpl: async () => openSseResponse([
			frame({ jsonrpc: "2.0", method: "notifications/progress", params: { text: "x".repeat(100) } }),
			frame({ jsonrpc: "2.0", id: 7, result: {} }),
		], () => { cancelled = true; }),
	}), (error: unknown) => {
		assert.equal((error as { code: string }).code, "parse_error");
		assert.match((error as Error).message, /byte response cap/);
		return true;
	});
	assert.equal(cancelled, true);
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

test("mcp preserves tool replies and RPC errors on open SSE streams", async () => {
	for (const reply of [
		{ result: { content: [{ type: "text", text: "the answer" }] } },
		{ error: { code: -32603, message: "internal error" } },
	]) {
		let cancelled = false;
		const { fetchImpl } = mcpFetch(({ method }) => method === "initialize" ? INIT_FRAME : "");
		const client = createMcpClient({
			url: "https://mcp.test",
			timeoutMs: 500,
			fetchImpl: (url, init) => {
				const request = JSON.parse(init.body ?? "{}") as { method?: string; id?: number };
				return request.method === "tools/call"
					? Promise.resolve(openSseResponse([frame({ jsonrpc: "2.0", id: request.id, ...reply })], () => {
						cancelled = true;
						return new Promise(() => {});
					}))
					: fetchImpl(url, init);
			},
		});
		await client.initialize();
		try {
			if ("error" in reply) {
				await assert.rejects(client.callTool("t", {}), (error: unknown) => {
					assert.equal((error as { code: string }).code, "rpc_error");
					assert.equal((error as { rpcCode: number }).rpcCode, -32603);
					return true;
				});
			} else {
				assert.equal(await client.callTool("t", {}), "the answer");
			}
			assert.equal(cancelled, true);
		} finally { await client.close(); }
	}
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

test("mcp close cancels the DELETE response body without waiting for its EOF", { timeout: 1000 }, async () => {
	let cancelled = false;
	const { fetchImpl } = mcpFetch(({ method }) => method === "initialize" ? INIT_FRAME : "");
	const client = await initializedClient((url, init) => init.method === "DELETE"
		? Promise.resolve(openSseResponse([], () => {
			cancelled = true;
			return new Promise(() => {});
		}))
		: fetchImpl(url, init));
	await client.close();
	assert.equal(cancelled, true, "cleanup must release the unused DELETE body");
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
