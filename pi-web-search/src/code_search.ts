import type {
	AgentToolResult,
	AgentToolUpdateCallback,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { executeSearch } from "./execute.ts";
import type { WebSearchDetails } from "./format.ts";
import type { RunSearchOptions } from "./providers/index.ts";

export const CodeSearchSchema = Type.Object({
	query: Type.String({
		minLength: 1,
		description: "Code identifiers or a literal snippet, not a prose question",
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
			progress: `Searching code for "${params.query}"...`,
		},
		signal,
		onUpdate,
		ctx,
		options,
	);
}
