import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { formatWebSearchResult } from "../src/format.ts";
import { previewEvidence, uniqueEvidence } from "../src/providers/results.ts";
import { isolatedEnvironment, runCommand, withTemporaryDirectory } from "./validation.ts";

const script = fileURLToPath(import.meta.url);
const packageRoot = resolve(dirname(script), "..");

/** Host-built tools/system prompt, not hand-counted schema source. No network or model calls. */
export async function measureFootprint(extensionRoot = packageRoot) {
	const root = await mkdtemp(join(tmpdir(), "search-footprint-"));
	const prior = { agent: process.env.PI_CODING_AGENT_DIR, config: process.env.PI_WEB_SEARCH_CONFIG };
	const samples: Record<string, { declarations: number; prompt: string; tools: string[]; continuationSchema: number }> = {};
	try {
		for (const mode of ["baseline", "default", "research"] as const) {
			const dir = join(root, mode);
			await mkdir(dir);
			process.env.PI_CODING_AGENT_DIR = dir;
			process.env.PI_WEB_SEARCH_CONFIG = join(dir, "web-search.json");
			await writeFile(join(dir, "auth.json"), "{}");
			await writeFile(process.env.PI_WEB_SEARCH_CONFIG, JSON.stringify({ research: { enabled: mode === "research" } }));
			const settingsManager = SettingsManager.inMemory({ defaultTools: [], compaction: { enabled: false } });
			const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager,
				noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
				additionalExtensionPaths: mode === "baseline" ? [] : [extensionRoot] });
			await loader.reload();
			if (loader.getExtensions().errors.length) throw new Error(JSON.stringify(loader.getExtensions().errors));
			const modelRuntime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: join(dir, "models.json") });
			const { session } = await createAgentSession({ cwd: dir, agentDir: dir, resourceLoader: loader, settingsManager, modelRuntime, sessionManager: SessionManager.inMemory(dir) });
			try {
				const active = session.agent.state.tools.filter((tool) => ["web_search", "code_search", "multi_search"].includes(tool.name));
				const declarations = JSON.stringify(active.map(({ name, description, parameters }) => ({ name, description, parameters }))).length;
				const continuation = session.getAllTools().find((tool) => tool.name === "search_read");
				samples[mode] = { declarations, prompt: session.systemPrompt, tools: active.map((tool) => tool.name), continuationSchema: continuation ? JSON.stringify(continuation.parameters).length : 0 };
			} finally { session.dispose(); }
		}
		const modes = Object.fromEntries(["default", "research"].map((mode) => {
			const sample = samples[mode];
			// Baseline has a different temporary cwd spelling; strip it before measuring deltas.
			const promptDelta = sample.prompt.replaceAll(join(root, mode), "<cwd>").length - samples.baseline.prompt.replaceAll(join(root, "baseline"), "<cwd>").length;
			const chars = sample.declarations - samples.baseline.declarations + promptDelta;
			return [mode, { tools: sample.tools, declarationChars: sample.declarations, promptDeltaChars: promptDelta, estimatedTokens: Math.ceil(chars / 4), continuationSchemaChars: sample.continuationSchema }];
		}));
		const fixture = uniqueEvidence({ text: "", providerKind: "exa" as const, searchResults: Array.from({ length: 24 }, (_, index) => ({ title: `Document ${index}`, url: `https://example.com/${index}`, citedText: "Evidence. ".repeat(1000) })) });
		const formatted = formatWebSearchResult(previewEvidence(fixture, 8));
		const directChars = formatted.content.map((part) => part.type === "text" ? part.text.length : 0).reduce((a, b) => a + b, 0);
		const structuredChars = JSON.stringify(formatted.structuredContent).length;
		return { method: "Pi SDK declarations + system-prompt delta; ceil(chars/4), not provider tokenizer billing. Output schema is programmatic, not included in direct tool declarations. MCP service connection is not started.", modes, result: { previewCount: formatted.details.resultCount, directChars, structuredChars } };
	} finally {
		if (prior.agent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prior.agent;
		if (prior.config === undefined) delete process.env.PI_WEB_SEARCH_CONFIG; else process.env.PI_WEB_SEARCH_CONFIG = prior.config;
		await rm(root, { recursive: true, force: true });
	}
}

if (process.argv[1] === script) {
	if (process.argv[2] === "--child") console.log(JSON.stringify(await measureFootprint(process.argv[3] ? resolve(process.argv[3]) : packageRoot), null, 2));
	else withTemporaryDirectory("search-footprint-env-", (root) => {
		process.stdout.write(runCommand(process.execPath, ["--experimental-strip-types", script, "--child", ...(process.argv[2] ? [resolve(process.argv[2])] : [])], root, isolatedEnvironment(root)));
	});
}
