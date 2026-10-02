import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { applyConfig } from "../src/providers/config.ts";
import {
	classifierUnavailableMessage,
	selectPinnedClassifier,
	systemOne,
} from "../src/jev/api.ts";

type Registry = ExtensionContext["modelRegistry"];
const typesafe = { provider: "typesafe", id: "jev-latest" };
const vercel = { provider: "vercel-ai-gateway", id: "typesafe-ai/jev" };
const openrouter = { provider: "openrouter", id: "~typesafe/jev-latest" };
function registry(models: { provider: string; id: string }[], classify?: (args: unknown) => Promise<unknown>): Registry {
	return {
		findOfType: (_type: string, provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id),
		getAvailableOfType: async (_type: string, provider?: string) =>
			provider ? models.filter((model) => model.provider === provider) : models,
		classify: async (_model: unknown, args: unknown) => classify?.(args),
	} as unknown as Registry;
}
const questions = {
	answer: { type: "bool" as const, instructions: "Is the answer present?", criteria: { true: "Yes", false: "No" } },
	risk: { type: "choice" as const, instructions: "What risk?", criteria: { safe: "Safe", phishing: "Phishing" } },
};
const state = { query: "query", candidates: [{ index: 0, title: "A", url: "https://a.example", excerpt: "A" }] };

test("an unpinned or unavailable pair never selects another classifier", async () => {
	assert.equal(await selectPinnedClassifier(registry([typesafe, vercel, openrouter]), undefined, undefined), undefined);
	assert.equal(await selectPinnedClassifier(registry([typesafe, vercel, openrouter]), "", "jev-latest"), undefined);
	assert.equal(await selectPinnedClassifier(registry([typesafe, vercel]), "openrouter", "~typesafe/jev-latest"), undefined);
	assert.equal(await selectPinnedClassifier(registry([openrouter]), "openrouter", "unknown"), undefined);
	const registeredUnavailable = {
		...registry([typesafe, vercel]),
		getAvailableOfType: async () => [vercel],
	} as unknown as Registry;
	assert.equal(await selectPinnedClassifier(registeredUnavailable, "typesafe", "jev-latest"), undefined);
});

test("only the exact pinned provider/model pair runs", async () => {
	const pinned = { provider: "openrouter", id: "typesafe/jev-1.13" };
	assert.equal((await selectPinnedClassifier(registry([pinned]), "openrouter", pinned.id))?.id, pinned.id);
	assert.equal(await selectPinnedClassifier(registry([typesafe, openrouter]), "vercel-ai-gateway", "typesafe-ai/jev"), undefined);
	assert.equal(
		(await selectPinnedClassifier(registry([typesafe, { provider: "openrouter", id: "jev-latest" }]), "typesafe", "jev-latest"))?.provider,
		"typesafe",
	);
});

test("legacy backend configs load unpinned and do not remap models", () => {
	const enabled = applyConfig("/unused", { jev: { enabled: true } });
	assert.equal(enabled.jev.enabled, true);
	assert.equal(enabled.jev.provider, "");
	assert.equal(enabled.jev.model, "");
	assert.match(enabled.notices.join(" "), /unpinned/);
	const legacy = applyConfig("/unused", { jev: { enabled: true, backend: "openrouter", model: "jev-1.13.0" } });
	assert.equal(legacy.jev.provider, "");
	assert.equal(legacy.jev.model, "jev-1.13.0");
	assert.match(legacy.notices.join(" "), /backend/);
	const pinned = applyConfig("/unused", { jev: { enabled: true, provider: "llama.cpp", model: "qwen" } });
	assert.equal(pinned.jev.provider, "llama.cpp");
	assert.equal(pinned.jev.model, "qwen");
	assert.deepEqual(pinned.notices, []);
});

test("Pi receives bool and choice questions in one call", async () => {
	let calls = 0;
	const modelRegistry = registry([typesafe], async (args) => {
		calls++;
		const ctx = args as { questions: Record<string, { type: string }>; state: typeof state };
		assert.equal(ctx.questions.answer.type, "bool");
		assert.equal(ctx.questions.risk.type, "choice");
		assert.deepEqual(ctx.state, state);
		return { stopReason: "stop", answers: {
			answer: { type: "bool", probability: 0.8 },
			risk: { type: "choice", choice: "safe", probabilities: { safe: 0.9 }, confidence: 0.9 },
		} };
	});
	const response = await systemOne(state, questions, {
		modelRegistry, provider: "typesafe", model: "jev-latest",
	});
	assert.equal(calls, 1);
	assert.deepEqual(response.answers.answer, { type: "bool", probability: 0.8 });
	assert.equal(response.answers.risk.type, "choice");
});

test("missing pin fails before catalog work", async () => {
	let calls = 0;
	const modelRegistry = {
		...registry([typesafe]),
		findOfType: () => { calls++; return typesafe; },
		getAvailableOfType: async () => { calls++; return [typesafe]; },
		classify: async () => { calls++; throw new Error("must not classify"); },
	} as unknown as Registry;
	await assert.rejects(systemOne(state, questions, { modelRegistry }), /pin jev.provider/);
	assert.equal(calls, 0);
	assert.match(classifierUnavailableMessage("typesafe", "jev-latest"), /typesafe\/jev-latest/);
});

test("missing or malformed classifier answers never become a policy verdict", async () => {
	for (const answers of [{}, { answer: { type: "bool", probability: Number.NaN } },
		{ answer: { type: "bool", probability: 0.8 }, risk: { type: "choice", choice: "phishing", probabilities: { phishing: Infinity }, confidence: 1 } }]) {
		const modelRegistry = registry([typesafe], async () => ({ stopReason: "stop", answers }));
		await assert.rejects(systemOne(state, questions, {
			modelRegistry, provider: "typesafe", model: "jev-latest",
		}), /malformed answers/);
	}
});

test("pre-aborted judging never starts catalog or classifier work", async () => {
	const controller = new AbortController();
	controller.abort(new Error("cancelled before judging"));
	let calls = 0;
	const modelRegistry = {
		...registry([typesafe]),
		findOfType: () => { calls++; return typesafe; },
		getAvailableOfType: async () => { calls++; return [typesafe]; },
		classify: async () => { calls++; throw new Error("must not classify"); },
	} as unknown as Registry;
	await assert.rejects(systemOne(state, questions, {
		modelRegistry, provider: "typesafe", model: "jev-latest", signal: controller.signal,
	}), /cancelled before judging/);
	assert.equal(calls, 0);
});

test("synchronous cancellation during catalog lookup observes its late rejection", async () => {
	const controller = new AbortController();
	let classifyCalls = 0;
	const failures: unknown[] = [];
	const onUnhandled = (failure: unknown) => failures.push(failure);
	process.on("unhandledRejection", onUnhandled);
	try {
		const modelRegistry = {
			...registry([typesafe]),
			getAvailableOfType: () => {
				controller.abort(new Error("cancelled during availability"));
				return Promise.reject(new Error("late availability rejection"));
			},
			classify: () => { classifyCalls++; throw new Error("must not classify"); },
		} as unknown as Registry;
		await assert.rejects(systemOne(state, questions, {
			modelRegistry, provider: "typesafe", model: "jev-latest", signal: controller.signal,
		}), /cancelled during availability/);
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(classifyCalls, 0);
		assert.deepEqual(failures, []);
	} finally {
		process.off("unhandledRejection", onUnhandled);
	}
});

test("late catalog resolution after deadline cannot launch a classifier", async () => {
	let resolveAvailability!: (value: typeof typesafe[]) => void;
	const available = new Promise<typeof typesafe[]>((resolve) => { resolveAvailability = resolve; });
	let classifyCalls = 0;
	const modelRegistry = {
		...registry([typesafe]),
		getAvailableOfType: () => available,
		classify: () => { classifyCalls++; throw new Error("must not classify"); },
	} as unknown as Registry;
	await assert.rejects(systemOne(state, questions, {
		modelRegistry, provider: "typesafe", model: "jev-latest", timeoutMs: 25,
	}), /deadline/);
	resolveAvailability([typesafe]);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(classifyCalls, 0);
});

test("uncooperative native classifier is bounded, and caller abort is observed", async () => {
	const modelRegistry = registry([typesafe], async () => new Promise(() => {}));
	const started = Date.now();
	await assert.rejects(systemOne(state, questions, {
		modelRegistry, provider: "typesafe", model: "jev-latest", timeoutMs: 25,
	}), /deadline/);
	assert.ok(Date.now() - started < 1000);
	const controller = new AbortController();
	const pending = systemOne(state, questions, {
		modelRegistry, provider: "typesafe", model: "jev-latest", signal: controller.signal, timeoutMs: 1000,
	});
	controller.abort(new Error("user cancelled"));
	await assert.rejects(pending, /user cancelled/);
});
