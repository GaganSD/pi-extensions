import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { affectedPackages, ciMatrix } from "./ci.mjs";
import { root } from "./lib.mjs";
import { packages } from "./packages.mjs";
import { validateContents } from "./package.mjs";
import { selectTests, testFiles } from "./test-package.mjs";

test("package changes select only their packages; shared changes select all", () => {
  assert.deepEqual(affectedPackages(["pi-ask/src/index.ts"]), ["pi-ask"]);
  assert.deepEqual(affectedPackages(["pi-slate/package.json", "pi-ask/tests/example.test.ts"]), ["pi-ask", "pi-slate"]);
  assert.deepEqual(affectedPackages(["README.md", "docs/releases.md"]), []);
  for (const file of ["package-lock.json", ".github/workflows/ci.yml", "scripts/packages.mjs", ".gitleaks.toml", ".release/plan.json"]) {
    assert.deepEqual(affectedPackages([file]), Object.keys(packages));
  }
});

test("the matrix adds cross-platform legs only when pi-web-search is affected", () => {
  const ask = ciMatrix(["pi-ask"]);
  assert.deepEqual(ask, [{ package: "pi-ask", os: "ubuntu-latest", node: "24", kind: "package" }]);

  const web = ciMatrix(["pi-web-search"]);
  const standard = web.filter(leg => leg.kind === "package");
  const compat = web.filter(leg => leg.kind === "compat");
  assert.deepEqual(standard, [{ package: "pi-web-search", os: "ubuntu-latest", node: "24", kind: "package" }]);
  assert.deepEqual(compat.map(leg => [leg.os, leg.node, leg.pi]), [
    ["ubuntu-latest", "22.19.0", "0.99.0"],
    ["windows-latest", "24.x", "0.99.0"],
    ["macos-latest", "24.x", "1.0.0"],
  ]);

  assert.deepEqual(ciMatrix([]), []);
});

test("test suites partition every test exactly once and contain real integration tests", () => {
  for (const [path, config] of Object.entries(packages)) {
    const files = testFiles(join(root, path, config.tests));
    const unit = selectTests(files, config.integration, "unit");
    const integration = selectTests(files, config.integration, "integration");
    assert.deepEqual([...unit, ...integration].sort(), files);
    assert.equal(new Set([...unit, ...integration]).size, files.length);
  }
  assert.throws(() => selectTests(["a.test.ts"], ["missing.test.ts"], "unit"), /Missing/);
  assert.throws(() => selectTests(["a.test.ts"], [], "integration"), /Empty/);
  assert.throws(() => selectTests([], [], "all"), /Expected/);
});

test("package content checks reject missing entrypoints, secrets and development files", () => {
  const manifest = { pi: { extensions: ["./src/index.ts"] } };
  const files = ["package.json", "README.md", "LICENSE", "src/index.ts"];
  validateContents(manifest, files);
  for (const extra of [".env", ".env.local", ".npmrc", "auth.json", "secrets/private.pem", "../secret", "/absolute", "node_modules/x.js", "scripts/publish.js", "tests/a.test.ts"]) {
    assert.throws(() => validateContents(manifest, [...files, extra]));
  }
  assert.throws(() => validateContents(manifest, files.slice(0, -1)), /entrypoint/);
  assert.throws(() => validateContents({ ...manifest, scripts: { postinstall: "anything" } }, files), /install hook/);
});
