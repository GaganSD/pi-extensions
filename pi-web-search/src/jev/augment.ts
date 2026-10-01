import type { SearchRequest } from "../providers/index.ts";
import { isProviderError, providerError, type StreamResult } from "../providers/types.ts";
import { hasJevAuth, JEV_TIMEOUT_MS, type JevOptions, systemOne } from "./api.ts";
import {
	type Candidate,
	type JudgeOutcome,
	applyPolicy,
	buildJudgeQuestions,
	stateSize,
	toCandidates,
} from "./judge.ts";

export type AugmentOptions = JevOptions;

/**
 * Judges and reorders a result set in place.
 *
 * This never fails a search. If the key is missing, the model is disabled, the
 * result set is empty, or the judged set would exceed the state budget, the
 * input is returned unchanged. A decision layer that is down must degrade a
 * search, not break it — so every failure becomes a warning, not an error.
 */
export async function augmentResults(
	req: SearchRequest,
	result: StreamResult,
	options: AugmentOptions = {},
): Promise<StreamResult> {
	const settings = req.settings.jev;
	const authOptions: JevOptions = {
		...options,
		backend: options.backend ?? settings.backend,
		model: options.model ?? settings.model,
	};
	if (!settings.enabled || !hasJevAuth(authOptions)) {
		return result;
	}

	const results = result.searchResults ?? [];
	if (results.length === 0) {
		return result;
	}

	const candidates = toCandidates(results, results.length);
	if (stateSize(candidates, req.query) > settings.maxStateChars) {
		return withWarning(
			result,
			`jev skipped: the judged set exceeds ${settings.maxStateChars} characters.`,
		);
	}

	try {
		const response = await systemOne(
			{ query: req.query, candidates },
			buildJudgeQuestions(candidates),
			{
				...authOptions,
				// The caller's abort must reach the judge, or a cancelled search
				// keeps waiting on a judgment nobody will read.
				signal: req.signal,
				timeoutMs: options.timeoutMs ?? JEV_TIMEOUT_MS,
			},
		);
		const outcome = applyPolicy(candidates, response, settings);
		return merge(result, outcome);
	} catch (error) {
		// User cancel is fatal. A Jev deadline/network failure is not.
		if (req.signal?.aborted && isAbortLike(error)) {
			throw isProviderError(error) && error.code === "aborted"
				? error
				: providerError("aborted", "jev judging was aborted.");
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

	const warnings = [...(result.warnings ?? []), ...outcome.warnings];
	if (!outcome.sufficient) {
		warnings.push(
			"jev judged these results insufficient to answer the query; consider a narrower or differently worded search.",
		);
	}
	if (outcome.lowConfidence) {
		warnings.push("jev ranked these results low-confidence for the query.");
	}

	const usage = [...(result.usage ?? []), ...(outcome.usage ?? [])];

	return {
		...result,
		// Keep citation-bound results only. Do not hoist a Jev pick into an
		// uncited top-level answer.
		searchResults: results,
		sources: results
			.map((entry) => ({ title: entry.title ?? "", url: entry.url ?? "" }))
			.filter((source) => source.url.length > 0),
		...(warnings.length > 0 ? { warnings } : {}),
		...(usage.length > 0 ? { usage } : {}),
		jev: {
			sufficient: outcome.sufficient,
			lowConfidence: outcome.lowConfidence,
			suppressed: outcome.suppressed,
			suppressedUrls: outcome.suppressedUrls,
		},
	};
}

function withWarning(result: StreamResult, message: string): StreamResult {
	return {
		...result,
		warnings: [...(result.warnings ?? []), message],
	};
}

function isAbortLike(error: unknown): boolean {
	if (isProviderError(error) && error.code === "aborted") {
		return true;
	}
	return (
		!!error &&
		typeof error === "object" &&
		"name" in error &&
		(error as { name?: unknown }).name === "AbortError"
	);
}

function describe(error: unknown): string {
	if (error instanceof Error && "code" in error) {
		return (error as { code: string }).code;
	}
	return error instanceof Error ? error.message : String(error);
}

export type { Candidate };
