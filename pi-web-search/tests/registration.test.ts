import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TSchema } from "@earendil-works/pi-ai";
import { SearchOutputSchema } from "../src/format.ts";

import type {
	AgentToolResult,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { CREDENTIAL_ENV_ALIASES, disableStoredCredentials, enableStoredCredentials } from "../src/env.ts";
import type { WebSearchDetails } from "../src/format.ts";
import webSearchExtension, { assertSupportedPiVersion } from "../src/index.ts";
import { CONFIG_PATH_ENV_VAR } from "../src/providers/config.ts";

test("host version gate rejects older and malformed versions, without fallback", () => {
	for (const version of ["0.85.1", "0.98.99", "0.99.0-preview", "v0.98.0", "unknown", "", "0.99", "00.99.0"]) {
		assert.throws(() => assertSupportedPiVersion(version), /requires Pi >=0.99.0/);
	}
	for (const version of ["0.99.0", "0.99.1", "0.99.0+build.1", "0.100.0", "0.100.0-preview", "1.0.0"]) {
		assert.doesNotThrow(() => assertSupportedPiVersion(version));
	}
});

test("headless settings uses host messages rather than corrupting stdout", async () => {
	await loadExtension("{}", async (registration, dir) => {
		const authPath = join(dir, "auth.json");
		await writeFile(authPath, "{}");
		enableStoredCredentials(authPath);
		try {
			await registration.commands[0].handler("", { hasUI: false, ui: { notify: () => { throw new Error("no UI"); } } });
			assert.equal(registration.messages.length, 1);
			assert.equal(registration.messages[0].customType, "web-search-settings");
			assert.match(registration.messages[0].content, /pi-web-search settings/);
		} finally { disableStoredCredentials(); }
	});
});

interface RegisteredTool {
	name: string;
	description: string;
	promptSnippet?: string;
	promptGuidelines?: string[];
	outputSchema?: TSchema;
	namespace?: { name: string; description?: string };
	annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
	execute: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: ExtensionContext,
	) => Promise<AgentToolResult<WebSearchDetails>>;
}

interface RegisteredCommand {
	name: string;
	handler: (
		args: string,
		ctx: { hasUI: boolean; ui: { notify: (message: string) => void } },
	) => Promise<void>;
}

interface Registration {
	tools: RegisteredTool[];
	commands: RegisteredCommand[];
	messages: Array<{ customType: string; content: string; display: boolean }>;
}

/**
 * Loads the extension against a temporary config path, so the operator's real
 * web-search.json can never change the registered tool set.
 */
async function loadExtension(
	config: string | undefined,
	run: (registration: Registration, dir: string) => Promise<void> | void,
): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "pi-web-search-register-"));
	const configPath = join(dir, "web-search.json");
	if (config !== undefined) {
		await writeFile(configPath, config, "utf-8");
	}
	const previous = process.env[CONFIG_PATH_ENV_VAR];
	process.env[CONFIG_PATH_ENV_VAR] = configPath;
	const tools: RegisteredTool[] = [];
	const commands: RegisteredCommand[] = [];
	const messages: Registration["messages"] = [];
	const pi = {
		sendMessage: (message: Registration["messages"][number]) => messages.push(message),
		registerTool: (tool: RegisteredTool) => {
			tools.push(tool);
		},
		registerCommand: (name: string, options: Omit<RegisteredCommand, "name">) => {
			commands.push({ name, ...options });
		},
	};
	try {
		webSearchExtension(pi as never);
		await run({ tools, commands, messages }, dir);
	} finally {
		disableStoredCredentials();
		if (previous === undefined) {
			delete process.env[CONFIG_PATH_ENV_VAR];
		} else {
			process.env[CONFIG_PATH_ENV_VAR] = previous;
		}
		await rm(dir, { recursive: true, force: true });
	}
}

function names(registration: Pick<Registration, "tools" | "commands">): string[] {
	return registration.tools.map((tool) => tool.name);
}

const ctx = {} as unknown as ExtensionContext;

test("a missing config registers web_search and code_search, not research_search", async () => {
	await loadExtension(undefined, ({ tools, commands }) => {
		assert.deepEqual(names({ tools, commands }), ["web_search", "code_search"]);
		assert.ok(commands.some((command) => command.name === "web-search-settings"));
		for (const tool of tools) {
			assert.ok(tool.promptSnippet, `${tool.name} must set promptSnippet`);
			assert.ok(
				tool.promptGuidelines?.length,
				`${tool.name} must set promptGuidelines`,
			);
			assert.ok(
				tool.promptGuidelines.some((line) => line.includes(`\`${tool.name}\``)),
				`${tool.name} guidelines must reference the tool`,
			);
		}
	});
});

test("all tools declare the modern Pi data and permission contracts", async () => {
	await loadExtension(JSON.stringify({ research: { enabled: true } }), ({ tools }) => {
		assert.equal(tools.length, 3);
		for (const tool of tools) {
			assert.deepEqual(tool.outputSchema, SearchOutputSchema);
			assert.equal(tool.namespace?.name, "search");
			assert.deepEqual(tool.annotations, {
				readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true,
			});
		}
	});
});

test("research.enabled=true registers research_search", async () => {
	await loadExtension(
		JSON.stringify({ research: { enabled: true } }),
		({ tools, commands }) => {
			assert.deepEqual(names({ tools, commands }), [
				"web_search",
				"code_search",
				"research_search",
			]);
		},
	);
});

test("research.enabled=false does not register research_search", async () => {
	await loadExtension(JSON.stringify({ research: { enabled: false } }), ({ tools, commands }) => {
		assert.equal(names({ tools, commands }).includes("research_search"), false);
	});
});

test("invalid configuration is a structured failed tool call", async () => {
	await loadExtension("{ not json", async ({ tools, commands }) => {
		assert.deepEqual(names({ tools, commands }), ["web_search", "code_search"]);
		const web = tools.find((tool) => tool.name === "web_search");
		assert.ok(web);
		const result = await web.execute("call_1", { query: "hi" }, undefined, undefined, ctx);
		assert.equal(result.isError, true);
		assert.equal(result.details.error?.code, "invalid_config");
		assert.match(result.details.error?.message ?? "", /^web_search failed \(invalid_config\): /);
	});
});

test("the /web-search-settings command reports presence without keys", async () => {
	await loadExtension(
		JSON.stringify({ research: { enabled: true } }),
		async ({ commands }, dir) => {
			await writeFile(
				join(dir, "auth.json"),
				JSON.stringify({ github: { type: "api_key", key: "gh-secret-value" } }),
				"utf-8",
			);
			enableStoredCredentials(join(dir, "auth.json"));
			// Snapshot the whole alias set so the operator's environment cannot
			// change which source the report attributes a credential to.
			const aliases = Object.values(CREDENTIAL_ENV_ALIASES).flat();
			const previous = new Map<string, string | undefined>();
			for (const name of aliases) {
				previous.set(name, process.env[name]);
				delete process.env[name];
			}
			process.env.PARALLEL_API_KEY = "parallel-secret-value";
			let report = "";
			try {
				const command = commands.find(
					(entry) => entry.name === "web-search-settings",
				);
				assert.ok(command);
				await command.handler("", {
					hasUI: true,
					ui: {
						notify: (message) => {
							report = message;
						},
					},
				});
			} finally {
				for (const [name, value] of previous) {
					if (value === undefined) {
						delete process.env[name];
					} else {
						process.env[name] = value;
					}
				}
			}

			assert.match(report, /pi-web-search settings/);
			assert.match(report, /research_search: enabled/);
			assert.match(report, /github: present via auth\.json/);
			assert.match(report, /parallel: present via PARALLEL_API_KEY/);
			assert.match(report, /Install from a repository checkout: pi install \.\/pi-web-search/);
			assert.match(report, /After an npm release is available:/);
			assert.doesNotMatch(report, /gh-secret-value/);
			assert.doesNotMatch(report, /parallel-secret-value/);
		},
	);
});
