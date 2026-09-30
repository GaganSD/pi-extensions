import type {
	AgentToolResult,
	AgentToolUpdateCallback,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { type WebSearchDetails, formatWebSearchResult } from "./format.ts";
import { resolveSettings } from "./providers/config.ts";
import { type RunSearchOptions, runSearch } from "./providers/index.ts";
import { errorResult, invalidConfigResult } from "./utils.ts";

export const WebSearchSchema = Type.Object({
	query: Type.String({
		description: "The search query or question to answer",
	}),
	urls: Type.Optional(
		Type.Array(Type.String(), {
			description: "Additional URLs to analyze along with search (up to 20)",
			maxItems: 20,
		}),
	),
});

export type WebSearchInput = Static<typeof WebSearchSchema>;

/**
 * Runs one search. `options` is forwarded to the provider registry so tests can
 * inject fake transports; production callers pass nothing. The tool never
 * throws — every failure comes back as a tool result.
 */
export async function webSearch(
	_toolCallId: string,
	params: WebSearchInput,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<WebSearchDetails> | undefined,
	_ctx: ExtensionContext,
	options: RunSearchOptions = {},
): Promise<AgentToolResult<WebSearchDetails>> {
	try {
		const resolved = await resolveSettings();
		if ("error" in resolved) {
			return invalidConfigResult(resolved.error);
		}

		const urlCount = params.urls?.length ?? 0;
		onUpdate?.({
			content: [
				{
					type: "text",
					text:
						urlCount > 0
							? `Searching and analyzing ${urlCount} URL(s)...`
							: `Searching for "${params.query}"...`,
				},
			],
			details: {},
		});

		const result = await runSearch(
			{
				query: params.query,
				urls: params.urls,
				signal,
				onUpdate,
				settings: resolved,
			},
			options,
		);

		return formatWebSearchResult(result);
	} catch (e) {
		return errorResult(e);
	}
}
