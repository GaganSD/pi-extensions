import type {
	AgentToolResult,
	AgentToolUpdateCallback,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { StringEnum, Type, type Static } from "@earendil-works/pi-ai";
import { MAX_QUERY_CHARS } from "./providers/config.ts";
import { executeSearch } from "./execute.ts";
import type { WebSearchDetails } from "./format.ts";
import type { RunSearchOptions } from "./providers/index.ts";

export const ResearchSearchSchema = Type.Object({
	query: Type.String({
		minLength: 1,
		maxLength: MAX_QUERY_CHARS,
		description: "Search terms; use code identifiers or snippets for code or both",
	}),
	scope: StringEnum(["web", "code", "both"] as const, {
		description: "Sources to consult; both explicitly requests mixed web and code results",
	}),
});

export type ResearchSearchInput = Static<typeof ResearchSearchSchema>;

/**
 * Opt-in cross-check. Parallel retrieval in the requested scope, then at most
 * one Jev judgment when that layer is enabled and authenticated.
 */
export async function researchSearch(
	_toolCallId: string,
	params: ResearchSearchInput,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<WebSearchDetails> | undefined,
	ctx: ExtensionContext,
	options: RunSearchOptions = {},
): Promise<AgentToolResult<WebSearchDetails>> {
	return executeSearch(
		{
			query: params.query,
			scope: params.scope,
			parallel: true,
			judge: true,
			tool: "research_search",
			requireResearch: true,
			progress: `Researching "${params.query}" (${params.scope})...`,
		},
		signal,
		onUpdate,
		ctx,
		options,
	);
}
