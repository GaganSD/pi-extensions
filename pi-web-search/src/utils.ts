import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { formatResult, type WebSearchDetails } from "./format.ts";
import { isProviderError } from "./providers/types.ts";

export type SearchToolName = "web_search" | "code_search" | "research_search";

/**
 * Names parameters the tool does not declare. The host validates arguments
 * before `execute` but leaves undeclared keys in place, so they arrive here and
 * can be reported. A model that sends `top_n` and has it silently dropped
 * believes a filter ran that never did; ignoring the key keeps the search,
 * and saying so keeps the model honest.
 */
export function droppedParamsWarning(
	params: object,
	accepted: readonly string[],
): string | undefined {
	const dropped = Object.keys(params).filter((key) => !accepted.includes(key));
	if (dropped.length === 0) return undefined;
	const keys = dropped.map((key) => `\`${key}\``).join(", ");
	return `Ignored unknown parameter${dropped.length === 1 ? "" : "s"} ${keys}. This tool accepts only the parameters in its schema.`;
}

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
