import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	parseWebSearchArgs,
	webSearchCompletions,
	WEB_SEARCH_USAGE,
} from "../src/command.ts";
import {
	disableStoredCredentials,
	enableStoredCredentials,
} from "../src/env.ts";
import webSearchExtension from "../src/index.ts";
import { CONFIG_PATH_ENV_VAR } from "../src/providers/config.ts";

test("parseWebSearchArgs routes menu, provider, classifier, and compat pins", () => {
	assert.deepEqual(parseWebSearchArgs(""), { kind: "menu" });
	assert.deepEqual(parseWebSearchArgs("status"), { kind: "status" });
	assert.deepEqual(parseWebSearchArgs("provider"), { kind: "provider" });
	assert.deepEqual(parseWebSearchArgs("provider exa"), { kind: "provider", id: "exa" });
	assert.deepEqual(parseWebSearchArgs("provider github remove"), { kind: "usage" });
	assert.deepEqual(parseWebSearchArgs("classifier"), { kind: "classifier", action: "pick" });
	assert.deepEqual(parseWebSearchArgs("classifier none"), { kind: "classifier", action: "off" });
	assert.deepEqual(parseWebSearchArgs("classifier typesafe/jev-latest"), {
		kind: "classifier",
		action: { provider: "typesafe", id: "jev-latest" },
	});
	assert.deepEqual(parseWebSearchArgs("off"), { kind: "classifier", action: "off" });
	assert.deepEqual(parseWebSearchArgs("openrouter/~typesafe/jev-latest"), { kind: "usage" });
	assert.deepEqual(parseWebSearchArgs("accidentally-pasted-secret"), { kind: "usage" });
	assert.deepEqual(parseWebSearchArgs("provider exa sk-secret"), { kind: "usage" });
	assert.deepEqual(parseWebSearchArgs("abcd efgh"), { kind: "usage" });
});

test("completions cover the new command surface", () => {
	assert.deepEqual(webSearchCompletions("").map((item) => item.value), [
		"status", "provider", "classifier", "on", "off",
	]);
	assert.deepEqual(webSearchCompletions("pro").map((item) => item.value), ["provider"]);
	assert.deepEqual(webSearchCompletions("provider ").map((item) => item.value), [
		"exa", "parallel", "grep", "sourcegraph", "github", "brave",
	]);
	assert.deepEqual(webSearchCompletions("provider github ").map((item) => item.value), []);
	assert.deepEqual(webSearchCompletions("classifier ").map((item) => item.value), ["none"]);
});

interface Harness {
	handler: (args: string, ctx: CommandCtx) => Promise<void>;
	messages: Array<{ customType: string; content: string }>;
	dir: string;
}

interface CommandCtx {
	hasUI: boolean;
	ui: {
		notify: (message: string) => void;
		select?: (title: string, options: string[]) => Promise<string | undefined>;
		input?: (title: string) => Promise<string | undefined>;
		confirm?: (title: string, message: string) => Promise<boolean>;
	};
	modelRegistry?: {
		getModelsOfType?: (type: string) => Array<{ provider: string; id: string }>;
		getAvailableOfType?: () => Promise<Array<{ provider: string; id: string }>>;
		getProviderAuthStatus?: (provider: string) => { configured: boolean };
		findOfType?: (type: string, provider: string, id: string) => { provider: string; id: string } | undefined;
	};
}

async function withCommand(
	run: (harness: Harness) => Promise<void>,
	storedAuth: unknown = {},
): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "pi-web-search-command-"));
	const previous = process.env[CONFIG_PATH_ENV_VAR];
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env[CONFIG_PATH_ENV_VAR] = join(dir, "web-search.json");
	process.env.PI_CODING_AGENT_DIR = dir;
	await writeFile(join(dir, "auth.json"), JSON.stringify(storedAuth));
	const messages: Harness["messages"] = [];
	const commands: Array<{ name: string; handler: Harness["handler"] }> = [];
	webSearchExtension({
		on: () => () => {},
		registerMcpServer: () => {},
		sendMessage: (message: Harness["messages"][number]) => messages.push(message),
		registerTool: () => {},
		registerCommand: (name: string, options: { handler: Harness["handler"] }) => {
			commands.push({ name, handler: options.handler });
		},
	} as never);
	enableStoredCredentials(join(dir, "auth.json"));
	try {
		const command = commands.find((entry) => entry.name === "web-search");
		assert.ok(command);
		await run({ handler: command.handler, messages, dir });
	} finally {
		disableStoredCredentials();
		if (previous === undefined) delete process.env[CONFIG_PATH_ENV_VAR];
		else process.env[CONFIG_PATH_ENV_VAR] = previous;
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(dir, { recursive: true, force: true });
	}
}

test("interactive menu stores a provider key in auth.json and never echoes it", async () => {
	const previous = process.env.EXA_API_KEY;
	delete process.env.EXA_API_KEY;
	try {
		await withCommand(async ({ handler, dir }) => {
			const notes: string[] = [];
			await handler("provider exa", {
				hasUI: true,
				ui: {
					notify: (message) => { notes.push(message); },
					input: async (title) => {
						assert.match(title, /dashboard\.exa\.ai/);
						return "  exa-secret-value  ";
					},
					confirm: async () => true,
				},
			});
			const auth = JSON.parse(await readFile(join(dir, "auth.json"), "utf8"));
			assert.deepEqual(auth.exa, { type: "api_key", key: "exa-secret-value" });
			assert.deepEqual(auth.openai, { type: "api_key", key: "keep-me" });
			assert.match(notes.join("\n"), /dashboard\.exa\.ai/);
			assert.match(notes.join("\n"), /Saved exa API key/);
			assert.doesNotMatch(notes.join("\n"), /exa-secret-value|keep-me/);
		}, { openai: { type: "api_key", key: "keep-me" } });
	} finally {
		if (previous === undefined) delete process.env.EXA_API_KEY;
		else process.env.EXA_API_KEY = previous;
	}
});

test("a remove argument is usage and does not change auth.json", async () => {
	await withCommand(async ({ handler, dir, messages }) => {
		await handler("provider parallel remove", {
			hasUI: false,
			ui: { notify: () => { throw new Error("headless"); } },
		});
		const auth = JSON.parse(await readFile(join(dir, "auth.json"), "utf8"));
		assert.deepEqual(auth.parallel, { type: "api_key", key: "keep-parallel" });
		assert.equal(messages[0]?.content, WEB_SEARCH_USAGE);
	}, { parallel: { type: "api_key", key: "keep-parallel" } });
});

test("a pasted key after provider is usage, not storage", async () => {
	await withCommand(async ({ handler, dir }) => {
		let report = "";
		await handler("provider exa pasted-secret", {
			hasUI: true,
			ui: { notify: (message) => { report = message; } },
		});
		assert.equal(report, WEB_SEARCH_USAGE);
		assert.doesNotMatch(report, /pasted-secret/);
		assert.deepEqual(JSON.parse(await readFile(join(dir, "auth.json"), "utf8")), {});
	});
});

test("keyless providers do not open a key prompt", async () => {
	await withCommand(async ({ handler }) => {
		let report = "";
		await handler("provider grep", {
			hasUI: true,
			ui: {
				notify: (message) => { report = message; },
				input: async () => { throw new Error("must not collect a key"); },
			},
		});
		assert.match(report, /grep: keyless/);
	});
});

test("classifier picker lists Pi models plus None and can disable judgment", async () => {
	await withCommand(async ({ handler, dir }) => {
		await writeFile(join(dir, "web-search.json"), JSON.stringify({
			research: { enabled: true },
			jev: { enabled: true, provider: "typesafe", model: "jev-latest" },
		}));
		const offered: string[][] = [];
		let report = "";
		await handler("classifier", {
			hasUI: true,
			ui: {
				notify: (message) => { report = message; },
				select: async (_title, options) => {
					offered.push(options);
					return "None";
				},
			},
			modelRegistry: {
				getModelsOfType: () => [
					{ provider: "typesafe", id: "jev-latest" },
					{ provider: "openai", id: "gpt-6-luna" },
				],
				getAvailableOfType: async () => [{ provider: "typesafe", id: "jev-latest" }],
			},
		});
		assert.deepEqual(offered[0]?.[0], "None");
		assert.ok(offered[0]?.some((option) => option.includes("typesafe/jev-latest")));
		assert.ok(offered[0]?.some((option) => option.includes("openai/gpt-6-luna") && option.includes("login required")));
		const saved = JSON.parse(await readFile(join(dir, "web-search.json"), "utf8"));
		assert.equal(saved.jev.enabled, false);
		assert.match(report, /Classifier disabled\. Saved to .* — run \/reload to apply\./);
	});
});

test("failed classifier discovery marks rows untested, not login required", async () => {
	await withCommand(async ({ handler }) => {
		const offered: string[][] = [];
		await handler("classifier", {
			hasUI: true,
			ui: {
				notify: () => {},
				select: async (_title, options) => {
					offered.push(options);
					return "None";
				},
			},
			modelRegistry: {
				getModelsOfType: () => [
					{ provider: "typesafe", id: "jev-latest" },
					{ provider: "openai", id: "gpt-6-luna" },
				],
				getAvailableOfType: async () => { throw new Error("discovery blew up"); },
			},
		});
		const rows = offered[0] ?? [];
		assert.ok(rows.some((option) => option.startsWith("typesafe/jev-latest")));
		assert.ok(rows.every((option) => !option.includes("login required")));
		assert.ok(rows.some((option) => option.includes("untested")));
	});
});

test("status report says auth status unknown when the registry cannot answer", async () => {
	await withCommand(async ({ handler, dir }) => {
		await writeFile(join(dir, "web-search.json"), JSON.stringify({
			jev: { enabled: true, provider: "opencode", model: "jev-1.13" },
		}));
		let report = "";
		await handler("status", {
			hasUI: true,
			ui: { notify: (message) => { report = message; } },
			modelRegistry: {},
		});
		assert.match(report, /opencode\/jev-1\.13: auth status unknown; registration unknown\./);
	});
});

test("pinning a classifier without Pi credentials says how to log in", async () => {
	await withCommand(async ({ handler }) => {
		let report = "";
		await handler("classifier opencode/jev-1.13", {
			hasUI: true,
			ui: { notify: (message) => { report = message; } },
			modelRegistry: {
				getProviderAuthStatus: () => ({ configured: false }),
			},
		});
		assert.match(report, /Pi has no opencode credentials\. Run \/login opencode, then \/reload\./);
	});
});
