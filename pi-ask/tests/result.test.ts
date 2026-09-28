import assert from "node:assert/strict";
import test from "node:test";
import { renderResultText } from "../src/result.ts";
import { formatResultLines } from "../src/result-format.ts";
import { serializeAnswer } from "../src/state/answers.ts";
import { createInitialState } from "../src/state/create.ts";
import { toAskResult } from "../src/state/result.ts";
import {
	confirmCurrentSelection,
	enterQuestionNoteMode,
	saveCustomAnswer,
	saveNote,
	toggleCurrentMultiOption,
} from "../src/state/transitions.ts";

test("submitted results include unanswered questions and omit merged custom text", () => {
	let state = createInitialState({
		questions: [
			{
				id: "stack",
				label: "Stack",
				prompt: "Stack?",
				type: "multi",
				options: [
					{ value: "vue", label: "Vue" },
					{ value: "react", label: "React" },
				],
			},
			{ id: "dir", label: "Dir", prompt: "Which directory?", type: "text" },
		],
	});
	state = toggleCurrentMultiOption(state);
	state = saveCustomAnswer(
		{ ...state, view: { kind: "input", questionId: "stack" } },
		"SolidStart"
	);
	const result = toAskResult(state);
	assert.equal(result.status, "submitted");
	assert.deepEqual(result.answers.stack.values, ["vue"]);
	assert.equal(result.answers.stack.customText, "SolidStart");
	assert.deepEqual(result.unanswered, ["dir"]);
	assert.match(formatResultLines(result, { mode: "summary" }).join("\n"), /SolidStart/);
});

test("submitted results include notes with settled answers", () => {
	let state = createInitialState({
		questions: [
			{
				id: "goal",
				label: "Goal",
				prompt: "Goal?",
				options: [{ value: "speed", label: "Speed" }],
			},
			{
				id: "tone",
				label: "Tone",
				prompt: "Tone?",
				options: [{ value: "quiet", label: "Quiet" }],
			},
		],
	});
	state = confirmCurrentSelection(state);
	state = enterQuestionNoteMode(state, "tone");
	state = saveNote(state, "Why quiet?");
	const result = toAskResult(state);
	assert.equal(result.status, "submitted");
	assert.deepEqual(result.answers.goal.values, ["speed"]);
	assert.equal(result.answers.tone?.note, "Why quiet?");
	assert.deepEqual(result.unanswered, ["tone"]);
});

test("cancelled and invalid render distinctly", () => {
	const cancelled = toAskResult(createInitialState({
		questions: [
			{
				id: "goal",
				label: "Goal",
				prompt: "Goal?",
				options: [{ value: "speed", label: "Speed" }],
			},
		],
	}), "cancelled");
	assert.equal(renderResultText(cancelled), "Cancelled");
	assert.equal(
		renderResultText({
			status: "invalid",
			answers: {},
			questions: [],
			unanswered: [],
			error: { kind: "invalid_input", issues: [] },
		}),
		"Invalid tool payload"
	);
});

test("serializeAnswer never copies custom text into values", () => {
	assert.deepEqual(
		serializeAnswer({
			selected: [],
			customSelected: true,
			customText: "typed",
		}),
		{
			values: [],
			labels: [],
			customText: "typed",
			note: undefined,
			optionNotes: undefined,
		}
	);
});
