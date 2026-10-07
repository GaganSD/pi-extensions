import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { FileArtifacts } from "../src/artifacts.ts";
import { captureHead, diffPath, diffTool } from "../src/diff.ts";
import { canonicalDirectory, git, overlaps, workspaceRoot } from "../src/workspace.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { RunManager } from "../src/runs.ts";
import { plan, temp } from "./helpers.ts";

async function repository(root: string): Promise<void> {
  await git(root, ["init", "-q"]);
  await writeFile(path.join(root, "tracked.txt"), "before\n");
  await git(root, ["add", "tracked.txt"]);
  await git(root, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"]);
}

test("canonical roots collapse symlinks and subdirs but distinguish Git worktrees", { skip: process.platform === "win32" }, async t => {
  const root = await temp(t);
  const repo = path.join(root, "repo"), linked = path.join(root, "linked"), other = path.join(root, "other");
  await mkdir(repo); await repository(repo);
  await symlink(repo, linked);
  await mkdir(path.join(repo, "subdir"));
  assert.equal(await canonicalDirectory(linked), await canonicalDirectory(repo));
  assert.equal(await workspaceRoot(path.join(repo, "subdir")), await canonicalDirectory(repo));
  await git(repo, ["worktree", "add", "-qb", "fixture-branch", other]);
  assert.notEqual(await workspaceRoot(repo), await workspaceRoot(other));
  assert(await overlaps(repo, path.join(repo, "subdir")));
  assert(!await overlaps(repo, repo + "-other"));
  assert(await overlaps(linked, repo), "symlink aliases of one tree overlap");
  assert.equal(await workspaceRoot(root), await canonicalDirectory(root));
});

test("diff is bounded, literal, read-only, and rejects a changed baseline", async t => {
  const root = await temp(t); await repository(root);
  const head = await captureHead(root);
  assert(head);
  const tool = diffTool(root, head);
  await writeFile(path.join(root, "tracked.txt"), "after\n");
  await writeFile(path.join(root, "untracked.txt"), "do not silently claim to have reviewed this\n");
  const run = (args = {}) => tool.execute("fixture", args, undefined, undefined, undefined!);
  const output = await run();
  const text = output.content.filter(item => item.type === "text").map(item => item.text).join("\n");
  assert.match(text, /\+after/); assert.match(text, /untracked.txt/);
  assert(!text.includes("do not silently claim"));
  await assert.rejects(run({ path: ":(exclude)*" }), /relative path/); // Magic pathspecs are rejected, not silently literal.
  await writeFile(path.join(root, "tracked.txt"), "large line\n".repeat(10000));
  const large = await run();
  assert.match(JSON.stringify(large.content), /Truncated/);
  assert(large.content.filter(item => item.type === "text").every(item => item.text.length < 24100));
  await git(root, ["add", "tracked.txt"]);
  await git(root, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "changed head"]);
  await assert.rejects(run(), /HEAD changed/);
});

test("diff never executes textconv, external diff, or clean filters", async t => {
  const root = await temp(t); await repository(root);
  await writeFile(path.join(root, ".gitattributes"), "tracked.txt diff=fixture filter=fixture\n");
  await git(root, ["config", "filter.fixture.clean", "touch CLEAN_WAS_RUN; cat"]);
  await git(root, ["config", "filter.fixture.required", "true"]);
  await git(root, ["config", "diff.fixture.textconv", "touch TEXTCONV_WAS_RUN"]);
  await git(root, ["config", "diff.external", "touch EXTERNAL_WAS_RUN"]);
  await writeFile(path.join(root, "tracked.txt"), "after\n");
  const tool = diffTool(root, await captureHead(root));
  await tool.execute("fixture", {}, undefined, undefined, undefined!);
  await assert.rejects(stat(path.join(root, "TEXTCONV_WAS_RUN")));
  await assert.rejects(stat(path.join(root, "EXTERNAL_WAS_RUN")));
  await assert.rejects(stat(path.join(root, "CLEAN_WAS_RUN")));
});

test("diff path restrictions and no baseline fail honestly", async t => {
  for (const value of ["", "../secret", "a/../secret", "/absolute", "C:\\secret", "-option", "a\0", ":(glob)*", "*.ts", "a?.ts", "[x].ts"]) assert.throws(() => diffPath(value));
  assert.deepEqual(diffPath("src/file.ts"), ["src/file.ts"]);
  const root = await temp(t);
  assert.equal(await captureHead(root), undefined);
  await assert.rejects(diffTool(root).execute("fixture", {}, undefined, undefined, undefined!), /No Git HEAD/);
});

test("private atomic artifacts persist evidence and never overwrite existing run directories", async t => {
  const root = await temp(t);
  const store = new FileArtifacts(path.join(root, "artifacts"));
  const manager = new RunManager({ owner: "test-agent", store, config: { ...DEFAULT_CONFIG } });
  const [id] = await manager.launch([plan()]); await manager.settled(id!);
  const result = manager.status(id!);
  assert.equal(JSON.parse(await readFile(result.metadataPath, "utf8")).state, "completed");
  assert.match(await readFile(result.reportPath!, "utf8"), /Evidence report/);
  if (process.platform !== "win32") {
    assert.equal((await stat(store.directory(id!))).mode & 0o777, 0o700);
    assert.equal((await stat(result.metadataPath)).mode & 0o777, 0o600);
    assert.equal((await stat(result.reportPath!)).mode & 0o777, 0o600);
  }
  await assert.rejects(store.create(result), /EEXIST/);
  assert.throws(() => store.directory("../../escape"), /Invalid run ID/);
  await assert.rejects(store.report(id!, "  "), /nonempty report/);
  const cancelled = new AbortController();
  const publication = store.report(id!, "replacement".repeat(100000), cancelled.signal);
  cancelled.abort(new Error("Publication deadline"));
  await assert.rejects(publication);
  assert.equal(await readFile(result.reportPath!, "utf8"), "Evidence report\n", "cancelled writes must not replace saved evidence");
  await assert.rejects(store.save({ ...result, state: "failed" }, cancelled.signal));
  assert.equal(JSON.parse(await readFile(result.metadataPath, "utf8")).state, "completed");
});
