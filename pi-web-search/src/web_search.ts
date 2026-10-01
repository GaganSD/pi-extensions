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

export const WebSearchSchema = Type.Object({
	query: Type.String({
		minLength: 1,
		maxLength: MAX_QUERY_CHARS,
		description: "Web question or search terms (docs, prose, current events)",
	}),
	urls: Type.Optional(
		Type.Array(Type.String(), {
			description: "URLs to retrieve alongside the search",
			maxItems: 20,
		}),
	),
});

export type WebSearchInput = Static<typeof WebSearchSchema>;

/** Everyday web search: one family, sequential fallback, no Jev. */
export async function webSearch(
	_toolCallId: string,
	params: WebSearchInput,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<WebSearchDetails> | undefined,
	ctx: ExtensionContext,
	options: RunSearchOptions = {},
): Promise<AgentToolResult<WebSearchDetails>> {
	const urlCount = params.urls?.length ?? 0;
	return executeSearch(
		{
			query: params.query,
			urls: params.urls,
			scope: "web",
			parallel: false,
			judge: false,
			tool: "web_search",
			progress:
				urlCount > 0
					? `Searching and analyzing ${urlCount} URL(s)...`
					: `Searching for "${params.query}"...`,
		},
		signal,
		onUpdate,
		ctx,
		options,
	);
}
