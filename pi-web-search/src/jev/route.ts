import type { ProviderFamily } from "../providers/types.ts";
import {
	type JevOptions,
	type JevQuestion,
	type JevResponse,
	hasJevAuth,
	readChoice,
	systemOne,
} from "./api.ts";

/**
 * Picks the family a query belongs to. This is what keeps four sources
 * coherent: without it, a code question falls into the web chain and a web
 * question has no way to reach code search at all.
 *
 * Runs before retrieval, so its state is the query alone — tiny and cheap.
 */
export interface RouteResult {
	family: ProviderFamily;
	probability: number;
	confidence: number;
}

export async function routeFamily(
	query: string,
	options: JevOptions = {},
): Promise<RouteResult> {
	const questions: Record<string, JevQuestion> = {
		kind: {
			type: "choice",
			instructions:
				"Is `query` asking for code, an API, a library, or a programming technique, rather than for general facts, news, documentation prose, or how-to explanations?",
			criteria: {
				web: "General knowledge, current events, products, companies, laws, how-to explanations, or prose documentation.",
				code: "Source code, an API signature, a library's usage, a function, a config value, or an implementation detail in some programming language.",
			},
		},
	};

	const response = await systemOne({ query }, questions, options);
	return readRoute(response);
}

/** Exported for tests: turns a response into the routing decision. */
export function readRoute(response: JevResponse): RouteResult {
	const { choice, probability, confidence } = readChoice(response.answers, "kind");
	if (choice !== "web" && choice !== "code") {
		throw new Error("jev routing returned an unknown family");
	}
	return { family: choice, probability, confidence };
}

/**
 * Routing is optional. It is skipped when the key is absent, when the model is
 * disabled, or when a family is pinned in config — and any failure falls back
 * to the configured default rather than failing the search.
 */
export async function resolveRouting(
	query: string,
	pinnedFamily: ProviderFamily | undefined,
	enabled: boolean,
	options: JevOptions = {},
): Promise<{ family: ProviderFamily | undefined; note?: string }> {
	if (pinnedFamily !== undefined) {
		return { family: pinnedFamily };
	}
	if (!enabled || !hasJevAuth(options)) {
		return { family: undefined };
	}
	try {
		const route = await routeFamily(query, options);
		return { family: route.family };
	} catch (error) {
		return {
			family: undefined,
			note: `jev routing unavailable (${describeError(error)}); using the configured provider.`,
		};
	}
}

function describeError(error: unknown): string {
	if (error instanceof Error && "code" in error) {
		return `${(error as { code: string }).code}`;
	}
	return error instanceof Error ? error.message : String(error);
}
