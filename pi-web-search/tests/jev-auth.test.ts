import assert from "node:assert/strict";
import test from "node:test";

import {
	JEV_NATIVE_MODEL,
	JEV_VERCEL_MODEL,
	TYPESAFE_API_URL,
	VERCEL_TYPESAFE_API_URL,
	modelFor,
	resolveJevAuth,
} from "../src/jev/auth.ts";
import { systemOne } from "../src/jev/api.ts";
import { CREDENTIAL_ENV_ALIASES } from "../src/env.ts";

const CREDENTIAL_ALIASES = [
	...new Set(Object.values(CREDENTIAL_ENV_ALIASES).flat()),
];

/**
 * Runs `run` with every credential alias cleared, then applies `vars` on top.
 * Clearing the whole alias set is what makes these tests independent of the
 * operator's environment (e.g. dummy `JEV_API_KEY`/`AI_GATEWAY_API_KEY`).
 */
function withEnv(vars: Record<string, string | undefined>, run: () => void): void {
	const previous = new Map<string, string | undefined>();
	for (const name of CREDENTIAL_ALIASES) {
		previous.set(name, process.env[name]);
		delete process.env[name];
	}
	for (const [key, value] of Object.entries(vars)) {
		if (value !== undefined) {
			process.env[key] = value;
		}
	}
	try {
		run();
	} finally {
		for (const [key, value] of previous) {
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	}
}

test("native TypeSafe env wins over a Vercel gateway key", () => {
	withEnv(
		{ TYPESAFE_API_KEY: "ts-key", AI_GATEWAY_API_KEY: "vck-key" },
		() => {
			const auth = resolveJevAuth();
			assert.deepEqual(auth, {
				backend: "typesafe",
				apiKey: "ts-key",
				url: TYPESAFE_API_URL,
				model: JEV_NATIVE_MODEL,
			});
		},
	);
});

test("JEV_API_KEY is accepted as the native key", () => {
	withEnv({ JEV_API_KEY: "jev-key" }, () => {
		assert.equal(resolveJevAuth()?.backend, "typesafe");
		assert.equal(resolveJevAuth()?.apiKey, "jev-key");
	});
});

test("Vercel AI Gateway is used when no native key is set", () => {
	withEnv({ AI_GATEWAY_API_KEY: "vck-key" }, () => {
		const auth = resolveJevAuth();
		assert.deepEqual(auth, {
			backend: "vercel",
			apiKey: "vck-key",
			url: VERCEL_TYPESAFE_API_URL,
			model: JEV_VERCEL_MODEL,
		});
	});
});

test("a pinned backend does not fall through to the other key", () => {
	withEnv(
		{ TYPESAFE_API_KEY: "ts-key", AI_GATEWAY_API_KEY: "vck-key" },
		() => {
			assert.equal(resolveJevAuth({ backend: "vercel" })?.backend, "vercel");
			assert.equal(resolveJevAuth({ backend: "typesafe" })?.backend, "typesafe");
		},
	);
});

test("Pi auth.json is ignored unless usePiAuth is on", () => {
	withEnv({}, () => {
		assert.equal(resolveJevAuth(), undefined);
		const auth = resolveJevAuth({
			usePiAuth: true,
			readCredential: (id) =>
				id === "vercel-ai-gateway" ? { type: "api_key", key: "vck-from-auth" } : undefined,
		});
		assert.equal(auth?.backend, "vercel");
		assert.equal(auth?.apiKey, "vck-from-auth");
	});
});

test("an env alias always beats a stored auth value", () => {
	withEnv({}, () => {
		const auth = resolveJevAuth({
			usePiAuth: true,
			readCredential: (id) =>
				id === "typesafe" ? { type: "api_key", key: "stored-key" } : undefined,
		});
		assert.equal(auth?.apiKey, "stored-key");
		process.env.JEV_API_KEY = "env-key";
		assert.equal(resolveJevAuth({ usePiAuth: true, readCredential: () => ({ key: "stored-key" }) })?.apiKey, "env-key");
	});
});

test("whitespace keys are absent", () => {
	withEnv({ TYPESAFE_API_KEY: "  ", AI_GATEWAY_API_KEY: "\n" }, () => {
		assert.equal(resolveJevAuth(), undefined);
	});
});

test("native model ids are remapped on the Vercel backend", () => {
	assert.equal(modelFor("vercel", "jev-1.13.0"), JEV_VERCEL_MODEL);
	assert.equal(modelFor("typesafe", "typesafe-ai/jev"), JEV_NATIVE_MODEL);
	assert.equal(modelFor("typesafe", "jev-1.13.0"), "jev-1.13.0");
});

test("systemOne posts to the Vercel System One URL with the gateway model", async () => {
	let seenUrl = "";
	let seenBody: { model?: string } = {};
	await systemOne(
		{ query: "q" },
		{
			kind: {
				type: "choice",
				instructions: "web or code?",
				criteria: { web: "web", code: "code" },
			},
		},
		{
			apiKey: "vck-test",
			backend: "vercel",
			fetchImpl: ((url: string, init: RequestInit) => {
				seenUrl = url;
				seenBody = JSON.parse(String(init.body)) as { model?: string };
				return Promise.resolve(
					new Response(
						JSON.stringify({
							answers: {
								kind: {
									type: "choice",
									choice: "web",
									probabilities: { web: 1 },
									confidence: 1,
								},
							},
						}),
						{ status: 200 },
					),
				);
			}) as unknown as typeof fetch,
		},
	);
	assert.equal(seenUrl, VERCEL_TYPESAFE_API_URL);
	assert.equal(seenBody.model, JEV_VERCEL_MODEL);
});
