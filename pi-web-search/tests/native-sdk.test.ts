import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
	createAgentSession, createCodemodeExtension, createMcpExtension, DefaultResourceLoader,
	ModelRuntime, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { PARALLEL_MCP_SERVER } from "../src/providers/parallel.ts";
import { classifierRegistry } from "./fixtures/native-jev.ts";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const fixture = fileURLToPath(new URL("./fixtures/parallel-mcp-server.mjs", import.meta.url));
const zeroUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

test("Pi SDK permission-hook reasons never retry Parallel through Exa, even when they resemble HTTP 429", { timeout: 20000 }, async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-native-permission-"));
	const callsPath = join(root, "mcp-calls.jsonl");
	const configPath = join(root, "web-search.json");
	const prior = { agent: process.env.PI_CODING_AGENT_DIR, config: process.env.PI_WEB_SEARCH_CONFIG, fetch: globalThis.fetch };
	process.env.PI_CODING_AGENT_DIR = root;
	process.env.PI_WEB_SEARCH_CONFIG = configPath;
	let fetchCalls = 0;
	globalThis.fetch = async () => { fetchCalls++; throw new Error("offline fixture: Exa fallback must not run"); };
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	try {
		await writeFile(join(root, "auth.json"), "{}");
		await writeFile(configPath, JSON.stringify({ web: { provider: "parallel", fallback: ["exa"] }, timeoutMs: 5000 }));
		await writeFile(join(root, "mcp.json"), JSON.stringify({ mcpServers: { [PARALLEL_MCP_SERVER]: {
			command: process.execPath, args: [fixture, callsPath], exposure: "codemode-deferred",
		} } }));
		const settingsManager = SettingsManager.inMemory({ defaultTools: ["web_search"], compaction: { enabled: false }, retry: { enabled: false } });
		const native = `mcp__${PARALLEL_MCP_SERVER}__web_search`;
		let reason = "No thanks";
		let deniedCalls = 0;
		const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager,
			noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
			additionalExtensionPaths: [packageRoot],
			extensionFactories: [createMcpExtension(), createCodemodeExtension(), (pi) => {
				pi.on("tool_call", (event) => {
					if (event.toolName === native) { deniedCalls++; return { block: true, reason }; }
				});
			}],
		});
		await loader.reload();
		assert.deepEqual(loader.getExtensions().errors, []);
		const modelRuntime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: join(root, "models.json") });
		({ session } = await createAgentSession({ cwd: root, agentDir: root, resourceLoader: loader,
			settingsManager, modelRuntime, sessionManager: SessionManager.inMemory(root) }));
		await session.bindExtensions({});
		const readyBy = Date.now() + 5000;
		while (!session.getCallableToolNames().includes(native) && Date.now() < readyBy) {
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		assert.ok(session.getCallableToolNames().includes(native), "native tool must be callable before permission hook blocks it");
		session.sessionManager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "permission-call", name: "web_search", arguments: { query: "fixture" } }],
			api: "openai-responses", provider: "openai", model: "fixture", usage: zeroUsage, stopReason: "toolUse", timestamp: Date.now() });
		session.refreshContext();
		const ctx = session.extensionRunner.createToolContext("permission-call", AbortSignal.timeout(6000));
		for (const denialReason of ["No thanks", "HTTP 429 too many requests"]) {
			reason = denialReason;
			const outcome = await ctx.executeTool("web_search", { query: "fixture" });
			assert.equal(outcome.isError, true, reason);
			const data = outcome.result.structuredContent as { error?: { code?: string; message?: string; retryable?: boolean } };
			assert.equal(data.error?.code, "tool_error");
			assert.equal(data.error?.retryable, false);
			assert.match(data.error?.message ?? "", /Pi's tool pipeline:.*Check \/mcp/);
			assert.ok(data.error?.message?.includes(reason));
		}
		assert.equal(deniedCalls, 2);
		assert.equal(fetchCalls, 0, "Exa fallback must not start after a permission denial");
		assert.equal(existsSync(callsPath), false, "denied MCP tool must never reach the fixture server");
	} finally {
		if (session) { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); }
		globalThis.fetch = prior.fetch;
		if (prior.agent === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = prior.agent;
		if (prior.config === undefined) delete process.env.PI_WEB_SEARCH_CONFIG;
		else process.env.PI_WEB_SEARCH_CONFIG = prior.config;
		await rm(root, { recursive: true, force: true });
	}
});

for (const mode of ["anonymous", "stub", "openrouter-stored", "openrouter-runtime", "vercel-stored"] as const) {
	const judge = mode !== "anonymous";
	const nativeClassifier = mode !== "anonymous" && mode !== "stub";
	const backend = mode === "vercel-stored" ? "vercel" : "openrouter";
	const provider = backend === "vercel" ? "vercel-ai-gateway" : "openrouter";
	const key = "isolated-harness-classifier-key";
	test(`Pi SDK local MCP search/fetch with ${mode} classifier authentication`, { timeout: 20000 }, async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-native-sdk-search-"));
		const configPath = join(root, "web-search.json");
		const callsPath = join(root, "mcp-calls.jsonl");
		const prior = { agent: process.env.PI_CODING_AGENT_DIR, config: process.env.PI_WEB_SEARCH_CONFIG, fetch: globalThis.fetch };
		let classifyCalls = 0;
		// Only the native classifier transport is faked; Pi selects the model and resolves its real auth pipeline.
		globalThis.fetch = async (input, init) => {
			const url = String(input);
			const origin = backend === "vercel" ? "https://ai-gateway.vercel.sh/" : "https://openrouter.ai/";
			if (!nativeClassifier || !url.startsWith(origin) || !url.endsWith("/systemone")) throw new Error("offline MCP fixture");
			assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${key}`);
			const body = JSON.parse(String(init?.body));
			assert.equal(body.model, backend === "vercel" ? "typesafe-ai/jev" : "~typesafe/jev-latest");
			assert.equal(body.state.query, "fixture question");
			classifyCalls++;
			const answers = Object.fromEntries(Object.entries(body.questions as Record<string, { type: string; criteria: Record<string, string> }>).map(([id, question]) => [id,
				question.type === "choice" ? { type: "choice", choice: "safe", confidence: 1,
					probabilities: Object.fromEntries(Object.keys(question.criteria).map((choice) => [choice, choice === "safe" ? 1 : 0])) }
					: { type: "noul", noul: 0.9 },
			]));
			return new Response(JSON.stringify({ answers, usage: { input_tokens: 11, output_tokens: 0 } }), { headers: { "content-type": "application/json" } });
		};
		process.env.PI_CODING_AGENT_DIR = root;
		process.env.PI_WEB_SEARCH_CONFIG = configPath;
		let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
		try {
			await writeFile(join(root, "auth.json"), JSON.stringify(mode.endsWith("stored") ? { [provider]: { type: "api_key", key } } : {}));
			await writeFile(configPath, JSON.stringify({ web: { provider: "parallel", fallback: [] },
				research: { enabled: judge }, jev: { enabled: judge, ...(nativeClassifier ? { backend } : {}) }, timeoutMs: 5000, maxResults: 2 }));
			// The explicit same-name user config wins over the extension's remote registration.
			await writeFile(join(root, "mcp.json"), JSON.stringify({ mcpServers: { [PARALLEL_MCP_SERVER]: {
				command: process.execPath, args: [fixture, callsPath], exposure: "codemode-deferred",
			} } }));
			const settingsManager = SettingsManager.inMemory({ defaultTools: ["web_search", ...(judge ? ["multi_search"] : [])],
				compaction: { enabled: false }, retry: { enabled: false } });
			const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager,
				noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
				additionalExtensionPaths: [packageRoot],
				extensionFactories: [createMcpExtension(), createCodemodeExtension()],
			});
			await loader.reload();
			assert.deepEqual(loader.getExtensions().errors, []);
			const modelRuntime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: join(root, "models.json") });
			if (mode === "openrouter-runtime") await modelRuntime.setRuntimeApiKey(provider, key);
			({ session } = await createAgentSession({ cwd: root, agentDir: root, resourceLoader: loader,
				settingsManager, modelRuntime, sessionManager: SessionManager.inMemory(root) }));
			await session.bindExtensions({});
			const native = `mcp__${PARALLEL_MCP_SERVER}__web_search`;
			const readyBy = Date.now() + 5000;
			while (!session.getCallableToolNames().includes(native) && Date.now() < readyBy) {
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
			assert.ok(session.getCallableToolNames().includes(native), "local native MCP must connect");
			const query = "fixture question";
			const args = { query, urls: ["https://example.test/document"] };
			// A seeded assistant tool call allows Pi to run the real tool/nested MCP pipeline without model credentials.
			session.sessionManager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "fixture-call", name: "web_search", arguments: args }],
				api: "openai-responses", provider: "openai", model: "fixture", usage: zeroUsage, stopReason: "toolUse", timestamp: Date.now() });
			session.refreshContext();
			const ctx = session.extensionRunner.createToolContext("fixture-call", AbortSignal.timeout(6000));
			if (mode === "stub") {
				const stub = classifierRegistry({ answers: {} });
				ctx.modelRegistry.findOfType = stub.findOfType.bind(stub);
				ctx.modelRegistry.getAvailableOfType = stub.getAvailableOfType.bind(stub);
				ctx.modelRegistry.classify = async (...input) => {
				classifyCalls++;
				const response = await stub.classify(...input);
				return { ...response, usage: { ...zeroUsage, input: 11, totalTokens: 11 } };
			};
			}
			const ordinary = await ctx.executeTool("web_search", args);
			assert.equal(ordinary.isError, false, JSON.stringify(ordinary.result));
			const ordinaryData = ordinary.result.structuredContent as { provider?: string; searchResults?: { type?: string; url?: string }[] };
			assert.equal(ordinaryData.provider, "parallel");
			assert.ok(ordinaryData.searchResults?.some((hit) =>
				hit.type === "extract" && hit.url === args.urls[0]));
			assert.equal(classifyCalls, 0, "ordinary search never judges");
			if (judge) {
				const judged = await ctx.executeTool("multi_search", { query, scope: "web" });
				assert.equal(judged.isError, false, JSON.stringify(judged.result));
				assert.equal((judged.result.structuredContent as { jevStatus?: string }).jevStatus, "ran");
				assert.equal(judged.result.usage?.totalTokens, 11, "own classifier usage reaches AgentToolResult");
				assert.equal(classifyCalls, 1);
			}
			const calls = (await readFile(callsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
			assert.deepEqual(calls.slice(0, 2).map((call) => call.name), ["web_search", "web_fetch"]);
			assert.equal(calls[0].args.session_id, calls[1].args.session_id);
			assert.equal(calls[0].args.model_name, nativeClassifier ? ctx.model?.id : undefined, "analytics uses only the known runtime model ID, not the seeded transcript model");
			assert.equal(calls[1].args.full_content, false);
		} finally {
			if (session) { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); }
			globalThis.fetch = prior.fetch;
			if (prior.agent === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = prior.agent;
			if (prior.config === undefined) delete process.env.PI_WEB_SEARCH_CONFIG;
			else process.env.PI_WEB_SEARCH_CONFIG = prior.config;
			await rm(root, { recursive: true, force: true });
		}
	});
}
