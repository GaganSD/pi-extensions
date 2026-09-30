import type {
	AgentToolResult,
	AgentToolUpdateCallback,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { type WebSearchDetails, formatWebSearchResult } from "./format.ts";
import { resolveSettings } from "./providers/config.ts";
import { type RunSearchOptions, runSearch } from "./providers/index.ts";
import { augmentResults } from "./jev/augment.ts";
import { resolveRouting } from "./jev/route.ts";
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

		// Routing is optional and never fatal: a failure here just falls back
		// to the configured provider.
		const routing = await resolveRouting(
			params.query,
			resolved.family,
			resolved.jev.enabled,
			{ signal },
		);

		const result = await runSearch(
			{
				query: params.query,
				urls: params.urls,
				signal,
				onUpdate,
				settings: resolved,
			},
			{ ...options, family: routing.family },
		);

		const augmented = await augmentResults(
			{ query: params.query, signal, settings: resolved },
			{
				...result,
				// Config notices were recorded but never shown, so a dropped
				// cross-family fallback stayed invisible to the operator.
				warnings: [
					...resolved.notices,
					...(routing.note ? [routing.note] : []),
					...(result.warnings ?? []),
				],
			},
		);

		return formatWebSearchResult(augmented);
	} catch (e) {
		return errorResult(e);
	}
}
