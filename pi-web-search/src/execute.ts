import type {
	AgentToolResult,
	AgentToolUpdateCallback,
	ExtensionContext,
	ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import { evidenceOwner, evidenceStore } from "./evidence.ts";
import { previewEvidence, uniqueEvidence } from "./providers/results.ts";
import { type WebSearchDetails, formatWebSearchResult } from "./format.ts";
import { augmentResults, type AugmentedStreamResult } from "./jev/augment.ts";
import { resolveSettings } from "./providers/config.ts";
import { awaitWithSignal, withTimeout } from "./providers/http.ts";
import { jinaFetch } from "./providers/jina.ts";
import { reuseTransport } from "./providers/reuse.ts";
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
	fetchOnly?: boolean;
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
	/** `multi_search` requires an explicit opt-in in the resolved settings. */
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
	ctx: ExtensionContext,
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
				`multi_search is disabled. Set "research": { "enabled": true } in ${resolved.configPath} and run /reload.`,
			);
		}

		const query = trimQuery(params.query);
		if (query.length === 0 && !params.fetchOnly) {
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
		if (params.fetchOnly && urls.urls.length === 0) {
			throw providerError("unknown", "Supply a query or at least one valid HTTP(S) URL.");
		}
		progress.emit(params.progress);

		const family = params.scope === "both" ? undefined : params.scope;
		const composed = withTimeout(signal, resolved.timeoutMs);
		try {
			const req: SearchRequest = {
				query,
				fetchOnly: params.fetchOnly,
				reuseScope: options.transports || options.loadTransports ? undefined : evidenceOwner(ctx),
				urls: urls.urls.length > 0 ? urls.urls : undefined,
				signal: composed.signal,
				onUpdate: (partial) => {
					if (composed.signal.aborted) return;
					const text = partial.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
					progress.emit(text);
				},
				settings: resolved,
				...(typeof (ctx as Partial<ExtensionToolContext>).executeTool === "function"
					? { runtime: ctx as ExtensionToolContext } : {}),
			};

			const availability = options.availability ?? providerAvailability(family);
			const skipped = params.parallel
				? skippedSources(params.scope, availability)
				: [];

			const raw = params.fetchOnly && (options.fetchUrls || (!options.transports && !options.loadTransports))
				? await runUrlOnly(req, options, availability)
				: params.parallel
				? await runParallelSearch(req, { ...options, family, availability })
				: await runSearch(req, { ...options, family: family ?? "web", availability });

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
			const judged: AugmentedStreamResult = wantJudge
				? await augmentResults(
						req,
						withNotes,
						{
							signal: composed.signal,
							modelRegistry: ctx.modelRegistry,
							provider: resolved.jev.provider,
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
			// Store only post-policy evidence. Suppressed passages must never reappear.
			const unique = previewEvidence(uniqueEvidence(judged), Number.MAX_SAFE_INTEGER, urls.urls);
			const owner = evidenceOwner(ctx);
			const continuation = owner ? evidenceStore.put(owner, unique) : undefined;
			const preview = previewEvidence(unique, resolved.maxResults, urls.urls, !!continuation);
			const formatted = formatWebSearchResult({
				...preview,
				// Local policy notices are not upstream evidence. Add them after
				// judging so suppression can redact untrusted provider diagnostics
				// without hiding scope/config/argument guidance.
				warnings: [
					...resolved.notices,
					...urls.warnings,
					...(dropped ? [dropped] : []),
					...(preview.warnings ?? []),
				],
				jevStatus: jevStatus(wantJudge, judged),
			}, undefined, continuation);
			if (judged.classifierUsage) {
				formatted.usage = judged.classifierUsage;
			}
			return formatted;
		} finally {
			composed.dispose();
		}
	} catch (error) {
		progress.finish();
		return formatSearchError(params.tool, error);
	}
}

/** Keep URL-only reads keyless and independent of the selected search provider. */
async function runUrlOnly(req: SearchRequest, options: RunSearchOptions, availability: Partial<Record<ProviderKind, boolean>>): Promise<StreamResult> {
	try {
		const pending = reuseTransport("jina", req, options.fetchUrls ?? jinaFetch);
		return req.signal ? await awaitWithSignal(pending, req.signal) : await pending;
	} catch (error) {
		if (req.signal?.aborted || !isProviderError(error) || !error.retryable) throw error;
		// Brave also delegates extraction to Jina: never retry it through that path.
		const chain = [req.settings.web.provider, ...req.settings.web.fallback];
		if (chain.every((kind) => kind === "brave")) throw error;
		const result = await runSearch(req, { ...options, family: "web", availability: { ...availability, brave: false } });
		return { ...result, warnings: [`Jina URL extraction failed (${error.code}); used fallback.`, ...(result.warnings ?? [])] };
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
