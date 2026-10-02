import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	createAgentSession, createCodemodeExtension, createMcpExtension, DefaultResourceLoader,
	ModelRuntime, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { isolatedEnvironment, runCommand, withTemporaryDirectory } from "./validation.ts";

const script = fileURLToPath(import.meta.url);
const sourceRoot = resolve(dirname(script), "..");

// Opt-in live requests only. Never use the operator's config, keys, or gh login.
if (process.argv[2] !== "--child") {
	const artifact = resolve(process.argv[2] ?? sourceRoot);
	withTemporaryDirectory("pi-web-search-live space-", (root) => {
		const env = { ...isolatedEnvironment(root), PI_OFFLINE: "1", NODE_TEST_CONTEXT: "live-smoke" };
		process.stdout.write(runCommand(process.execPath,
			["--experimental-strip-types", script, "--child", artifact], root, env));
	});
} else {
	const artifact = resolve(process.argv[3]);
	const root = process.env.PI_CODING_AGENT_DIR!;
	const configPath = process.env.PI_WEB_SEARCH_CONFIG!;
	const save = (config: object) => writeFileSync(configPath, JSON.stringify(config));
	save({ research: { enabled: true } });
	writeFileSync(join(root, "auth.json"), "{}");
	const settingsManager = SettingsManager.inMemory({ defaultTools: ["web_search", "code_search", "multi_search"],
		compaction: { enabled: false }, retry: { enabled: false } });
	const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager,
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
		additionalExtensionPaths: [artifact],
		extensionFactories: [createMcpExtension(), createCodemodeExtension()],
	});
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	const modelRuntime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: join(root, "models.json") });
	const { session } = await createAgentSession({ cwd: root, agentDir: root, resourceLoader: loader,
		settingsManager, modelRuntime, sessionManager: SessionManager.inMemory(root) });
	try {
		await session.bindExtensions({});
		const cases: Array<{ name: string; tool: string; provider?: string; config: object; args: Record<string, string | string[]> }> = [
			{ name: "default web and URL extraction", tool: "web_search", provider: "exa", config: {},
				args: { query: "Node.js AbortSignal.timeout documentation", urls: ["https://nodejs.org/api/globals.html"] } },
			{ name: "default code", tool: "code_search", provider: "grep", config: {}, args: { query: "useSyncExternalStore" } },
			{ name: "scoped Sourcegraph", tool: "code_search", provider: "sourcegraph", config: { code: { provider: "sourcegraph", fallback: [] } },
				args: { query: "createServer repo:nodejs/node" } },
			{ name: "native Parallel search and extraction", tool: "web_search", provider: "parallel", config: { web: { provider: "parallel", fallback: [] } },
				args: { query: "Node.js AbortSignal.timeout documentation", urls: ["https://nodejs.org/api/globals.html"] } },
			{ name: "multi-source code", tool: "multi_search", config: { research: { enabled: true } },
				args: { query: "useSyncExternalStore", scope: "code" } },
		];
		for (const [index, sample] of cases.entries()) {
			save({ ...sample.config, timeoutMs: 15_000 });
			const id = `live-smoke-${index}`;
			session.sessionManager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id, name: sample.tool, arguments: sample.args }],
				api: "openai-responses", provider: "openai", model: "fixture", stopReason: "toolUse", timestamp: Date.now(),
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
			session.refreshContext();
			const started = Date.now();
			const ctx = session.extensionRunner.createToolContext(id, AbortSignal.timeout(20_000));
			const response = await ctx.executeTool(sample.tool, sample.args);
			const data = response.result.structuredContent as {
				provider?: string; resultCount?: number; warnings?: string[]; error?: unknown;
				searchResults?: Array<{ url?: string; type?: string; citedText?: string }>;
			};
			console.log(JSON.stringify({ check: sample.name, ms: Date.now() - started, provider: data.provider,
				count: data.resultCount, warnings: data.warnings, error: data.error }));
			assert.equal(response.isError, false, `${sample.name} failed`);
			if (sample.provider) assert.equal(data.provider, sample.provider, `${sample.name} used a fallback instead`);
			assert.ok((data.resultCount ?? 0) > 0, `${sample.name} returned no evidence`);
			if (Array.isArray(sample.args.urls)) {
				const requested = sample.args.urls;
				assert.ok(data.searchResults?.some((hit) => hit.url && requested.includes(hit.url) &&
					["extract", "content"].includes(hit.type ?? "") && hit.citedText), "URL extraction missing");
			}
			if (sample.name === "scoped Sourcegraph") {
				assert.ok(data.searchResults?.every((hit) => hit.url?.startsWith("https://github.com/nodejs/node/blob/")));
			}
		}
	} finally {
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		session.dispose();
	}
}
