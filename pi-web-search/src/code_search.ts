import type {
	AgentToolResult,
	AgentToolUpdateCallback,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "@earendil-works/pi-ai";
import { MAX_QUERY_CHARS } from "./providers/config.ts";
import { executeSearch } from "./execute.ts";
import type { WebSearchDetails } from "./format.ts";
import type { RunSearchOptions } from "./providers/index.ts";

export const CodeSearchSchema = Type.Object({
	query: Type.String({
		minLength: 1,
		maxLength: MAX_QUERY_CHARS,
		description:
			"Literal code pattern or identifier (not a prose question). Supports repo:<owner/name> and language:<name> qualifiers, quoted when they contain spaces; path:, filename: and extension: are not filters.",
	}),
});

export type CodeSearchInput = Static<typeof CodeSearchSchema>;

/** Everyday code search: grep.app then GitHub. No URLs, no Jev. */
export async function codeSearch(
	_toolCallId: string,
	params: CodeSearchInput,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<WebSearchDetails> | undefined,
	ctx: ExtensionContext,
	options: RunSearchOptions = {},
): Promise<AgentToolResult<WebSearchDetails>> {
	return executeSearch(
		{
			query: params.query,
			scope: "code",
			parallel: false,
			judge: false,
			tool: "code_search",
			progress: `Searching code for "${params.query}"...`,
		},
		signal,
		onUpdate,
		ctx,
		options,
	);
}
