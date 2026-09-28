import type {
	AskOption,
	AskParams,
	AskQuestion,
	AskQuestionInput,
	AskValidationIssue,
} from "../types.ts";

interface IssueCollector {
	add: (path: string, message: string) => void;
	issues: AskValidationIssue[];
}

interface ValidationOptions {
	allowFreeform?: boolean;
}

export function normalizeQuestions(
	params: AskParams,
	options: ValidationOptions = {}
): AskQuestion[] {
	const issues = collectValidationIssues(params, options);
	if (issues.length > 0) {
		throw new Error(issues[0]?.message ?? "Invalid clarify payload");
	}
	return params.questions.map((question, index) =>
		normalizeQuestion(question, index)
	);
}

export function collectValidationIssues(
	params: AskParams,
	options: ValidationOptions = {}
): AskValidationIssue[] {
	const collector = createIssueCollector();
	validateQuestions(params.questions, collector, options);
	return collector.issues;
}

export function prepareAskParams(input: unknown): unknown {
	if (!(isRecord(input) && Array.isArray(input.questions))) {
		return input;
	}
	return {
		...input,
		questions: input.questions.map((question) => {
			if (!(isRecord(question) && Array.isArray(question.options))) {
				return question;
			}
			return {
				...question,
				options: question.options.map(prepareOption),
			};
		}),
	};
}

function prepareOption(input: unknown): unknown {
	if (!isRecord(input)) {
		return input;
	}
	if (
		input.label !== undefined &&
		!(typeof input.label === "string" && !input.label.trim())
	) {
		return input;
	}
	if (typeof input.value !== "string") {
		return input;
	}
	const words = input.value.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
	if (!words) {
		return input;
	}
	return {
		...input,
		label: words.charAt(0).toUpperCase() + words.slice(1),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeQuestion(
	question: AskQuestionInput,
	index: number
): AskQuestion {
	const type = normalizeQuestionType(question.type);
	return {
		id: question.id.trim(),
		label: question.label?.trim() || `Q${index + 1}`,
		prompt: question.prompt.trim(),
		type,
		options: type === "text" ? [] : (question.options ?? []).map(normalizeOption),
	};
}

function normalizeOption(option: AskOption): AskOption {
	return {
		value: option.value.trim(),
		label: option.label.trim(),
		description: option.description?.trim() || undefined,
		...(option.recommended === undefined
			? {}
			: { recommended: option.recommended }),
	};
}

function validateQuestions(
	questions: AskParams["questions"],
	collector: IssueCollector,
	_options: ValidationOptions
) {
	if (questions.length === 0) {
		collector.add("questions", "At least one question is required");
		return;
	}

	const questionIds = new Set<string>();
	for (const [questionIndex, question] of questions.entries()) {
		validateQuestion(question, questionIndex, questionIds, collector);
	}
}

function validateQuestion(
	question: AskQuestionInput,
	questionIndex: number,
	questionIds: Set<string>,
	collector: IssueCollector
) {
	const questionNumber = questionIndex + 1;
	const questionPath = `questions[${questionIndex}]`;
	const questionId = question.id?.trim();
	const questionType = normalizeQuestionType(question.type);
	const options = question.options ?? [];

	validateQuestionType(
		question.type,
		questionNumber,
		collector,
		`${questionPath}.type`
	);
	assertRequired(
		questionId,
		collector,
		`${questionPath}.id`,
		`Question ${questionNumber}: id is required`
	);
	assertUnique(
		questionIds,
		questionId,
		collector,
		`${questionPath}.id`,
		`Question ${questionNumber}: duplicate question id "${questionId}"`
	);
	assertRequired(
		question.prompt?.trim(),
		collector,
		`${questionPath}.prompt`,
		`Question ${questionNumber}: prompt is required`
	);

	if (questionType === "text") {
		if (options.length > 0) {
			collector.add(
				`${questionPath}.options`,
				`Question ${questionNumber}: text questions have no options`
			);
		}
		return;
	}

	if (options.length === 0) {
		collector.add(
			`${questionPath}.options`,
			`Question ${questionNumber}: at least one option is required`
		);
		return;
	}

	const optionValues = new Set<string>();
	for (const [optionIndex, option] of options.entries()) {
		validateOption(
			option,
			optionIndex,
			optionValues,
			questionNumber,
			collector,
			`${questionPath}.options[${optionIndex}]`
		);
	}
}

function validateOption(
	option: AskOption,
	optionIndex: number,
	optionValues: Set<string>,
	questionNumber: number,
	collector: IssueCollector,
	optionPath: string
) {
	const optionNumber = optionIndex + 1;
	const prefix = `Question ${questionNumber}, option ${optionNumber}`;
	const optionValue = option.value?.trim();

	assertRequired(
		optionValue,
		collector,
		`${optionPath}.value`,
		`${prefix}: value is required`
	);
	assertUnique(
		optionValues,
		optionValue,
		collector,
		`${optionPath}.value`,
		`${prefix}: duplicate option value "${optionValue}"`
	);
	assertRequired(
		option.label?.trim(),
		collector,
		`${optionPath}.label`,
		`${prefix}: label is required`
	);
}

function normalizeQuestionType(
	value: AskQuestionInput["type"]
): AskQuestion["type"] {
	return value === "multi" || value === "text" ? value : "single";
}

function validateQuestionType(
	value: AskQuestionInput["type"],
	questionNumber: number,
	collector: IssueCollector,
	path: string
) {
	if (
		value !== undefined &&
		value !== "single" &&
		value !== "multi" &&
		value !== "text"
	) {
		collector.add(
			path,
			`Question ${questionNumber}: invalid type ${JSON.stringify(value)}; expected "single", "multi", or "text"`
		);
	}
}

function assertRequired(
	value: string | undefined,
	collector: IssueCollector,
	path: string,
	message: string
) {
	if (!value) {
		collector.add(path, message);
	}
}

function assertUnique(
	seen: Set<string>,
	value: string | undefined,
	collector: IssueCollector,
	path: string,
	message: string
) {
	if (!value) {
		return;
	}
	if (seen.has(value)) {
		collector.add(path, message);
		return;
	}
	seen.add(value);
}

function createIssueCollector(): IssueCollector {
	const issues: AskValidationIssue[] = [];
	return {
		issues,
		add(path, message) {
			issues.push({ path, message });
		},
	};
}
