import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { root } from "./lib.mjs";

const available = spawnSync("gitleaks", ["version"]).status === 0;
const scanArgs = ["git", "--pre-commit", "--staged", "--redact", "--no-banner", "--config", join(root, ".gitleaks.toml")];
if (process.env.REQUIRE_GITLEAKS === "1") assert(available, "The secret-scanning job must install Gitleaks");

test("Gitleaks blocks a synthetic staged credential without printing it", { skip: !available }, () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-secret-test-"));
  try {
    assert.equal(spawnSync("git", ["init", "-q", directory]).status, 0);
    // Construct an intentionally invalid token at runtime; never store real credentials.
    const value = ["ghp", "AbCdEf0123456789AbCdEf0123456789AbCdEf"].join("_");
    writeFileSync(join(directory, "example.txt"), "token=" + value + "\n");
    assert.equal(spawnSync("git", ["-C", directory, "add", "example.txt"]).status, 0);
    const result = spawnSync("gitleaks", [...scanArgs, directory], { encoding: "utf8" });
    assert.equal(result.status, 1, result.stderr);
    assert(!result.stdout.includes(value) && !result.stderr.includes(value), "Secret must be redacted");
    writeFileSync(join(directory, "example.txt"), "ordinary text\n");
    spawnSync("git", ["-C", directory, "add", "example.txt"]);
    assert.equal(spawnSync("gitleaks", [...scanArgs, directory]).status, 0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
