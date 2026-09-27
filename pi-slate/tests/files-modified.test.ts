import assert from "node:assert/strict";
import test from "node:test";
import {
  clampFilesOffset,
  fileAtPanelRow,
  fileMark,
  filesPanel,
  formatFileLabel,
  parsePorcelain,
  sameFiles,
  type FileChange,
} from "../extensions/pi-slate/files-modified.ts";
import { GitStatusPoller } from "../extensions/pi-slate/git-status.ts";

function file(path: string, index = " ", worktree = "M"): FileChange {
  return { index, worktree, path };
}

test("parsePorcelain reads status, untracked, and rename records", () => {
  assert.deepEqual(parsePorcelain(""), []);
  assert.deepEqual(parsePorcelain(" M src/a.ts\0M  src/b.ts\0?? scratch.md\0"), [
    { index: " ", worktree: "M", path: "src/a.ts" },
    { index: "M", worktree: " ", path: "src/b.ts" },
    { index: "?", worktree: "?", path: "scratch.md" },
  ]);
  assert.deepEqual(parsePorcelain("R  new.ts\0old.ts\0"), [
    { index: "R", worktree: " ", path: "new.ts", origPath: "old.ts" },
  ]);
});

test("parsePorcelain skips junk and keeps later valid rows", () => {
  assert.deepEqual(parsePorcelain("x\0 M keep.ts\0"), [file("keep.ts")]);
});

test("file labels stay git-status short and show renames", () => {
  assert.equal(formatFileLabel(file("a.ts")), "a.ts");
  assert.equal(formatFileLabel({ index: "R", worktree: " ", path: "new.ts", origPath: "old.ts" }), "old.ts → new.ts");
});

test("file marks collapse porcelain into a short colored label", () => {
  assert.deepEqual(fileMark(file("a.ts", " ", "M")), { mark: "M", tone: "warning" });
  assert.deepEqual(fileMark(file("b.ts", "?", "?")), { mark: "N", tone: "success" });
  assert.deepEqual(fileMark(file("c.ts", "A", " ")), { mark: "N", tone: "success" });
  assert.deepEqual(fileMark(file("d.ts", " ", "D")), { mark: "D", tone: "error" });
  assert.deepEqual(fileMark({ index: "R", worktree: " ", path: "new.ts", origPath: "old.ts" }), {
    mark: "R",
    tone: "accent",
  });
});

test("empty files panel is a heading plus none, or just none when only one row fits", () => {
  assert.deepEqual(filesPanel([], 0), { lines: [], offset: 0 });
  assert.deepEqual(filesPanel([], 1), { lines: [{ type: "empty" }], offset: 0 });
  assert.deepEqual(filesPanel([], 5), {
    lines: [{ type: "heading", count: 0 }, { type: "empty" }],
    offset: 0,
  });
});

test("overflowing files stay inside the 5-line window and can scroll", () => {
  const files = ["a", "b", "c", "d", "e", "f"].map((path) => file(`${path}.ts`));
  const first = filesPanel(files, 5, 0);
  assert.deepEqual(first.lines[0], { type: "heading", count: 6 });
  assert.deepEqual(first.lines.slice(1).map((line) => line.type === "file" ? line.item.path : line.type), [
    "a.ts",
    "b.ts",
    "c.ts",
    "d.ts",
  ]);
  assert.equal(first.offset, 0);

  const scrolled = filesPanel(files, 5, 2);
  assert.deepEqual(scrolled.lines.slice(1).map((line) => line.type === "file" ? line.item.path : line.type), [
    "c.ts",
    "d.ts",
    "e.ts",
    "f.ts",
  ]);
  assert.equal(scrolled.offset, 2);
  assert.equal(filesPanel(files, 5, 99).offset, 2);
});

test("scroll offset clamps to the visible body", () => {
  assert.equal(clampFilesOffset(-2, 10, 4), 0);
  assert.equal(clampFilesOffset(8, 10, 4), 6);
  assert.equal(clampFilesOffset(2, 3, 4), 0);
});

test("fileAtPanelRow maps a click onto the visible file, not the heading", () => {
  const files = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"].map((path) => file(path));
  assert.equal(fileAtPanelRow(files, 5, 0, 0), undefined);
  assert.equal(fileAtPanelRow(files, 5, 0, 1)?.path, "a.ts");
  assert.equal(fileAtPanelRow(files, 5, 1, 1)?.path, "b.ts");
  assert.equal(fileAtPanelRow([], 5, 0, 1), undefined);
});

test("sameFiles compares status and paths", () => {
  assert.equal(sameFiles([file("a.ts")], [file("a.ts")]), true);
  assert.equal(sameFiles([file("a.ts")], [file("a.ts", "M", " ")]), false);
});

test("poller publishes changes and ignores duplicate snapshots", async () => {
  let output = " M a.ts\0";
  const seen: string[][] = [];
  const poller = new GitStatusPoller((files) => {
    seen.push(files.map((item) => item.path));
  }, async () => output);
  poller.start("/repo");
  await poller.refresh();
  assert.deepEqual(seen, [["a.ts"]]);
  await poller.refresh();
  assert.deepEqual(seen, [["a.ts"]]);
  output = " M a.ts\0?? b.ts\0";
  await poller.refresh();
  assert.deepEqual(seen, [["a.ts"], ["a.ts", "b.ts"]]);
  output = "";
  await poller.refresh();
  assert.deepEqual(seen.at(-1), []);
  poller.dispose();
});

test("poller coalesces overlapping refreshes into one trailing refresh", async () => {
  let resolveFirst!: (output: string) => void;
  let runs = 0;
  const firstOutput = new Promise<string>((resolve) => {
    resolveFirst = resolve;
  });
  const poller = new GitStatusPoller(() => {}, async () => {
    runs += 1;
    return runs === 1 ? firstOutput : " M fresh.ts\0";
  });
  poller.start("/repo");
  const first = poller.refresh();
  const second = poller.refresh();
  assert.equal(runs, 1);
  resolveFirst(" M stale.ts\0");
  await Promise.all([first, second]);
  assert.equal(runs, 2);
  poller.dispose();
});

test("poller keeps the last snapshot when git times out", async () => {
  let shouldFail = false;
  const seen: number[] = [];
  const poller = new GitStatusPoller((files) => {
    seen.push(files.length);
  }, async () => {
    if (shouldFail) throw new Error("killed");
    return " M a.ts\0";
  });
  poller.start("/repo");
  await poller.refresh();
  shouldFail = true;
  await poller.refresh();
  assert.deepEqual(seen, [1]);
  poller.dispose();
});
