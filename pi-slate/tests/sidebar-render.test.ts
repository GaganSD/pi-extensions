import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { stripVTControlCharacters } from "node:util";
import {
  Container,
  Markdown,
  ScrollView,
  Text,
  TuiAltScreen,
  VStack,
  visibleWidth,
  type MarkdownTheme,
  type Terminal,
} from "@earendil-works/pi-tui";
import { installSidebarSplit } from "../extensions/pi-slate/sidebar-split.ts";
import { MESSAGE_LENGTH_DEFAULT, mainColumnWidth, workspaceColumnWidth } from "../extensions/pi-slate/layout.ts";

const identity = (text: string) => text;
const theme: MarkdownTheme = {
  heading: identity, link: identity, linkUrl: identity, code: identity,
  codeBlock: identity, codeBlockBorder: identity, quote: identity,
  quoteBorder: identity, hr: identity, listBullet: identity, bold: identity,
  italic: identity, strikethrough: identity, underline: identity,
};

class NullTerminal implements Terminal {
  columns = 140;
  rows = 24;
  kittyProtocolActive = false;
  start(_input: (data: string) => void, _resize: () => void): void {}
  stop(): void {}
  async drainInput(): Promise<void> {}
  write(_data: string): void {}
  moveBy(_lines: number): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(_title: string): void {}
  setProgress(_active: boolean): void {}
}

function fixture(
  t: TestContext,
  count = MESSAGE_LENGTH_DEFAULT,
  scrollbar: "auto" | "always" | "hidden" = "auto",
  preferred?: { value?: number },
) {
  const terminal = new NullTerminal();
  const tui = new TuiAltScreen(terminal);
  const chat = new Container();
  const reformats = Array<number>(count).fill(0);
  const widths = new Set<number>();
  const messages = Array.from({ length: count }, (_, i) => new Markdown(
    `## Message ${i}\n\n${"Long **styled** prose with 漢字 and 🙂. ".repeat(8)}\n\n\`\`\`ts\nconst n = ${i};\n\`\`\``,
    1, 0, theme, undefined,
    // Markdown invokes this hook only on a cache miss. Do not count ordinary
    // render() calls as reformats or assert hardware-dependent timings.
    { transform: (text, width) => { reformats[i]++; widths.add(width); return text; } },
  ));
  for (const message of messages) chat.addChild(message);
  let textReformats = 0;
  const tool = new Text("read src/example.ts\nconst result = true;", 0, 0, (line) => {
    textReformats++;
    return line;
  });
  chat.addChild(tool);
  const scroll = new ScrollView(chat, { follow: "end", primary: true, scrollbar });
  const editor = new Text("editor", 0, 0);
  const footer = new Text("footer", 0, 0);
  const dock = new VStack([editor, footer]);
  const main = new VStack([
    { component: scroll, basis: 0, grow: 1, minSize: 1 },
    { component: dock, basis: "auto", minSize: 1 },
  ]);
  const pane = {
    invalidate() {},
    setText(_text: string) {},
    render(width: number) {
      const line = `SIDEBAR${" ".repeat(Math.max(0, width - 7))}`;
      return Array.from({ length: terminal.rows }, () => line);
    },
  };
  tui.setLayoutRoot(main);
  const dispose = installSidebarSplit(tui, pane, preferred ? () => preferred.value : undefined);
  assert(dispose, "Fullscreen must mount the real sidebar split");
  t.after(() => {
    tui.stop({ preserveScreen: true });
    dispose();
  });
  tui.start();
  tui.renderNow();

  function reset() {
    reformats.fill(0);
    textReformats = 0;
    widths.clear();
  }
  function assertCached() {
    assert.deepEqual(reformats, Array(count).fill(0), "Old Markdown must remain cached");
    assert.equal(textReformats, 0, "Unchanged tool-like Text must remain cached");
  }
  function assertFrame() {
    // Diagnostic-only access to the committed layout frame, as in the benchmark.
    const frame = (tui as unknown as { currentLayout?: { lines: string[] } }).currentLayout;
    assert(frame);
    assert.equal(frame.lines.length, terminal.rows);
    for (const line of frame.lines) assert(visibleWidth(line) <= terminal.columns);
    const lines = frame.lines.map(stripVTControlCharacters);
    if (workspaceColumnWidth(terminal.columns, preferred?.value)) {
      const sidebarIndex = lines[0].indexOf("SIDEBAR");
      assert(sidebarIndex >= 0);
      assert.equal(visibleWidth(lines[0].slice(0, sidebarIndex)), mainColumnWidth(terminal.columns, preferred?.value));
    } else {
      assert(lines.every((line) => !line.includes("SIDEBAR")));
    }
    assert(lines.at(-1)!.startsWith("footer"), "Footer must stay docked");
    if (workspaceColumnWidth(terminal.columns, preferred?.value)) {
      assert(lines.at(-1)!.includes("SIDEBAR"), "Sidebar divider reaches the composer");
    }
  }
  return { terminal, tui, chat, messages, reformats, widths, scroll, editor, pane, main, reset, assertCached, assertFrame };
}

for (const scrollbar of ["auto", "always", "hidden"] as const) {
  test(`sidebar preserves warm caches during redraws, typing and scrolling (${scrollbar} scrollbar)`, (t) => {
    const f = fixture(t, MESSAGE_LENGTH_DEFAULT, scrollbar);
    assert.deepEqual(f.reformats, Array(MESSAGE_LENGTH_DEFAULT).fill(1), "Cold frame formats each Markdown only once");
    assert.equal(f.widths.size, 1, "One allocated width, not full-width then pane-width");
    f.reset();
    for (let i = 0; i < 3; i++) f.tui.renderNow();
    f.editor.setText("editor\nsecond line\nthird line");
    f.tui.renderNow();
    f.pane.setText("SIDEBAR\nUpdated reserved / MCP status");
    f.tui.renderNow();
    f.scroll.scrollToStart();
    f.tui.renderNow();
    f.scroll.scrollBy(1);
    f.tui.renderNow();
    f.assertCached();
    f.assertFrame();
    assert.equal(f.chat.children.length, 101, "No transcript entries may be evicted");
  });
}

test("streaming reformats only the active Markdown and preserves manual scroll position", (t) => {
  const f = fixture(t);
  f.scroll.scrollToStart();
  f.tui.renderNow();
  const position = f.scroll.scrollTop;
  f.reset();
  f.messages.at(-1)!.setText("Updated streaming **message**\n".repeat(40));
  f.tui.renderNow();
  assert.deepEqual(f.reformats, [...Array(MESSAGE_LENGTH_DEFAULT - 1).fill(0), 1]);
  assert.equal(f.scroll.scrollTop, position);
  assert.equal(f.scroll.isFollowingEnd, false);
  f.reset();
  f.scroll.scrollToEnd();
  f.tui.renderNow();
  f.assertCached();
  assert.equal(f.scroll.isFollowingEnd, true);
  f.assertFrame();
});

for (const count of [0, 1, MESSAGE_LENGTH_DEFAULT]) {
  test(`sidebar resizes and crosses its visibility threshold without cache thrashing (${count} messages)`, (t) => {
    const f = fixture(t, count);
    for (const columns of [59, 60, 61, 80, 140, 200, 59]) {
      f.reset();
      f.terminal.columns = columns;
      f.tui.renderNow();
      assert.deepEqual(f.reformats, Array(count).fill(1), "One reformat per message after a width change");
      f.assertFrame();
      f.reset();
      f.tui.renderNow();
      f.assertCached();
    }
  });
}

test("theme invalidation and root remounting keep correct cache lifetimes", (t) => {
  const f = fixture(t, 10);
  f.reset();
  f.tui.invalidate();
  f.tui.renderNow();
  assert.deepEqual(f.reformats, Array(10).fill(1), "Invalidation must still refresh all messages");
  f.reset();
  f.tui.renderNow();
  f.assertCached();
  // The extension rewraps roots when pi replaces its fullscreen composition.
  f.tui.setLayoutRoot(f.main);
  f.tui.renderNow();
  f.assertCached();
  f.assertFrame();
});

test("committing a preferred sidebar width reformats chat once", (t) => {
  const preferred: { value?: number } = {};
  const f = fixture(t, 20, "auto", preferred);
  f.reset();
  f.tui.renderNow();
  f.assertCached();
  preferred.value = 48;
  f.reset();
  f.tui.renderNow();
  assert.deepEqual(f.reformats, Array(20).fill(1), "One reformat after the committed width change");
  f.assertFrame();
  f.reset();
  f.tui.renderNow();
  f.assertCached();
});
