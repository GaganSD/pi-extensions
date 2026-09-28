import { CANCELLED_SUMMARY, SUBMITTED_SUMMARY } from "../constants/text.ts";
import { formatResultLines } from "../result-format.ts";
import type {
	AskResult,
	AskResultAnswer,
	AskResultStatus,
	AskState,
	AskStateAnswer,
} from "../types.ts";
import {
	getExtraOptionNotes,
	isAnswerEmpty,
	isResultAnswerCommitted,
	isResultAnswerEmpty,
	serializeAnswer,
} from "./answers.ts";

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
			.filter(([, answer]) => !isResultAnswerEmpty(answer))
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

	const lines = formatResultLines(result, { mode: "summary" });
	return lines.join("\n") || SUBMITTED_SUMMARY;
}

export function hasAnswerContent(state: AskState, questionId: string): boolean {
	const answer = state.answers[questionId];
	return !!answer && !isAnswerEmpty(answer);
}

function resultStatusFromState(state: AskState): AskResultStatus {
	return state.cancelled ? "cancelled" : "submitted";
}

function emptyResultAnswer(): AskResultAnswer {
	return { values: [], labels: [] };
}

export function toReviewAnswer(
	question: AskState["questions"][number],
	answer: AskStateAnswer | undefined
): ReviewAnswer | undefined {
	if (!answer) {
		return;
	}

	const serialized = serializeAnswer(answer);
	const hasCommittedAnswer = isResultAnswerCommitted(serialized);

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
