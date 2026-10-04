import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packageConfig } from "./packages.mjs";
import { isolatedEnvironment, isMain, root, run } from "./lib.mjs";

export function testFiles(directory, prefix = "") {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const relative = prefix + entry.name;
    return entry.isDirectory() ? testFiles(join(directory, entry.name), relative + "/")
      : /\.test\.(ts|mjs)$/.test(entry.name) ? [relative] : [];
  }).sort();
}

export function selectTests(files, integration, suite) {
  if (!["unit", "integration"].includes(suite)) throw new Error("Expected unit or integration");
  for (const file of integration) {
    if (!files.includes(file)) throw new Error(`Missing integration test: ${file}`);
  }
  const selected = files.filter(file => integration.includes(file) === (suite === "integration"));
  if (!selected.length) throw new Error(`Empty ${suite} suite`);
  return selected;
}

if (isMain(import.meta.url)) {
  const [path, suite] = process.argv.slice(2);
  const config = packageConfig(path), cwd = join(root, path);
  const directory = join(cwd, config.tests);
  const files = selectTests(testFiles(directory), config.integration, suite).map(file => join(directory, file));
  const temporary = mkdtempSync(join(tmpdir(), "pi-ci-tests-"));
  try {
    run(process.execPath, ["--experimental-strip-types", "--test", ...files], {
      cwd, env: isolatedEnvironment(temporary), stdio: "inherit",
    });
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}
