import type {
	AgentToolResult,
	AgentToolUpdateCallback,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { executeSearch } from "./execute.ts";
import type { WebSearchDetails } from "./format.ts";
import type { RunSearchOptions } from "./providers/index.ts";

export const ResearchSearchSchema = Type.Object({
	query: Type.String({
		minLength: 1,
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
			progress: `Researching "${params.query}" (${params.scope})...`,
		},
		signal,
		onUpdate,
		ctx,
		options,
	);
}
