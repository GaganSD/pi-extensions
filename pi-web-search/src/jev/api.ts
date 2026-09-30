import { providerError } from "../providers/types.ts";

export const TYPESAFE_API_URL = "https://api.typesafe.ai/v1/systemone";

/**
 * Pinned. `jev-latest` moves, and a decision layer whose behavior shifts
 * underneath you is not debuggable.
 */
export const JEV_DEFAULT_MODEL = "jev-1.13.0";

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

export interface JevOptions {
	fetchImpl?: FetchLike;
	apiKey?: string;
	model?: string;
	timeoutMs?: number;
	signal?: AbortSignal;
}

type FetchLike = typeof globalThis.fetch;

/** The token is read per call so tests and key rotation are both easy. */
export function jevApiKey(explicit?: string): string | undefined {
	const key = explicit ?? process.env.TYPESAFE_API_KEY;
	return typeof key === "string" && key.length > 0 ? key : undefined;
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
	const key = jevApiKey(options.apiKey);
	if (key === undefined) {
		throw providerError(
			"missing_credentials",
			"jev: set TYPESAFE_API_KEY to enable the decision layer.",
		);
	}
	const doFetch = options.fetchImpl ??
		(globalThis.fetch as FetchLike | undefined);
	if (!doFetch) {
		throw providerError("network_error", "jev: no fetch implementation available.");
	}

	const response = await doFetch(TYPESAFE_API_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${key}`,
		},
		body: JSON.stringify({
			state,
			model: options.model ?? JEV_DEFAULT_MODEL,
			questions,
		}),
		signal: options.signal,
	});

	if (!response.ok) {
		const detail = await safeText(response);
		throw providerError(
			response.status === 429 ? "rate_limited" : "http_error",
			`jev: HTTP ${response.status}${detail ? ` ${detail.slice(0, 200)}` : ""}`,
			// 429 and 5xx are worth one retry; a 400 means our questions are
			// malformed and repeating them changes nothing.
			{ status: response.status },
		);
	}

	const parsed = await parseBody(response);
	if (!isRecord(parsed) || !isRecord(parsed.answers)) {
		throw providerError("parse_error", "jev: response had no answers object.");
	}
	return parsed as unknown as JevResponse;
}

async function parseBody(response: Response): Promise<unknown> {
	const text = await safeText(response);
	try {
		return JSON.parse(text);
	} catch {
		throw providerError("parse_error", "jev: response was not JSON.");
	}
}

async function safeText(response: Response): Promise<string> {
	try {
		return await response.text();
	} catch {
		return "";
	}
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
