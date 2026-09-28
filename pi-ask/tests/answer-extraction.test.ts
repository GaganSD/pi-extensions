import assert from "node:assert/strict";
import test from "node:test";
import {
	collectExtractionBusinessIssues,
	createExtractionContext,
	extractionCandidateFromContent,
	parseExtractionCandidate,
	selectExtractionModel,
} from "../src/answer-extraction.ts";

function model(provider: string, id: string) {
	return { provider, id } as never;
}

test("selectExtractionModel uses first configured model with auth", async () => {
	const first = model("missing", "a");
	const second = model("ok", "b");
	const result = await selectExtractionModel(
		{
			model: model("fallback", "c"),
			scopedModels: [],
			modelRegistry: {
				find(provider: string, _id: string) {
					if (provider === "missing") {
						return first;
					}
					if (provider === "ok") {
						return second;
					}
				},
				getApiKeyAndHeaders(candidate: { provider: string }) {
					if (candidate.provider === "ok") {
						return Promise.resolve({ ok: true, apiKey: "key" });
					}
					return Promise.resolve({ ok: false, error: "no" });
				},
			},
		} as never,
		[
			{ provider: "missing", id: "a" },
			{ provider: "ok", id: "b" },
		]
	);

	assert.deepEqual(result, {
		model: second,
		usedFallback: false,
	});
});

test("selectExtractionModel respects the current session model scope", async () => {
	const configured = model("configured", "a");
	const fallback = model("fallback", "b");
	const result = await selectExtractionModel(
		{
			model: fallback,
			scopedModels: [{ model: fallback }],
			modelRegistry: {
				find() {
					return configured;
				},
				getApiKeyAndHeaders() {
					return Promise.resolve({ ok: true, apiKey: "key" });
				},
			},
		} as never,
		[{ provider: "configured", id: "a" }]
	);

	assert.deepEqual(result, { model: fallback, usedFallback: true });
});

test("selectExtractionModel rejects a fallback outside the current session scope", async () => {
	const fallback = model("fallback", "a");
	const result = await selectExtractionModel(
		{
			model: fallback,
			scopedModels: [{ model: model("allowed", "b") }],
			modelRegistry: {
				find() {
					return;
				},
			},
		} as never,
		[]
	);

	assert.deepEqual(result, {
		error: "No available extraction model in the current session model scope.",
	});
});

test("extraction does not flag or truncate extra offered options", () => {
	const params = {
		questions: [
			{
				id: "q",
				prompt: "Pick one",
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
	assert.deepEqual(
		params.questions[0]?.options?.map((option) => option.value),
		["a", "b", "c", "d", "e"]
	);
});

test("extraction flags generic prompts but does not drop questions", () => {
	const params = {
		questions: [
			{
				id: "generic",
				prompt: "How can I help you today?",
				options: [{ value: "help", label: "Help me" }],
			},
			{
				id: "platform",
				prompt: "Could you clarify which platform: Mac or Linux?",
				options: [
					{ value: "mac", label: "Mac" },
					{ value: "linux", label: "Linux" },
				],
			},
		],
	};

	assert.ok(collectExtractionBusinessIssues(params).length > 0);
	assert.deepEqual(
		params.questions.map((question) => question.id),
		["generic", "platform"]
	);
});

test("extraction context includes the ask_user tool and preceding turn", () => {
	const context = createExtractionContext({
		assistantText: "Which direction: A or B?",
		attempt: 0,
		lastError: "",
		lastResponse: "",
		previousUserText: "Choose an implementation direction.",
	});

	assert.equal(context.tools?.[0]?.name, "ask_user");
	assert.equal(context.tools?.length, 1);
	assert.equal(
		(context.systemPrompt ?? "").includes("Never add recommendation metadata."),
		true
	);
	const prompt = JSON.stringify(context.messages[0]?.content);
	assert.equal(prompt.includes("Choose an implementation direction."), true);
	assert.equal(prompt.includes("Which direction: A or B?"), true);
});

test("tool-call arguments become the extraction candidate", () => {
	const candidate = extractionCandidateFromContent([
		{ type: "thinking", thinking: "ignored" },
		{
			type: "toolCall",
			id: "call-1",
			name: "ask_user",
			arguments: {
				title: "Direction",
				questions: [
					{
						id: "direction",
						prompt: "Which direction?",
						options: [{ value: "a", label: "A" }],
					},
				],
			},
		},
	] as never);
	const result = parseExtractionCandidate(candidate);

	assert.equal(result.ok, true);
	if (result.ok) {
		assert.equal(result.params.title, "Direction");
	}
});

test("tool-call arguments take precedence over text", () => {
	const candidate = extractionCandidateFromContent([
		{ type: "text", text: "not JSON" },
		{
			type: "toolCall",
			id: "call-1",
			name: "ask_user",
			arguments: { questions: [] },
		},
	] as never);

	assert.equal(parseExtractionCandidate(candidate).ok, true);
});

test("multiple tool calls are rejected", () => {
	const candidate = extractionCandidateFromContent([
		{
			type: "toolCall",
			id: "call-1",
			name: "ask_user",
			arguments: { questions: [] },
		},
		{
			type: "toolCall",
			id: "call-2",
			name: "ask_user",
			arguments: { questions: [] },
		},
	] as never);

	assert.equal(parseExtractionCandidate(candidate).ok, false);
});

test("fenced text remains a fallback", () => {
	const result = parseExtractionCandidate('```json\n{"questions":[]}\n```');
	assert.equal(result.ok, true);
});

test("text questions parse without options", () => {
	const result = parseExtractionCandidate(
		JSON.stringify({
			questions: [{ id: "dir", prompt: "Which directory?", type: "text" }],
		})
	);
	assert.equal(result.ok, true);
	if (result.ok) {
		assert.equal(result.params.questions[0]?.type, "text");
		assert.deepEqual(result.issues, []);
	}
});

test("extraction rejects invented recommendation metadata", () => {
	const result = parseExtractionCandidate(
		JSON.stringify({
			questions: [
				{
					id: "scope",
					prompt: "Pick scope",
					options: [
						{
							value: "small",
							label: "Small",
							recommended: true,
						},
					],
				},
			],
		})
	);
	assert.equal(result.ok, true);
	if (result.ok) {
		assert.ok(
			result.issues.some((issue) => issue.includes("recommended"))
		);
	}
});
