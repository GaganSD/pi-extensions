import { type FetchLike as HttpFetchLike, postJson } from "../providers/http.ts";
import { providerError } from "../providers/types.ts";
import {
	JEV_NATIVE_MODEL,
	type ResolveJevAuthOptions,
	TYPESAFE_API_URL,
	resolveJevAuth,
} from "./auth.ts";

export {
	JEV_NATIVE_MODEL,
	JEV_VERCEL_MODEL,
	TYPESAFE_API_URL,
	VERCEL_TYPESAFE_API_URL,
	hasJevAuth,
	resolveJevAuth,
} from "./auth.ts";

/**
 * Pinned native id. `jev-latest` moves, and a decision layer whose behavior
 * shifts underneath you is not debuggable. Vercel uses `typesafe-ai/jev`.
 */
export const JEV_DEFAULT_MODEL = JEV_NATIVE_MODEL;

/**
 * Judging is an optimization, so its deadline is deliberately shorter than a
 * search's: it is better to return unranked results than to block on them.
 */
export const JEV_TIMEOUT_MS = 8000;

export interface JevChoiceQuestion {
	type: "choice";
	instructions: string;
	criteria: Record<string, string>;
}

export interface JevNoulQuestion {
	type: "noul";
	instructions: string;
	criteria?: { true: string; false: string };
}

export type JevQuestion = JevChoiceQuestion | JevNoulQuestion;

export interface JevChoiceAnswer {
	type: "choice";
	choice: string;
	probabilities: Record<string, number>;
	confidence: number;
}

export interface JevNoulAnswer {
	type: "noul";
	noul: number;
}

export type JevAnswer = JevChoiceAnswer | JevNoulAnswer;

export interface JevUsage {
	input_tokens?: number;
	output_tokens?: number;
	total_tokens?: number;
}

export interface JevResponse {
	answers: Record<string, JevAnswer>;
	model?: string;
	usage?: JevUsage;
}

export interface JevOptions extends ResolveJevAuthOptions {
	fetchImpl?: FetchLike;
	/** Caller abort plus a deadline; without one a hung call blocks the tool. */
	signal?: AbortSignal;
	timeoutMs?: number;
}

type FetchLike = typeof globalThis.fetch;

/** The token is read per call so tests and key rotation are both easy. */
export function jevApiKey(explicit?: string): string | undefined {
	return resolveJevAuth({ apiKey: explicit })?.apiKey;
}

/**
 * One request, many independent questions. Every question sees the same state,
 * which is what lets a whole result set be judged in a single round trip:
 * instructions reference candidates by backticked path.
 */
export async function systemOne(
	state: unknown,
	questions: Record<string, JevQuestion>,
	options: JevOptions,
): Promise<JevResponse> {
	const auth = resolveJevAuth(options);
	if (auth === undefined) {
		throw providerError(
			"missing_credentials",
			"jev: set JEV_API_KEY, TYPESAFE_API_KEY or AI_GATEWAY_API_KEY, or add a typesafe/vercel-ai-gateway key to Pi auth.json.",
		);
	}
	// Reuse the bounded transport rather than duplicating fetch/body/error logic.
	const parsed = await postJson<unknown>(auth.url, {
		headers: { Authorization: `Bearer ${auth.apiKey}` },
		body: { state, model: auth.model, questions },
		signal: options.signal,
		timeoutMs: options.timeoutMs ?? JEV_TIMEOUT_MS,
		fetchImpl: options.fetchImpl as HttpFetchLike | undefined,
	});
	if (!isRecord(parsed) || !isRecord(parsed.answers)) {
		throw providerError("parse_error", "jev: response had no answers object.");
	}
	return parsed as unknown as JevResponse;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads a noul answer, tolerating a missing or malformed entry. */
export function readNoul(answers: Record<string, JevAnswer>, id: string): number {
	const answer = answers[id];
	if (answer && answer.type === "noul" && typeof answer.noul === "number") {
		return clamp01(answer.noul);
	}
	return Number.NaN;
}

/** Reads the winning choice and its probability for that choice. */
export function readChoice(
	answers: Record<string, JevAnswer>,
	id: string,
): { choice: string; probability: number; confidence: number } {
	const answer = answers[id];
	if (answer && answer.type === "choice" && typeof answer.choice === "string") {
		const probability = answer.probabilities?.[answer.choice];
		return {
			choice: answer.choice,
			probability: typeof probability === "number" ? clamp01(probability) : Number.NaN,
			confidence:
				typeof answer.confidence === "number" ? clamp01(answer.confidence) : Number.NaN,
		};
	}
	return { choice: "", probability: Number.NaN, confidence: Number.NaN };
}

function clamp01(value: number): number {
	return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : Number.NaN;
}
