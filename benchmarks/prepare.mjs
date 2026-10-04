import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { digest as hash, inventory, modelFingerprint } from "./runtime.mjs";

const root = dirname(fileURLToPath(import.meta.url)), repo = dirname(root), cache = join(root, ".cache");
const config = JSON.parse(readFileSync(join(root, "config.json"), "utf8"));
const configHash = hash(readFileSync(join(root, "config.json")));
const run = (command, args, cwd = repo) => execFileSync(command, args, { cwd, encoding: "utf8", maxBuffer: 40 * 1024 * 1024 });
const manifestPath = join(cache, "manifest.json");
const existing = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : undefined;
const piEntry = realpathSync(run("which", ["pi"]).trim());
let sdkRoot = dirname(piEntry);
while (!existsSync(join(sdkRoot, "package.json"))) {
  const parent = dirname(sdkRoot);
  assert.notEqual(parent, sdkRoot, "Cannot find the actual Pi CLI's npm package");
  sdkRoot = parent;
}
assert.equal(JSON.parse(readFileSync(join(sdkRoot, "package.json"))).name, "@earendil-works/pi-coding-agent");
const sdkPath = join(sdkRoot, "dist/index.js");
const sdk = await import(pathToFileURL(sdkPath).href);
const ai = await import(pathToFileURL(join(sdkRoot, "node_modules/@earendil-works/pi-ai/dist/index.js")).href);
const agentDir = existing?.source_agent_dir ?? resolve(process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME, ".pi/agent"));
assert.equal(sdk.VERSION, config.pi_version, "Benchmark requires the pinned Pi version");
const modelRuntime = await sdk.ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"), allowModelNetwork: false });
const routes = {};
for (const [key, model] of Object.entries(config.models)) {
  const physical = modelRuntime.getPhysicalModel(model.provider, model.id);
  assert(physical, `Unavailable exact model: ${model.provider}/${model.id}`);
  assert(modelRuntime.hasConfiguredAuth(model.provider), `Missing authentication: ${model.provider}`);
  const levels = ai.getSupportedThinkingLevels(physical);
  assert(levels.includes(model.thinking), `Unsupported thinking: ${model.provider}/${model.id}:${model.thinking}`);
  routes[key] = JSON.parse(JSON.stringify(modelFingerprint(physical, levels)));
}
const protocolPaths = ["config.json", "README.md", ...readdirSync(root).filter(name => /\.(py|mjs|cjs|ts)$/.test(name)),
  ...readdirSync(join(root, "scenarios")).map(name => `scenarios/${name}`),
  ...Object.keys(config.models).flatMap(key => readdirSync(join(root, key)).filter(name => name.endsWith(".txt")).map(name => `${key}/${name}`))].sort();
const protocol = Object.fromEntries(protocolPaths.map(path => [path, hash(readFileSync(join(root, path)))]));
const runtime = { node_executable: realpathSync(process.execPath), node_version: process.version,
  pi_entrypoint: piEntry, pi_version: sdk.VERSION, sdk_path: sdkPath, sdk_root: sdkRoot,
  node_sha256: hash(readFileSync(process.execPath)), sdk_inventory: inventory(sdkRoot) };

function checkArtifacts(manifest) {
  assert.equal(manifest.config_sha256, configHash, "Config changed; a new campaign is required");
  for (const pkg of Object.values(manifest.packages)) {
    assert.equal(hash(readFileSync(resolve(root, pkg.archive))), pkg.archive_sha256, "Archive changed");
    for (const file of pkg.files) assert.equal(hash(readFileSync(resolve(root, pkg.directory, file.path))), file.sha256, `Distributed file changed: ${file.path}`);
  }
}
function checkSealed(manifest) {
  assert.equal(manifest.schema_version, 2, "Protocol/runtime not sealed; do not run scored trials");
  checkArtifacts(manifest);
  assert.deepEqual(protocol, manifest.protocol_sha256, "Protocol changed, including added/removed files; do not mix campaigns");
  assert.deepEqual(inventory(join(cache, "protocol")), manifest.frozen_protocol_inventory, "Frozen protocol changed");
  assert.deepEqual(runtime, manifest.runtime, "Pi/Node executable, SDK, or dependency runtime changed");
  assert.deepEqual(routes, manifest.model_routes, "Resolved model routing/capabilities changed");
  for (const pkg of Object.values(manifest.packages)) assert.deepEqual(inventory(resolve(root, pkg.directory)), pkg.runtime_inventory, "Installed package dependencies/resources changed");
}
function seal(manifest) {
  for (const key of Object.keys(config.models)) assert(!existsSync(join(root, key, "results/episodes")), "Cannot reseal after scored collection begins");
  checkArtifacts(manifest);
  const frozen = join(cache, "protocol");
  rmSync(frozen, { recursive: true, force: true });
  mkdirSync(frozen, { recursive: true });
  for (const path of protocolPaths) { mkdirSync(dirname(join(frozen, path)), { recursive: true }); cpSync(join(root, path), join(frozen, path)); }
  for (const pkg of Object.values(manifest.packages)) pkg.runtime_inventory = inventory(resolve(root, pkg.directory));
  Object.assign(manifest, { schema_version: 2, sealed_at: new Date().toISOString(), protocol_sha256: protocol,
    frozen_protocol_inventory: inventory(frozen), runtime, model_routes: routes, source_home: process.env.HOME });
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  console.log("Sealed protocol, exact CLI/Node/SDK, dependencies, and sanitized model routes. No model calls.");
}
mkdirSync(cache, { recursive: true });
if (process.argv.includes("--check")) { assert(existing, "Run preparation first"); checkSealed(existing); console.log("Sealed campaign validated. No model calls."); process.exit(0); }
if (process.argv.includes("--seal")) { assert(existing, "Freeze artifacts first"); seal(existing); process.exit(0); }
assert(!existing, "Artifacts already frozen. Use --check; --seal is only allowed before scored collection.");

const source = join(cache, "upstream-source");
if (!existsSync(join(source, ".git"))) run("git", ["clone", "--no-checkout", config.upstream.repository, source]);
run("git", ["checkout", "--detach", config.upstream.commit], source);
assert.equal(run("git", ["rev-parse", "HEAD"], source).trim(), config.upstream.commit);
assert.equal(JSON.parse(readFileSync(join(source, "package.json"))).version, config.upstream.version);
run("npm", ["install", "--ignore-scripts", "--legacy-peer-deps", "--no-audit", "--no-fund"], source);
run(process.execPath, [join(source, "scripts/build-package.mjs")], source);
function freeze(key, directory, commit) {
  const archives = join(cache, "archives"); mkdirSync(archives, { recursive: true });
  const [packed] = Object.values(JSON.parse(run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", archives], directory)));
  const archive = join(archives, packed.filename), dest = join(cache, key);
  assert(!existsSync(dest), `Refuse to overwrite ${dest}`); mkdirSync(dest);
  run("tar", ["-xzf", archive, "--strip-components=1", "-C", dest]);
  const metadata = JSON.parse(readFileSync(join(dest, "package.json"), "utf8"));
  const files = packed.files.map(file => ({ path: file.path, size: file.size, sha256: hash(readFileSync(join(dest, file.path))) }));
  run("npm", ["install", "--omit=dev", "--omit=peer", "--ignore-scripts", "--no-audit", "--no-fund"], dest);
  return { name: packed.name, version: packed.version, source_commit: commit, directory: `.cache/${key}`,
    entrypoint: metadata.pi.extensions[0], archive: `.cache/archives/${packed.filename}`, archive_sha256: hash(readFileSync(archive)),
    packed_bytes: packed.size, unpacked_bytes: packed.unpackedSize, files,
    artifact_kind: "local release build; dependencies and host peers excluded from size" };
}
const manifest = { frozen_at: new Date().toISOString(), config_sha256: configHash, pi_version: sdk.VERSION,
  source_agent_dir: agentDir, packages: {
    ours: freeze("ours", join(repo, "pi-subagents"), run("git", ["rev-parse", "HEAD"]).trim()),
    upstream: freeze("upstream", join(source, "dist-pkg"), config.upstream.commit) } };
seal(manifest);
for (const [key, model] of Object.entries(config.models)) {
  const dir = join(root, key, ".pi"); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ defaultProvider: model.provider, defaultModel: model.id, defaultThinkingLevel: model.thinking }, null, 2) + "\n");
}
