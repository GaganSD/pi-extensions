import assert from "node:assert/strict";
import test from "node:test";
import { findLatestPayloadInCurrentBranch } from "../src/ask-payload-store.ts";
import type { AskParams } from "../src/types.ts";

const params: AskParams = {
	questions: [
		{
			id: "goal",
			prompt: "Goal?",
			options: [{ value: "a", label: "A", recommended: true }],
		},
	],
};

function custom(data: unknown) {
	return { type: "custom", customType: "ask:payload", data };
}

function ctx(branch: unknown[]) {
	return { sessionManager: { getBranch: () => branch } } as never;
}

test("branch payload lookup returns the latest valid matching source", () => {
	const older = {
		version: 1,
		source: "tool",
		params,
		timestamp: 1,
	};
	const newer = {
		version: 1,
		source: "tool",
		params: { ...params, title: "Newer" },
		timestamp: 2,
	};

	const result = findLatestPayloadInCurrentBranch(
		ctx([custom(older), custom(newer)]),
		"tool"
	);

	assert.equal(result.data, newer);
	assert.equal(result.invalidMatchFound, false);
});

test("branch payload lookup accepts text questions for tool and /answer payloads", () => {
	const textParams: AskParams = {
		questions: [
			{
				id: "language",
				prompt: "Which language?",
				type: "text",
			},
		],
	};

	const answerPayload = {
		version: 1,
		source: "answer-extraction",
		params: textParams,
		timestamp: 1,
	};
	const toolPayload = {
		version: 1,
		source: "tool",
		params: textParams,
		timestamp: 2,
	};

	assert.equal(
		findLatestPayloadInCurrentBranch(
			ctx([custom(answerPayload)]),
			"answer-extraction"
		).data,
		answerPayload
	);
	assert.equal(
		findLatestPayloadInCurrentBranch(ctx([custom(toolPayload)]), "tool").data,
		toolPayload
	);
});

test("branch payload lookup ignores invalid stored payloads", () => {
	const result = findLatestPayloadInCurrentBranch(
		ctx([
			custom({ version: 1, source: "tool", params: { questions: [] } }),
			custom({ version: 1, source: "tool", params: {} }),
			custom({ version: 1, source: "answer-extraction", params }),
		]),
		"tool"
	);

	assert.equal(result.data, undefined);
	assert.equal(result.invalidMatchFound, true);
});
