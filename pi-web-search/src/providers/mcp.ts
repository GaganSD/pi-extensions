import {
	type FetchLike,
	awaitWithSignal,
	postSseJson,
	withTimeout,
} from "./http.ts";
import { type ProviderError, providerError } from "./types.ts";

export const MCP_PROTOCOL_VERSION = "2024-11-05";
const SESSION_ID_HEADER = "mcp-session-id";
const PROTOCOL_VERSION_HEADER = "MCP-Protocol-Version";

/**
 * Cleanup is best-effort and must never hang teardown. This is independent of
 * `timeoutMs` so a caller that omitted a timeout still gets a finite close, and
 * independent of the caller's signal so an aborted operation still releases
 * the server-side session.
 */
const CLOSE_TIMEOUT_MS = 2000;

export interface McpClientOptions {
	url: string;
	fetchImpl?: FetchLike;
	timeoutMs?: number;
	signal?: AbortSignal;
	/** Extra headers for every request, e.g. GitHub's `Authorization`. */
	headers?: Record<string, string>;
}

export interface McpClient {
	initialize(): Promise<void>;
	/** Returns the concatenated text of the tool's text content blocks. */
	callTool(name: string, args: Record<string, unknown>): Promise<string>;
	close(): Promise<void>;
}

interface JsonRpcResponse {
	jsonrpc?: string;
	id?: number | string | null;
	result?: unknown;
	error?: { code?: number; message?: string; data?: unknown };
}

interface McpToolResult {
	content?: unknown;
	isError?: boolean;
	structuredContent?: unknown;
}

export async function withMcpSession<T>(
	options: McpClientOptions,
	body: (client: McpClient) => Promise<T>,
): Promise<T> {
	const client = createMcpClient(options);
	try {
		await client.initialize();
		return await body(client);
	} finally {
		await client.close().catch(() => {});
	}
}

export function createMcpClient(options: McpClientOptions): McpClient {
	const { url } = options;
	let sessionId: string | undefined;
	let protocolVersion: string | undefined;
	let nextId = 1;

	/** Session id and the negotiated protocol version never win over auth. */
	function requestHeaders(): Record<string, string> | undefined {
		const headers: Record<string, string> = { ...options.headers };
		if (sessionId) {
			headers["Mcp-Session-Id"] = sessionId;
		}
		if (protocolVersion) {
			headers[PROTOCOL_VERSION_HEADER] = protocolVersion;
		}
		return Object.keys(headers).length > 0 ? headers : undefined;
	}

	async function rpc(
		method: string,
		params?: Record<string, unknown>,
	): Promise<unknown> {
		const id = nextId++;
		const body: Record<string, unknown> = { jsonrpc: "2.0", id, method };
		if (params) {
			body.params = params;
		}

		const message = await postSseJson<JsonRpcResponse>(url, {
			body,
			fetchImpl: options.fetchImpl,
			timeoutMs: options.timeoutMs,
			signal: options.signal,
			headers: requestHeaders(),
			// Correlate on the request id: a trailing notification (progress/log)
			// must not be mistaken for the reply.
			selectMessage: (value) => isJsonRpcMessage(value) && value.id === id,
			onResponse: (response) => {
				const header = response.headers.get(SESSION_ID_HEADER);
				if (header) {
					sessionId = header;
				}
			},
		});

		if (!isJsonRpcMessage(message)) {
			throw providerError(
				"parse_error",
				`MCP ${method} returned a malformed JSON-RPC message.`,
			);
		}
		if (message.error) {
			throw rpcError(method, message.error);
		}
		if (message.result === undefined || message.result === null) {
			throw providerError(
				"parse_error",
				`MCP ${method} response had no result field.`,
			);
		}
		return message.result;
	}

	return {
		async initialize() {
			const result = await rpc("initialize", {
				protocolVersion: MCP_PROTOCOL_VERSION,
				capabilities: {},
				clientInfo: { name: "pi-web-search", version: "0.1.0" },
			});
			// Honour the server's negotiated version on subsequent requests.
			const negotiated = readString(result, "protocolVersion");
			if (negotiated) {
				protocolVersion = negotiated;
			}
			// The server answers this notification with 202 and an empty body.
			await postSseJson(url, {
				body: { jsonrpc: "2.0", method: "notifications/initialized" },
				fetchImpl: options.fetchImpl,
				timeoutMs: options.timeoutMs,
				signal: options.signal,
				allowEmptyBody: true,
				headers: requestHeaders(),
			});
		},

		async callTool(name: string, args: Record<string, unknown>) {
			const result = await rpc("tools/call", {
				name,
				arguments: args,
			});
			if (!isPlainObject(result)) {
				throw providerError(
					"parse_error",
					`MCP tool ${name} returned a non-object result.`,
				);
			}

			const toolResult = result as McpToolResult;
			const text = collectTextContent(toolResult.content);
			if (toolResult.isError === true) {
				// A tool-level failure is a provider failure, not a malformed
				// response: keep it retryable so the registry can fall back.
				throw providerError(
					"tool_error",
					`MCP tool ${name} reported an error: ${
						text.length > 0 ? text : "no message"
					}`,
					{ retryable: true },
				);
			}
			if (text.length > 0) {
				return text;
			}
			// Structured-only results are still evidence: serialize them rather
			// than dropping the payload on the floor.
			if (toolResult.structuredContent !== undefined) {
				return JSON.stringify(toolResult.structuredContent);
			}
			return text;
		},

		async close() {
			if (!sessionId) {
				return;
			}
			const sid = sessionId;
			// Clear first so a repeated close is a no-op even if the DELETE fails.
			sessionId = undefined;
			const doFetch = options.fetchImpl ??
				(globalThis.fetch as FetchLike | undefined);
			if (!doFetch) {
				return;
			}
			const headers: Record<string, string> = {
				...options.headers,
				"Mcp-Session-Id": sid,
			};
			if (protocolVersion) {
				headers[PROTOCOL_VERSION_HEADER] = protocolVersion;
			}
			const deadline = withTimeout(undefined, CLOSE_TIMEOUT_MS);
			try {
				const response = await awaitWithSignal(doFetch(url, {
					method: "DELETE",
					headers,
					signal: deadline.signal,
				}), deadline.signal);
				// DELETE is best-effort cleanup; release its unused body without
				// waiting for an open stream or an uncooperative cancel callback.
				void response.body?.cancel().catch(() => {});
			} catch (error) {
				throw providerError("network_error", `MCP close failed: ${
					error instanceof Error ? error.message : String(error)
				}`, { retryable: true, cause: error });
			} finally {
				deadline.dispose();
			}
		},
	};
}

/** A well-formed JSON-RPC 2.0 reply carries `result` or `error`. */
function isJsonRpcMessage(value: unknown): value is JsonRpcResponse {
	if (!isPlainObject(value)) {
		return false;
	}
	if (value.jsonrpc !== "2.0") {
		return false;
	}
	return "result" in value || "error" in value;
}

/** JSON-RPC error codes are not HTTP statuses; keep them on `rpcCode`. */
function rpcError(
	method: string,
	error: { code?: number; message?: string },
): ProviderError {
	const rpcCode = typeof error.code === "number" ? error.code : undefined;
	const message = typeof error.message === "string" && error.message.length > 0
		? error.message
		: "unknown error";
	return providerError("rpc_error", `MCP ${method} failed: ${message}`, {
		rpcCode,
		retryable: rpcCode === undefined ? true : isTransientRpcCode(rpcCode),
	});
}

/** Server errors (-32000..-32099) and internal errors are worth a retry. */
function isTransientRpcCode(code: number): boolean {
	return code === -32603 || (code >= -32099 && code <= -32000);
}

/** Joins every `text` block of a `tools/call` content array. */
function collectTextContent(content: unknown): string {
	if (typeof content === "string") {
		return content;
	}
	if (!Array.isArray(content)) {
		return "";
	}
	const parts: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") {
			continue;
		}
		const candidate = block as { type?: unknown; text?: unknown };
		if (candidate.type === "text" && typeof candidate.text === "string") {
			parts.push(candidate.text);
		}
	}
	return parts.join("\n");
}

function readString(value: unknown, key: string): string | undefined {
	if (!isPlainObject(value)) {
		return undefined;
	}
	const field = value[key];
	return typeof field === "string" && field.length > 0 ? field : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
