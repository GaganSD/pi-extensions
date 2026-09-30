import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	DEFAULT_FALLBACK,
	applyConfig,
	clampMaxResults,
	defaultWebSearchConfigPath,
	readWebSearchConfig,
	resolveSettings,
} from "../src/providers/config.ts";
import { isProviderError } from "../src/providers/types.ts";

async function tempDir(): Promise<string> {
	return mkdtemp(join(tmpdir(), "pi-web-search-config-"));
}

async function writeConfig(
	dir: string,
	contents: string,
): Promise<string> {
	const path = join(dir, "web-search.json");
	await writeFile(path, contents, "utf-8");
	return path;
}

test("missing file is not an error and yields defaults", async () => {
	const dir = await tempDir();
	const path = join(dir, "web-search.json");

	const read = await readWebSearchConfig(path);
	assert.equal(read.status, "missing");

	const settings = await resolveSettings(path);
	assert.ok("provider" in settings);
	assert.equal(settings.provider, "exa");
	assert.deepEqual(settings.fallback, ["parallel"]);
	assert.equal(settings.timeoutMs, 20000);
	assert.equal(settings.maxResults, 8);
	assert.equal(settings.configPath, path);
});

test("valid file is read and unknown keys are ignored", async () => {
	const dir = await tempDir();
	const path = await writeConfig(
		dir,
		JSON.stringify({
			provider: "parallel",
			fallback: ["exa"],
			timeoutMs: 5000,
			maxResults: 3,
			somethingElse: { nested: true },
		}),
	);

	const read = await readWebSearchConfig(path);
	assert.equal(read.status, "ok");
	if (read.status !== "ok") {
		return;
	}
	assert.deepEqual(read.config, {
		provider: "parallel",
		fallback: ["exa"],
		timeoutMs: 5000,
		maxResults: 3,
	});

	const settings = await resolveSettings(path);
	assert.ok("provider" in settings);
	assert.equal(settings.provider, "parallel");
	assert.deepEqual(settings.fallback, ["exa"]);
	assert.equal(settings.timeoutMs, 5000);
	assert.equal(settings.maxResults, 3);
});

test("invalid JSON is reported as invalid_config with the path", async () => {
	const dir = await tempDir();
	const path = await writeConfig(dir, "{ not json ");

	const read = await readWebSearchConfig(path);
	assert.equal(read.status, "invalid");
	if (read.status !== "invalid") {
		return;
	}
	assert.equal(read.error.code, "invalid_config");
	assert.equal(read.error.configPath, path);
	assert.match(read.error.message, /not valid JSON/);
	assert.equal(isProviderError(read.error), true);

	const resolved = await resolveSettings(path);
	assert.ok("error" in resolved);
	assert.equal(resolved.error.configPath, path);
});

test("unknown provider is rejected", async () => {
	const dir = await tempDir();
	const path = await writeConfig(
		dir,
		JSON.stringify({ provider: "tavily" }),
	);

	const read = await readWebSearchConfig(path);
	assert.equal(read.status, "invalid");
	if (read.status !== "invalid") {
		return;
	}
	assert.match(read.error.message, /Unknown provider "tavily"/);
});

test("non-numeric timeoutMs and maxResults are rejected", async () => {
	const dir = await tempDir();

	const badTimeout = await writeConfig(
		await tempDir(),
		JSON.stringify({ timeoutMs: "20000" }),
	);
	const timeoutRead = await readWebSearchConfig(badTimeout);
	assert.equal(timeoutRead.status, "invalid");
	if (timeoutRead.status === "invalid") {
		assert.match(timeoutRead.error.message, /"timeoutMs" must be a finite/);
	}

	const badResults = await writeConfig(
		dir,
		JSON.stringify({ maxResults: null }),
	);
	const resultsRead = await readWebSearchConfig(badResults);
	assert.equal(resultsRead.status, "invalid");
	if (resultsRead.status === "invalid") {
		assert.match(resultsRead.error.message, /"maxResults" must be a finite/);
	}
});

test("a JSON array is rejected, not treated as an object", async () => {
	const dir = await tempDir();
	const path = await writeConfig(dir, JSON.stringify(["exa"]));

	const read = await readWebSearchConfig(path);
	assert.equal(read.status, "invalid");
	if (read.status !== "invalid") {
		return;
	}
	assert.match(read.error.message, /must contain a JSON object/);
});

test("maxResults is clamped to 1..20", async () => {
	assert.equal(clampMaxResults(0), 1);
	assert.equal(clampMaxResults(-5), 1);
	assert.equal(clampMaxResults(8), 8);
	assert.equal(clampMaxResults(20), 20);
	assert.equal(clampMaxResults(500), 20);
	assert.equal(clampMaxResults(7.9), 7);

	const dir = await tempDir();
	const high = await writeConfig(
		dir,
		JSON.stringify({ maxResults: 99 }),
	);
	const settings = await resolveSettings(high);
	assert.ok("provider" in settings);
	assert.equal(settings.maxResults, 20);

	const low = await writeConfig(await tempDir(), JSON.stringify({ maxResults: 0 }));
	const lowSettings = await resolveSettings(low);
	assert.ok("provider" in lowSettings);
	assert.equal(lowSettings.maxResults, 1);
});

test("an explicit empty fallback list overrides the default", async () => {
	const dir = await tempDir();
	const path = await writeConfig(dir, JSON.stringify({ fallback: [] }));

	const settings = await resolveSettings(path);
	assert.ok("provider" in settings);
	assert.deepEqual(settings.fallback, []);
	assert.deepEqual(DEFAULT_FALLBACK, ["parallel"]);
});

test("PI_WEB_SEARCH_CONFIG overrides the config path", async () => {
	const dir = await tempDir();
	const path = await writeConfig(
		dir,
		JSON.stringify({ provider: "parallel", timeoutMs: 1234 }),
	);
	const previous = process.env.PI_WEB_SEARCH_CONFIG;
	process.env.PI_WEB_SEARCH_CONFIG = path;
	try {
		assert.equal(defaultWebSearchConfigPath(), path);
		const read = await readWebSearchConfig();
		assert.equal(read.status, "ok");
		const settings = await resolveSettings();
		assert.ok("provider" in settings);
		assert.equal(settings.provider, "parallel");
		assert.equal(settings.timeoutMs, 1234);
		assert.equal(settings.configPath, path);
	} finally {
		if (previous === undefined) {
			delete process.env.PI_WEB_SEARCH_CONFIG;
		} else {
			process.env.PI_WEB_SEARCH_CONFIG = previous;
		}
	}
});

test("applyConfig fills defaults from a parsed file", () => {
	const settings = applyConfig("/tmp/web-search.json", {});
	assert.equal(settings.provider, "exa");
	assert.deepEqual(settings.fallback, ["parallel"]);
	assert.equal(settings.timeoutMs, 20000);
	assert.equal(settings.maxResults, 8);
});
