import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const repo = dirname(root);
const cache = join(root, ".cache");
const config = JSON.parse(readFileSync(join(root, "config.json"), "utf8"));
const hash = data => createHash("sha256").update(data).digest("hex");
const configHash = hash(readFileSync(join(root, "config.json")));
const run = (command, args, cwd = repo) => execFileSync(command, args, {
  cwd, encoding: "utf8", maxBuffer: 20 * 1024 * 1024,
});
const globalModules = run("npm", ["root", "-g"]).trim();
const sdkRoot = join(globalModules, "@earendil-works/pi-coding-agent");
const sdkPath = join(sdkRoot, "dist/index.js");
const sdk = await import(pathToFileURL(sdkPath).href);
const ai = await import(pathToFileURL(join(sdkRoot, "node_modules/@earendil-works/pi-ai/dist/index.js")).href);
const agentDir = resolve(process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME, ".pi/agent"));
assert.equal(sdk.VERSION, config.pi_version, "Benchmark requires the pinned Pi version");
const runtime = await sdk.ModelRuntime.create({
  authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"), allowModelNetwork: false,
});
for (const model of Object.values(config.models)) {
  const physical = runtime.getPhysicalModel(model.provider, model.id);
  assert(physical, `Unavailable exact model: ${model.provider}/${model.id}`);
  assert(runtime.hasConfiguredAuth(model.provider), `Missing authentication: ${model.provider}`);
  assert(ai.getSupportedThinkingLevels(physical).includes(model.thinking),
    `Unsupported thinking: ${model.provider}/${model.id}:${model.thinking}`);
}

mkdirSync(cache, { recursive: true });
const manifestPath = join(cache, "manifest.json");
if (process.argv.includes("--check")) {
  assert(existsSync(manifestPath), "Run node benchmarks/prepare.mjs first");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert.equal(manifest.config_sha256, configHash, "Config changed after freezing; use a new benchmark campaign");
  assert.equal(manifest.pi_version, sdk.VERSION);
  for (const pkg of Object.values(manifest.packages)) {
    assert.equal(hash(readFileSync(resolve(root, pkg.archive))), pkg.archive_sha256, "Frozen archive changed");
    const metadata = JSON.parse(readFileSync(resolve(root, pkg.directory, "package.json"), "utf8"));
    assert.equal(metadata.name, pkg.name);
    assert.equal(metadata.version, pkg.version);
    for (const file of pkg.files) {
      assert.equal(hash(readFileSync(resolve(root, pkg.directory, file.path))), file.sha256,
        `Frozen package changed: ${file.path}`);
    }
  }
  console.log("Pinned packages, Pi, models, thinking levels, and auth configuration validated (no model calls).");
  process.exit(0);
}
assert(!existsSync(manifestPath), "A frozen campaign already exists. Use --check; never refreeze during a campaign.");

const source = join(cache, "upstream-source");
if (!existsSync(join(source, ".git"))) run("git", ["clone", "--no-checkout", config.upstream.repository, source]);
run("git", ["checkout", "--detach", config.upstream.commit], source);
assert.equal(run("git", ["rev-parse", "HEAD"], source).trim(), config.upstream.commit);
assert.equal(JSON.parse(readFileSync(join(source, "package.json"))).version, config.upstream.version);
run("npm", ["install", "--ignore-scripts", "--legacy-peer-deps", "--no-audit", "--no-fund"], source);
run(process.execPath, [join(source, "scripts/build-package.mjs")], source);

function freeze(key, directory, commit) {
  const archives = join(cache, "archives");
  mkdirSync(archives, { recursive: true });
  const [packed] = Object.values(JSON.parse(run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", archives], directory)));
  const archive = join(archives, packed.filename);
  const dest = join(cache, key);
  assert(!existsSync(dest), `Refuse to overwrite ${dest}`);
  mkdirSync(dest);
  run("tar", ["-xzf", archive, "--strip-components=1", "-C", dest]);
  const metadata = JSON.parse(readFileSync(join(dest, "package.json"), "utf8"));
  const files = packed.files.map(file => ({
    path: file.path, size: file.size, sha256: hash(readFileSync(join(dest, file.path))),
  }));
  run("npm", ["install", "--omit=dev", "--omit=peer", "--ignore-scripts", "--no-audit", "--no-fund"], dest);
  // npm may add lockfile metadata, but must not change any distributed file.
  for (const file of files) assert.equal(hash(readFileSync(join(dest, file.path))), file.sha256);
  return {
    name: packed.name, version: packed.version, source_commit: commit,
    directory: `.cache/${key}`, entrypoint: metadata.pi.extensions[0],
    archive: `.cache/archives/${packed.filename}`, archive_sha256: hash(readFileSync(archive)),
    packed_bytes: packed.size, unpacked_bytes: packed.unpackedSize, files,
    artifact_kind: "local release build; dependencies and host peers excluded from size",
  };
}
const manifest = {
  schema_version: 1, frozen_at: new Date().toISOString(), config_sha256: configHash,
  pi_version: sdk.VERSION, sdk_path: sdkPath, source_agent_dir: agentDir,
  packages: {
    ours: freeze("ours", join(repo, "pi-subagents"), run("git", ["rev-parse", "HEAD"]).trim()),
    upstream: freeze("upstream", join(source, "dist-pkg"), config.upstream.commit),
  },
};
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
for (const [name, model] of Object.entries(config.models)) {
  const dir = join(root, name, ".pi");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "settings.json"), JSON.stringify({
    defaultProvider: model.provider, defaultModel: model.id, defaultThinkingLevel: model.thinking,
  }, null, 2) + "\n");
}
console.log("Frozen both distributable artifacts. No live model calls made.");
for (const [key, pkg] of Object.entries(manifest.packages)) console.log(`${key}: ${pkg.unpacked_bytes} unpacked bytes`);
