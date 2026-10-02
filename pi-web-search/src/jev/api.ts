import type {
	ClassifierAnswer,
	ClassifierApi,
	ClassifierModel,
	ClassifierQuestion,
	Usage,
} from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { awaitWithSignal } from "../providers/http.ts";
import type { Candidate } from "./judge.ts";

/** Optional judging should not hold up a completed search. */
export const JEV_TIMEOUT_MS = 8000;

export type JudgeQuestion = ClassifierQuestion;
export type JudgeAnswer = ClassifierAnswer;

export interface JevResponse {
	answers: Record<string, JudgeAnswer>;
	usage?: Usage;
}

export interface JevOptions {
	modelRegistry?: ExtensionContext["modelRegistry"];
	/** Exact Pi catalog provider. Empty means unpinned. */
	provider?: string;
	/** Exact Pi catalog model id. Empty means unpinned. */
	model?: string;
	/** Caller abort plus a deadline; an uncooperative classifier cannot hold up the tool. */
	signal?: AbortSignal;
	timeoutMs?: number;
}

type ModelRegistry = ExtensionContext["modelRegistry"];

/** Run only the pinned classifier if Pi reports that exact pair available. */
export async function selectPinnedClassifier(
	registry: ModelRegistry,
	provider: string | undefined,
	model: string | undefined,
	signal?: AbortSignal,
): Promise<ClassifierModel<ClassifierApi> | undefined> {
	const pinned = pinnedRef(provider, model);
	if (!pinned) {
		return undefined;
	}
	const found = registry.findOfType("classifier", pinned.provider, pinned.model);
	if (!found) {
		return undefined;
	}
	const available = await registry.getAvailableOfType("classifier", pinned.provider, { signal });
	return available.some((entry) => entry.provider === pinned.provider && entry.id === pinned.model)
		? found
		: undefined;
}

export function classifierUnavailableMessage(
	provider?: string,
	model?: string,
): string {
	const pinned = pinnedRef(provider, model);
	if (!pinned) {
		return "jev judging unavailable: pin jev.provider and jev.model to a Pi classifier.";
	}
	return `jev judging unavailable: Pi has no available classifier for ${pinned.provider}/${pinned.model}.`;
}

export async function systemOne(
	state: { query: string; candidates: Candidate[] },
	questions: Record<string, JudgeQuestion>,
	options: JevOptions,
): Promise<JevResponse> {
	if (options.signal?.aborted) throw options.signal.reason;
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
			const model = await selectPinnedClassifier(
				registry, options.provider, options.model, controller.signal,
			);
			controller.signal.throwIfAborted();
			if (!model) throw new Error(classifierUnavailableMessage(options.provider, options.model));
			const classifierState = {
				query: state.query,
				candidates: state.candidates.map((candidate) => ({
					index: candidate.index, title: candidate.title, url: candidate.url, excerpt: candidate.excerpt,
				})),
			};
			const result = await registry.classify(model, { state: classifierState, questions }, { signal: controller.signal });
			if (result.stopReason !== "stop") {
				throw new Error(result.errorMessage || `classifier ${result.stopReason}`);
			}
			for (const [id, question] of Object.entries(questions)) {
				if (!validAnswer(question, result.answers[id])) {
					throw new Error("classifier returned malformed answers");
				}
			}
			return {
				answers: result.answers,
				...(validUsage(result.usage) ? { usage: result.usage } : {}),
			};
		})(), controller.signal);
	} catch (error) {
		if (controller.signal.aborted) throw controller.signal.reason;
		throw error;
	} finally {
		clearTimeout(timeout);
		options.signal?.removeEventListener("abort", parentAbort);
	}
}

export function readBool(answers: Record<string, JudgeAnswer>, id: string): number {
	const answer = answers[id];
	return answer?.type === "bool" && typeof answer.probability === "number"
		? clamp01(answer.probability)
		: Number.NaN;
}

export function readChoice(
	answers: Record<string, JudgeAnswer>, id: string,
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

function pinnedRef(
	provider: string | undefined,
	model: string | undefined,
): { provider: string; model: string } | undefined {
	const pinnedProvider = provider?.trim() ?? "";
	const pinnedModel = model?.trim() ?? "";
	if (pinnedProvider.length === 0 || pinnedModel.length === 0) {
		return undefined;
	}
	return { provider: pinnedProvider, model: pinnedModel };
}

function validAnswer(question: JudgeQuestion, answer: ClassifierAnswer | undefined): boolean {
	if (question.type === "bool") {
		return answer?.type === "bool" && probability(answer.probability);
	}
	if (question.type === "choice") {
		return answer?.type === "choice" &&
			Object.hasOwn(question.criteria, answer.choice) &&
			probability(answer.probabilities?.[answer.choice]) && probability(answer.confidence);
	}
	return answer?.type === "score" && Number.isFinite(answer.score) && probability(answer.confidence);
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

function clamp01(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value)
		? Math.min(1, Math.max(0, value)) : Number.NaN;
}
