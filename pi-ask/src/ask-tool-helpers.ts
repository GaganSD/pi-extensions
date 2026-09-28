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
	"Ask the user to resolve material requirement, preference, or authorization gaps after context review, or conduct explicitly requested interviews. Supports single, multi, and text questions.";

export const ASK_TOOL_PROMPT_GUIDELINES = [
	"Use `ask_user` only for critical requirements, outcome-changing preferences, or missing authorization for consequential/hard-to-reverse actions still unresolved by relevant context; also for explicitly requested interviews, requirements gathering, or interactive questions.",
	"Before `ask_user`, resolve facts from available evidence. Do not reconfirm settled choices or authorization, or ask merely because alternatives exist. Complete clear comparisons/research directly; proceed with authorized routine work and delegated choices, stating useful assumptions.",
	"In `ask_user`, ask one decision per question and only current blockers or the requested interview topic; bundle independent questions. Answer elaborations first, preserve prior answers, and reopen decisions only for materially new information. Cancellation, missing or ambiguous answers are not high-risk approval; keep that action blocked and continue independent authorized work.",
	"For `ask_user`, use stable unique question `id`s and non-empty `prompt`s. Use `single` for one answer, `multi` for several, and `text` when the user should type freely. `text` questions have no options. `single`/`multi` need real distinct options with non-empty `value` and `label`; do not invent filler. Explain grounded `recommended: true` choices in `description`; recommendations are not preselected.",
	"Neither submission nor non-cancellation proves approval. Unanswered questions stay unanswered. Typed custom text is never a canonical option value.",
] as const;

interface ValidateParamsOptions {
	allowFreeform?: boolean;
}

export function validateParams(
	params: AskParams,
	options: ValidateParamsOptions = {}
):
	| { ok: true; state: ReturnType<typeof createInitialState> }
	| { ok: false; issues: AskValidationIssue[] } {
	const issues = collectValidationIssues(params, options);
	if (issues.length > 0) {
		return { ok: false, issues };
	}

	return {
		ok: true,
		state: createInitialState(params, options),
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
