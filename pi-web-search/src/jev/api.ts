import type { ClassifierAnswer, ClassifierQuestion, Usage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { JEV_LEGACY_MODEL, jevUnavailableMessage, selectJevModel, type JevModelOptions } from "./model.ts";
import type { Candidate } from "./judge.ts";

export const JEV_DEFAULT_MODEL = JEV_LEGACY_MODEL;
/** Optional judging should not hold up a completed search. */
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
export interface JevResponse {
	answers: Record<string, JevAnswer>;
	usage?: Usage;
}

export interface JevOptions extends JevModelOptions {
	modelRegistry?: ExtensionContext["modelRegistry"];
	/** Caller abort plus a deadline; an uncooperative classifier cannot hold up the tool. */
	signal?: AbortSignal;
	timeoutMs?: number;
}

/** Translate Pi's typed bool answer to the policy's noul at this one boundary. */
export async function systemOne(
	state: { query: string; candidates: Candidate[] },
	questions: Record<string, JevQuestion>,
	options: JevOptions,
): Promise<JevResponse> {
	const registry = options.modelRegistry;
	if (!registry) throw new Error("Pi modelRegistry is unavailable");
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(new Error("classifier deadline exceeded")),
		options.timeoutMs ?? JEV_TIMEOUT_MS);
	const parentAbort = () => controller.abort(options.signal?.reason);
	options.signal?.addEventListener("abort", parentAbort, { once: true });
	if (options.signal?.aborted) parentAbort();
	try {
		return await awaitWithSignal((async () => {
			const model = await selectJevModel(registry, options, controller.signal);
			if (!model) throw new Error(jevUnavailableMessage(options));
			const nativeQuestions: Record<string, ClassifierQuestion> = {};
			for (const [id, question] of Object.entries(questions)) {
				nativeQuestions[id] = question.type === "noul"
					? { ...question, type: "bool", criteria: question.criteria ?? { true: "Yes", false: "No" } }
					: question;
			}
			const classifierState = {
				query: state.query,
				candidates: state.candidates.map((candidate) => ({
					index: candidate.index, title: candidate.title, url: candidate.url, excerpt: candidate.excerpt,
				})),
			};
			const result = await registry.classify(model, { state: classifierState, questions: nativeQuestions }, { signal: controller.signal });
			if (result.stopReason !== "stop") {
				throw new Error(result.errorMessage || `classifier ${result.stopReason}`);
			}
			const answers: Record<string, JevAnswer> = {};
			for (const [id, question] of Object.entries(questions)) {
				const answer = result.answers[id];
				if (!validAnswer(question, answer)) throw new Error("classifier returned malformed answers");
				answers[id] = question.type === "noul"
					? { type: "noul", noul: (answer as Extract<ClassifierAnswer, { type: "bool" }>).probability }
					: answer as JevChoiceAnswer;
			}
			return { answers, ...(validUsage(result.usage) ? { usage: result.usage } : {}) };
		})(), controller.signal);
	} finally {
		clearTimeout(timeout);
		options.signal?.removeEventListener("abort", parentAbort);
	}
}

function validAnswer(question: JevQuestion, answer: ClassifierAnswer | undefined): boolean {
	if (question.type === "noul") {
		return answer?.type === "bool" && probability(answer.probability);
	}
	return answer?.type === "choice" &&
		Object.hasOwn(question.criteria, answer.choice) &&
		probability(answer.probabilities?.[answer.choice]) && probability(answer.confidence);
}
function probability(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}
function validUsage(value: Usage | undefined): value is Usage {
	return !!value && !!value.cost &&
		[value.input, value.output, value.cacheRead, value.cacheWrite, value.totalTokens,
			value.cost.input, value.cost.output, value.cost.cacheRead, value.cost.cacheWrite,
			value.cost.total].every((number) => Number.isFinite(number) && number >= 0);
}

/** Bounds even a registry stub that ignores abort signals (Pi receives the signal too). */
function awaitWithSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(signal.reason);
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => {
			signal.removeEventListener("abort", onAbort);
			reject(signal.reason);
		};
		signal.addEventListener("abort", onAbort, { once: true });
		operation.then(
			(value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
			(error) => { signal.removeEventListener("abort", onAbort); reject(error); },
		);
	});
}

export function readNoul(answers: Record<string, JevAnswer>, id: string): number {
	const answer = answers[id];
	return answer?.type === "noul" && typeof answer.noul === "number" ? clamp01(answer.noul) : Number.NaN;
}
export function readChoice(
	answers: Record<string, JevAnswer>, id: string,
): { choice: string; probability: number; confidence: number } {
	const answer = answers[id];
	if (answer?.type === "choice" && typeof answer.choice === "string") {
		return {
			choice: answer.choice,
			probability: clamp01(answer.probabilities?.[answer.choice]),
			confidence: clamp01(answer.confidence),
		};
	}
	return { choice: "", probability: Number.NaN, confidence: Number.NaN };
}
function clamp01(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value)
		? Math.min(1, Math.max(0, value)) : Number.NaN;
}
