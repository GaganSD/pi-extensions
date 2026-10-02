import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { availableClassifiers } from "../src/index.ts";
import { configureJudgment } from "../src/providers/config.ts";
import { getJson, getText, postJson, postSseJson } from "../src/providers/http.ts";
import { createMcpClient } from "../src/providers/mcp.ts";
import { buildSourcegraphQuery } from "../src/providers/sourcegraph.ts";
import { hasSeenWelcome, markWelcomeSeen, welcomeStatePath } from "../src/welcome.ts";

async function listen(server: Server): Promise<string> {
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	assert.ok(address && typeof address === "object");
	return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
	server.closeAllConnections();
	await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test("fixed provider requests never follow redirects with keys, queries, or MCP sessions", async (t) => {
	let leakedRequests = 0;
	const destination = createServer((_req, res) => { leakedRequests++; res.end("{}"); });
	const target = await listen(destination);
	t.after(() => close(destination));
	const origin = createServer((req, res) => {
		req.resume();
		if (req.url === "/mcp" && req.method === "POST") {
			res.writeHead(200, { "Content-Type": "application/json", "Mcp-Session-Id": "synthetic-session" });
			res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-03-26" } }));
		} else {
			res.writeHead(307, { Location: target });
			res.end();
		}
	});
	const url = await listen(origin);
	t.after(() => close(origin));
	const headers = { "x-api-key": "synthetic-key", Authorization: "Bearer synthetic-token" };
	for (const request of [postJson, postSseJson, getJson, getText]) {
		await assert.rejects(request(url, { body: { query: "synthetic-query" }, headers, timeoutMs: 1000 }),
			(error: { code?: string }) => error.code === "network_error");
	}
	const client = createMcpClient({ url: `${url}/mcp`, headers, timeoutMs: 1000 });
	await client.initialize();
	await assert.rejects(client.close(), (error: { code?: string }) => error.code === "network_error");
	assert.equal(leakedRequests, 0);
});

test("welcome state creation preserves existing files and concurrent sessions", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-welcome-safe-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const configPath = join(dir, "web-search-welcome.json");
	const config = JSON.stringify({ web: { provider: "parallel" } });
	await writeFile(configPath, config);
	const marker = welcomeStatePath(configPath);
	assert.notEqual(marker, configPath);
	await Promise.all(Array.from({ length: 24 }, () => markWelcomeSeen(marker)));
	assert.equal(await hasSeenWelcome(marker), true);
	assert.equal(await readFile(configPath, "utf8"), config);
	// Even a caller that supplies an occupied path must not truncate it.
	await markWelcomeSeen(configPath);
	assert.equal(await readFile(configPath, "utf8"), config);
});

test("welcome state does not follow an existing symlink", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-welcome-link-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const victim = join(dir, "config.json");
	const marker = join(dir, "web-search-welcome.json");
	await writeFile(victim, "do not replace");
	try {
		await symlink(victim, marker, "file");
	} catch (error) {
		if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") {
			t.skip("Windows requires permission to create file symlinks");
			return;
		}
		throw error;
	}
	await markWelcomeSeen(marker);
	assert.equal(await readFile(victim, "utf8"), "do not replace");
});

test("Sourcegraph repo filters match one exact repository, not prefixes or regex wildcards", () => {
	for (const [repo, nearMiss] of [["facebook/react", "facebook/react-native"], ["vercel/next.js", "vercel/nextXjs"]]) {
		const query = buildSourcegraphQuery(`useState repo:${repo}`, 8);
		const quoted = query.match(/repo:("(?:\\.|[^"\\])*")/)?.[1];
		assert.ok(quoted);
		const pattern = new RegExp(JSON.parse(quoted));
		assert.equal(pattern.test(`github.com/${repo}`), true);
		assert.equal(pattern.test(`github.com/${nearMiss}`), false);
		assert.equal(pattern.test(`othergithub.com/${repo}`), false);
	}
});

test("classifier discovery bounds a signal-ignoring auth resolver", async () => {
	let observed: AbortSignal | undefined;
	const started = Date.now();
	await assert.rejects(availableClassifiers({
		getAvailableOfType: (_type: string, _provider: string | undefined, options: { signal: AbortSignal }) => {
			observed = options.signal;
			return new Promise(() => {});
		},
	} as never, undefined, 20), /Settings did not change.*provider\/model/);
	assert.equal(observed?.aborted, true);
	assert.ok(Date.now() - started < 2000);
});

test("classifier discovery respects cancellation before it probes auth", async () => {
	const controller = new AbortController();
	controller.abort();
	let called = false;
	await assert.rejects(availableClassifiers({
		getAvailableOfType: async () => { called = true; return []; },
	} as never, controller.signal), /discovery failed or stopped/);
	assert.equal(called, false);
});

test("enabling an existing classifier pin does not discover or change providers", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-classifier-pin-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const path = join(dir, "web-search.json");
	await writeFile(path, JSON.stringify({ jev: { enabled: false, provider: "openrouter", model: "~typesafe/jev-latest" } }));
	const previous = process.env.PI_WEB_SEARCH_CONFIG;
	process.env.PI_WEB_SEARCH_CONFIG = path;
	t.after(() => {
		if (previous === undefined) delete process.env.PI_WEB_SEARCH_CONFIG;
		else process.env.PI_WEB_SEARCH_CONFIG = previous;
	});
	await configureJudgment("on", () => { throw new Error("must not discover"); });
	assert.deepEqual(JSON.parse(await readFile(path, "utf8")).jev, {
		enabled: true, provider: "openrouter", model: "~typesafe/jev-latest",
	});
	await writeFile(path, "{}");
	await assert.rejects(configureJudgment("on", async () => { throw new Error("discovery failed"); }), /discovery failed/);
	assert.equal(await readFile(path, "utf8"), "{}", "failed discovery must not change configuration");
});
