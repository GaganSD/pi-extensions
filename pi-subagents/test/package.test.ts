import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, symlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { temp } from "./helpers.ts";

const repo = fileURLToPath(new URL("../", import.meta.url));
test("packed package is public, contains no retired runtime, and loads with host peers", { skip: process.platform === "win32" }, async t => {
  const root = await temp(t);
  const output = execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", root], { cwd: repo, encoding: "utf8" });
  const [pack] = Object.values(JSON.parse(output)) as { filename: string; files: { path: string }[]; size: number }[];
  assert(pack);
  assert(pack.size < 100000);
  const files = pack.files.map(file => file.path);
  assert.deepEqual(files.filter(file => file.startsWith("agents/")).sort(), ["agents/reviewer.md", "agents/worker.md"]);
  assert(!files.some(file => file.startsWith("node_modules/") || file.startsWith("docs/") || file.endsWith(".html")));
  execFileSync("tar", ["-xzf", path.join(root, pack.filename), "-C", root]);
  const packaged = path.join(root, "package");
  const manifest = JSON.parse(await readFile(path.join(packaged, "package.json"), "utf8"));
  assert.equal(manifest.private, undefined);
  assert.equal(manifest.name, "@gagansd/pi-subagents");
  assert.deepEqual(Object.keys(manifest.exports), ["."]);
  assert.deepEqual(Object.keys(manifest.dependencies), ["yaml"]);
  assert.equal(manifest.bin, undefined);
  for (const peer of ["pi-ai", "pi-coding-agent", "pi-tui"]) {
    assert.equal(manifest.peerDependencies[`@earendil-works/${peer}`], "^1.0.0", "Pi minor/patch upgrades must remain installable");
    assert.deepEqual(manifest.peerDependenciesMeta[`@earendil-works/${peer}`], { optional: true });
  }
  const lock = JSON.parse(await readFile(path.join(repo, "package-lock.json"), "utf8"));
  assert.deepEqual(lock.packages[""].peerDependencies, manifest.peerDependencies);
  // Local dependencies are supplied explicitly, just as required for a local Pi
  // package. No SDK is placed beside it: Pi must resolve host peers itself.
  await mkdir(path.join(packaged, "node_modules"));
  await symlink(path.join(repo, "node_modules", "yaml"), path.join(packaged, "node_modules", "yaml"));
  const agentDir = path.join(root, "agent"), cwd = path.join(root, "workspace");
  await mkdir(agentDir); await mkdir(cwd);
  const loader = new DefaultResourceLoader({
    cwd, agentDir, settingsManager: SettingsManager.inMemory({}, { projectTrusted: true }),
    additionalExtensionPaths: [path.join(packaged, "index.ts")],
    noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true,
  });
  await loader.reload();
  const result = loader.getExtensions();
  assert.deepEqual(result.errors, [], JSON.stringify(result.errors));
  assert.equal(result.extensions.length, 1);
  assert.deepEqual([...result.extensions[0]!.tools.keys()], ["subagent"]);
  assert.deepEqual([...result.extensions[0]!.commands.keys()], ["subagents"]);
});
