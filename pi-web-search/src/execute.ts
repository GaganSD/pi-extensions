import type {
	AgentToolResult,
	AgentToolUpdateCallback,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { type WebSearchDetails, formatWebSearchResult } from "./format.ts";
import { augmentResults } from "./jev/augment.ts";
import { resolveSettings } from "./providers/config.ts";
import { withTimeout } from "./providers/http.ts";
import {
	type RunSearchOptions,
	type SearchRequest,
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
import { type SearchToolName, droppedParamsWarning, formatSearchError } from "./utils.ts";

export type SearchScope = ProviderFamily | "both";

export interface ExecuteSearchParams {
	query: string;
	urls?: string[];
	scope: SearchScope;
	parallel: boolean;
	judge: boolean;
	progress: string;
	/** The registered tool this run belongs to; used in every failure message. */
	tool: SearchToolName;
	/**
	 * The argument object the host passed to the tool. Undeclared keys survive
	 * host validation, so it is where hallucinated parameters are observed.
	 */
	rawParams: object;
	/** The parameter names this tool declares; anything else is reported, not used. */
	acceptedParams: readonly string[];
	/** `research_search` requires an explicit opt-in in the resolved settings. */
	requireResearch?: boolean;
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
 * Best-effort progress observer owned by the runner. Cancellation is checked
 * before every emit, a throwing callback never fails or reshapes the search,
 * and nothing is emitted after `finish()`.
 */
interface ProgressObserver {
	emit(text: string): void;
	finish(): void;
}

function createProgressObserver(
	onUpdate: AgentToolUpdateCallback<WebSearchDetails> | undefined,
	signal: AbortSignal | undefined,
): ProgressObserver {
	let finished = false;
	return {
		emit(text) {
			if (finished || !onUpdate || signal?.aborted) {
				return;
			}
			try {
				onUpdate({ content: [{ type: "text", text }], details: {} });
			} catch {
				// A progress observer is advisory; its failure is not a search failure.
			}
		},
		finish() {
			finished = true;
		},
	};
}

/**
 * Shared tool runner. Family and cost policy are fixed by the caller; the
 * agent never chooses a provider or a Jev backend here.
 *
 * Failures return `isError: true` with a typed error payload for scripts and
 * renderers. The whole operation — retrieval plus optional Jev — shares one
 * bounded deadline composed with the caller's cancellation.
 */
export async function executeSearch(
	params: ExecuteSearchParams,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<WebSearchDetails> | undefined,
	_ctx: ExtensionContext,
	options: RunSearchOptions = {},
): Promise<AgentToolResult<WebSearchDetails>> {
	const progress = createProgressObserver(onUpdate, signal);
	try {
		if (signal?.aborted) throw abortedError(signal.reason);
		const resolved = await resolveSettings();
		if ("error" in resolved) {
			throw resolved.error;
		}
		if (params.requireResearch && !resolved.researchEnabled) {
			throw providerError(
				"invalid_config",
				`research_search is disabled. Set "research": { "enabled": true } in ${resolved.configPath} and run /reload.`,
			);
		}

		const query = trimQuery(params.query);
		if (query.length === 0) {
			throw providerError("unknown", "query must not be empty.");
		}

		const urls = params.scope === "code"
			? { urls: [] as string[], warnings: params.urls?.length
				? ["Ignored urls: code_search does not fetch pages."]
				: [] }
			: normalizeUrls(params.urls);

		if (signal?.aborted) {
			throw abortedError(signal.reason);
		}
		progress.emit(params.progress);

		const family = params.scope === "both" ? undefined : params.scope;
		const composed = withTimeout(signal, resolved.timeoutMs);
		try {
			const req: SearchRequest = {
				query,
				urls: urls.urls.length > 0 ? urls.urls : undefined,
				signal: composed.signal,
				onUpdate: (partial) => {
					if (composed.signal.aborted) return;
					const text = partial.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
					progress.emit(text);
				},
				settings: resolved,
			};

			const availability = options.availability ?? providerAvailability();
			const skipped = params.parallel
				? skippedSources(params.scope, availability)
				: [];

			const raw = params.parallel
				? await runParallelSearch(req, { ...options, family })
				: await runSearch(req, { ...options, family: family ?? "web" });

			if (composed.signal.aborted) {
				throw abortedError(composed.signal.reason);
			}

			const dropped = droppedParamsWarning(params.rawParams, params.acceptedParams);
			const withNotes: StreamResult = {
				...raw,
				scope: params.scope,
				skipped,
			};

			const wantJudge = params.judge && resolved.jev.enabled;
			const judged = wantJudge
				? await augmentResults(
						req,
						withNotes,
						{
							signal: composed.signal,
							usePiAuth: true,
							backend: resolved.jev.backend,
							model: resolved.jev.model,
						},
					)
				: withNotes;

			// Optional judging may exhaust the budget after retrieval succeeded.
			// Keep its cited results, but a genuine caller cancellation stays fatal.
			if (signal?.aborted) {
				throw abortedError(signal.reason);
			}
			if (composed.signal.aborted && !(wantJudge && isProviderError(composed.signal.reason) && composed.signal.reason.code === "timeout")) {
				throw abortedError(composed.signal.reason);
			}

			progress.finish();
			return formatWebSearchResult({
				...judged,
				// Local policy notices are not upstream evidence. Add them after
				// judging so suppression can redact untrusted provider diagnostics
				// without hiding scope/config/argument guidance.
				warnings: [
					...resolved.notices,
					...urls.warnings,
					...(dropped ? [dropped] : []),
					...(judged.warnings ?? []),
				],
				jevStatus: jevStatus(wantJudge, judged),
			});
		} finally {
			composed.dispose();
		}
	} catch (error) {
		progress.finish();
		return formatSearchError(params.tool, error);
	}
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
	return result.jevStatus ?? (result.jev ? "ran" : "disabled");
}

function abortedError(reason: unknown): unknown {
	// Preserve any ProviderError, including `timeout` from a parent deadline:
	// an operation timeout must never be reported as a user abort.
	if (isProviderError(reason)) {
		return reason;
	}
	return providerError("aborted", "search was aborted.");
}
