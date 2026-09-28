import assert from "node:assert/strict";
import test from "node:test";
import { Value } from "typebox/value";
import { registerAnswerCommands } from "../src/answer-commands.ts";
import { collectExtractionBusinessIssues } from "../src/answer-extraction.ts";
import { registerAskSettingsCommand } from "../src/ask-settings-command.ts";
import { registerAskTool } from "../src/ask-tool.ts";
import { DEFAULT_ASK_CONFIG } from "../src/config/defaults.ts";
import { getAskConfigPath } from "../src/config/store.ts";
import { AskParamsSchema } from "../src/schema.ts";
import { serializeAnswer } from "../src/state/answers.ts";
import { createInitialState } from "../src/state/create.ts";
import { collectValidationIssues } from "../src/state/normalize.ts";
import { cycleCurrentQuestionType } from "../src/state/question-type.ts";
import { toAskResult } from "../src/state/result.ts";
import {
	confirmCurrentSelection,
	toggleCurrentMultiOption,
} from "../src/state/transitions.ts";
import type { AskParams } from "../src/types.ts";

function registerMockTool() {
	const tools: Record<string, unknown>[] = [];
	registerAskTool({
		appendEntry() {},
		registerTool(tool: unknown) {
			tools.push(tool as Record<string, unknown>);
		},
	} as never);
	return tools[0] as {
		name: string;
		parameters: unknown;
		promptGuidelines: string[];
		execute: (...args: any[]) => Promise<any>;
	};
}

test("registers ask_user", () => {
	const tool = registerMockTool();
	assert.equal(tool.name, "ask_user");
	assert.equal(Value.Check(AskParamsSchema, { questions: [] }), true);
});

test("schema accepts text questions and rejects preview and required", () => {
	assert.equal(
		Value.Check(AskParamsSchema, {
			questions: [{ id: "dir", prompt: "Which directory?", type: "text" }],
		}),
		true
	);
	assert.equal(
		collectValidationIssues({
			questions: [{ id: "dir", prompt: "Which directory?", type: "text" }],
		}).length,
		0
	);
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
		}).some((issue) => issue.message.includes("text questions have no options"))
	);
	assert.ok(
		collectValidationIssues({
			questions: [
				{
					id: "choice",
					prompt: "Pick one",
					type: "preview",
					options: [{ value: "a", label: "A" }],
				} as unknown as AskParams["questions"][number],
			],
		}).some((issue) => issue.message.includes("invalid type"))
	);
	assert.ok(
		collectValidationIssues({
			questions: [{ id: "choice", prompt: "Pick one", type: "single" }],
		}).some((issue) => issue.message.includes("at least one option"))
	);
});

test("typed text is not merged into option values", () => {
	const answer = serializeAnswer({
		selected: [{ index: 1, label: "Vue", value: "vue" }],
		customSelected: true,
		customText: "SolidStart",
	});
	assert.deepEqual(answer.values, ["vue"]);
	assert.deepEqual(answer.labels, ["Vue"]);
	assert.equal(answer.customText, "SolidStart");
	assert.equal("indices" in answer, false);
});

test("result uses honest status and unanswered ids", () => {
	const state = createInitialState({
		title: "Scope",
		questions: [
			{
				id: "goal",
				prompt: "Goal?",
				options: [
					{ value: "speed", label: "Speed" },
					{ value: "clarity", label: "Clarity" },
				],
			},
			{ id: "notes", prompt: "Anything else?", type: "text" },
		],
	});
	const selected = confirmCurrentSelection(state);
	const result = toAskResult(selected);
	assert.equal(result.status, "submitted");
	assert.deepEqual(result.answers.goal.values, ["speed"]);
	assert.deepEqual(result.unanswered, ["notes"]);
	assert.equal(result.answers.notes, undefined);
});

test("non-TUI tool execution returns unavailable", async () => {
	const tool = registerMockTool();
	const response = await tool.execute(
		"call-1",
		{
			questions: [
				{
					id: "goal",
					label: "Goal",
					prompt: "What should I optimize for?",
					options: [{ value: "speed", label: "Speed" }],
				},
			],
		},
		undefined,
		() => {},
		{ mode: "rpc", hasUI: false }
	);
	assert.equal(response.details.status, "unavailable");
	assert.match(response.content[0].text, /Needs user input: ask_user requires interactive TUI mode/);
	assert.deepEqual(response.details.unanswered, ["goal"]);
});

test("invalid payloads return status invalid", async () => {
	const tool = registerMockTool();
	const response = await tool.execute(
		"call-1",
		{ questions: [] },
		undefined,
		() => {},
		{ mode: "tui" }
	);
	assert.equal(response.details.status, "invalid");
	assert.match(response.content[0].text, /Invalid ask_user payload/);
});

test("live type change is single to multi with confirm when dropping selections", () => {
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
	state = {
		...state,
		activeOptionIndex: 1,
	};
	state = toggleCurrentMultiOption(state);
	const pending = cycleCurrentQuestionType(state);
	assert.equal(pending.needsConfirmation, true);
	const confirmed = cycleCurrentQuestionType(state, { confirmed: true });
	assert.equal(confirmed.state.questions[0]?.type, "single");
	assert.equal(confirmed.state.answers.stack, undefined);
});

test("/answer extraction keeps every offered option", () => {
	const params: AskParams = {
		questions: [
			{
				id: "stack",
				prompt: "Which stack?",
				options: [
					{ value: "a", label: "A" },
					{ value: "b", label: "B" },
					{ value: "c", label: "C" },
					{ value: "d", label: "D" },
					{ value: "e", label: "E" },
				],
			},
		],
	};
	assert.deepEqual(collectExtractionBusinessIssues(params), []);
	assert.equal(params.questions[0]?.options?.length, 5);
});

test("commands and config path are first-party", () => {
	const commands = new Set<string>();
	registerAnswerCommands({
		registerCommand(name: string) {
			commands.add(name);
		},
	} as never);
	registerAskSettingsCommand({
		registerCommand(name: string) {
			commands.add(name);
		},
	} as never);
	assert.deepEqual(
		[...commands].sort(),
		["answer", "answer:again", "ask-settings", "ask:replay"]
	);
	assert.match(getAskConfigPath(), /pi-ask\.json$/);
	assert.deepEqual(DEFAULT_ASK_CONFIG.answer.extractionModels, [
		{ provider: "openai", id: "gpt-5.6-luna" },
		{ provider: "openai", id: "gpt-5.6-sol" },
		{ provider: "bedrock", id: "xai.grok-4.6" },
	]);
	assert.equal(DEFAULT_ASK_CONFIG.behaviour.autoSubmitWhenAnsweredWithoutNotes, false);
	assert.equal(DEFAULT_ASK_CONFIG.behaviour.confirmDismissWhenDirty, true);
	assert.equal(DEFAULT_ASK_CONFIG.behaviour.doublePressReviewShortcuts, true);
	assert.deepEqual(DEFAULT_ASK_CONFIG.keymaps.main.changeQuestionType, ["t"]);
});
