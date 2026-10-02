import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { discoverAndLoadExtensions, getAgentDir } from "@earendil-works/pi-coding-agent";

const packageRoot = resolve(process.argv[2]);
assert.ok(!existsSync(join(packageRoot, "node_modules")), "Smoke load must use only Pi's host-provided modules");
const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
const configPath = process.env.PI_WEB_SEARCH_CONFIG;
assert.ok(configPath, "Smoke load requires an isolated config path");
// No tool executes, and any unexpected network request fails immediately.
globalThis.fetch = async () => { throw new Error("Package smoke validation must not access the network"); };
for (const researchEnabled of [false, true]) {
	writeFileSync(configPath, JSON.stringify({ research: { enabled: researchEnabled } }));
	const loaded = await discoverAndLoadExtensions([packageRoot], packageRoot, getAgentDir());
	assert.deepEqual(loaded.errors, [], "Pi must load the packed source entrypoint without compilation");
	assert.deepEqual(loaded.warnings, []);
	assert.equal(loaded.extensions.length, 1);
	const extension = loaded.extensions[0];
	assert.equal(extension.resolvedPath, resolve(packageRoot, manifest.pi.extensions[0]));
	assert.deepEqual([...extension.tools.keys()], researchEnabled
		? ["web_search", "code_search", "multi_search"] : ["web_search", "code_search"]);
	assert.ok(extension.commands.has("web-search-settings"));
}
console.log("Packed TypeScript entrypoint loads in Pi without local dependencies; default and research registrations pass.");
