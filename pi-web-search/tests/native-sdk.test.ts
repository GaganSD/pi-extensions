import assert from "node:assert/strict";
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

for (const judge of [false, true]) {
	test(`Pi SDK local MCP override runs package search/fetch${judge ? " and optional classifier" : " anonymously"}`, { timeout: 20000 }, async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-native-sdk-search-"));
		const configPath = join(root, "web-search.json");
		const callsPath = join(root, "mcp-calls.jsonl");
		const prior = { agent: process.env.PI_CODING_AGENT_DIR, config: process.env.PI_WEB_SEARCH_CONFIG, fetch: globalThis.fetch };
		// Research appends Exa even with fallback: []; fail offline rather than reaching a live endpoint.
		globalThis.fetch = async () => { throw new Error("offline MCP fixture"); };
		process.env.PI_CODING_AGENT_DIR = root;
		process.env.PI_WEB_SEARCH_CONFIG = configPath;
		let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
		try {
			await writeFile(join(root, "auth.json"), "{}");
			await writeFile(configPath, JSON.stringify({ web: { provider: "parallel", fallback: [] },
				research: { enabled: judge }, jev: { enabled: judge }, timeoutMs: 5000, maxResults: 2 }));
			// The explicit same-name user config wins over the extension's remote registration.
			await writeFile(join(root, "mcp.json"), JSON.stringify({ mcpServers: { [PARALLEL_MCP_SERVER]: {
				command: process.execPath, args: [fixture, callsPath], exposure: "codemode-deferred",
			} } }));
			const settingsManager = SettingsManager.inMemory({ defaultTools: ["web_search", ...(judge ? ["research_search"] : [])],
				compaction: { enabled: false }, retry: { enabled: false } });
			const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager,
				noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
				additionalExtensionPaths: [packageRoot],
				extensionFactories: [createMcpExtension(), createCodemodeExtension()],
			});
			await loader.reload();
			assert.deepEqual(loader.getExtensions().errors, []);
			const modelRuntime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: join(root, "models.json") });
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
			let classifyCalls = 0;
			if (judge) {
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
				const judged = await ctx.executeTool("research_search", { query, scope: "web" });
				assert.equal(judged.isError, false, JSON.stringify(judged.result));
				assert.equal((judged.result.structuredContent as { jevStatus?: string }).jevStatus, "ran");
				assert.equal(judged.result.usage?.totalTokens, 11, "own classifier usage reaches AgentToolResult");
				assert.equal(classifyCalls, 1);
			}
			const calls = (await readFile(callsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
			assert.deepEqual(calls.slice(0, 2).map((call) => call.name), ["web_search", "web_fetch"]);
			assert.equal(calls[0].args.session_id, calls[1].args.session_id);
			assert.equal(calls[0].args.model_name, undefined, "Pi fallback model is not an analytics identity");
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
