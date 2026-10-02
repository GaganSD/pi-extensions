import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	CREDENTIAL_ENV_ALIASES,
	disableStoredCredentials,
	enableStoredCredentials,
	exaApiKey,
	githubToken,
	parallelApiKey,
	resolveCredential,
} from "../src/env.ts";

async function tempAuthFile(
	contents: unknown,
	run: (authPath: string) => Promise<void> | void,
): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "pi-web-search-auth-"));
	const authPath = join(dir, "auth.json");
	try {
		await writeFile(authPath, JSON.stringify(contents), "utf-8");
		await run(authPath);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

test("every nonblank env alias beats the stored credential", () => {
	assert.deepEqual(
		resolveCredential("github", {
			env: { GH_TOKEN: "env-gh" },
			readCredential: () => ({ key: "stored" }),
		}),
		{ key: "env-gh", source: "env", name: "GH_TOKEN" },
	);
});

test("the stored credential is used only when no alias is set", () => {
	assert.deepEqual(
		resolveCredential("parallel", {
			env: {},
			readCredential: () => ({ type: "api_key", key: " stored-key " }),
		}),
		{ key: "stored-key", source: "auth", name: "parallel" },
	);
});

test("rotation and removal of the stored key are observed on the next call", async () => {
	await tempAuthFile({ parallel: { type: "api_key", key: "old" } }, async (authPath) => {
		assert.equal(
			resolveCredential("parallel", { env: {}, authPath })?.key,
			"old",
		);
		await writeFile(
			authPath,
			JSON.stringify({ parallel: { type: "api_key", key: "rotated" } }),
			"utf-8",
		);
		assert.equal(
			resolveCredential("parallel", { env: {}, authPath })?.key,
			"rotated",
		);
		await writeFile(authPath, JSON.stringify({}), "utf-8");
		assert.equal(resolveCredential("parallel", { env: {}, authPath }), undefined);
	});
});

test("a whitespace-only value is absent whether it comes from env or auth", () => {
	assert.equal(
		resolveCredential("exa", {
			env: { EXA_API_KEY: "   " },
			readCredential: () => ({ key: "   " }),
		}),
		undefined,
	);
});

test("an unreadable auth file is treated as an absent credential", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-web-search-auth-"));
	try {
		const missing = join(dir, "does-not-exist.json");
		assert.equal(resolveCredential("github", { env: {}, authPath: missing }), undefined);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("provider helpers resolve through the single resolver", () => {
	assert.equal(exaApiKey({ env: { EXA_API_KEY: " e " }, readCredential: () => undefined }), "e");
	assert.equal(
		parallelApiKey({ env: { PARALLEL_API_KEY: "p" }, readCredential: () => undefined }),
		"p",
	);
	assert.equal(
		githubToken({ env: { GH_TOKEN: "g" }, readCredential: () => undefined }),
		"g",
	);
});

test("enabling stored credentials reads the given auth file until disabled", async () => {
	await tempAuthFile({ exa: { type: "api_key", key: "auth-exa" } }, async (authPath) => {
		try {
			enableStoredCredentials(authPath);
			assert.equal(exaApiKey({ env: {} }), "auth-exa");
		} finally {
			disableStoredCredentials();
		}
		assert.equal(exaApiKey({ env: {} }), undefined);
	});
});

test("the alias table documents every supported provider id", () => {
	assert.deepEqual(CREDENTIAL_ENV_ALIASES.github, ["GITHUB_TOKEN", "GH_TOKEN"]);
	assert.deepEqual(Object.keys(CREDENTIAL_ENV_ALIASES), ["exa", "parallel", "github"]);
	assert.ok(Object.values(CREDENTIAL_ENV_ALIASES).flat().every((name) => !["TYPESAFE_API_KEY", "JEV_API_KEY", "AI_GATEWAY_API_KEY", "OPENROUTER_API_KEY"].includes(name)));
});
