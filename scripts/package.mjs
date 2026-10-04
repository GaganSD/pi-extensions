import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packageConfig } from "./packages.mjs";
import { isolatedEnvironment, isMain, npm, root, run } from "./lib.mjs";

export function validateContents(manifest, files) {
  assert(files.includes("package.json") && files.includes("README.md") && files.includes("LICENSE"));
  for (const file of files) {
    assert(!file.startsWith("/") && !file.split("/").includes(".."), `Unsafe archive path: ${file}`);
    assert(!/(^|\/)(node_modules|tests?|scripts|\.git|\.github|\.pi)(\/|$)/.test(file), `Development file shipped: ${file}`);
    assert(!/(^|\/)(\.env(?:\..*)?|\.npmrc|auth\.json|credentials(?:\.json)?|.*\.(?:pem|key))$/i.test(file), `Sensitive file shipped: ${file}`);
  }
  assert(manifest.pi?.extensions?.length > 0, "Missing Pi entrypoints");
  for (const entry of manifest.pi.extensions) assert(files.includes(entry.replace(/^\.\//, "")), `Missing entrypoint: ${entry}`);
  for (const hook of ["preinstall", "install", "postinstall"]) assert(!manifest.scripts?.[hook], `Unexpected install hook: ${hook}`);
}

if (isMain(import.meta.url)) {
  const [path] = process.argv.slice(2);
  const config = packageConfig(path), cwd = join(root, path);
  const directory = join(root, ".artifacts", path);
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  const temporary = mkdtempSync(join(tmpdir(), "pi-package-"));
  try {
    const packed = Object.values(JSON.parse(npm(["pack", "--json", "--ignore-scripts", "--pack-destination", directory], { cwd })));
    assert.equal(packed.length, 1);
    const metadata = packed[0];
    const manifest = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
    assert.equal(metadata.name, config.name);
    assert.equal(metadata.version, manifest.version);
    const files = metadata.files.map(file => file.path);
    validateContents(manifest, files);
    const archive = join(directory, metadata.filename);
    const listed = run("tar", ["-tzf", archive]).trim().split(/\r?\n/);
    assert.deepEqual(listed.sort(), files.map(file => "package/" + file).sort());
    const consumer = join(temporary, "consumer");
    mkdirSync(consumer);
    writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "pi-clean-consumer", private: true }));
    // Pi supplies its peers. Install only package runtime dependencies in this clean consumer.
    const env = isolatedEnvironment(temporary);
    npm(["install", archive, "--omit=dev", "--omit=peer", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: consumer, env, stdio: "inherit" });
    run(process.execPath, ["--experimental-import-meta-resolve", join(root, "scripts/artifact-smoke.mjs"), path, join(consumer, "node_modules", config.name)], { env, stdio: "inherit" });
    const integrity = "sha512-" + createHash("sha512").update(readFileSync(archive)).digest("base64");
    writeFileSync(join(directory, "manifest.json"), JSON.stringify({
      name: metadata.name, version: metadata.version, filename: metadata.filename, integrity,
    }, null, 2) + "\n");
    console.log(`Validated ${metadata.filename}: ${files.length} files, ${metadata.unpackedSize} bytes`);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}
