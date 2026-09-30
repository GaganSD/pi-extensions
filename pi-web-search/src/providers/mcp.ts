import {
	type FetchLike,
	postSseJson,
} from "./http.ts";
import { providerError } from "./types.ts";

export const MCP_PROTOCOL_VERSION = "2024-11-05";
const SESSION_ID_HEADER = "mcp-session-id";

export interface McpClientOptions {
	url: string;
	fetchImpl?: FetchLike;
	timeoutMs?: number;
	signal?: AbortSignal;
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

export function createMcpClient(options: McpClientOptions): McpClient {
	const { url } = options;
	let sessionId: string | undefined;
	let nextId = 1;

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
			headers: sessionId ? { "Mcp-Session-Id": sessionId } : undefined,
			onResponse: (response) => {
				sessionId = response.headers.get(SESSION_ID_HEADER) ?? sessionId;
			},
		});

		if (message && typeof message === "object" && message.error) {
			throw providerError(
				"http_error",
				`MCP ${method} failed: ${message.error.message ?? "unknown error"}`,
				{ status: message.error.code },
			);
		}
		if (!message || typeof message !== "object" || message.result === undefined) {
			throw providerError(
				"parse_error",
				`MCP ${method} response had no result field.`,
			);
		}
		return message.result;
	}

	return {
		async initialize() {
			await rpc("initialize", {
				protocolVersion: MCP_PROTOCOL_VERSION,
				capabilities: {},
				clientInfo: { name: "pi-web-search", version: "0.1.0" },
			});
			// The server answers this notification with 202 and an empty body.
			await postSseJson(url, {
				body: { jsonrpc: "2.0", method: "notifications/initialized" },
				fetchImpl: options.fetchImpl,
				timeoutMs: options.timeoutMs,
				signal: options.signal,
				allowEmptyBody: true,
				headers: sessionId ? { "Mcp-Session-Id": sessionId } : undefined,
			});
		},

		async callTool(name: string, args: Record<string, unknown>) {
			const result = (await rpc("tools/call", {
				name,
				arguments: args,
			})) as McpToolResult;

			const text = collectTextContent(result.content);
			if (result.isError === true) {
				throw providerError(
					"parse_error",
					`MCP tool ${name} reported an error: ${
						text.length > 0 ? text : "no message"
					}`,
				);
			}
			return text;
		},

		async close() {
			if (!sessionId) {
				return;
			}
			const doFetch = options.fetchImpl ??
				(globalThis.fetch as FetchLike | undefined);
			if (!doFetch) {
				return;
			}
			try {
				await doFetch(url, {
					method: "DELETE",
					headers: { "Mcp-Session-Id": sessionId },
					signal: options.signal,
				});
			} catch (error) {
				throw providerError("network_error", `MCP close failed: ${
					error instanceof Error ? error.message : String(error)
				}`, { retryable: true, cause: error });
			}
		},
	};
}

/** Joins every `text` block of a `tools/call` content array. */
export function collectTextContent(content: unknown): string {
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
