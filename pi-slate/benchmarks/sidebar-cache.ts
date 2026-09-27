/**
 * Regression benchmark: real pi renderer + this package's sidebar split.
 * Does NOT change the extension or session data. The legacy automatic basis is
 * restored only in a synthetic layout, using internal metadata for comparison.
 *
 * Run with Bun and installed peer dependencies, or reuse pi's dependencies:
 * NODE_PATH="$(npm root -g)/@earendil-works/pi-coding-agent/node_modules" \
 *   bun benchmarks/sidebar-cache.ts
 * Optional COUNTS=100,500,2500 FRAMES=30 WARMUP=5 COLUMNS=140 ROWS=50
 *
 * Synthetic Markdown/terminal, not a live-session latency or memory benchmark.
 * Theme callbacks are identity functions: real syntax highlighting may cost more.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  Container,
  Markdown,
  ScrollView,
  Text,
  TuiAltScreen,
  VStack,
  type Component,
  type MarkdownTheme,
  type Terminal,
} from "@earendil-works/pi-tui";
import { installSidebarSplit } from "../extensions/pi-slate/sidebar-split.ts";
import { workspaceColumnWidth } from "../extensions/pi-slate/layout.ts";

const COLUMNS = Number(process.env.COLUMNS ?? 140);
const ROWS = Number(process.env.ROWS ?? 50);
const frames = Number(process.env.FRAMES ?? 30);
const warmup = Number(process.env.WARMUP ?? 5);
const counts = (process.env.COUNTS ?? "100,500,2500").split(",").map(Number);
for (const value of [COLUMNS, ROWS, frames, warmup, ...counts]) {
  assert(Number.isSafeInteger(value) && value > 0, "Counts must be positive integers");
}
const identity = (text: string) => text;
const theme: MarkdownTheme = {
  heading: identity, link: identity, linkUrl: identity, code: identity,
  codeBlock: identity, codeBlockBorder: identity, quote: identity,
  quoteBorder: identity, hr: identity, listBullet: identity, bold: identity,
  italic: identity, strikethrough: identity, underline: identity,
};
const markdownText = [
  "## Investigate rendering",
  "",
  "Representative **styled prose** and a [link](https://example.com) with enough words to wrap across a realistic terminal column. ".repeat(3),
  "",
  "- Preserve scrollback and the sidebar",
  "- Keep unchanged Markdown cached",
  "",
  "```ts",
  "for (const child of children) {",
  "  const lines = child.render(width);",
  "  output.push(...lines);",
  "}",
  "```",
].join("\n");

class NullTerminal implements Terminal {
  columns = COLUMNS;
  rows = ROWS;
  bytesWritten = 0;
  kittyProtocolActive = false;
  start(_input: (data: string) => void, _resize: () => void): void {}
  stop(): void {}
  async drainInput(): Promise<void> {}
  write(data: string): void { this.bytesWritten += Buffer.byteLength(data); }
  moveBy(_lines: number): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(_title: string): void {}
  setProgress(_active: boolean): void {}
}

type Variant = "no-sidebar" | "legacy-auto-basis" | "current-sidebar";

function run(count: number, variant: Variant): string[] {
  const screenHashes: string[] = [];
  const terminal = new NullTerminal();
  // Same chat width as the sidebar cases, so formatting cost is comparable.
  if (variant === "no-sidebar") terminal.columns -= workspaceColumnWidth(COLUMNS);
  const tui = new TuiAltScreen(terminal);
  const document = new Container();
  const chat = new Container();
  document.addChild(new Text("Header", 0, 0));
  document.addChild(chat);
  let reformats = 0;
  let calls = 0;
  const widths = new Set<number>();
  class MeasuredMarkdown extends Markdown {
    override render(width: number): string[] {
      calls++;
      widths.add(width);
      return super.render(width);
    }
  }
  const messages = Array.from({ length: count }, () => new MeasuredMarkdown(
    markdownText, 1, 0, theme, undefined,
    { transform: (text) => { reformats++; return text; } },
  ));
  for (const message of messages) chat.addChild(message);
  const scroll = new ScrollView(document, { follow: "end", primary: true });
  const editor = new Text("editor", 0, 0);
  const dock = new VStack([editor, new Text("footer", 0, 0)]);
  const main = new VStack([
    { component: scroll, basis: 0, grow: 1, minSize: 1 },
    { component: dock, basis: "auto", minSize: 1 },
  ]);
  let mountedRoot: Component | undefined;
  const setLayoutRoot = tui.setLayoutRoot.bind(tui);
  tui.setLayoutRoot = (component) => {
    mountedRoot = component;
    setLayoutRoot(component);
  };
  tui.setLayoutRoot(main);
  const dispose = variant === "no-sidebar"
    ? undefined
    : installSidebarSplit(tui, new Text("Sidebar\nTodos\nTokens / spend / MCP", 0, 0));
  if (variant !== "no-sidebar") assert(dispose, "Sidebar split did not mount");

  // Diagnostic-only access: reproduce the old layout without changing production.
  if (variant === "legacy-auto-basis") {
    const root = mountedRoot as Component & {
      [key: symbol]: () => { type: string; entries: { basis?: number | "auto" }[] };
    };
    const node = root[Symbol.for("@earendil-works/pi-tui/layout-node")]();
    assert.equal(node.type, "hstack");
    node.entries[0].basis = "auto";
  }

  function measure(name: string, beforeFrame: (index: number) => void): void {
    for (let i = 0; i < warmup; i++) tui.renderNow();
    reformats = calls = 0;
    widths.clear();
    const bytesBefore = terminal.bytesWritten;
    const times: number[] = [];
    for (let i = 0; i < frames; i++) {
      const start = performance.now();
      beforeFrame(i);
      tui.renderNow();
      times.push(performance.now() - start);
      // Compare full layout frames outside the timed section. Diagnostic-only
      // access: this guards visual equivalence without building an ANSI parser.
      const layout = (tui as unknown as { currentLayout?: { lines: string[] } }).currentLayout;
      assert(layout, "This pi version does not expose the expected layout frame");
      screenHashes.push(createHash("sha256").update(JSON.stringify(layout.lines)).digest("hex"));
    }
    const sorted = [...times].sort((a, b) => a - b);
    console.log(JSON.stringify({
      count, variant, scenario: name, frames,
      meanMs: Number((times.reduce((sum, time) => sum + time, 0) / frames).toFixed(3)),
      p95Ms: Number(sorted[Math.ceil(frames * 0.95) - 1].toFixed(3)),
      renderCallsPerFrame: calls / frames,
      markdownReformatsPerFrame: reformats / frames,
      markdownWidths: [...widths],
      bytesWrittenPerFrame: Math.round((terminal.bytesWritten - bytesBefore) / frames),
    }));
    // Structural regression assertions, not hardware-dependent timing gates.
    if (variant === "current-sidebar" && ["steady", "editor", "scroll"].includes(name)) {
      assert.equal(reformats, 0, `${name}: unchanged Markdown must stay cached`);
      assert.equal(widths.size, 1, `${name}: do not measure at another width`);
    }
    if (variant === "current-sidebar" && name === "streaming") {
      assert.equal(reformats, frames, "Only the streaming Markdown should reformat");
    }
  }

  tui.start();
  try {
    measure("steady", () => {});
    measure("editor", (i) => editor.setText(`editor ${i}`));
    scroll.scrollToStart();
    measure("scroll", () => scroll.scrollBy(1));
    scroll.scrollToEnd();
    measure("streaming", (i) => messages.at(-1)!.setText(`${markdownText}\nstream ${i}`));
    const originalWidth = terminal.columns;
    measure("resize", (i) => { terminal.columns = originalWidth - (i % 2); });
  } finally {
    tui.stop({ preserveScreen: true });
    dispose?.();
  }
  return screenHashes;
}

for (const count of counts) {
  run(count, "no-sidebar");
  const legacy = run(count, "legacy-auto-basis");
  const current = run(count, "current-sidebar");
  assert.deepEqual(current, legacy, "The cache fix must preserve every visible frame");
}
