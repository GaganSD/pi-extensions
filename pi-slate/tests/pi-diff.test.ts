import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { createTwoFilesPatch } from "diff";
import { bundledLanguagesInfo } from "shiki";
import { visibleWidth } from "@earendil-works/pi-tui";
import { ansiColor, DIFF_MAX_BYTES, diffText, readDiffConfig } from "../extensions/pi-slate/pi-diff-config.ts";
import { DiffHighlighter, diffLanguage } from "../extensions/pi-slate/pi-diff-highlight.ts";
import { emphasizeRows, pairRows, patchRows, PiDiffView } from "../extensions/pi-slate/pi-diff-renderer.ts";
import { writeDiff } from "../extensions/pi-slate/pi-diff.ts";

const config = readDiffConfig({});
const patch = (before: string, after: string) => createTwoFilesPatch("before", "after", before, after);
const plain = (lines: string[]) => lines.map(stripVTControlCharacters).join("\n");

function view(t: test.TestContext, before: string, after: string, options: { kind?: "edit" | "write"; expanded?: boolean; path?: string } = {}) {
  const highlighter = new DiffHighlighter(config);
  t.after(() => highlighter.dispose());
  return new PiDiffView(patch(before, after), options.path ?? "example.ts", options.kind ?? "edit", options.expanded ?? true, config, highlighter, () => {});
}

test("Pi-Diff validates configuration and exposes every palette color", () => {
  assert.equal(config.enabled, true);
  assert.equal(config.theme, "github-dark");
  for (const value of ["0", "false", "OFF"]) assert.equal(readDiffConfig({ PI_DIFF_ENABLED: value }).enabled, false);
  const custom = readDiffConfig({ PI_DIFF_THEME: "github-light", PI_DIFF_ADD_BG: "#abc", PI_DIFF_FG: "#123456", PI_DIFF_SPLIT_MIN_WIDTH: "120" });
  assert.equal(custom.theme, "github-light");
  assert.equal(custom.colors.addBg, "#aabbcc");
  assert.equal(custom.colors.fg, "#123456");
  assert.equal(custom.splitMinWidth, 120);
  const invalid = readDiffConfig({ PI_DIFF_THEME: "__proto__", PI_DIFF_REMOVE_BG: "\x1b[31m", PI_DIFF_SPLIT_MIN_WIDTH: "NaN" });
  assert.equal(invalid.theme, config.theme);
  assert.equal(invalid.colors.removeBg, config.colors.removeBg);
  assert.equal(invalid.splitMinWidth, config.splitMinWidth);
  for (const width of ["0", "59", "501", "1.5", ""]) assert.equal(readDiffConfig({ PI_DIFF_SPLIT_MIN_WIDTH: width }).splitMinWidth, 100);
  const colors = { FG: "fg", CONTEXT_BG: "contextBg", ADD_BG: "addBg", REMOVE_BG: "removeBg", ADD_WORD_BG: "addWordBg", REMOVE_WORD_BG: "removeWordBg", LINE_NUMBER_FG: "lineNumberFg", BORDER_FG: "borderFg", HEADER_FG: "headerFg" } as const;
  for (const [env, key] of Object.entries(colors)) assert.equal(readDiffConfig({ [`PI_DIFF_${env}`]: "#fedcba" }).colors[key], "#fedcba");
});

test("language detection uses Shiki's full bundle with plaintext fallback", () => {
  assert.ok(bundledLanguagesInfo.length >= 190);
  for (const [path, language] of Object.entries({ "a.ts": "ts", "a.tsx": "tsx", "a.py": "py", "a.rs": "rust", "a.cpp": "cpp", "a.yml": "yaml", "Dockerfile": "dockerfile", "Makefile": "makefile", ".env.local": "dotenv", "a.unknown": "text", "README": "text" })) {
    assert.equal(diffLanguage(path), language);
  }
});

test("patch parsing retains hunks, line numbers, blank lines, and EOF markers", () => {
  const rows = patchRows(patch("one\n\nold", "one\n\nnew"));
  assert.equal(rows[0].kind, "meta");
  assert.deepEqual(rows.filter((row) => row.kind === "context").map((row) => [row.text, row.oldLine, row.newLine]), [["one", 1, 1], ["", 2, 2]]);
  assert.equal(rows.find((row) => row.kind === "remove")?.noNewline, true);
  assert.equal(rows.find((row) => row.kind === "add")?.noNewline, true);
  assert.equal(pairRows(rows).at(-1)?.left?.text, "old");
  assert.equal(pairRows(rows).at(-1)?.right?.text, "new");
  const separated = patchRows(patch("old\n" + "context\n".repeat(20) + "old\n", "new\n" + "context\n".repeat(20) + "new\n"));
  assert.equal(separated.filter((row) => row.kind === "meta").length, 2);
  assert.equal(separated.at(-1)?.newLine, 22);
});

test("split pairing handles insertion, deletion, and unequal change blocks", () => {
  const rows = patchRows(patch("one\ntwo\nthree\n", "new\n"));
  const pairs = pairRows(rows).filter((pair) => !pair.meta);
  assert.equal(pairs.length, 3);
  assert.equal(pairs[0].left?.text, "one");
  assert.equal(pairs[0].right?.text, "new");
  assert.equal(pairs[1].right, undefined);
  assert.equal(pairRows(patchRows(patch("", "insert\n"))).at(-1)?.left, undefined);
  assert.equal(pairRows(patchRows(patch("delete\n", ""))).at(-1)?.right, undefined);
});

test("character emphasis isolates edits inside words and handles Unicode", () => {
  for (const [before, after, oldSpan, newSpan] of [
    ["const port = 3000;", "const port = 3001;", "0", "1"],
    ["hello", "helloWorld", "", "World"],
    ["A😀B", "A😃B", "😀", "😃"],
  ]) {
    const rows = patchRows(patch(before + "\n", after + "\n"));
    emphasizeRows(rows);
    const old = rows.find((row) => row.kind === "remove")!;
    const next = rows.find((row) => row.kind === "add")!;
    assert.equal(old.emphasis?.map(([a, b]) => old.text.slice(a, b)).join(""), oldSpan);
    assert.equal(next.emphasis?.map(([a, b]) => next.text.slice(a, b)).join(""), newSpan);
  }
});

test("Shiki colors are composited with diff and character backgrounds", async (t) => {
  const diff = view(t, "const port = 3000;\n", "const port = 3001;\n");
  await diff.ready;
  const output = diff.render(120).join("\n");
  assert.ok(output.includes(ansiColor(config.colors.addBg, true)));
  assert.ok(output.includes(ansiColor(config.colors.removeBg, true)));
  assert.ok(output.includes(ansiColor(config.colors.addWordBg, true)));
  assert.ok(output.includes(ansiColor(config.colors.removeWordBg, true)));
  const added = diff.rows.find((row) => row.kind === "add")!;
  assert.ok(new Set(added.tokens?.map((token) => token.color)).size > 1);
  for (const token of added.tokens ?? []) if (token.color) assert.ok(output.includes(ansiColor(token.color)));
});

test("edit is responsive to actual pane width; write is always unified", async (t) => {
  const edit = view(t, "old\n", "new\n");
  const write = view(t, "old\n", "new\n", { kind: "write" });
  await Promise.all([edit.ready, write.ready]);
  assert.match(plain(edit.render(120)), /split/);
  assert.match(plain(edit.render(120)), /Before.*After/);
  assert.match(plain(edit.render(99)), /unified/);
  assert.match(plain(edit.render(100)), /split/);
  assert.match(plain(write.render(200)), /unified/);
  assert.doesNotMatch(plain(write.render(200)), /Before.*After/);
});

test("all lines fit narrow, odd, wide, and resized panes with Unicode and tabs", async (t) => {
  const diff = view(t, "\t中文😀é👩‍💻".repeat(30) + "\n", "\t世界😃é👨‍💻".repeat(30) + "\n");
  await diff.ready;
  assert.deepEqual(diff.render(0), []);
  for (const width of [1, 2, 3, 7, 20, 59, 80, 99, 100, 101, 120, 201]) {
    for (const line of diff.render(width)) assert.ok(visibleWidth(line) <= width, `overflow at ${width}: ${visibleWidth(line)}`);
  }
  const cached = diff.render(120);
  assert.equal(diff.render(120), cached);
  diff.invalidate();
  assert.notEqual(diff.render(120), cached);
  assert.deepEqual(diff.render(120), cached);
});

test("source terminal escapes are shown as text, never executed", async (t) => {
  const malicious = "\x1b]52;c;Y2xpcGJvYXJk\x07\x1b[2J\x9b31m\r";
  assert.equal(diffText("a\tb"), "a    b");
  const diff = view(t, "old\n", malicious + "\n");
  await diff.ready;
  const output = diff.render(200).join("\n");
  assert.ok(!output.includes("\x1b]52"));
  assert.ok(!output.includes("\x1b[2J"));
  assert.ok(!output.includes("\x9b"));
  assert.match(plain([output]), /\\x1b\]52/);
});

test("unknown languages and disposed highlighters fall back to plain code", async (t) => {
  const diff = view(t, "old\n", "new\n", { path: "file.unknown" });
  await diff.ready;
  assert.match(plain(diff.render(80)), /new/);
  assert.equal(diff.rows.find((row) => row.kind === "add")?.tokens, undefined);
  const highlighter = new DiffHighlighter(config);
  highlighter.dispose();
  assert.equal(await highlighter.tokens("const x = 1", "a.ts"), undefined);
});

test("highlight completion invalidates cached plain rendering", async (t) => {
  const highlighter = new DiffHighlighter(config);
  t.after(() => highlighter.dispose());
  let redraws = 0;
  const diff = new PiDiffView(patch("old\n", "const n = 2;\n"), "a.ts", "edit", false, config, highlighter, () => { redraws++; });
  const initial = diff.render(80);
  await diff.ready;
  assert.equal(redraws, 1);
  assert.notEqual(diff.render(80), initial);
});

test("collapsed and expanded previews are bounded and disclose omitted rows", async (t) => {
  const after = Array.from({ length: 500 }, (_, i) => `line ${i}\n`).join("");
  const collapsed = view(t, "", after, { expanded: false, path: "file.txt" });
  const expanded = view(t, "", after, { expanded: true, path: "file.txt" });
  await Promise.all([collapsed.ready, expanded.ready]);
  assert.equal(collapsed.render(80).length, 18);
  assert.equal(expanded.render(80).length, 402);
  assert.match(plain(collapsed.render(80)), /expand tool output/);
  assert.match(plain(expanded.render(80)), /preview limit/);
  assert.match(patchRows(patch("", "line\n".repeat(3000))).at(-1)!.text, /2000-line/);
});

test("write comparisons cover overwrites, empty files, CRLF, and terminal newlines", () => {
  for (const [before, after] of [["", "new\n"], ["old\n", "new\n"], ["old", ""], ["a\r\n", "b\r\n"], ["a", "a\n"]]) {
    const details = writeDiff(before, after);
    assert.equal(typeof details.slateDiff.patch, "string");
    const rows = patchRows(details.slateDiff.patch!);
    assert.ok(rows.some((row) => row.kind === "add" || row.kind === "remove"));
  }
  assert.match(patchRows(writeDiff("", "").slateDiff.patch!)[0].text, /No content changes/);
});

test("large, binary, unreadable and malformed diffs degrade without blocking", () => {
  assert.match(writeDiff(undefined, "new").slateDiff.note!, /unavailable/);
  assert.match(writeDiff("old", "\0binary").slateDiff.note!, /binary/);
  assert.match(writeDiff("", "x".repeat(DIFF_MAX_BYTES + 1)).slateDiff.note!, /256 KiB/);
  assert.match(writeDiff("x".repeat(DIFF_MAX_BYTES + 1), "").slateDiff.note!, /256 KiB/);
  assert.match(patchRows("x".repeat(DIFF_MAX_BYTES + 1))[0].text, /256 KiB/);
  assert.match(patchRows("@@ -1,4 +1,4 @@\n-one\n+two\n")[0].text, /invalid patch/);
});
