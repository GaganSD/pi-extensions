export type AskQuestionType = "single" | "multi" | "text";

export interface AskOption {
	description?: string;
	label: string;
	recommended?: boolean;
	value: string;
}

export interface AskQuestionInput {
	id: string;
	label?: string;
	options?: AskOption[];
	prompt: string;
	type?: AskQuestionType;
}

export interface AskParams {
	questions: AskQuestionInput[];
	title?: string;
}

export interface AskValidationIssue {
	message: string;
	path: string;
}

export interface AskValidationError {
	issues: AskValidationIssue[];
	kind: "invalid_input";
}

export interface AskQuestion
	extends Omit<AskQuestionInput, "type" | "label" | "options"> {
	label: string;
	options: AskOption[];
	presentedType?: AskQuestionType;
	requestedType?: AskQuestionType;
	type: AskQuestionType;
}

export interface AskSelectedOption {
	index: number;
	label: string;
	value: string;
}

export interface AskStateAnswer {
	customSelected?: boolean;
	customText?: string;
	note?: string;
	optionNotes?: Record<string, string>;
	selected: AskSelectedOption[];
}

export interface AskResultAnswer {
	customText?: string;
	labels: string[];
	note?: string;
	optionNotes?: Record<string, string>;
	values: string[];
}

export interface AskQuestionSummary {
	id: string;
	label: string;
	presentedType?: AskQuestionType;
	prompt: string;
	type: AskQuestionType;
}

export type AskResultStatus =
	| "submitted"
	| "cancelled"
	| "unavailable"
	| "invalid";

export interface AskResult {
	answers: Record<string, AskResultAnswer>;
	error?: AskValidationError;
	questions: AskQuestionSummary[];
	status: AskResultStatus;
	title?: string;
	unanswered: string[];
}

export type ViewState =
	| { kind: "navigate" }
	| { kind: "submit" }
	| { kind: "input"; questionId: string }
	| { kind: "note"; questionId: string; optionValue?: string };

export interface AskState {
	activeOptionIndex: number;
	activeSubmitActionIndex: number;
	activeTabIndex: number;
	answers: Record<string, AskStateAnswer>;
	cancelled: boolean;
	completed: boolean;
	questions: AskQuestion[];
	title?: string;
	view: ViewState;
}

export interface AskDisplayOption extends AskOption {
	isCustomOption?: boolean;
	isFreeformOnlyOption?: boolean;
}
