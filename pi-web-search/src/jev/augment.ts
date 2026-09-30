import type { SearchRequest } from "../providers/index.ts";
import type { StreamResult } from "../providers/types.ts";
import { jevApiKey, type JevOptions, systemOne } from "./api.ts";
import {
	type Candidate,
	type JudgeOutcome,
	applyPolicy,
	buildJudgeQuestions,
	stateSize,
	toCandidates,
} from "./judge.ts";

export interface AugmentOptions extends JevOptions {
	maxResults?: number;
}

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
	if (!settings.enabled || jevApiKey(options.apiKey) === undefined) {
		return result;
	}

	const results = result.searchResults ?? [];
	if (results.length === 0) {
		return result;
	}

	const candidates = toCandidates(req.query, results, options.maxResults ?? results.length);
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
			{ ...options, model: options.model ?? settings.model },
		);
		const outcome = applyPolicy(candidates, response, settings);
		return merge(result, outcome);
	} catch (error) {
		return withWarning(result, `jev judging unavailable: ${describe(error)}`);
	}
}

function merge(result: StreamResult, outcome: JudgeOutcome): StreamResult {
	const byUrl = new Map(
		(result.searchResults ?? []).map((entry) => [entry.url ?? "", entry]),
	);
	const results = outcome.results.map((entry) => {
		const original = byUrl.get(entry.url ?? "");
		// Keep whatever the provider supplied; the judge only decides order
		// and admission, never content.
		return original ? { ...original, ...entry } : entry;
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
		searchResults: results,
		sources: results
			.map((entry) => ({ title: entry.title ?? "", url: entry.url ?? "" }))
			.filter((source) => source.url.length > 0),
		...(warnings.length > 0 ? { warnings } : {}),
		...(usage.length > 0 ? { usage } : {}),
	};
}

function withWarning(result: StreamResult, message: string): StreamResult {
	return {
		...result,
		warnings: [...(result.warnings ?? []), message],
	};
}

function describe(error: unknown): string {
	if (error instanceof Error && "code" in error) {
		return (error as { code: string }).code;
	}
	return error instanceof Error ? error.message : String(error);
}

export type { Candidate };
