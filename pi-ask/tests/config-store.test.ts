import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { DEFAULT_ASK_CONFIG } from "../src/config/defaults.ts";
import {
	AskConfigStore,
	getAskConfigPath,
	getAskConfigStore,
	resetAskConfigStore,
} from "../src/config/store.ts";

function expectedConfigFile() {
	return {
		schemaVersion: 1,
		answer: DEFAULT_ASK_CONFIG.answer,
		behaviour: DEFAULT_ASK_CONFIG.behaviour,
		keymaps: DEFAULT_ASK_CONFIG.keymaps,
		notifications: DEFAULT_ASK_CONFIG.notifications,
	};
}

async function makeTempPath(name: string): Promise<string> {
	const { mkdtemp } = await import("node:fs/promises");
	const root = await mkdtemp(join(tmpdir(), name));
	return join(root, "pi-ask.json");
}

test("config path is first-party only", () => {
	assert.match(getAskConfigPath(), /extensions\/pi-ask\.json$/);
});

test("resetAskConfigStore reloads the global store from disk", async () => {
	const { mkdtemp } = await import("node:fs/promises");
	const root = await mkdtemp(join(tmpdir(), "pi-ask-config-reset-"));
	const path = join(root, "extensions", "pi-ask.json");
	await mkdir(dirname(path), { recursive: true });
	await writeFile(
		path,
		JSON.stringify({
			...expectedConfigFile(),
			behaviour: {
				...DEFAULT_ASK_CONFIG.behaviour,
				autoSubmitWhenAnsweredWithoutNotes: true,
			},
		})
	);
	process.env.PI_CODING_AGENT_DIR = root;
	resetAskConfigStore();
	getAskConfigStore().setConfig(DEFAULT_ASK_CONFIG);

	resetAskConfigStore();
	const result = await getAskConfigStore().ensureLoaded();

	assert.equal(
		result.config.behaviour.autoSubmitWhenAnsweredWithoutNotes,
		true
	);
	delete process.env.PI_CODING_AGENT_DIR;
	resetAskConfigStore();
	await rm(root, { force: true, recursive: true });
});

test("config store writes defaults when file is missing", async () => {
	const path = await makeTempPath("pi-ask-config-missing-");
	const store = new AskConfigStore(path);

	const result = await store.ensureLoaded();

	assert.deepEqual(result.config, DEFAULT_ASK_CONFIG);
	assert.deepEqual(
		JSON.parse(await readFile(path, "utf-8")),
		expectedConfigFile()
	);
});

test("config store writes full normalized config on save", async () => {
	const path = await makeTempPath("pi-ask-config-save-");
	const store = new AskConfigStore(path);
	await store.ensureLoaded();
	await store.save({
		...DEFAULT_ASK_CONFIG,
		behaviour: {
			...DEFAULT_ASK_CONFIG.behaviour,
			showFooterHints: false,
		},
	});
	const written = JSON.parse(await readFile(path, "utf-8"));
	assert.equal(written.schemaVersion, 1);
	assert.equal(written.behaviour.showFooterHints, false);
	assert.equal(written.behaviour.presentSingleAsMulti, undefined);
});

test("config store leaves invalid files unchanged", async () => {
	const path = await makeTempPath("pi-ask-config-invalid-");
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, "{not json");
	const store = new AskConfigStore(path);
	const result = await store.ensureLoaded();
	assert.deepEqual(result.config, DEFAULT_ASK_CONFIG);
	assert.equal(result.notice?.kind, "error");
	assert.equal(await readFile(path, "utf-8"), "{not json");
});

test("config store does not read legacy eko24ive paths", async () => {
	const { mkdtemp } = await import("node:fs/promises");
	const root = await mkdtemp(join(tmpdir(), "pi-ask-legacy-"));
	await writeFile(
		join(root, "eko24ive-pi-ask.json"),
		JSON.stringify({
			behaviour: { autoSubmitWhenAnsweredWithoutNotes: true },
		})
	);
	process.env.PI_CODING_AGENT_DIR = root;
	resetAskConfigStore();
	const result = await getAskConfigStore().ensureLoaded();
	assert.equal(
		result.config.behaviour.autoSubmitWhenAnsweredWithoutNotes,
		false
	);
	delete process.env.PI_CODING_AGENT_DIR;
	resetAskConfigStore();
	await rm(root, { force: true, recursive: true });
});
