import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	applyConfig, clampMaxResults, configureJudgment, defaultWebSearchConfigPath, parseJudgmentArgs,
	readWebSearchConfig, resolveSettings, resolveSettingsSync,
} from "../src/providers/config.ts";
import { isProviderError } from "../src/providers/types.ts";

async function withConfig(contents: unknown, run: (path: string) => Promise<void>) {
	const dir = await mkdtemp(join(tmpdir(), "pi-web-search-config-"));
	const path = join(dir, "web-search.json");
	try {
		if (contents !== undefined) await writeFile(path, typeof contents === "string" ? contents : JSON.stringify(contents));
		await run(path);
	} finally { await rm(dir, { recursive: true, force: true }); }
}

test("missing file yields independent web/code defaults and research stays off", () => withConfig(undefined, async (path) => {
	assert.equal((await readWebSearchConfig(path)).status, "missing");
	const settings = await resolveSettings(path);
	assert.ok(!("error" in settings));
	assert.deepEqual(settings.web, { provider: "exa", fallback: ["parallel"] });
	assert.deepEqual(settings.code, { provider: "grep", fallback: ["sourcegraph", "github"] });
	assert.equal(settings.timeoutMs, 20000);
	assert.equal(settings.maxResults, 8);
	assert.equal(settings.configPath, path);
	assert.equal(settings.researchEnabled, false);
	assert.equal(settings.jev.enabled, false);
	for (const key of ["mode", "family", "provider", "fallback"]) assert.equal(key in settings, false);
}));

test("scoped provider chains are read without cross-family migration", () => withConfig({
	web: { provider: "parallel", fallback: ["exa"] },
	code: { provider: "github", fallback: [] }, timeoutMs: 5000, maxResults: 3,
}, async (path) => {
	const read = await readWebSearchConfig(path);
	assert.equal(read.status, "ok");
	const settings = await resolveSettings(path);
	assert.ok(!("error" in settings));
	assert.deepEqual(settings.web, { provider: "parallel", fallback: ["exa"] });
	assert.deepEqual(settings.code, { provider: "github", fallback: [] });
	assert.equal(settings.timeoutMs, 5000);
	assert.equal(settings.maxResults, 3);
}));

test("removed top-level configuration is rejected rather than migrated or ignored", async () => {
	for (const config of [{ mode: "parallel" }, { family: "code" }, { provider: "github" }, { fallback: ["exa"] }, { provider: "openai", model: "old-model" }, { somethingElse: true }]) {
		await withConfig(config, async (path) => {
			const read = await readWebSearchConfig(path);
			assert.equal(read.status, "invalid");
			if (read.status === "invalid") {
				assert.equal(read.error.code, "invalid_config");
				assert.match(read.error.message, /Unsupported configuration keys/);
				assert.equal(read.error.configPath, path);
			}
		});
	}
});

test("invalid JSON and non-object documents report invalid_config with the path", async () => {
	for (const [raw, expected] of [["{ not json", /not valid JSON/], ["[\"exa\"]", /must contain a JSON object/]] as const) {
		await withConfig(raw, async (path) => {
			const read = await readWebSearchConfig(path);
			assert.equal(read.status, "invalid");
			if (read.status === "invalid") {
				assert.match(read.error.message, expected);
				assert.equal(read.error.configPath, path);
				assert.equal(isProviderError(read.error), true);
			}
			assert.ok("error" in await resolveSettings(path));
		});
	}
});

test("non-numeric timeoutMs and maxResults are rejected", async () => {
	for (const [key, value] of [["timeoutMs", "20000"], ["maxResults", null]]) {
		await withConfig({ [key as string]: value }, async (path) => {
			const read = await readWebSearchConfig(path);
			assert.equal(read.status, "invalid");
			if (read.status === "invalid") assert.match(read.error.message, /must be a finite number/);
		});
	}
});

test("malformed family and research blocks fail instead of silently defaulting", async () => {
	for (const config of [
		{ web: "exa" }, { code: { provider: "openai" } }, { web: { fallback: ["missing"] } },
		{ code: { fallback: "github" } }, { web: { unrelated: true } },
		{ research: true }, { research: { enabled: "yes" } }, { research: { mode: "parallel" } },
	]) {
		await withConfig(config, async (path) => {
			const settings = await resolveSettings(path);
			assert.ok("error" in settings);
			assert.equal(settings.error.code, "invalid_config");
			assert.equal(settings.error.configPath, path);
		});
	}
});

test("misspelled judgment settings and weights fail explicitly", async () => {
	for (const jev of [
		{ enabled: true, safetyTreshold: 0.95 }, { enabled: true, constructor: "not a setting" },
		{ weights: { answer: 1 } }, { weights: { __unknown: 1 } }, { weights: [] },
	]) {
		await withConfig({ jev }, async (path) => {
			const settings = await resolveSettings(path);
			assert.ok("error" in settings);
			assert.equal(settings.error.code, "invalid_config");
			assert.equal(settings.error.configPath, path);
		});
	}
	await withConfig({ jev: { enabled: true, safetyThreshold: 0.95, weights: { answers: 0.6 } } }, async (path) => {
		const settings = await resolveSettings(path);
		assert.ok(!("error" in settings));
		assert.equal(settings.jev.safetyThreshold, 0.95);
		assert.equal(settings.jev.weights.answers, 0.6);
	});
});

test("maxResults is clamped to 1..20", async () => {
	for (const [value, expected] of [[0, 1], [-5, 1], [8, 8], [20, 20], [500, 20], [7.9, 7]]) assert.equal(clampMaxResults(value), expected);
	await withConfig({ maxResults: 99 }, async (path) => {
		const settings = await resolveSettings(path);
		assert.ok(!("error" in settings));
		assert.equal(settings.maxResults, 20);
	});
});

test("explicit empty family fallbacks override defaults independently", () => {
	const settings = applyConfig("/unused", { web: { fallback: [] } });
	assert.deepEqual(settings.web.fallback, []);
	assert.deepEqual(settings.code.fallback, ["sourcegraph", "github"]);
});

test("PI_WEB_SEARCH_CONFIG overrides the config path", () => withConfig({ web: { provider: "parallel" }, timeoutMs: 1234 }, async (path) => {
	const previous = process.env.PI_WEB_SEARCH_CONFIG;
	process.env.PI_WEB_SEARCH_CONFIG = path;
	try {
		assert.equal(defaultWebSearchConfigPath(), path);
		const settings = await resolveSettings();
		assert.ok(!("error" in settings));
		assert.equal(settings.web.provider, "parallel");
		assert.equal(settings.timeoutMs, 1234);
	} finally {
		if (previous === undefined) delete process.env.PI_WEB_SEARCH_CONFIG;
		else process.env.PI_WEB_SEARCH_CONFIG = previous;
	}
}));

test("only research.enabled opts in, and both resolvers agree", async () => {
	for (const research of [undefined, {}, { enabled: false }, { enabled: true }]) {
		await withConfig(research ? { research } : {}, async (path) => {
			const sync = resolveSettingsSync(path), asyncSettings = await resolveSettings(path);
			assert.ok(!("error" in sync) && !("error" in asyncSettings));
			assert.equal(sync.researchEnabled, research?.enabled === true);
			assert.deepEqual(sync, asyncSettings);
		});
	}
});

test("legacy backend configs stay loadable and unpinned", () => withConfig({
	research: { enabled: true }, jev: { enabled: true, backend: "openrouter" },
}, async (path) => {
	const settings = await resolveSettings(path);
	assert.ok(!("error" in settings));
	assert.equal(settings.jev.enabled, true);
	assert.equal(settings.jev.provider, "");
	assert.equal(settings.jev.model, "");
	assert.match(settings.notices.join(" "), /backend/);
}));

test("parseJudgmentArgs accepts on, off, and an exact pin", () => {
	assert.equal(parseJudgmentArgs(""), "status");
	assert.equal(parseJudgmentArgs("on"), "on");
	assert.equal(parseJudgmentArgs("off"), "off");
	assert.deepEqual(parseJudgmentArgs("typesafe/jev-latest"), { provider: "typesafe", id: "jev-latest" });
	assert.deepEqual(parseJudgmentArgs("openrouter ~typesafe/jev-latest"), { provider: "openrouter", id: "~typesafe/jev-latest" });
	assert.equal(parseJudgmentArgs("accidentally-pasted-secret"), undefined);
});

test("concurrent setup preserves settings and existing config symlinks", () => withConfig({
	maxResults: 3, jev: { weights: { answers: 0.9 }, safetyThreshold: 0.8 },
}, async (path) => {
	// Windows file symlinks need elevated privileges; still exercise concurrent writes there.
	const alias = process.platform === "win32" ? path : `${path}.link`;
	if (alias !== path) await symlink(path, alias);
	const previous = process.env.PI_WEB_SEARCH_CONFIG;
	process.env.PI_WEB_SEARCH_CONFIG = alias;
	try {
		await Promise.all([
			configureJudgment({ provider: "openrouter", id: "~typesafe/jev-latest" }),
			configureJudgment({ provider: "typesafe", id: "jev-latest" }),
		]);
		if (alias !== path) assert.equal((await lstat(alias)).isSymbolicLink(), true);
		const saved = JSON.parse(await readFile(path, "utf8"));
		assert.equal(saved.maxResults, 3);
		assert.equal(saved.research.enabled, true);
		assert.deepEqual(saved.jev.weights, { answers: 0.9 });
		assert.equal(saved.jev.safetyThreshold, 0.8);
		assert.ok(["openrouter", "typesafe"].includes(saved.jev.provider));
		assert.equal(saved.jev.model, saved.jev.provider === "openrouter" ? "~typesafe/jev-latest" : "jev-latest");
	} finally {
		if (previous === undefined) delete process.env.PI_WEB_SEARCH_CONFIG;
		else process.env.PI_WEB_SEARCH_CONFIG = previous;
	}
}));
