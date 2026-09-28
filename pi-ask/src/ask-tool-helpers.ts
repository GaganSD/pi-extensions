import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { UI_DIMENSIONS } from "./constants/ui.ts";
import { renderResultText } from "./result.ts";
import { createInitialState } from "./state/create.ts";
import { collectValidationIssues } from "./state/normalize.ts";
import { summarizeResult, toAskResult } from "./state/result.ts";
import type {
	AskParams,
	AskQuestionInput,
	AskResult,
	AskValidationIssue,
} from "./types.ts";

export const ASK_TOOL_DESCRIPTION =
	"After context review, ask about unresolved material requirement, preference, or authorization gaps, or conduct explicitly requested interviews. Supports single, multi, and text questions.";

export const ASK_TOOL_PROMPT_GUIDELINES = [
	"Use `ask_user` for unresolved critical requirements, outcome-changing preferences, missing authorization for consequential actions, or explicitly requested interviews. Resolve facts from context; do not reconfirm settled choices, ask just because alternatives exist, or defer routine authorized work and comparisons.",
	"In `ask_user`, ask one decision per question; bundle independent blockers. Answer elaboration notes first, keep prior answers, and reopen only when material facts change. Cancellation or ambiguous answers do not authorize risky actions; continue independent work.",
	"For `ask_user`, use unique `id`s and non-empty `prompt`s. Use `single` for one choice, `multi` for several, `text` for free input (no options). Choice questions need distinct non-empty `value` and `label`; no filler. Explain grounded `recommended: true` choices in `description`; never preselect them. Typed custom text is not an option value. Submission alone is not approval; unanswered questions stay unanswered.",
] as const;

export function validateParams(
	params: AskParams
):
	| { ok: true; state: ReturnType<typeof createInitialState> }
	| { ok: false; issues: AskValidationIssue[] } {
	const issues = collectValidationIssues(params);
	if (issues.length > 0) {
		return { ok: false, issues };
	}

	return {
		ok: true,
		state: createInitialState(params),
	};
}

export function invalidPayloadResponse(
	params: AskParams,
	issues: AskValidationIssue[]
) {
	return {
		content: [{ type: "text" as const, text: formatValidationError(issues) }],
		details: errorResultDetails(params, issues),
	};
}

export function nonInteractiveResponse(
	state: ReturnType<typeof createInitialState>
) {
	return {
		content: [
			{ type: "text" as const, text: formatNonInteractiveMessage(state) },
		],
		details: {
			...toAskResult(state, "unavailable"),
		},
	};
}

export function successfulResponse(result: AskResult) {
	return {
		content: [{ type: "text" as const, text: summarizeResult(result) }],
		details: result,
	};
}

type ToolTheme = ExtensionContext["ui"]["theme"];

export function renderAskToolCall(args: unknown, theme: ToolTheme) {
	const params = args as AskParams;
	const labels = Array.isArray(params.questions)
		? params.questions
				.map(
					(question: AskQuestionInput, index) =>
						question.label?.trim() || `Q${index + 1}`
				)
				.join(", ")
		: "";
	let text = theme.fg("toolTitle", theme.bold("ask_user "));
	text += theme.fg("muted", `${params.questions?.length ?? 0} question(s)`);
	if (labels) {
		text += theme.fg(
			"dim",
			` (${truncateToWidth(labels, UI_DIMENSIONS.callLabelTruncateWidth)})`
		);
	}
	return new Text(text, 0, 0);
}

export function renderAskToolResult(
	result: {
		content: Array<{ type?: string; text?: string }>;
		details?: AskResult;
	},
	_options: unknown,
	theme: ToolTheme
) {
	const details = result.details;
	if (!(details && Array.isArray(details.questions))) {
		const text = result.content[0];
		return new Text(text?.type === "text" ? (text.text ?? "") : "", 0, 0);
	}
	const text = renderResultText(details);
	return new Text(
		details.status === "invalid" ||
			details.status === "cancelled" ||
			details.status === "unavailable"
			? theme.fg("warning", text)
			: text,
		0,
		0
	);
}

function errorResultDetails(
	params: AskParams,
	issues: AskValidationIssue[]
): AskResult {
	return {
		title: params.title,
		status: "invalid",
		questions: [],
		answers: {},
		unanswered: [],
		error: {
			kind: "invalid_input",
			issues,
		},
	};
}

function formatValidationError(issues: AskValidationIssue[]): string {
	return [
		"Invalid ask_user payload:",
		...issues.map((issue) => `- ${issue.path}: ${issue.message}`),
	].join("\n");
}

function formatNonInteractiveMessage(
	state: ReturnType<typeof createInitialState>
): string {
	const lines = [
		"Needs user input: ask_user requires interactive TUI mode.",
		"Run the same tool call in interactive TUI mode, or ask the user these questions manually:",
	];

	for (const [index, question] of state.questions.entries()) {
		lines.push(`${index + 1}. ${question.label}: ${question.prompt}`);
		if (question.type === "text") {
			lines.push("   - Type your answer");
			continue;
		}
		for (const option of question.options) {
			lines.push(`   - ${option.label} [${option.value}]`);
		}
		lines.push("   - Type your own [custom]");
	}

	lines.push(
		"details.status is unavailable. details.answers stays empty until the user responds."
	);
	return lines.join("\n");
}
