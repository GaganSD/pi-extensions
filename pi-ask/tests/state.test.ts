import assert from "node:assert/strict";
import test from "node:test";
import { createInitialState } from "../src/state/create.ts";
import { collectValidationIssues } from "../src/state/normalize.ts";
import { cycleCurrentQuestionType } from "../src/state/question-type.ts";
import { toAskResult } from "../src/state/result.ts";
import { getRenderableOptions } from "../src/state/selectors.ts";
import {
	confirmCurrentSelection,
	enterQuestionNoteMode,
	saveCustomAnswer,
	saveNote,
	toggleCurrentMultiOption,
} from "../src/state/transitions.ts";

test("normalize defaults via initial state", () => {
	const state = createInitialState({
		questions: [
			{
				id: " goal ",
				prompt: " Goal? ",
				options: [{ value: " speed ", label: " Speed " }],
			},
		],
	});
	assert.equal(state.questions[0]?.id, "goal");
	assert.equal(state.questions[0]?.prompt, "Goal?");
	assert.equal(state.questions[0]?.type, "single");
	assert.equal(state.questions[0]?.options[0]?.value, "speed");
	assert.equal("required" in state.questions[0]!, false);
});

test("text questions render a freeform-only input and reject options", () => {
	const state = createInitialState({
		questions: [{ id: "dir", prompt: "Which directory?", type: "text" }],
	});
	const options = getRenderableOptions(state.questions[0]);
	assert.equal(options.length, 1);
	assert.equal(options[0]?.isFreeformOnlyOption, true);
	assert.ok(
		collectValidationIssues({
			questions: [
				{
					id: "dir",
					prompt: "Which directory?",
					type: "text",
					options: [{ value: "fake", label: "Fake" }],
				},
			],
		}).some((issue) => issue.message.includes("no options"))
	);
});

test("question type hotkey toggles single and multi only", () => {
	const state = createInitialState({
		questions: [
			{
				id: "stack",
				prompt: "Stack?",
				type: "single",
				options: [
					{ value: "vue", label: "Vue" },
					{ value: "react", label: "React" },
				],
			},
		],
	});
	const next = cycleCurrentQuestionType(state);
	assert.equal(next.state.questions[0]?.type, "multi");
	assert.equal(cycleCurrentQuestionType(next.state).state.questions[0]?.type, "single");
	const text = createInitialState({
		questions: [{ id: "dir", prompt: "Dir?", type: "text" }],
	});
	assert.equal(cycleCurrentQuestionType(text).state.questions[0]?.type, "text");
});

test("question type hotkey requires confirmation before clearing multi answers", () => {
	let state = createInitialState({
		questions: [
			{
				id: "stack",
				prompt: "Stack?",
				type: "multi",
				options: [
					{ value: "vue", label: "Vue" },
					{ value: "react", label: "React" },
				],
			},
		],
	});
	state = toggleCurrentMultiOption(state);
	state = { ...state, activeOptionIndex: 1 };
	state = toggleCurrentMultiOption(state);
	const pending = cycleCurrentQuestionType(state);
	assert.equal(pending.needsConfirmation, true);
	assert.equal(state.answers.stack?.selected.length, 2);
	const confirmed = cycleCurrentQuestionType(state, { confirmed: true });
	assert.equal(confirmed.state.questions[0]?.type, "single");
	assert.equal(confirmed.state.answers.stack, undefined);
});

test("question note can be saved without selecting an answer and is submitted", () => {
	let state = createInitialState({
		questions: [
			{
				id: "goal",
				prompt: "Goal?",
				options: [{ value: "speed", label: "Speed" }],
			},
		],
	});
	state = enterQuestionNoteMode(state, "goal");
	state = saveNote(state, "Need more context");
	const result = toAskResult(state);
	assert.equal(result.answers.goal?.note, "Need more context");
	assert.deepEqual(result.answers.goal?.values, []);
	assert.deepEqual(result.unanswered, ["goal"]);
});

test("custom text stays out of option values", () => {
	let state = createInitialState({
		questions: [
			{
				id: "stack",
				prompt: "Stack?",
				type: "multi",
				options: [{ value: "vue", label: "Vue" }],
			},
		],
	});
	state = toggleCurrentMultiOption(state);
	state = saveCustomAnswer(
		{ ...state, view: { kind: "input", questionId: "stack" } },
		"SolidStart"
	);
	const result = toAskResult(state);
	assert.deepEqual(result.answers.stack.values, ["vue"]);
	assert.equal(result.answers.stack.customText, "SolidStart");
});

test("single confirm advances after selecting an option", () => {
	const state = confirmCurrentSelection(
		createInitialState({
			questions: [
				{
					id: "goal",
					prompt: "Goal?",
					options: [{ value: "speed", label: "Speed" }],
				},
			],
		})
	);
	assert.equal(state.activeTabIndex, 1);
	assert.deepEqual(toAskResult(state).answers.goal.values, ["speed"]);
});
