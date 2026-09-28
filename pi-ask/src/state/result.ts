import {
	CANCELLED_SUMMARY,
	ELABORATED_SUMMARY,
	ELABORATION_INSTRUCTION,
	SUBMITTED_SUMMARY,
} from "../constants/text.ts";
import { formatElaborationLines, formatResultLines } from "../result-format.ts";
import type {
	AskElaborationPayload,
	AskResult,
	AskResultAnswer,
	AskResultStatus,
	AskState,
	AskStateAnswer,
} from "../types.ts";
import {
	cloneResultAnswer,
	getExtraOptionNotes,
	hasAnswerNotes,
	isAnswerEmpty,
	isResultAnswerCommitted,
	isResultAnswerEmpty,
	serializeAnswer,
} from "./answers.ts";
import { getQuestionOptionByValue } from "./selectors.ts";

export type ReviewAnswer = AskResult["answers"][string] & {
	extraOptionNotes?: Array<{
		label: string;
		note: string;
	}>;
};

export function toAskResult(
	state: AskState,
	status?: AskResultStatus
): AskResult {
	const answers = Object.fromEntries(
		Object.entries(state.answers)
			.map(
				([questionId, answer]) => [questionId, serializeAnswer(answer)] as const
			)
			.filter(([, answer]) =>
				state.mode === "elaborate"
					? isResultAnswerCommitted(answer)
					: !isResultAnswerEmpty(answer)
			)
	);
	const unanswered = state.questions
		.filter((question) => !isResultAnswerCommitted(answers[question.id] ?? emptyResultAnswer()))
		.map((question) => question.id);

	return {
		title: state.title,
		status: status ?? resultStatusFromState(state),
		questions: state.questions.map((question) => ({
			id: question.id,
			label: question.label,
			prompt: question.prompt,
			type: question.requestedType ?? question.type,
			...(question.presentedType &&
			question.presentedType !== question.requestedType
				? { presentedType: question.presentedType }
				: {}),
		})),
		answers,
		unanswered,
		elaboration:
			state.mode === "elaborate" ? serializeElaboration(state, answers) : undefined,
	};
}

export function summarizeResult(result: AskResult): string {
	if (result.status === "cancelled") {
		return CANCELLED_SUMMARY;
	}
	if (result.status === "unavailable") {
		return "Needs user input";
	}
	if (result.status === "invalid") {
		return "Invalid tool payload";
	}
	if (result.status === "elaborated") {
		const lines = formatElaborationLines(result, { mode: "summary" });
		return lines.join("\n") || ELABORATED_SUMMARY;
	}

	const lines = formatResultLines(result, { mode: "summary" });
	return lines.join("\n") || SUBMITTED_SUMMARY;
}

export function hasAnswerContent(state: AskState, questionId: string): boolean {
	const answer = state.answers[questionId];
	return !!answer && !isAnswerEmpty(answer);
}

function resultStatusFromState(state: AskState): AskResultStatus {
	if (state.cancelled) {
		return "cancelled";
	}
	return state.mode === "elaborate" ? "elaborated" : "submitted";
}

function emptyResultAnswer(): AskResultAnswer {
	return { values: [], labels: [] };
}

function serializeElaboration(
	state: AskState,
	answers: AskResult["answers"]
): AskElaborationPayload {
	const explain = state.questions.flatMap((question) =>
		serializeElaborationItemsForQuestion(question, state.answers[question.id])
	);
	const keep = Object.fromEntries(
		state.questions
			.filter((question) => !hasAnswerNotes(state.answers[question.id]))
			.flatMap((question) => {
				const answer = answers[question.id];
				return answer ? [[question.id, cloneResultAnswer(answer)] as const] : [];
			})
	);

	return {
		instruction: ELABORATION_INSTRUCTION,
		explain,
		keep,
	};
}

function serializeElaborationItemsForQuestion(
	question: AskState["questions"][number],
	answer: AskStateAnswer | undefined
): AskElaborationPayload["explain"] {
	if (!(answer && hasAnswerNotes(answer))) {
		return [];
	}

	const items: AskElaborationPayload["explain"] = [];

	if (answer.note) {
		items.push({
			questionId: question.id,
			prompt: question.prompt,
			note: answer.note,
		});
	}

	for (const [value, note] of Object.entries(answer.optionNotes ?? {})) {
		const option = getQuestionOptionByValue(question, value);
		if (!(option && note)) {
			continue;
		}
		items.push({
			questionId: question.id,
			prompt: question.prompt,
			optionValue: value,
			optionLabel: option.label,
			note,
		});
	}

	return items;
}

export function toReviewAnswer(
	question: AskState["questions"][number],
	answer: AskStateAnswer | undefined,
	showAllNotes: boolean
): ReviewAnswer | undefined {
	if (!answer) {
		return;
	}

	const serialized = serializeAnswer(answer);
	const hasCommittedAnswer = isResultAnswerCommitted(serialized);
	if (!showAllNotes) {
		return hasCommittedAnswer ? serialized : undefined;
	}

	const extraOptionNotes = getExtraOptionNotes({
		answer,
		questionOptions: question.options,
		selectedValues: serialized.values,
	});
	if (
		!(hasCommittedAnswer || serialized.note) &&
		extraOptionNotes.length === 0
	) {
		return;
	}

	return {
		...serialized,
		extraOptionNotes:
			extraOptionNotes.length > 0 ? extraOptionNotes : undefined,
	};
}

export function shouldRenderAnswersIndividually(answer: ReviewAnswer): boolean {
	if (!answer.labels.length) {
		return false;
	}

	return (
		answer.labels.length > 1 ||
		Boolean(answer.optionNotes && Object.keys(answer.optionNotes).length > 0)
	);
}
