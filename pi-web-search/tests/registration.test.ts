import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
import { PARALLEL_MCP_SERVER, PARALLEL_MCP_URL } from "../src/providers/parallel.ts";

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
		ctx: { hasUI: boolean; ui: { notify: (message: string) => void }; modelRegistry?: ExtensionContext["modelRegistry"] },
	) => Promise<void>;
}

interface Registration {
	tools: RegisteredTool[];
	commands: RegisteredCommand[];
	messages: Array<{ customType: string; content: string; display: boolean }>;
	servers: Array<{ name: string; config: { url: string; exposure: string; headers?: Record<string, string> } }>;
}

/**
 * Loads the extension against a temporary config path, so the operator's real
 * web-search.json can never change the registered tool set.
 */
async function loadExtension(
	config: string | undefined,
	run: (registration: Registration, dir: string) => Promise<void> | void,
	storedAuth?: unknown,
): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "pi-web-search-register-"));
	const configPath = join(dir, "web-search.json");
	if (config !== undefined) {
		await writeFile(configPath, config, "utf-8");
	}
	if (storedAuth !== undefined) await writeFile(join(dir, "auth.json"), JSON.stringify(storedAuth));
	const previous = process.env[CONFIG_PATH_ENV_VAR];
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env[CONFIG_PATH_ENV_VAR] = configPath;
	process.env.PI_CODING_AGENT_DIR = dir;
	const tools: RegisteredTool[] = [];
	const commands: RegisteredCommand[] = [];
	const messages: Registration["messages"] = [];
	const servers: Registration["servers"] = [];
	const pi = {
		on: () => () => {},
		registerMcpServer: (name: string, config: Registration["servers"][number]["config"]) => servers.push({ name, config }),
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
		await run({ tools, commands, messages, servers }, dir);
	} finally {
		disableStoredCredentials();
		if (previous === undefined) {
			delete process.env[CONFIG_PATH_ENV_VAR];
		} else {
			process.env[CONFIG_PATH_ENV_VAR] = previous;
		}
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(dir, { recursive: true, force: true });
	}
}

function names(registration: Pick<Registration, "tools" | "commands">): string[] {
	return registration.tools.map((tool) => tool.name);
}

const ctx = {} as unknown as ExtensionContext;

test("a missing config registers web_search and code_search, not multi_search", async () => {
	await loadExtension(undefined, ({ tools, commands, servers }) => {
		assert.equal(servers[0]?.name, PARALLEL_MCP_SERVER);
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

test("research.enabled=true registers multi_search", async () => {
	await loadExtension(
		JSON.stringify({ research: { enabled: true } }),
		({ tools, commands }) => {
			assert.deepEqual(names({ tools, commands }), [
				"web_search",
				"code_search",
				"multi_search",
			]);
		},
	);
});

test("Parallel registration is anonymous by default, or Bearer when a key already exists", async () => {
	const oldKey = process.env.PARALLEL_API_KEY;
	try {
		delete process.env.PARALLEL_API_KEY;
		await loadExtension("{}", async ({ servers, commands }) => {
			assert.deepEqual(servers, [{ name: PARALLEL_MCP_SERVER, config: { url: PARALLEL_MCP_URL, exposure: "codemode-deferred" } }]);
			let report = "";
			await commands[0].handler("", { hasUI: true, ui: { notify: (text) => { report = text; } } });
			assert.match(report, /parallel: anonymous MCP needs no key/);
			assert.match(report, /Classifier authentication \(Pi snapshot/);
			assert.match(report, /openrouter: Pi auth status unavailable/);
			assert.doesNotMatch(report, /JEV_API_KEY|package-visible/);
			assert.match(report, /\/reload after changing.*Parallel credential/);
		});
		process.env.PARALLEL_API_KEY = "  configured-key  ";
		await loadExtension("{}", ({ servers }) => {
			assert.deepEqual(servers[0]?.config.headers, { Authorization: "Bearer configured-key" });
		});
		delete process.env.PARALLEL_API_KEY;
		await loadExtension("{}", ({ servers }) => {
			assert.deepEqual(servers[0]?.config.headers, { Authorization: "Bearer stored-key" });
		}, { parallel: { type: "api_key", key: "stored-key" } });
		await loadExtension(JSON.stringify({ web: { provider: "exa", fallback: [] } }), ({ servers }) => {
			assert.deepEqual(servers, []);
		});
	} finally {
		if (oldKey === undefined) delete process.env.PARALLEL_API_KEY;
		else process.env.PARALLEL_API_KEY = oldKey;
	}
});

test("registered web_search forwards the live tool context through the native pipeline", async () => {
	await loadExtension(JSON.stringify({ web: { provider: "parallel", fallback: [] } }), async ({ tools }) => {
		const seen: string[] = [];
		const runtime = {
			sessionManager: { getSessionId: () => "session-registration" },
			executeTool: async (name: string) => {
				seen.push(name);
				return { isError: false, result: { content: [], details: {}, structuredContent: {
					content: [{ type: "text", text: JSON.stringify({ results: [{ url: "https://example.test", title: "Evidence", excerpts: ["citation"] }] }) }],
				} } };
			},
		} as unknown as ExtensionContext;
		const result = await tools[0].execute("call-1", { query: "native path" }, undefined, undefined, runtime);
		assert.deepEqual(seen, [`mcp__${PARALLEL_MCP_SERVER}__web_search`]);
		assert.equal(result.isError, false);
		assert.equal(result.details.searchResults?.[0].citedText, "citation");
	});
});

test("research.enabled=false does not register multi_search", async () => {
	await loadExtension(JSON.stringify({ research: { enabled: false } }), ({ tools, commands }) => {
		assert.equal(names({ tools, commands }).includes("multi_search"), false);
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
			assert.match(report, /multi_search: enabled/);
			assert.match(report, /github: present via auth\.json/);
			assert.match(report, /parallel: present via PARALLEL_API_KEY/);
			assert.match(report, /Install from a repository checkout: pi install \.\/pi-web-search/);
			assert.match(report, /After an npm release is available:/);
			assert.doesNotMatch(report, /gh-secret-value/);
			assert.doesNotMatch(report, /parallel-secret-value/);
		},
	);
});

test("classifier diagnostics use Pi's auth snapshot, including stored/runtime auth, without resolving keys", async () => {
	await loadExtension("{}", async ({ commands }) => {
		let report = "";
		const checked: string[] = [];
		const modelRegistry = {
			getProviderAuthStatus: (provider: string) => {
				checked.push(provider);
				return { configured: provider !== "typesafe", source: "runtime", label: "classifier-secret" };
			},
			findOfType: (_type: string, provider: string, id: string) => ({ provider, id }),
			getProviderAuth: () => { throw new Error("must not resolve credentials for diagnostics"); },
			getAvailableOfType: () => { throw new Error("must not probe availability for diagnostics"); },
		} as unknown as ExtensionContext["modelRegistry"];
		await commands[0].handler("", { hasUI: true, ui: { notify: (message) => { report = message; } }, modelRegistry });
		assert.deepEqual(checked, ["typesafe", "vercel-ai-gateway", "openrouter"]);
		assert.match(report, /typesafe: Pi auth not configured; classifier registered/);
		assert.match(report, /vercel-ai-gateway: Pi auth configured; classifier registered/);
		assert.match(report, /openrouter: Pi auth configured; classifier registered/);
		assert.doesNotMatch(report, /classifier-secret|JEV_API_KEY|package-visible/);
	});
});

test("setup selects an explicit provider, preserves tuning/search settings, and never writes auth", async () => {
	const initial = { web: { provider: "parallel", fallback: [] }, timeoutMs: 3456,
		jev: { safetyThreshold: 0.9, weights: { answers: 0.8 } } };
	const auth = { openrouter: { type: "api_key", key: "existing-harness-secret" } };
	await loadExtension(JSON.stringify(initial), async ({ commands }, dir) => {
		const authBefore = await readFile(join(dir, "auth.json"), "utf8");
		const defaults = { typesafe: "jev-latest", vercel: "typesafe-ai/jev", openrouter: "~typesafe/jev-latest" };
		for (const [backend, model] of Object.entries(defaults)) {
			let report = "";
			await commands[0].handler(backend, { hasUI: true, ui: { notify: (message) => { report = message; } } });
			const saved = JSON.parse(await readFile(join(dir, "web-search.json"), "utf8"));
			assert.deepEqual(saved.web, initial.web);
			assert.equal(saved.timeoutMs, initial.timeoutMs);
			assert.equal(saved.research.enabled, true);
			assert.deepEqual(saved.jev, { ...initial.jev, enabled: true, backend, model });
			assert.match(report, /Saved search settings.*Run \/reload/);
			assert.doesNotMatch(report, /existing-harness-secret/);
		}
		await commands[0].handler("off", { hasUI: false, ui: { notify: () => { throw new Error("headless"); } } });
		const saved = JSON.parse(await readFile(join(dir, "web-search.json"), "utf8"));
		assert.equal(saved.jev.enabled, false);
		assert.equal(saved.research.enabled, true, "off disables judgment, not retrieval");
		assert.equal(await readFile(join(dir, "auth.json"), "utf8"), authBefore);
		assert.deepEqual((await readdir(dir)).sort(), ["auth.json", "web-search.json"]);
	}, auth);
});

test("first-time headless setup creates the overridden config path without any keys", async () => {
	await loadExtension(undefined, async ({ commands, messages }, dir) => {
		const path = join(dir, "nested", "web-search.json");
		process.env[CONFIG_PATH_ENV_VAR] = path;
		await commands[0].handler("openrouter", { hasUI: false, ui: { notify: () => { throw new Error("headless"); } } });
		assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
			research: { enabled: true }, jev: { enabled: true, backend: "openrouter", model: "~typesafe/jev-latest" },
		});
		assert.equal(messages.length, 1);
		assert.match(messages[0].content, /No separate Jev key is needed/);
		assert.deepEqual(await readdir(dir), ["nested"]);
	});
});

test("setup refuses malformed config and unknown arguments without leaking their content", async () => {
	for (const config of ["{ broken", JSON.stringify({ unrelated: "private-config-value" })]) {
		await loadExtension(config, async ({ commands }, dir) => {
			let report = "";
			await commands[0].handler("openrouter", { hasUI: true, ui: { notify: (message) => { report = message; } } });
			assert.match(report, /malformed configuration is never overwritten/);
			assert.equal(await readFile(join(dir, "web-search.json"), "utf8"), config);
			assert.doesNotMatch(report, /private-config-value/);
		});
	}
	await loadExtension("{}", async ({ commands }, dir) => {
		let report = "";
		await commands[0].handler("accidentally-pasted-secret", { hasUI: true, ui: { notify: (message) => { report = message; } } });
		assert.match(report, /^Usage:/);
		assert.doesNotMatch(report, /accidentally-pasted-secret/);
		assert.equal(await readFile(join(dir, "web-search.json"), "utf8"), "{}");
	});
});
