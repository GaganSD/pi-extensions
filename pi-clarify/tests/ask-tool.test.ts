import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Value } from "typebox/value";
import { registerAskTool } from "../src/ask-tool.ts";
import { AskOptionSchema, AskParamsSchema } from "../src/schema.ts";

const NON_INTERACTIVE_MESSAGE_RE =
	/Needs user input: clarify requires interactive TUI mode\./;
const FIRST_QUESTION_RE = /1\. Goal: What should I optimize for\?/;
const SPEED_OPTION_RE = /- Speed \[speed\]/;
const CUSTOM_OPTION_RE = /- Type your own \[custom\]/;
const DUPLICATE_ID_RE =
	/questions\[1\]\.id: Question 2: duplicate question id "scope"/;
const MISSING_OPTION_VALUE_RE =
	/questions\[0\]\.options\[0\]\.value: Question 1, option 1: value is required/;
const EMPTY_QUESTIONS_RE = /questions: At least one question is required/;
const INVALID_TYPE_RE =
	/questions\[0\]\.type: Question 1: invalid type "grid"; expected "single", "multi", or "text"/;

function registerMockTool() {
	const tools: Record<string, unknown>[] = [];
	const entries: Array<{ customType: string; data: unknown }> = [];
	registerAskTool({
		appendEntry(customType: string, data: unknown) {
			entries.push({ customType, data });
		},
		registerTool(tool: unknown) {
			tools.push(tool as Record<string, unknown>);
		},
	} as never);
	return {
		entries,
		tool: tools[0] as {
			description: string;
			execute: (...args: any[]) => Promise<any>;
			name: string;
			parameters: Record<string, any>;
			prepareArguments: (args: unknown) => unknown;
			promptSnippet: string;
			promptGuidelines: string[];
			renderCall: (args: unknown, theme: any) => { text: string };
			renderResult: (
				result: any,
				options: unknown,
				theme: any
			) => { text: string };
		},
	};
}

test("registered ask prompts require material gaps after context review (static)", () => {
	const { tool } = registerMockTool();
	const guidelines = tool.promptGuidelines.join("\n");

	for (const text of [tool.description, tool.promptSnippet, guidelines]) {
		for (const concept of [
			"context",
			"requirement",
			"preference",
			"authorization",
			"explicitly requested interviews",
		]) {
			assert.ok(text.includes(concept), `Missing prompt concept: ${concept}`);
		}
	}
	assert.ok(tool.promptGuidelines.every((text) => text.includes("`clarify`") || text.includes("Typed custom text") || text.includes("Neither submission")));
	assert.equal(tool.name, "clarify");
});

test("registered prompts and bundled skill omit blanket interview triggers (static)", async () => {
	const { tool } = registerMockTool();
	const skill = await readFile(
		new URL("../skills/clarify/SKILL.md", import.meta.url),
		"utf-8"
	);

	for (const text of [
		tool.description,
		tool.promptSnippet,
		...tool.promptGuidelines,
		skill,
	]) {
		for (const obsoleteRule of [
			"choosing between multiple valid directions",
			"When multiple valid directions exist, call `ask_user`",
			"Use `ask_user` before making preference-sensitive decisions about",
			"## Handshake (required)",
		]) {
			assert.ok(
				!text.includes(obsoleteRule),
				`Obsolete blanket trigger: ${obsoleteRule}`
			);
		}
	}
	assert.ok(
		skill.includes("Check relevant context and existing authorization")
	);
	assert.ok(skill.includes("do not reconfirm settled decisions"));
	assert.ok(skill.includes("not a runtime authorization mechanism"));
});

test("prompt layers stay compact and route to shipped references (static)", async () => {
	const { tool } = registerMockTool();
	const skillUrl = new URL("../skills/clarify/SKILL.md", import.meta.url);
	const skill = await readFile(skillUrl, "utf-8");
	assert.ok(tool.description.length <= 400);
	assert.ok(tool.promptGuidelines.join("\n").length <= 2200);
	assert.ok(skill.length <= 2800);
	for (const path of [
		"references/interaction.md",
		"references/decision-cases.md",
		"../../docs/contract.md",
		"../../docs/configuration.md",
	]) {
		assert.ok(skill.includes(`(${path})`), `Missing route: ${path}`);
		assert.ok((await readFile(new URL(path, skillUrl), "utf-8")).length > 0);
	}
});

test("ask option schema and tool guidance support grounded recommendations", () => {
	const { tool } = registerMockTool();

	assert.equal(
		Value.Check(AskOptionSchema, {
			value: "small",
			label: "Small",
			description: "Lowest implementation risk",
			recommended: true,
		}),
		true
	);
	assert(
		tool.promptGuidelines.some(
			(guideline) =>
				guideline.includes("grounded `recommended: true`") &&
				guideline.includes("description")
		)
	);
});

test("ask params schema constrains question types", () => {
	assert.equal(
		Value.Check(AskParamsSchema, {
			questions: [
				{
					id: "layout",
					prompt: "Choose a layout",
					type: "grid",
					options: [{ value: "compact", label: "Compact" }],
				},
			],
		}),
		false
	);
	assert.equal(
		Value.Check(AskParamsSchema, {
			questions: [
				{
					id: "dir",
					prompt: "Which directory?",
					type: "text",
				},
			],
		}),
		true
	);
});

test("public schema requires semantic identifiers and labels", () => {
	assert.equal(
		Value.Check(AskOptionSchema, { value: "fast", label: "Fast" }),
		true
	);
	assert.equal(Value.Check(AskOptionSchema, { value: "fast" }), false);
});

test("ask tool returns pending questions in non-interactive mode", async () => {
	const { tool, entries } = registerMockTool();
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
		{ mode: "json" }
	);
	assert.match(response.content[0].text, NON_INTERACTIVE_MESSAGE_RE);
	assert.match(response.content[0].text, FIRST_QUESTION_RE);
	assert.match(response.content[0].text, SPEED_OPTION_RE);
	assert.match(response.content[0].text, CUSTOM_OPTION_RE);
	assert.equal(response.details.status, "unavailable");
	assert.equal(entries[0]?.customType, "clarify:payload");
});

test("ask tool rejects invalid payloads before UI opens with structured issues", async () => {
	const { tool } = registerMockTool();
	const response = await tool.execute(
		"call-1",
		{
			questions: [
				{
					id: "scope",
					prompt: "Scope?",
					options: [{ value: "small", label: "Small" }],
				},
				{
					id: "scope",
					prompt: "Again?",
					options: [{ value: "large", label: "Large" }],
				},
			],
		},
		undefined,
		() => {},
		{ mode: "tui", ui: { custom() {}, setWorkingVisible() {} } }
	);
	assert.match(response.content[0].text, DUPLICATE_ID_RE);
	assert.equal(response.details.status, "invalid");
});

test("ask tool reports missing option values with structured issues", async () => {
	const { tool } = registerMockTool();
	const response = await tool.execute(
		"call-1",
		{
			questions: [
				{
					id: "goal",
					prompt: "Goal?",
					options: [{ label: "Speed" }],
				},
			],
		},
		undefined,
		() => {},
		{ mode: "tui", ui: { custom() {}, setWorkingVisible() {} } }
	);
	assert.match(response.content[0].text, MISSING_OPTION_VALUE_RE);
});

test("ask tool reports empty questions with structured issues", async () => {
	const { tool } = registerMockTool();
	const response = await tool.execute(
		"call-1",
		{ questions: [] },
		undefined,
		() => {},
		{ mode: "tui", ui: { custom() {}, setWorkingVisible() {} } }
	);
	assert.match(response.content[0].text, EMPTY_QUESTIONS_RE);
});

test("ask tool reports invalid question types with structured issues", async () => {
	const { tool } = registerMockTool();
	const response = await tool.execute(
		"call-1",
		{
			questions: [
				{
					id: "goal",
					prompt: "Goal?",
					type: "grid",
					options: [{ value: "speed", label: "Speed" }],
				},
			],
		},
		undefined,
		() => {},
		{ mode: "tui", ui: { custom() {}, setWorkingVisible() {} } }
	);
	assert.match(response.content[0].text, INVALID_TYPE_RE);
});

test("prepareArguments fills missing option labels from values", () => {
	const { tool } = registerMockTool();
	const prepared = tool.prepareArguments({
		questions: [
			{
				id: "goal",
				prompt: "Goal?",
				options: [{ value: "ship_it" }],
			},
		],
	}) as { questions: Array<{ options: Array<{ label: string }> }> };
	assert.equal(prepared.questions[0]?.options[0]?.label, "Ship it");
});
