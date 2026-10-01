import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { formatResult, type WebSearchDetails } from "./format.ts";
import { isProviderError } from "./providers/types.ts";

export type SearchToolName = "web_search" | "code_search" | "research_search";

/**
 * Extra keys the model sent, keyed by the cleaned object `prepareSearchArgs`
 * returned. WeakMap rather than a module variable because the host can prepare
 * several tool calls before executing any of them.
 */
const droppedParams = new WeakMap<object, readonly string[]>();

/**
 * Drops parameters the tool does not declare instead of letting the host fail
 * the call on them. A model that sends `top_n` and has it ignored believes a
 * filter ran that never did; ignoring the key keeps the search but reporting it
 * keeps the model honest. Cheaper for a weak model than an error round trip.
 */
export function prepareSearchArgs(accepted: readonly string[]): (args: unknown) => object {
	return (args) => {
		if (typeof args !== "object" || args === null || Array.isArray(args)) {
			return args as object;
		}
		const source = { ...(args as Record<string, unknown>) };
		const dropped = Object.keys(source).filter((key) => !accepted.includes(key));
		for (const key of dropped) delete source[key];
		if (dropped.length > 0) droppedParams.set(source, dropped);
		return source;
	};
}

/** The ignored-parameter note for a prepared call, or undefined when none. */
export function droppedParamsWarning(params: object): string | undefined {
	const dropped = droppedParams.get(params);
	if (!dropped || dropped.length === 0) return undefined;
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
