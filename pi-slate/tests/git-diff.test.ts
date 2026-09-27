import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import {
  classifyDiffLine,
  gitDiffArgs,
  GitDiffPreviewLoader,
  isBinaryDiff,
  loadGitDiff,
  repoRelativePath,
  type GitDiffResult,
  type GitDiffRunner,
} from "../extensions/pi-slate/git-diff.ts";
import type { FileChange } from "../extensions/pi-slate/files-modified.ts";

function file(path: string, extra: Partial<FileChange> = {}): FileChange {
  return { index: " ", worktree: "M", path, ...extra };
}

test("repoRelativePath rejects paths outside the workspace", () => {
  assert.equal(repoRelativePath("/repo", "src/a.ts"), "src/a.ts");
  assert.equal(repoRelativePath("/repo", "/repo/src/a.ts"), "src/a.ts");
  assert.equal(repoRelativePath("/repo", "../secret"), undefined);
  assert.equal(repoRelativePath("/repo", "/etc/passwd"), undefined);
});

test("gitDiffArgs covers modified, untracked, deleted, and renamed files", () => {
  assert.deepEqual(gitDiffArgs("/repo", file("src/a.ts")), [
    "--no-optional-locks", "diff", "--no-ext-diff", "--color=never", "HEAD", "--", "src/a.ts",
  ]);
  assert.deepEqual(gitDiffArgs("/repo", file("gone.ts", { index: " ", worktree: "D" })), [
    "--no-optional-locks", "diff", "--no-ext-diff", "--color=never", "HEAD", "--", "gone.ts",
  ]);
  assert.deepEqual(gitDiffArgs("/repo", file("new.ts", { index: "?", worktree: "?" })), [
    "--no-optional-locks",
    "diff",
    "--no-index",
    "--no-ext-diff",
    "--color=never",
    "--",
    "/dev/null",
    resolve("/repo", "new.ts"),
  ]);
  assert.deepEqual(gitDiffArgs("/repo", file("new.ts", { index: "R", worktree: " ", origPath: "old.ts" })), [
    "--no-optional-locks", "diff", "--no-ext-diff", "--color=never", "-M", "HEAD", "--", "old.ts", "new.ts",
  ]);
  assert.equal(gitDiffArgs("/repo", file("../outside.ts")), undefined);
});

test("classifyDiffLine and binary detection parse preview text", () => {
  assert.equal(classifyDiffLine("diff --git a/a.ts b/a.ts"), "header");
  assert.equal(classifyDiffLine("+++ b/a.ts"), "header");
  assert.equal(classifyDiffLine("@@ -1,2 +1,3 @@"), "hunk");
  assert.equal(classifyDiffLine("+added"), "added");
  assert.equal(classifyDiffLine("-removed"), "removed");
  assert.equal(classifyDiffLine(" context"), "context");
  assert.equal(isBinaryDiff("Binary files a/x.png and b/x.png differ\n"), true);
  assert.equal(isBinaryDiff("GIT binary patch\n"), true);
  assert.equal(isBinaryDiff("diff --git a/a.ts b/a.ts\n+ok\n"), false);
});

test("loadGitDiff maps empty, binary, git-error, and non-git cases", async () => {
  const empty = await loadGitDiff("/repo", file("a.ts"), async () => ({ stdout: "", exitCode: 0 }));
  assert.deepEqual(empty, { state: "empty", text: "No text diff is available for this file." });

  const binary = await loadGitDiff("/repo", file("a.png"), async () => ({
    stdout: "Binary files a/a.png and b/a.png differ\n",
    exitCode: 1,
  }));
  assert.equal(binary.state, "empty");

  const ok = await loadGitDiff("/repo", file("a.ts"), async () => ({
    stdout: "diff --git a/a.ts b/a.ts\n+ok\n",
    exitCode: 1,
  }));
  assert.equal(ok.state, "diff");

  const failed = await loadGitDiff("/repo", file("a.ts"), async () => {
    throw new Error("not a git repository");
  });
  assert.equal(failed.state, "error");
  assert.match(failed.text, /not a git repository/);

  const escaped = await loadGitDiff("/repo", file("../secret"), async () => {
    throw new Error("should not run");
  });
  assert.equal(escaped.state, "error");
});

test("preview loader caches by snapshot and ignores stale rapid clicks", async () => {
  const runs: string[] = [];
  const gates = new Map<string, (result: { stdout: string; exitCode: number }) => void>();
  const run: GitDiffRunner = async (_cwd, argv) => {
    const rel = argv.at(-1) ?? "";
    runs.push(rel);
    return new Promise((resolve) => {
      gates.set(rel, resolve);
    });
  };
  const loader = new GitDiffPreviewLoader(run);
  const applied: string[] = [];
  const apply = (label: string) => (result: GitDiffResult) => {
    applied.push(`${label}:${result.state}`);
  };

  const first = loader.select("/repo", file("a.ts"), "s1", apply("a"));
  const second = loader.select("/repo", file("b.ts"), "s1", apply("b"));
  gates.get("a.ts")?.({ stdout: "+a\n", exitCode: 1 });
  gates.get("b.ts")?.({ stdout: "+b\n", exitCode: 1 });
  await Promise.all([first, second]);
  assert.deepEqual(applied, ["b:diff"]);
  assert.deepEqual(runs, ["a.ts", "b.ts"]);

  applied.length = 0;
  await loader.select("/repo", file("b.ts"), "s1", apply("b-cached"));
  assert.deepEqual(applied, ["b-cached:diff"]);
  assert.deepEqual(runs, ["a.ts", "b.ts"]);

  loader.clear();
  applied.length = 0;
  const refreshed = loader.select("/repo", file("b.ts"), "s1", apply("b-refreshed"));
  gates.get("b.ts")?.({ stdout: "+b2\n", exitCode: 1 });
  await refreshed;
  assert.deepEqual(applied, ["b-refreshed:diff"]);
  assert.equal(runs.length, 3);

  applied.length = 0;
  const third = loader.select("/repo", file("b.ts"), "s2", apply("b-fresh"));
  gates.get("b.ts")?.({ stdout: "+b3\n", exitCode: 1 });
  await third;
  assert.deepEqual(applied, ["b-fresh:diff"]);
  assert.equal(runs.length, 4);
});
