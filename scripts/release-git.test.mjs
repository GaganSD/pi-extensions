import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { isolatedEnvironment, root } from "./lib.mjs";
import { packages } from "./packages.mjs";
import { checkRelease, makePlan, releaseFiles, selections } from "./release.mjs";

test("release checker validates actual git commits and treats subsequent normal merges as non-releases", () => {
  const temporary = mkdtempSync(join(tmpdir(), "pi-release-git-"));
  const directory = join(temporary, "repo");
  mkdirSync(directory);
  const env = isolatedEnvironment(temporary);
  const git = (...args) => execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd: directory, env, encoding: "utf8" }).trim();
  const write = (path, value) => {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), value);
  };
  const read = (path, optional) => {
    try { return readFileSync(join(directory, path), "utf8"); }
    catch (error) { if (optional && error.code === "ENOENT") return undefined; throw error; }
  };
  try {
    git("init", "-q");
    git("config", "user.name", "Release fixture");
    git("config", "user.email", "fixture@example.invalid");
    cpSync(join(root, "scripts"), join(directory, "scripts"), { recursive: true });
    for (const [path, { name }] of Object.entries(packages)) {
      write(path + "/package.json", JSON.stringify({ name, version: "1.0.0" }));
      write(path + "/package-lock.json", JSON.stringify({ name, version: "1.0.0", packages: { "": { name, version: "1.0.0" } } }));
    }
    git("add", ".");
    git("commit", "-qm", "fixture");
    const base = git("rev-parse", "HEAD");
    const plan = makePlan(base, selections(["pi-ask:patch"]), "Fixture release.", read);
    for (const [path, value] of Object.entries(releaseFiles(plan, read))) write(path, value);
    git("add", ".");
    git("commit", "-qm", "release");
    const released = git("rev-parse", "HEAD");
    const check = (from, to) => spawnSync(process.execPath, [join(directory, "scripts/release.mjs"), "check", from, to], { env, encoding: "utf8" });
    const result = check(base, released);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /release=true/);
    write("pi-ask/src/example.ts", "export const example = true;\n");
    git("add", ".");
    git("commit", "-qm", "normal change");
    const ordinary = check(released, git("rev-parse", "HEAD"));
    assert.equal(ordinary.status, 0, ordinary.stderr);
    assert.match(ordinary.stdout, /release=false/);
    // Pure checker proves the inverse against actual Git objects; no registry writes.
    git("revert", "--no-edit", released);
    const cancelled = checkRelease(git("rev-parse", "HEAD^1"), git("rev-parse", "HEAD"),
      sha => (path, optional) => {
        if (optional && !git("ls-tree", "--name-only", sha, "--", path)) return undefined;
        return execFileSync("git", ["show", `${sha}:${path}`], { cwd: directory, env, encoding: "utf8" });
      },
      (from, to) => git("diff", "--name-only", from, to).split("\n"));
    assert.deepEqual(cancelled, { cancelled: plan });
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});
