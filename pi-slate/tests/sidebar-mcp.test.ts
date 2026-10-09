import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { getPackageDir, VERSION } from "@earendil-works/pi-coding-agent";
import { loadSidebarMcpHost } from "../extensions/pi-slate/sidebar-mcp.ts";
import { SidebarMcpFiles } from "../extensions/pi-slate/sidebar-data.ts";

// Run the same fixtures through actual pinned and installed native file parsers.
const installed = "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent";
const installedVersion = await readFile(join(installed, "package.json"), "utf8").then(text => (JSON.parse(text) as { version: string }).version).catch(() => "unavailable");
const packages = [[getPackageDir(), VERSION], [installed, installedVersion]] as const;
for (const [packageDir, version] of packages) {
  test(`MCP parity with native ${version}: exact names, invalid values, overrides, collisions and project auth`, async t => {
    const root = await mkdtemp(join(tmpdir(), "slate-mcp-parity-")); t.after(() => rm(root, { recursive: true, force: true }));
    const agentDir = join(root, "agent"), cwd = join(root, "repo"); await mkdir(agentDir); await mkdir(join(cwd, ".pi"), { recursive: true });
    let native: { loadMcpConfig: (options: { agentDir: string; cwd: string; projectTrusted: boolean }) => { servers: Array<{ name: string; config: { enabled?: boolean } }>; errors: string[] } };
    try { native = await import(pathToFileURL(join(packageDir, "dist/extensions/mcp/config.js")).href); }
    catch { if (packageDir !== getPackageDir()) { t.skip("operator host not installed here"); return; } throw new Error("pinned parser unavailable"); }
    const host = await loadSidebarMcpHost(packageDir, version); assert(host);
    const cache = new SidebarMcpFiles(); cache.setHost(host);
    const fixtures = [
      [{ x: { command: "server" } }, { x: { enabled: false } }],
      [{ x: { command: "server" } }, { x: { enabled: false, env: { SECRET: "SECRET" } } }],
      [{ x: { command: "server" } }, { x: { command: "replacement", args: 123 } }],
      [{ x: { command: "server" }, y: { command: "collision" } }, {}],
      [{ x: { url: "https://example.com", headers: { token: 123 } }, y: { url: "https://example.com", oauth: { callbackPort: -1, clientSecret: "SECRET" } } }, {}],
      [{}, { x: { url: "https://example.com", auth: { provider: "fixture" } } }],
      [{ x: { command: "server", enabled: false, exposure: "codemode-deferred" } }, {}],
    ];
    for (const [global, project] of fixtures) {
      await writeFile(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: global }));
      await writeFile(join(cwd, ".pi/mcp.json"), JSON.stringify({ mcpServers: project }));
      cache.clear();
      const loaded = native.loadMcpConfig({ agentDir, cwd, projectTrusted: true });
      const result = cache.snapshot(agentDir, cwd, true, []);
      if (loaded.errors.length) continue;
      const configured = new Set([...Object.keys(global), ...Object.keys(project)]);
      const nativeRows = loaded.servers.filter(row => configured.has(row.name)).map(row => [row.name, row.config.enabled !== false]).sort();
      if (!nativeRows.length) continue;
      assert.deepEqual(
        result.mcp.filter(row => row.enabled !== null && configured.has(row.name)).map(row => [row.name, row.enabled]).sort(),
        nativeRows,
      );
      assert(!JSON.stringify(result).includes("SECRET"));
    }
    await writeFile(join(agentDir, "mcp.json"), '{"mcpServers":{}}');
    await writeFile(join(cwd, ".pi/mcp.json"), '{"mcpServers":{"registered":{"enabled":false}}}'); cache.clear();
    assert.equal(cache.snapshot(agentDir, cwd, true, [{ name: "registered", config: { command: "server" } }]).mcp[0]!.enabled, true);
  });
}
test("unavailable host adapter never fabricates enabled/disabled state", async () => {
  assert.equal(await loadSidebarMcpHost("/missing", "unknown"), undefined);
  assert.equal(await loadSidebarMcpHost(getPackageDir(), "1.2.0"), undefined);
  const cache = new SidebarMcpFiles();
  const result = cache.snapshot("/missing", "/missing", false, [{ name: "registered", config: { command: "server" } }]);
  assert.equal(result.mcp[0]!.enabled, null); assert.match(result.mcpError!, /unavailable/);
});
