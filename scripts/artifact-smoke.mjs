import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { packageConfig } from "./packages.mjs";
import { root } from "./lib.mjs";

const [path, installed] = process.argv.slice(2);
const config = packageConfig(path);
const host = import.meta.resolve("@earendil-works/pi-coding-agent", pathToFileURL(join(root, path, "package.json")).href);
globalThis.fetch = async () => { throw new Error("Artifact smoke must not access the network"); };
const { discoverAndLoadExtensions, getAgentDir } = await import(host);
const result = await discoverAndLoadExtensions([resolve(installed)], resolve(installed), getAgentDir());
assert.deepEqual(result.errors, [], "Packed TypeScript entrypoint must load with its host");
assert.deepEqual(result.warnings ?? [], []);
assert.equal(result.extensions.length, 1);
const extension = result.extensions[0];
for (const name of config.tools) assert(extension.tools.has(name), `Missing tool: ${name}`);
for (const name of config.commands) assert(extension.commands.has(name), `Missing command: ${name}`);
console.log(`Clean-consumer Pi registration passed: ${config.name}`);
