import {
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { UI_DIMENSIONS, UI_TEXT } from "../constants/ui.ts";
import {
	pushSavedNote,
	pushWrappedText,
	renderEditorBlock,
} from "./render-helpers.ts";
import type { QuestionRenderContext, Theme } from "./render-types.ts";
import {
	buildQuestionScreenModel,
	type OptionDetailModel,
	type OptionRowModel,
} from "./view-models/question.ts";

export function renderQuestionScreen(context: QuestionRenderContext) {
	const { lines, question, theme, width } = context;
	const model = buildQuestionScreenModel(context);

	pushWrappedText(lines, question.prompt, width, theme, "text", " ", " ");
	renderQuestionNote(lines, model.questionNote, context);

	for (const row of model.rows) {
		renderStandardOption(lines, row, context);
	}
}

function renderQuestionNote(
	lines: string[],
	questionNote: ReturnType<typeof buildQuestionScreenModel>["questionNote"],
	context: QuestionRenderContext
) {
	if (!questionNote) {
		lines.push("");
		return;
	}
	if (questionNote.kind === "editor") {
		renderEditorWithIndent({
			lines,
			editor: context.editor,
			width: context.width,
			theme: context.theme,
			indent: " ",
			padding: UI_DIMENSIONS.editorContentPadding,
			placeholder: questionNote.placeholder,
		});
		lines.push("");
		return;
	}
	pushSavedNote({
		lines,
		note: questionNote.text,
		width: context.width,
		theme: context.theme,
		indent: " ",
	});
	lines.push("");
}

function renderStandardOption(
	lines: string[],
	row: OptionRowModel,
	context: QuestionRenderContext
) {
	if (row.isCustom && row.detail?.kind === "editor") {
		renderInteractiveCustomOption(lines, row, context);
		return;
	}

	pushWrappedText(
		lines,
		formatOptionLabel(row),
		context.width,
		context.theme,
		row.color,
		row.pointer,
		" ".repeat(visibleWidth(row.pointer))
	);
	renderOptionSubtitle(
		lines,
		row.description,
		row.recommended,
		context.width,
		context.theme
	);
	renderOptionDetail(lines, row.detail, context, {
		suppressLeadingGap: !!row.description,
	});
}

function renderOptionDetail(
	lines: string[],
	detail: OptionDetailModel | undefined,
	context: QuestionRenderContext,
	options: { indent?: string; suppressLeadingGap?: boolean } = {}
) {
	if (!detail) {
		return;
	}
	const indent = options.indent ?? "     ";
	const padding =
		indent === " "
			? UI_DIMENSIONS.editorContentPadding
			: UI_DIMENSIONS.editorIndentedPadding;
	if (detail.withGap && !options.suppressLeadingGap) {
		lines.push("");
	}
	if (detail.kind === "editor") {
		renderEditorWithIndent({
			lines,
			editor: context.editor,
			width: context.width,
			theme: context.theme,
			indent,
			padding,
			placeholder: detail.placeholder,
		});
		return;
	}
	if (detail.kind === "saved-note") {
		pushSavedNote({
			lines,
			note: detail.text,
			width: context.width,
			theme: context.theme,
			indent,
		});
		return;
	}
	pushWrappedText(
		lines,
		detail.text,
		context.width,
		context.theme,
		"muted",
		indent,
		indent
	);
}

function renderEditorWithIndent(args: {
	lines: string[];
	editor: QuestionRenderContext["editor"];
	width: number;
	theme: Theme;
	indent: string;
	padding: number;
	placeholder: string;
}) {
	const { lines, editor, width, theme, indent, padding, placeholder } = args;
	renderEditorBlock({
		lines,
		editorLines: editor.render(
			Math.max(UI_DIMENSIONS.editorMinWidth, width - padding)
		),
		width,
		theme,
		indent,
		availableWidth: width - visibleWidth(indent),
		placeholder,
		isEmpty: editor.getText().length === 0,
	});
}

function formatOptionLabel(row: OptionRowModel): string {
	return row.isFreeformOnly
		? row.label
		: `${row.index + 1}. ${row.prefix}${row.label}`;
}

function renderInteractiveCustomOption(
	lines: string[],
	row: OptionRowModel,
	context: QuestionRenderContext
) {
	const indent = row.isFreeformOnly ? " " : row.pointer;
	pushWrappedText(
		lines,
		formatOptionLabel(row),
		context.width,
		context.theme,
		row.color,
		indent,
		" ".repeat(visibleWidth(indent))
	);
	renderOptionDetail(lines, row.detail, context, {
		indent: row.isFreeformOnly ? " " : undefined,
	});
}

function renderOptionSubtitle(
	lines: string[],
	description: string | undefined,
	recommended: boolean,
	width: number,
	theme: Theme
) {
	if (!recommended) {
		if (description) {
			pushWrappedText(
				lines,
				description,
				width,
				theme,
				"muted",
				"     ",
				"     "
			);
		}
		return;
	}

	const indent = "     ";
	const text =
		theme.fg("warning", UI_TEXT.recommendedMarker) +
		(description ? theme.fg("muted", ` | ${description}`) : "");
	for (const line of wrapTextWithAnsi(
		text,
		Math.max(1, width - visibleWidth(indent))
	)) {
		lines.push(truncateToWidth(`${indent}${line}`, width));
	}
}
