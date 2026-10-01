import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { formatResult, type WebSearchDetails } from "./format.ts";
import { isProviderError } from "./providers/types.ts";

export type SearchToolName = "web_search" | "code_search" | "research_search";

/** Keep machine-readable failures intact instead of discarding data on throw. */
export function formatSearchError(tool: SearchToolName, error: unknown): AgentToolResult<WebSearchDetails> {
	const code = isProviderError(error) ? error.code : "unknown";
	const message = `${tool} failed (${code}): ${error instanceof Error ? error.message : String(error)}`;
	return formatResult(message, {
		resultCount: 0, grounded: false, sources: [], searchResults: [], warnings: [],
		error: {
			code, message,
			...(isProviderError(error) ? {
				status: error.status, rpcCode: error.rpcCode, retryable: error.retryable,
			} : {}),
			...(typeof error === "object" && error !== null && "configPath" in error && typeof error.configPath === "string"
				? { configPath: error.configPath } : {}),
		},
	});
}
