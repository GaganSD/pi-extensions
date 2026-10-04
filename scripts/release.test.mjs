import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { packages } from "./packages.mjs";
import { bumpVersion, checkRelease, isReleasePullRequest, makePlan, planPath, publicationState, releaseFiles, repository, selections, validatePlan, verifyArtifact, verifyUnpublished } from "./release.mjs";

const base = "a".repeat(40), head = "b".repeat(40);
function fixture() {
  const before = {};
  for (const [path, { name }] of Object.entries(packages)) {
    before[path + "/package.json"] = JSON.stringify({ name, version: "0.1.2", scripts: { test: "node --test" } });
    before[path + "/package-lock.json"] = JSON.stringify({
      name, version: "0.1.2", lockfileVersion: 3,
      packages: { "": { name, version: "0.1.2" }, "node_modules/example": { version: "1.0.0", integrity: "unchanged" } },
    });
  }
  before["pi-ask/CHANGELOG.md"] = "# Changelog\n\n## Unreleased\n\n- Pending fix\n\n## 0.1.2\n\n- Old release\n";
  const plan = makePlan(base, selections(["pi-ask:patch", "pi-slate:minor"]), "- Release summary", path => before[path]);
  const after = { ...before, ...releaseFiles(plan, path => before[path]) };
  const changed = Object.keys(after).filter(path => after[path] !== before[path]);
  const check = () => checkRelease(base, head, sha => path => (sha === base ? before : after)[path], () => [...changed]);
  return { before, after, plan, changed, check };
}

test("stable semver bumps are explicit, including 0.x breaking changes", () => {
  assert.equal(bumpVersion("0.1.2", "patch"), "0.1.3");
  assert.equal(bumpVersion("0.1.2", "minor"), "0.2.0");
  assert.equal(bumpVersion("0.1.2", "major"), "1.0.0");
  for (const version of ["v1.0.0", "1.0.0-next.1", "01.0.0", "1.2", "9007199254740991.0.0"]) {
    assert.throws(() => bumpVersion(version, "major"));
  }
  assert.throws(() => bumpVersion("1.2.3", "latest"));
});

test("package selections are allowlisted, sorted, and reject ambiguous duplicates", () => {
  assert.deepEqual(selections(["pi-slate:minor", "pi-ask"], "patch"), [
    { path: "pi-ask", bump: "patch" }, { path: "pi-slate", bump: "minor" },
  ]);
  for (const input of [[], ["../pi-ask:patch"], ["pi-ask:patch:extra"], ["pi-ask"], ["pi-ask:patch", "pi-ask:minor"], ["toString:patch"]]) {
    assert.throws(() => selections(input));
  }
});

test("release generation is deterministic and preserves dependency resolutions and released notes", () => {
  const { plan, before, after, check } = fixture();
  assert.deepEqual(releaseFiles(plan, path => before[path]), releaseFiles(plan, path => before[path]));
  assert.deepEqual(check(), plan);
  assert.equal(JSON.parse(after["pi-ask/package.json"]).version, "0.1.3");
  const lock = JSON.parse(after["pi-slate/package-lock.json"]);
  assert.equal(lock.version, "0.2.0");
  assert.equal(lock.packages[""].version, "0.2.0");
  assert.deepEqual(lock.packages["node_modules/example"], JSON.parse(before["pi-slate/package-lock.json"]).packages["node_modules/example"]);
  assert.match(after["pi-ask/CHANGELOG.md"], /## Unreleased\n\n## 0.1.3\n\n- Release summary\n\n- Pending fix/);
  assert(after["pi-ask/CHANGELOG.md"].endsWith("## 0.1.2\n\n- Old release\n"));
  assert.match(after["pi-slate/CHANGELOG.md"], /# Changelog\n\n## 0.2.0/);
});

test("release metadata is strictly validated", () => {
  const { plan } = fixture();
  for (const mutate of [
    p => { p.schema = 2; },
    p => { p.sourceSha = "main"; },
    p => { p.notes = ""; },
    p => { p.extra = true; },
    p => { p.packages = []; },
    p => { p.packages.reverse(); },
    p => { p.packages[0].to = "99.0.0"; },
    p => { p.packages[0].name = "@other/package"; },
    p => { p.packages[0].path = "../pi-ask"; },
    p => { p.packages.push(p.packages[0]); },
  ]) {
    const copy = structuredClone(plan);
    mutate(copy);
    assert.throws(() => validatePlan(copy));
  }
});

test("stale release plans, modified generated files, and bundled code changes fail closed", () => {
  {
    const { after, check } = fixture();
    const plan = JSON.parse(after[planPath]);
    plan.sourceSha = "c".repeat(40);
    after[planPath] = JSON.stringify(plan);
    assert.throws(check, /Trunk moved/);
  }
  {
    const { after, check } = fixture();
    after["pi-ask/package.json"] = after["pi-ask/package.json"].replace("node --test", "malicious");
    assert.throws(check, /differs from the plan/);
  }
  {
    const { changed, check } = fixture();
    changed.push("pi-ask/src/index.ts");
    assert.throws(check, /only change/);
  }
});

test("ordinary PRs never release; manual version bumps are rejected", () => {
  const { before } = fixture();
  const after = structuredClone(before);
  const check = () => checkRelease(base, head, sha => path => (sha === base ? before : after)[path], () => ["pi-ask/src/index.ts"]);
  assert.equal(check(), null);
  after["pi-ask/package.json"] = JSON.stringify({ name: packages["pi-ask"].name, version: "0.1.3" });
  assert.throws(check, /Version changes require a release plan/);
});

test("only a merged release PR in this repository authorizes publication", () => {
  const pr = {
    merged_at: "2026-10-04T00:00:00Z", merge_commit_sha: head,
    base: { ref: "main", repo: { full_name: repository } },
    head: { ref: "release/next", repo: { full_name: repository } },
  };
  assert(isReleasePullRequest(pr, head));
  for (const change of [
    { merged_at: null }, { merge_commit_sha: base },
    { base: { ref: "develop", repo: { full_name: repository } } },
    { head: { ref: "feature", repo: { full_name: repository } } },
    { head: { ref: "release/next", repo: { full_name: "other/repository" } } },
  ]) assert(!isReleasePullRequest({ ...pr, ...change }, head));
});

test("partial publication retries skip only identical bytes and never move latest backwards", () => {
  const item = { from: "0.1.2", to: "0.1.3" }, integrity = "sha512-test";
  assert.equal(publicationState(item, integrity, null, { version: "0.1.2" }), "publish");
  assert.equal(publicationState(item, integrity, { dist: { integrity } }, null), "already-published");
  assert.throws(() => publicationState(item, integrity, { dist: { integrity: "different" } }, null), /different bytes/);
  assert.throws(() => publicationState(item, integrity, null, { version: "0.1.4" }), /out-of-order/);
  assert.throws(() => publicationState(item, integrity, null, null), /out-of-order/);
});

test("cancellation rejects partially published releases and registry failures", async () => {
  const { plan } = fixture();
  await verifyUnpublished(plan, async () => null);
  await assert.rejects(verifyUnpublished(plan, async name => name === "pi-slate" ? { version: "0.2.0" } : null), /Cannot cancel/);
  await assert.rejects(verifyUnpublished(plan, async () => { throw new Error("registry unavailable"); }), /registry unavailable/);
});

test("mismatched lockfile versions block release generation", () => {
  const { before, plan } = fixture();
  before["pi-ask/package-lock.json"] = before["pi-ask/package-lock.json"].replace('"version":"0.1.2"', '"version":"0.0.1"');
  assert.throws(() => releaseFiles(plan, path => before[path]));
});

test("artifact verification rejects traversal, wrong package/version and altered bytes", () => {
  const { plan } = fixture(), item = plan.packages[0], bytes = Buffer.from("test archive");
  const metadata = {
    name: item.name, version: item.to, filename: "gagansd-pi-ask-0.1.3.tgz",
    integrity: "sha512-" + createHash("sha512").update(bytes).digest("base64"),
  };
  assert.equal(verifyArtifact(item, metadata, bytes), metadata.integrity);
  assert.throws(() => verifyArtifact(item, metadata, Buffer.from("changed")));
  for (const changes of [{ filename: "../../other.tgz" }, { name: "pi-slate" }, { version: "9.0.0" }]) {
    assert.throws(() => verifyArtifact(item, { ...metadata, ...changes }, bytes));
  }
});
