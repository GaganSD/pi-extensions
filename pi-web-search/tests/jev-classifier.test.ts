import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { applyConfig } from "../src/providers/config.ts";
import { systemOne } from "../src/jev/api.ts";
import { JEV_LEGACY_MODEL, JEV_NATIVE_MODEL, JEV_VERCEL_MODEL, selectJevModel } from "../src/jev/model.ts";

type Registry = ExtensionContext["modelRegistry"];
const typesafe = { provider: "typesafe", id: JEV_NATIVE_MODEL };
const vercel = { provider: "vercel-ai-gateway", id: JEV_VERCEL_MODEL };
function registry(models: { provider: string; id: string }[], classify?: (args: unknown) => Promise<unknown>): Registry {
	return {
		findOfType: (_type: string, provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id),
		getAvailableOfType: async (_type: string, provider: string) => models.filter((model) => model.provider === provider),
		classify: async (_model: unknown, args: unknown) => classify?.(args),
	} as unknown as Registry;
}
const questions = {
	answer: { type: "noul" as const, instructions: "Is the answer present?" },
	risk: { type: "choice" as const, instructions: "What risk?", criteria: { safe: "Safe", phishing: "Phishing" } },
};
const state = { query: "query", candidates: [{ index: 0, title: "A", url: "https://a.example", excerpt: "A" }] };

// No environment mutation: credentials, including runtime-only/OAuth sources, belong to Pi.
test("current default prefers TypeSafe and maps to Vercel when needed", async () => {
	assert.equal((await selectJevModel(registry([typesafe, vercel]), {}))?.provider, "typesafe");
	assert.equal((await selectJevModel(registry([vercel]), {}))?.id, JEV_VERCEL_MODEL);
	assert.equal((await selectJevModel(registry([vercel]), { model: JEV_NATIVE_MODEL, backend: "vercel" }))?.id, JEV_VERCEL_MODEL);
	assert.equal(await selectJevModel(registry([vercel]), { model: JEV_NATIVE_MODEL, backend: "typesafe" }), undefined);
	const unavailableTypeSafe = {
		...registry([typesafe, vercel]),
		getAvailableOfType: async (_type: string, provider: string) => provider === "typesafe" ? [] : [vercel],
	} as unknown as Registry;
	assert.equal((await selectJevModel(unavailableTypeSafe, {}))?.provider, "vercel-ai-gateway");
});

test("legacy alias maps to installed catalog IDs and prefers available TypeSafe", async () => {
	assert.equal((await selectJevModel(registry([typesafe, vercel]), { model: JEV_LEGACY_MODEL }))?.provider, "typesafe");
	assert.equal((await selectJevModel(registry([vercel]), { model: JEV_LEGACY_MODEL }))?.id, JEV_VERCEL_MODEL);
	assert.equal((await selectJevModel(registry([vercel]), { model: JEV_LEGACY_MODEL, backend: "typesafe" })), undefined);
});

test("explicit catalog models honor backend and never switch to an arbitrary fallback", async () => {
	assert.equal((await selectJevModel(registry([vercel]), { model: JEV_VERCEL_MODEL, backend: "auto" }))?.provider, "vercel-ai-gateway");
	assert.equal((await selectJevModel(registry([vercel]), { model: JEV_NATIVE_MODEL, backend: "auto" }))?.id, JEV_VERCEL_MODEL);
	assert.equal(await selectJevModel(registry([typesafe, vercel]), { model: JEV_VERCEL_MODEL, backend: "typesafe" }), undefined);
	assert.equal(await selectJevModel(registry([typesafe, vercel]), { model: "unknown", backend: "auto" }), undefined);
});

test("default and current catalog IDs do not emit a legacy migration notice", () => {
	for (const jev of [{ enabled: true }, { enabled: true, model: JEV_NATIVE_MODEL }, { enabled: false }]) {
		const settings = applyConfig("/unused", { jev });
		assert.equal(settings.jev.model, JEV_NATIVE_MODEL);
		assert.deepEqual(settings.notices, []);
	}
	const legacy = applyConfig("/unused", { jev: { enabled: true, model: JEV_LEGACY_MODEL } });
	assert.match(legacy.notices.join(" "), /legacy direct-API ID.*typesafe\/jev-latest/);
	assert.equal(applyConfig("/unused", {}).notices.length, 0);
	const explicit = applyConfig("/unused", { jev: { enabled: true, model: "unknown-catalog-id" } });
	assert.equal(explicit.jev.model, "unknown-catalog-id");
	assert.equal(explicit.notices.length, 0);
});

test("Pi receives bool and choice questions in one call and returns policy-friendly answers", async () => {
	let calls = 0;
	const modelRegistry = registry([typesafe], async (args) => {
		calls++;
		const ctx = args as { questions: Record<string, { type: string }> ; state: typeof state };
		assert.equal(ctx.questions.answer.type, "bool");
		assert.equal(ctx.questions.risk.type, "choice");
		assert.deepEqual(ctx.state, state);
		return { stopReason: "stop", answers: {
			answer: { type: "bool", probability: 0.8 },
			risk: { type: "choice", choice: "safe", probabilities: { safe: 0.9 }, confidence: 0.9 },
		} };
	});
	const response = await systemOne(state, questions, { modelRegistry });
	assert.equal(calls, 1);
	assert.deepEqual(response.answers.answer, { type: "noul", noul: 0.8 });
	assert.equal(response.answers.risk.type, "choice");
});

test("Pi can resolve runtime authentication even with no package-local key", async () => {
	const modelRegistry = registry([typesafe], async () => ({ stopReason: "stop", answers: {
		answer: { type: "bool", probability: 0.8 },
		risk: { type: "choice", choice: "safe", probabilities: { safe: 0.9 }, confidence: 0.9 },
	} }));
	assert.equal((await systemOne(state, questions, { modelRegistry })).answers.answer.type, "noul");
});

test("missing or malformed classifier answers never become a policy verdict", async () => {
	for (const answers of [{}, { answer: { type: "bool", probability: Number.NaN } },
		{ answer: { type: "bool", probability: 0.8 }, risk: { type: "choice", choice: "phishing", probabilities: { phishing: Infinity }, confidence: 1 } }]) {
		const modelRegistry = registry([typesafe], async () => ({ stopReason: "stop", answers }));
		await assert.rejects(systemOne(state, questions, { modelRegistry }), /malformed answers/);
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
	await assert.rejects(systemOne(state, questions, { modelRegistry, signal: controller.signal }), /cancelled before judging/);
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
		await assert.rejects(systemOne(state, questions, { modelRegistry, signal: controller.signal }), /cancelled during availability/);
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
	await assert.rejects(systemOne(state, questions, { modelRegistry, timeoutMs: 25 }), /deadline/);
	resolveAvailability([typesafe]);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(classifyCalls, 0);
});

test("uncooperative native classifier is bounded, and caller abort is observed", async () => {
	const modelRegistry = registry([typesafe], async () => new Promise(() => {}));
	const started = Date.now();
	await assert.rejects(systemOne(state, questions, { modelRegistry, timeoutMs: 25 }), /deadline/);
	assert.ok(Date.now() - started < 1000);
	const controller = new AbortController();
	const pending = systemOne(state, questions, { modelRegistry, signal: controller.signal, timeoutMs: 1000 });
	controller.abort(new Error("user cancelled"));
	await assert.rejects(pending, /user cancelled/);
});
