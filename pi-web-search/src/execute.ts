import type {
	AgentToolResult,
	AgentToolUpdateCallback,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { hydrateFromPiAuth } from "./env.ts";
import { type WebSearchDetails, formatWebSearchResult } from "./format.ts";
import { augmentResults } from "./jev/augment.ts";
import { resolveSettings, type ResolvedSettings } from "./providers/config.ts";
import {
	type RunSearchOptions,
	providerAvailability,
	runParallelSearch,
	runSearch,
} from "./providers/index.ts";
import {
	DEFAULT_CHAIN,
	type ProviderFamily,
	type ProviderKind,
	type StreamResult,
	isProviderError,
	providerError,
} from "./providers/types.ts";
import { errorResult, invalidConfigResult } from "./utils.ts";

export type SearchScope = ProviderFamily | "both";

export interface ExecuteSearchParams {
	query: string;
	urls?: string[];
	scope: SearchScope;
	parallel: boolean;
	judge: boolean;
	progress: string;
}

export function trimQuery(query: string): string {
	return query.trim();
}

export function normalizeUrls(urls: string[] | undefined): {
	urls: string[];
	warnings: string[];
} {
	if (!urls || urls.length === 0) {
		return { urls: [], warnings: [] };
	}
	const kept: string[] = [];
	const warnings: string[] = [];
	for (const raw of urls) {
		const value = raw.trim();
		if (value.length === 0) {
			continue;
		}
		let parsed: URL;
		try {
			parsed = new URL(value);
		} catch {
			warnings.push(`Ignored invalid URL: ${value}`);
			continue;
		}
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
			warnings.push(`Ignored non-HTTP URL: ${value}`);
			continue;
		}
		kept.push(value);
	}
	return { urls: kept, warnings };
}

/**
 * Shared tool runner. Family and cost policy are fixed by the caller; the
 * agent never chooses a provider or a Jev backend here.
 */
export async function executeSearch(
	params: ExecuteSearchParams,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<WebSearchDetails> | undefined,
	_ctx: ExtensionContext,
	options: RunSearchOptions = {},
): Promise<AgentToolResult<WebSearchDetails>> {
	try {
		hydrateFromPiAuth();
		const resolved = await resolveSettings();
		if ("error" in resolved) {
			return invalidConfigResult(resolved.error);
		}

		const query = trimQuery(params.query);
		if (query.length === 0) {
			return errorResult(new Error("query must not be empty"));
		}

		const urls = params.scope === "code"
			? { urls: [] as string[], warnings: params.urls?.length
				? ["Ignored urls: code_search does not fetch pages."]
				: [] }
			: normalizeUrls(params.urls);

		onUpdate?.({
			content: [{ type: "text", text: params.progress }],
			details: {},
		});

		if (signal?.aborted) {
			return errorResult(abortedError(signal.reason));
		}

		const family = params.scope === "both" ? undefined : params.scope;
		const settings = settingsForScope(resolved, params.scope);
		const req = {
			query,
			urls: urls.urls.length > 0 ? urls.urls : undefined,
			signal,
			onUpdate,
			settings,
		};

		const availability = options.availability ?? providerAvailability();
		const skipped = params.parallel
			? skippedSources(params.scope, availability)
			: [];

		const raw = params.parallel
			? await runParallelSearch(req, { ...options, family })
			: await runSearch(req, { ...options, family: family ?? "web" });

		if (signal?.aborted) {
			return errorResult(abortedError(signal.reason));
		}

		const withNotes: StreamResult = {
			...raw,
			scope: params.scope,
			skipped,
			warnings: [
				...resolved.notices,
				...urls.warnings,
				...(raw.warnings ?? []),
			],
		};

		const wantJudge = params.judge && resolved.jev.enabled;
		const judged = wantJudge
			? await augmentResults(
					req,
					withNotes,
					{
						signal,
						usePiAuth: true,
						backend: resolved.jev.backend,
						model: resolved.jev.model,
					},
				)
			: withNotes;

		if (signal?.aborted) {
			return errorResult(abortedError(signal.reason));
		}

		return formatWebSearchResult({
			...judged,
			jevStatus: jevStatus(wantJudge, judged),
		});
	} catch (error) {
		return errorResult(error);
	}
}

function settingsForScope(
	resolved: ResolvedSettings,
	scope: SearchScope,
): ResolvedSettings {
	if (scope === "code") {
		return {
			...resolved,
			provider: resolved.code.provider,
			fallback: resolved.code.fallback,
			family: "code",
		};
	}
	if (scope === "web") {
		return {
			...resolved,
			provider: resolved.web.provider,
			fallback: resolved.web.fallback,
			family: "web",
		};
	}
	return resolved;
}

function skippedSources(
	scope: SearchScope,
	availability: Partial<Record<ProviderKind, boolean>>,
): string[] {
	const requested: ProviderKind[] =
		scope === "both"
			? [...DEFAULT_CHAIN.web, ...DEFAULT_CHAIN.code]
			: DEFAULT_CHAIN[scope];
	const notes: string[] = [];
	for (const kind of requested) {
		if (availability[kind] !== true) {
			notes.push(`${kind} skipped: not available.`);
		}
	}
	return notes;
}

function jevStatus(
	requested: boolean,
	result: StreamResult,
): NonNullable<StreamResult["jevStatus"]> {
	if (!requested) {
		return "disabled";
	}
	if (result.jev) {
		return "ran";
	}
	const warning = result.warnings?.join(" ") ?? "";
	if (/jev skipped/.test(warning)) {
		return "skipped";
	}
	if (/jev judging unavailable/.test(warning)) {
		return "unavailable";
	}
	return "disabled";
}

function abortedError(reason: unknown): unknown {
	if (isProviderError(reason) && reason.code === "aborted") {
		return reason;
	}
	return providerError("aborted", "search was aborted.");
}
