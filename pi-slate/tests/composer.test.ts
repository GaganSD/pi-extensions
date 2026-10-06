import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { Editor, visibleWidth, type EditorTheme, type TUI } from "@earendil-works/pi-tui";
import { formatFocusedContextResources, formatFocusedContextTokens } from "../extensions/pi-slate/layout.ts";
import {
  chromePaint,
  paintSelectedContent,
  composerContextEdge,
  composerLabels,
  composerStatusContextEdge,
  composerStatusLabel,
  composerPaddingX,
  frameComposerLines,
  padComposerFrame,
  frameRow,
  inscribedBorder,
  inscribedTitle,
  scrollComposerByLines,
} from "../extensions/pi-slate/composer.ts";
import type { Theme } from "@earendil-works/pi-coding-agent";

const theme = {
  fg: (_name: string, text: string) => text,
} as Theme;

test("composer padding follows density", () => {
  assert.equal(composerPaddingX("comfortable"), 4);
  assert.equal(composerPaddingX("compact"), 2);
});

test("chrome paint uses the theme border token", () => {
  const colors: string[] = [];
  const painted = chromePaint({
    fg: (name: string, text: string) => {
      colors.push(name);
      return text;
    },
  } as Theme)("─");
  assert.equal(painted, "─");
  assert.deepEqual(colors, ["border"]);
});

test("inscribed border keeps rounded corners and truncates the right label first", () => {
  const line = inscribedBorder(" left ", " right ", 16, (text) => text, "╰", "╯");
  assert.equal(line[0], "╰");
  assert.equal(line.at(-1), "╯");
  assert.ok(line.includes("left"));
  const squeezed = inscribedBorder(" project / main ", " model · high ", 18, (text) => text, "╰", "╯");
  assert.equal(visibleWidth(squeezed), 18);
  assert.ok(squeezed.startsWith("╰"));
  assert.ok(squeezed.endsWith("╯"));
  assert.ok(squeezed.includes("project"));
});

test("composer labels hide model on minimal footer and at narrow widths", () => {
  const wide = composerLabels(
    { project: "pi-configs", branch: "main", model: "grok-4.6", thinking: "medium", footer: "standard" },
    theme,
    100,
  );
  assert.match(wide.left, /pi-configs \/ main/);
  assert.match(wide.right, /grok-4.6/);
  assert.match(wide.right, /medium/);

  const withTokens = composerLabels(
    {
      project: "pi-configs",
      branch: "main",
      model: "grok-4.6",
      thinking: "medium",
      tokens: "0 tokens · 0% used · 0 tokens/sec",
      footer: "standard",
    },
    theme,
    140,
  );
  assert.match(withTokens.left, /pi-configs \/ main/);
  assert.match(withTokens.right, /0 tokens · 0% used · 0 tokens\/sec · grok-4.6 · medium/);

  const mid = composerLabels(
    {
      project: "pi-configs",
      branch: "main",
      model: "grok-4.6",
      thinking: "medium",
      tokens: "0 tokens · 0% used · 0 tokens/sec",
      footer: "standard",
    },
    theme,
    100,
  );
  assert.doesNotMatch(mid.right, /tokens/);
  assert.match(mid.left, /pi-configs \/ main/);
  assert.match(mid.right, /grok-4.6/);

  const minimal = composerLabels(
    { project: "pi-configs", branch: "main", model: "grok-4.6", thinking: "medium", footer: "minimal" },
    theme,
    100,
  );
  assert.equal(minimal.right, "");

  const narrow = composerLabels(
    { project: "pi-configs", branch: "main", model: "grok-4.6", thinking: "medium", footer: "standard" },
    theme,
    40,
  );
  assert.match(narrow.left, /pi-configs/);
  assert.doesNotMatch(narrow.left, /main/);
  assert.equal(narrow.right, "");
});

test("focused context sits on the composer top edge", () => {
  const line = composerContextEdge(
    "$7.47 · 14 skills loaded · 2 MCPs enabled",
    80,
    (text) => text,
  );
  assert.equal(line[0], "╭");
  assert.equal(line.at(-1), "╮");
  assert.doesNotMatch(line, /tokens/);
  assert.match(line, /\$7\.47/);
  const squeezed = composerContextEdge("$7.47 · 14 skills loaded", 28, (text) => text, 3);
  assert.equal(visibleWidth(squeezed), 28);
  assert.match(squeezed, /↑ 3 more/);
});

test("focused prompt edge hides empty resource counts and shows loaded skills", () => {
  const empty = composerContextEdge(formatFocusedContextResources(1.234, 0, 0), 40, (text) => text);
  assert.equal(empty, "╭" + "─".repeat(38) + "╮");
  assert.doesNotMatch(empty, /0 skills|0 MCP|\$1\.23/);

  const withSkill = composerContextEdge(formatFocusedContextResources(1.234, 1, 0), 80, (text) => text);
  assert.match(withSkill, /\$1\.23 · 1 skill loaded/);
  assert.doesNotMatch(withSkill, /0 MCP|0 skills/);
});

test("focused composer token label uses compact percent placement", () => {
  const tokens = formatFocusedContextTokens(47349, 5.2, 845.4);
  const labels = composerLabels(
    { project: "pi-extensions", branch: "pi-0.99", model: "kimi-k3", thinking: "medium", tokens, footer: "standard" },
    theme,
    140,
  );
  assert.match(labels.right, /47,349 tokens \(5%\) · 845 tokens\/sec/);
  assert.doesNotMatch(labels.right, /5% used/);
});

const labelTheme = {
  fg: (name: string, text: string) => `[${name}]${text}`,
  italic: (text: string) => `{i}${text}`,
} as Theme;

test("composerStatusLabel restyles working status that inherited frame color", () => {
  const label = composerStatusLabel(
    { kind: "working", renderInBorder: () => "\x1b[90mCrafting\x1b[0m" },
    labelTheme,
  );
  assert.equal(label, "{i}[accent]Crafting");
});

test("composerStatusLabel keeps Pi colors for other status kinds", () => {
  const painted = "\x1b[33mRetrying (1/3) in 5s...\x1b[0m";
  const label = composerStatusLabel(
    { kind: "retry", renderInBorder: () => painted },
    labelTheme,
  );
  assert.equal(label, painted);
});

test("working status stays left of the focused context edge", () => {
  const line = composerStatusContextEdge(
    "$7.47 · 14 skills loaded · 2 MCPs enabled",
    80,
    (text) => text,
    0,
    "pondering...",
  );
  assert.equal(visibleWidth(line), 80);
  assert.match(line, /^╭── pondering\.\.\./);
  assert.ok(line.indexOf("pondering") < line.indexOf("$7.47"));
  assert.match(line, /\$7\.47 · 14 skills loaded · 2 MCPs enabled ╮$/);
});

test("live status keeps its label when resources are long", () => {
  const line = composerStatusContextEdge(
    "$7.47 · 14 skills loaded · 2 MCPs enabled",
    64,
    (text) => text,
    0,
    "",
    (width) => {
      const label = "Retrying (2/5) in 8s... (esc to cancel)";
      return label.slice(0, Math.max(0, width));
    },
  );
  const plain = stripVTControlCharacters(line);
  assert.equal(visibleWidth(line), 64);
  assert.match(plain, /Retrying \(2\/5\)/);
  assert.ok(!plain.includes("2 MCPs enabled"));
});

test("empty composer frames sides and prompt without a hint row", () => {
  const width = 40;
  const lines = frameComposerLines(
    ["╭" + "─".repeat(width - 2) + "╮", " ".repeat(width), "╰" + "─".repeat(width - 2) + "╯"],
    { width, empty: true, paddingX: 4, paint: (text) => text },
  );
  assert.equal(lines.length, 3);
  assert.equal(stripVTControlCharacters(lines[1] ?? "").startsWith("│ ›"), true);
  assert.equal(stripVTControlCharacters(lines[1] ?? "").endsWith("│"), true);
  assert.equal(visibleWidth(lines[1] ?? ""), width);
  assert.doesNotMatch(lines.join("\n"), /send|esc/);
});

test("composer keeps a one-cell reverse cursor", () => {
  const width = 24;
  const cursorLine = `    \x1b[7m \x1b[0m${" ".repeat(width - 5)}`;
  const lines = frameComposerLines(
    ["╭" + "─".repeat(width - 2) + "╮", cursorLine, "╰" + "─".repeat(width - 2) + "╯"],
    { width, empty: false, paddingX: 4, paint: (text) => text },
  );
  const body = lines[1] ?? "";
  assert.match(body, /\x1b\[7m \x1b\[0m/);
  assert.doesNotMatch(body, /\x1b\[7m {2,}/);
  assert.equal(visibleWidth(body), width);
});

test("composer pins a right rail even when the source line is full width", () => {
  const width = 20;
  const lines = frameComposerLines(
    ["╭" + "─".repeat(width - 2) + "╮", "x".repeat(width), "╰" + "─".repeat(width - 2) + "╯"],
    { width, empty: false, paddingX: 4, paint: (text) => text },
  );
  const body = stripVTControlCharacters(lines[1] ?? "");
  assert.equal(body.startsWith("│"), true);
  assert.equal(body.endsWith("│"), true);
  assert.equal(visibleWidth(lines[1] ?? ""), width);
});

test("typed composer drops the prompt and hint", () => {
  const width = 20;
  const lines = frameComposerLines(
    ["╭" + "─".repeat(width - 2) + "╮", "    hello           ", "╰" + "─".repeat(width - 2) + "╯"],
    { width, empty: false, paddingX: 4, paint: (text) => text },
  );
  assert.equal(lines.length, 3);
  const body = stripVTControlCharacters(lines[1] ?? "");
  assert.equal(body.startsWith("│"), true);
  assert.doesNotMatch(body, /›/);
  assert.doesNotMatch(lines.join("\n"), /send/);
});

test("composer shelf pads to four rows without moving the footer", () => {
  const width = 20;
  const lines = padComposerFrame(
    ["╭" + "─".repeat(width - 2) + "╮", "│ ›               │", "╰" + "─".repeat(width - 2) + "╯"],
    width,
    (text) => text,
  );
  assert.equal(lines.length, 4);
  assert.equal(lines[0]?.startsWith("╭"), true);
  assert.equal(stripVTControlCharacters(lines[1] ?? "").startsWith("│"), true);
  assert.equal(stripVTControlCharacters(lines[2] ?? ""), "│" + " ".repeat(width - 2) + "│");
  assert.equal(lines[3]?.startsWith("╰"), true);
});

test("frameRow closes both sides and keeps a reverse-video cell intact", () => {
  const width = 20;
  const row = frameRow(` hi \x1b[7m \x1b[0m`, width, (text) => text);
  assert.equal(row.startsWith("│"), true);
  assert.equal(row.endsWith("│"), true);
  assert.match(row, /\x1b\[7m \x1b\[0m/);
  assert.equal(visibleWidth(row), width);
});

test("inscribed titles use composer corners", () => {
  assert.equal(visibleWidth(inscribedTitle("Summary", 16, (text) => text, "top")), 16);
  assert.match(inscribedTitle("Summary", 16, (text) => text, "top"), /^╭─ Summary /);
  assert.ok(inscribedTitle("Preview", 16, (text) => text, "mid").startsWith("├"));
  assert.ok(inscribedTitle("Context", 20, (text) => text, "bottom", "0%").endsWith("╯"));
});

test("selection paint happens before rails so the frame stays uninverted", () => {
  const width = 20;
  const painted = [
    "╭" + "─".repeat(width - 2) + "╮",
    paintSelectedContent("    hello           "),
    "╰" + "─".repeat(width - 2) + "╯",
  ];
  const lines = padComposerFrame(
    frameComposerLines(painted, { width, empty: false, paddingX: 4, paint: (text) => text }),
    width,
    (text) => text,
  );
  const body = lines[1] ?? "";
  assert.match(body, /^│/);
  assert.match(body, /│$/);
  assert.doesNotMatch(stripVTControlCharacters(body).slice(0, 1), /\x1b/);
  assert.match(body, /\x1b\[7mhello\x1b\[27m/);
  assert.doesNotMatch(body, /\x1b\[7m│/);
});

test("scrollComposerByLines moves overflow and ignores a fully visible prompt", () => {
  const lines = Array.from({ length: 12 }, (_, index) => ({ logicalLine: index, startCol: 0, length: 4 }));
  const editor = {
    lastWidth: 20,
    scrollOffset: 4,
    renderedVisibleLineCount: 4,
    buildVisualLineMap: () => lines,
    findCurrentVisualLine: () => 6,
    moveToVisualLineCalls: [] as Array<[number, number]>,
    moveToVisualLine(_lines: unknown, from: number, to: number) {
      this.moveToVisualLineCalls.push([from, to]);
    },
  };

  assert.equal(scrollComposerByLines(editor, -2), true);
  assert.equal(editor.scrollOffset, 2);
  assert.deepEqual(editor.moveToVisualLineCalls, [[6, 4]]);

  editor.scrollOffset = 0;
  assert.equal(scrollComposerByLines(editor, -2), true);
  assert.equal(editor.scrollOffset, 0);
  assert.deepEqual(editor.moveToVisualLineCalls, [[6, 4]]);

  editor.scrollOffset = 8;
  assert.equal(scrollComposerByLines(editor, 2), true);
  assert.equal(editor.scrollOffset, 8);
  assert.deepEqual(editor.moveToVisualLineCalls, [[6, 4]]);

  editor.renderedVisibleLineCount = 12;
  editor.scrollOffset = 0;
  assert.equal(scrollComposerByLines(editor, 3), false);
  assert.equal(editor.scrollOffset, 0);
});

test("a tall prompt scrolls by wheel and leaves a short prompt to the transcript", () => {
  const editor = new Editor({
    terminal: { rows: 24, columns: 80 },
    requestRender() {},
  } as TUI, { borderColor: (text) => text } as EditorTheme);
  editor.setText(Array.from({ length: 40 }, (_, index) => `line ${index}`).join("\n"));
  editor.render(40);
  const internals = editor as unknown as { scrollOffset: number };
  const before = internals.scrollOffset;
  assert.ok(before > 0);
  assert.equal(scrollComposerByLines(editor, -3), true);
  editor.render(40);
  assert.ok(internals.scrollOffset < before);

  editor.setText("short");
  editor.render(40);
  assert.equal(scrollComposerByLines(editor, -1), false);
});

