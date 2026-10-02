import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	ENABLE_JEV,
	KEEP_DEFAULTS,
	SETUP_BLURB,
	SHOW_SETUP,
	hasSeenWelcome,
	markWelcomeSeen,
	maybeShowWelcome,
	welcomeStatePath,
} from "../src/welcome.ts";

async function withDir(run: (dir: string) => Promise<void>): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "pi-web-search-welcome-"));
	try {
		await run(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

test("welcome state is a sidecar file next to the config", () => {
	assert.equal(
		welcomeStatePath("/tmp/agent/web-search.json"),
		"/tmp/agent/web-search-welcome.json",
	);
});

test("maybeShowWelcome is once-only and can persist TypeSafe setup", async () => {
	await withDir(async (dir) => {
		const path = join(dir, "web-search-welcome.json");
		const configPath = join(dir, "web-search.json");
		const previous = process.env.PI_WEB_SEARCH_CONFIG;
		process.env.PI_WEB_SEARCH_CONFIG = configPath;
		const shown: string[] = [];
		const ctx = {
			hasUI: true,
			ui: {
				select: async () => ENABLE_JEV,
				notify: (message: string) => {
					shown.push(message);
				},
			},
		};
		try {
			assert.equal(await hasSeenWelcome(path), false);
			await maybeShowWelcome(ctx as never);
			assert.equal(await hasSeenWelcome(), true);
			assert.match(shown.join("\n"), /\/reload/);
			const saved = JSON.parse(await readFile(configPath, "utf-8"));
			assert.equal(saved.jev.enabled, true);
			assert.equal(saved.research.enabled, true);
			shown.length = 0;
			await maybeShowWelcome(ctx as never);
			assert.deepEqual(shown, []);
		} finally {
			if (previous === undefined) delete process.env.PI_WEB_SEARCH_CONFIG;
			else process.env.PI_WEB_SEARCH_CONFIG = previous;
		}
		assert.equal(JSON.parse(await readFile(path, "utf-8")).seen, true);
	});
});

test("show-setup notifies the short blurb and keep-defaults writes seen", async () => {
	await withDir(async (dir) => {
		const configPath = join(dir, "web-search.json");
		const previous = process.env.PI_WEB_SEARCH_CONFIG;
		process.env.PI_WEB_SEARCH_CONFIG = configPath;
		try {
			let notified = "";
			await maybeShowWelcome({
				hasUI: true,
				ui: {
					select: async () => SHOW_SETUP,
					notify: (message: string) => {
						notified = message;
					},
				},
			} as never);
			assert.equal(notified, SETUP_BLURB);
			assert.equal(await hasSeenWelcome(), true);
			await markWelcomeSeen();
			assert.equal(KEEP_DEFAULTS.length > 0, true);
		} finally {
			if (previous === undefined) delete process.env.PI_WEB_SEARCH_CONFIG;
			else process.env.PI_WEB_SEARCH_CONFIG = previous;
		}
	});
});
