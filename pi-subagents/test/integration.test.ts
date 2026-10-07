import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { captureHead, diffTool } from "../src/diff.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { RunManager } from "../src/runs.ts";
import { presentLaunch } from "../src/tool.ts";
import { canonicalDirectory, git, workspaceRoot } from "../src/workspace.ts";
import { MemoryStore, plan, temp, waitForAbort } from "./helpers.ts";

async function repository(root: string): Promise<void> {
  await git(root, ["init", "-q"]);
  await writeFile(path.join(root, "tracked.txt"), "before\n");
  await git(root, ["add", "tracked.txt"]);
  await git(root, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"]);
}
function commit(cwd: string, message: string): Promise<string> {
  return git(cwd, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", message]);
}

test("two worktree writers run concurrently; aliases are rejected; agent integrates outside the manager", { skip: process.platform === "win32" }, async t => {
  const root = await temp(t);
  const repo = path.join(root, "repo"), wtA = path.join(root, "wt-a"), wtB = path.join(root, "wt-b"), linked = path.join(root, "link-a");
  await mkdir(repo); await repository(repo);
  await git(repo, ["worktree", "add", "-qb", "branch-a", wtA]);
  await git(repo, ["worktree", "add", "-qb", "branch-b", wtB]);
  await symlink(wtA, linked);
  const workspaceA = await workspaceRoot(wtA);
  const workspaceB = await workspaceRoot(wtB);
  assert.equal(workspaceA, await workspaceRoot(linked));
  assert.equal(await workspaceRoot(path.join(wtA, ".")), workspaceA);
  assert.notEqual(workspaceA, workspaceB);
  assert.equal(await canonicalDirectory(linked), await canonicalDirectory(wtA));

  const store = new MemoryStore();
  const manager = new RunManager({ owner: "test-agent", config: { ...DEFAULT_CONFIG }, store });
  t.after(() => manager.shutdown());

  await assert.rejects(manager.launch([
    plan(waitForAbort, { mode: "edit", agent: "worker", cwd: wtA, workspace: workspaceA, task: "A" }),
    plan(waitForAbort, { mode: "edit", agent: "worker", cwd: linked, workspace: await workspaceRoot(linked), task: "alias" }),
  ]), /Conflicting/);
  assert.equal(manager.list().length, 0);

  const ids = await manager.launch([
    plan(async () => {
      await writeFile(path.join(wtA, "feature-a.txt"), "A\n");
      return { report: "wrote feature-a.txt", toolErrors: 0 };
    }, { mode: "edit", agent: "worker", cwd: wtA, workspace: workspaceA, task: "Add feature A" }),
    plan(async () => {
      await writeFile(path.join(wtB, "feature-b.txt"), "B\n");
      return { report: "wrote feature-b.txt", toolErrors: 0 };
    }, { mode: "edit", agent: "worker", cwd: wtB, workspace: workspaceB, task: "Add feature B" }),
  ]);
  const receipt = presentLaunch(ids.map(id => manager.status(id)));
  assert.deepEqual(receipt.runs.map(run => ({ cwd: run.cwd, workspace: run.workspace })), [
    { cwd: wtA, workspace: workspaceA },
    { cwd: wtB, workspace: workspaceB },
  ]);
  await Promise.all(ids.map(id => manager.settled(id)));
  assert(ids.every(id => manager.status(id).state === "completed"), JSON.stringify(manager.list()));
  assert.equal(store.reports.get(ids[0]!), "wrote feature-a.txt");
  assert.equal(store.reports.get(ids[1]!), "wrote feature-b.txt");

  await git(wtA, ["add", "feature-a.txt"]); await commit(wtA, "A");
  await git(wtB, ["add", "feature-b.txt"]); await commit(wtB, "B");
  const shaA = (await git(wtA, ["rev-parse", "HEAD"])).trim();
  const shaB = (await git(wtB, ["rev-parse", "HEAD"])).trim();
  await git(repo, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "cherry-pick", shaA]);
  await git(repo, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "cherry-pick", shaB]);
  assert.equal(await readFile(path.join(repo, "feature-a.txt"), "utf8"), "A\n");
  assert.equal(await readFile(path.join(repo, "feature-b.txt"), "utf8"), "B\n");
});

test("worker-to-reviewer handoff waits for the writer; committed review uses a supplied artifact", { skip: process.platform === "win32" }, async t => {
  const root = await temp(t);
  const repo = path.join(root, "repo");
  await mkdir(repo); await repository(repo);
  const workspace = await workspaceRoot(repo);
  const store = new MemoryStore();
  const manager = new RunManager({ owner: "test-agent", config: { ...DEFAULT_CONFIG }, store });
  t.after(() => manager.shutdown());

  const [worker] = await manager.launch([plan(waitForAbort, {
    mode: "edit", agent: "worker", cwd: repo, workspace, task: "Edit tracked.txt",
  })]);
  await assert.rejects(manager.launch([plan(undefined, {
    mode: "inspect", agent: "reviewer", cwd: repo, workspace, task: "Review too early",
  })]), /Conflicting/);
  await manager.stop(worker!);
  assert.equal(manager.status(worker!).state, "cancelled");

  const baseline = await captureHead(repo);
  await writeFile(path.join(repo, "tracked.txt"), "after\n");
  const [writer] = await manager.launch([plan(async () => ({ report: "changed tracked.txt", toolErrors: 0 }), {
    mode: "edit", agent: "worker", cwd: repo, workspace, task: "Change tracked.txt",
  })]);
  await manager.settled(writer!);
  await git(repo, ["add", "tracked.txt"]); await commit(repo, "change");
  const artifact = path.join(root, "review.diff");
  await writeFile(artifact, await git(repo, ["diff", baseline!, "HEAD"]));
  assert.match(await readFile(artifact, "utf8"), /\+after/);

  const live = await diffTool(repo, await captureHead(repo)).execute("fixture", {}, undefined, undefined, undefined!);
  const liveText = live.content.filter(item => item.type === "text").map(item => item.text).join("\n");
  assert.match(liveText, /No working-tree changes/);
  assert(!liveText.includes("+after"));

  const [reviewer] = await manager.launch([plan(async () => ({
    report: `Reviewed supplied artifact ${artifact}; live launch-HEAD diff was empty.`,
    toolErrors: 0,
  }), { mode: "inspect", agent: "reviewer", cwd: repo, workspace, task: `Review ${artifact}` })]);
  await manager.settled(reviewer!);
  assert.equal(manager.status(reviewer!).state, "completed");
  assert.notEqual(reviewer, writer);
  assert.match(store.reports.get(reviewer!)!, /supplied artifact/);
});
