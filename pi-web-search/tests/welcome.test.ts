import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
	CONTINUE,
	SHOW_SETUP,
	detectWelcome,
	formatWelcomeStatus,
	hasSeenWelcome,
	markWelcomeSeen,
	maybeShowWelcome,
	setupBlurb,
	welcomeGaps,
	welcomeOptions,
	welcomeStatePath,
	type WelcomeSnapshot,
} from "../src/welcome.ts";

const EMPTY: WelcomeSnapshot = { configExists: false };
const ISOLATED = { env: {}, readGhToken: () => undefined };

async function withDir(run: (dir: string) => Promise<void>): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "pi-web-search-welcome-"));
	try {
		await run(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

async function withConfigEnv(configPath: string, run: () => Promise<void>): Promise<void> {
	const previous = process.env.PI_WEB_SEARCH_CONFIG;
	process.env.PI_WEB_SEARCH_CONFIG = configPath;
	try {
		await run();
	} finally {
		if (previous === undefined) delete process.env.PI_WEB_SEARCH_CONFIG;
		else process.env.PI_WEB_SEARCH_CONFIG = previous;
	}
}

test("welcome state is a sidecar file next to the config", () => {
	const configPath = join("tmp", "agent", "web-search.json");
	assert.equal(welcomeStatePath(configPath), join(dirname(configPath), "web-search-welcome.json"));
});

test("welcome options are search-auth only", () => {
	assert.deepEqual(welcomeOptions(EMPTY), [CONTINUE, SHOW_SETUP]);
	assert.deepEqual(
		welcomeOptions({ exa: "EXA_API_KEY", parallel: "auth.json", github: "gh auth", configExists: true }),
		[CONTINUE],
	);
	assert.equal(welcomeGaps({ ...EMPTY, github: "gh auth" }).some((gap) => gap.includes("GitHub")), false);
});

test("maybeShowWelcome is once-only and does not write search config", async () => {
	await withDir(async (dir) => {
		const path = join(dir, "web-search-welcome.json");
		const configPath = join(dir, "web-search.json");
		const shown: string[] = [];
		const offered: string[][] = [];
		const ctx = {
			mode: "tui",
			hasUI: true,
			ui: {
				select: async (_title: string, options: string[]) => {
					offered.push(options);
					return CONTINUE;
				},
				notify: (message: string) => {
					shown.push(message);
				},
			},
		};
		await withConfigEnv(configPath, async () => {
			assert.equal(await hasSeenWelcome(path), false);
			await maybeShowWelcome(ctx as never, { snapshot: EMPTY });
			assert.equal(await hasSeenWelcome(), true);
			assert.deepEqual(offered, [[CONTINUE, SHOW_SETUP]]);
			assert.equal(shown[0], formatWelcomeStatus(EMPTY));
			await assert.rejects(access(configPath));
			shown.length = 0;
			await maybeShowWelcome(ctx as never);
			assert.deepEqual(shown, []);
		});
		assert.equal(JSON.parse(await readFile(path, "utf-8")).seen, true);
	});
});

test("RPC and headless sessions skip the blocking welcome prompt", async () => {
	await withDir(async (dir) => {
		const configPath = join(dir, "web-search.json");
		await withConfigEnv(configPath, async () => {
			let selected = false;
			await maybeShowWelcome({
				mode: "rpc",
				hasUI: true,
				ui: {
					select: async () => {
						selected = true;
						return CONTINUE;
					},
					notify: () => {
						throw new Error("should not notify");
					},
				},
			} as never);
			assert.equal(selected, false);
			assert.equal(await hasSeenWelcome(), false);
		});
	});
});

test("show-setup notifies only missing search credentials", async () => {
	await withDir(async (dir) => {
		const configPath = join(dir, "web-search.json");
		await withConfigEnv(configPath, async () => {
			const notified: string[] = [];
			await maybeShowWelcome({
				mode: "tui",
				hasUI: true,
				ui: {
					select: async () => SHOW_SETUP,
					notify: (message: string) => {
						notified.push(message);
					},
				},
			} as never, { snapshot: EMPTY });
			assert.equal(notified.at(-1), setupBlurb(EMPTY));
			assert.match(setupBlurb(EMPTY), /Optional GitHub/);
			assert.doesNotMatch(setupBlurb(EMPTY), /Enable multi_search/);
			assert.equal(await hasSeenWelcome(), true);
			await markWelcomeSeen();
		});
	});
});

test("detectWelcome reports existing keys and gh auth without classifier work", async () => {
	await withDir(async (dir) => {
		const configPath = join(dir, "web-search.json");
		await writeFile(configPath, `${JSON.stringify({ jev: { enabled: true } }, null, 2)}\n`);
		await withConfigEnv(configPath, async () => {
			const snap = await detectWelcome({
				modelRegistry: {
					getProviderAuthStatus: () => {
						throw new Error("welcome must not inspect classifiers");
					},
					getAvailableOfType: () => {
						throw new Error("welcome must not probe classifiers");
					},
				},
			} as never, {
				credentials: {
					env: { EXA_API_KEY: "exa", PARALLEL_API_KEY: "par" },
					readGhToken: () => "gho_test",
				},
			});
			assert.deepEqual(snap, {
				exa: "EXA_API_KEY",
				parallel: "PARALLEL_API_KEY",
				github: "gh auth",
				configExists: true,
			});
		});
	});
});

test("live detectWelcome stays isolated from process env when credentials are injected", async () => {
	await withDir(async (dir) => {
		const configPath = join(dir, "web-search.json");
		await withConfigEnv(configPath, async () => {
			const snap = await detectWelcome({} as never, { credentials: ISOLATED });
			assert.deepEqual(snap, EMPTY);
		});
	});
});
