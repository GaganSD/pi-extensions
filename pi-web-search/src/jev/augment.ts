import type { Usage } from "@earendil-works/pi-ai";
import type { SearchRequest } from "../providers/index.ts";
import { isProviderError, providerError, type StreamResult } from "../providers/types.ts";
import { JEV_TIMEOUT_MS, type JevOptions, systemOne } from "./api.ts";
import {
	type Candidate,
	type JudgeOutcome,
	applyPolicy,
	buildJudgeQuestions,
	stateSize,
	toCandidates,
} from "./judge.ts";

export type AugmentOptions = JevOptions;
/** Own classifier usage, never nested tool usage; copy to AgentToolResult.usage after formatting. */
export type AugmentedStreamResult = StreamResult & { classifierUsage?: Usage };

/**
 * Judges and reorders a result set in place.
 *
 * A decision-layer failure never fails a search: an unavailable Pi classifier,
 * an empty result set, an over-budget judged set, or a Jev deadline/provider
 * error returns the input unchanged or with a warning. The one fatal
 * case is user cancellation. An operation deadline during optional judging
 * returns already-retrieved results with a warning, rather than discarding them.
 */
export async function augmentResults(
	req: SearchRequest,
	result: StreamResult,
	options: AugmentOptions = {},
): Promise<AugmentedStreamResult> {
	if (req.signal?.aborted) {
		if (isProviderError(req.signal.reason) && req.signal.reason.code === "timeout") {
			return withWarning(result, "jev judging unavailable: operation timeout");
		}
		throw abortError(req.signal.reason);
	}
	const settings = req.settings.jev;
	const judgeOptions: JevOptions = {
		...options,
		backend: options.backend ?? settings.backend,
		model: options.model ?? settings.model,
	};
	if (!settings.enabled) {
		return { ...result, jevStatus: "disabled" };
	}
	const results = result.searchResults ?? [];
	if (results.length === 0) {
		return { ...result, jevStatus: "skipped" };
	}

	const candidates = toCandidates(results, results.length);
	if (stateSize(candidates, req.query) > settings.maxStateChars) {
		return withWarning(
			result,
			`jev skipped: the judged set exceeds ${settings.maxStateChars} characters.`,
			"skipped",
		);
	}

	try {
		const response = await systemOne(
			{ query: req.query, candidates },
			buildJudgeQuestions(candidates),
			{
				...judgeOptions,
				// The caller's abort must reach the judge, or a cancelled search
				// keeps waiting on a judgment nobody will read.
				signal: req.signal,
				timeoutMs: options.timeoutMs ?? JEV_TIMEOUT_MS,
			},
		);
		const outcome = applyPolicy(candidates, response, settings);
		return { ...merge(result, outcome), ...(response.usage ? { classifierUsage: response.usage } : {}) };
	} catch (error) {
		// User cancellation is fatal; deadlines only skip optional judging.
		if (req.signal?.aborted) {
			if (isProviderError(req.signal.reason) && req.signal.reason.code === "timeout") {
				return withWarning(result, "jev judging unavailable: operation timeout");
			}
			throw abortError(req.signal.reason);
		}
		return withWarning(result, `jev judging unavailable: ${describe(error)}`);
	}
}

function merge(
	result: StreamResult,
	outcome: JudgeOutcome,
): StreamResult {
	// Merge by the candidate's original position, never by URL: a search hit and
	// a /contents hit for the same page are distinct results, and keying on URL
	// collapsed them into one.
	const originals = result.searchResults ?? [];
	const results = outcome.results.map((judged) => {
		const original = originals[judged.index];
		// The judge only decides order and admission; provider metadata and
		// content are carried through untouched.
		return original
			? { ...original, title: judged.title, url: judged.url }
			: { title: judged.title, url: judged.url, citedText: judged.citedText };
	});

	// Provider diagnostics can quote the same evidence policy withheld. They
	// have no per-candidate provenance, so retain only count-based disclosure
	// when suppressing; the runner appends its trusted local notices afterward.
	const warnings = [
		...(outcome.suppressed > 0 ? [] : result.warnings ?? []),
		...outcome.warnings,
	];
	if (outcome.suppressed > 0 && result.warnings?.length) {
		warnings.push(`jev withheld ${result.warnings.length} provider warning(s) because they may quote suppressed evidence.`);
	}
	const withholdProse = outcome.suppressed > 0 && result.text.length > 0;
	if (withholdProse) {
		warnings.push("jev withheld aggregate provider prose because it may include suppressed evidence; use the admitted cited results instead.");
	}
	if (!outcome.sufficient) {
		warnings.push(
			outcome.sufficiencyUnconfirmed
				? "jev could not confirm these results answer the query after withholding unsafe evidence; treat the set as unverified."
				: "jev judged these results insufficient to answer the query; consider a narrower or differently worded search.",
		);
	}
	if (outcome.lowConfidence) {
		warnings.push("jev ranked these results low-confidence for the query.");
	}

	const usage = [...(result.usage ?? []), ...(outcome.usage ?? [])];

	return {
		...result,
		// Aggregate prose cannot be attributed to individual candidates. Once a
		// candidate is suppressed, it must not leak back through that prose.
		text: withholdProse ? "" : result.text,
		// Keep citation-bound results only. Do not hoist a Jev pick into an
		// uncited top-level answer.
		searchResults: results,
		sources: results
			.map((entry) => ({ title: entry.title ?? "", url: entry.url ?? "" }))
			.filter((source) => source.url.length > 0),
		...(warnings.length > 0 ? { warnings } : {}),
		...(usage.length > 0 ? { usage } : {}),
		jevStatus: "ran",
		jev: {
			sufficient: outcome.sufficient,
			lowConfidence: outcome.lowConfidence,
			suppressed: outcome.suppressed,
			suppressedUrls: outcome.suppressedUrls,
		},
	};
}

function withWarning(
	result: StreamResult,
	message: string,
	jevStatus: StreamResult["jevStatus"] = "unavailable",
): StreamResult {
	return {
		...result,
		jevStatus,
		warnings: [...(result.warnings ?? []), message],
	};
}

/** Preserves a ProviderError reason; a bare abort becomes an `aborted` error. */
function abortError(reason: unknown): unknown {
	if (isProviderError(reason)) {
		return reason;
	}
	return providerError("aborted", "jev judging was aborted.");
}

function describe(error: unknown): string {
	if (error instanceof Error && "code" in error) {
		return (error as { code: string }).code;
	}
	return error instanceof Error ? error.message : String(error);
}

export type { Candidate };
