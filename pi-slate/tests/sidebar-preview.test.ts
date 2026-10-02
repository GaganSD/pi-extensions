import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { noteComposerFrameLines } from "../extensions/pi-slate/composer.ts";
import { DOUBLE_CLICK_MS, Sidebar } from "../extensions/pi-slate/sidebar.ts";
import { DiffWorkspaceView, type WorkspaceView } from "../extensions/pi-slate/workspace.ts";
import type { FileChange } from "../extensions/pi-slate/files-modified.ts";

function theme(): Theme {
  return {
    fg: (color, text) => `[${color}]${text}`,
    bold: (text) => text,
  } as Theme;
}

function view(id: string): WorkspaceView {
  return { id, render: () => [id], invalidate() {} };
}

function strip(line: string): string {
  return line
    .replace(/\[(?!clear\]|copy(?: path)?\])\w+\]/g, "")
    .replace(/^[╭╰├│]\s?/, "")
    .replace(/\s?[╮╯┤│]$/, "")
    .replace(/^─\s?/, "")
    .replace(/\s─+$/, "")
    .replace(/\s+$/, "");
}

function actionX(line: string, label: string): number {
  const x = strip(line).indexOf(label);
  assert.ok(x >= 0, `missing ${label}`);
  return x + 2;
}

function mouse(partial: Partial<TuiMouseEvent> & Pick<TuiMouseEvent, "type" | "y">): TuiMouseEvent {
  return {
    button: "left",
    x: 2,
    screenX: 2,
    screenY: partial.y,
    width: 40,
    height: 24,
    shift: false,
    alt: false,
    ctrl: false,
    ...partial,
  };
}

function attachSidebar(rows = 24): Sidebar {
  const sidebar = new Sidebar();
  const tui = {
    terminal: { rows, columns: 80 },
    requestRender() {},
    showOverlay() {
      return { hide() {} };
    },
  } as unknown as TUI;
  sidebar.attach(tui, theme());
  return sidebar;
}

test("DiffWorkspaceView highlights added, removed, and context lines", () => {
  const preview = new DiffWorkspaceView(
    "a.ts",
    "diff",
    ["diff --git a/a.ts b/a.ts", "@@ -1,1 +1,2 @@", " context", "-removed", "+added"].join("\n"),
    theme(),
  );
  assert.equal(preview.id, "diff:a.ts:diff");
  assert.deepEqual(preview.render(80, 5), [
    "[dim]diff --git a/a.ts b/a.ts",
    "[accent]@@ -1,1 +1,2 @@",
    "[toolDiffContext] context",
    "[toolDiffRemoved]-removed",
    "[toolDiffAdded]+added",
  ]);
  assert.deepEqual(new DiffWorkspaceView("a.ts", "loading", "", theme()).render(80, 1), [
    "[toolDiffContext]Loading change…",
  ]);
  const long = new DiffWorkspaceView("a.ts", "diff", ["one", "two", "three"].join("\n"), theme(), "a.ts");
  assert.deepEqual(long.render(80, 2), ["[toolDiffContext]one", "[toolDiffContext]two"]);
  assert.equal(long.handleWheel(1), true);
  assert.deepEqual(long.render(80, 2), ["[toolDiffContext]two", "[toolDiffContext]three"]);
});

test("a selected file preview returns after a temporary image peek", () => {
  const sidebar = new Sidebar();
  const fileView = view("diff:a.ts:diff");
  const imageView = view("image:1:/tmp/pic.png");

  sidebar.setSelectedPreview(fileView);
  assert.equal(sidebar.currentViewId(), "diff:a.ts:diff");

  sidebar.setView(imageView);
  assert.equal(sidebar.currentViewId(), "image:1:/tmp/pic.png");

  sidebar.setView(undefined);
  assert.equal(sidebar.currentViewId(), "diff:a.ts:diff");
});

test("clicking a changed file selects it instead of copying its path", () => {
  const sidebar = attachSidebar();
  const selected: FileChange[] = [];
  const copied: string[] = [];
  sidebar.setActions({
    copy: (text) => copied.push(text),
    openFile() {},
    selectFile: (file) => {
      selected.push(file);
      sidebar.setSelectedPreview(new DiffWorkspaceView(file.path, "diff", "+ok", theme(), file.path, file.path));
    },
  });
  sidebar.setFiles([
    { index: " ", worktree: "M", path: "src/a.ts" },
    { index: "?", worktree: "?", path: "src/b.ts" },
  ]);
  sidebar.render(40);

  const heading = sidebar.handleMouse(mouse({ type: "click", y: 2 }));
  assert.equal(heading, undefined);
  const first = sidebar.handleMouse(mouse({ type: "click", y: 3 }));
  assert.deepEqual(first, { handled: true });
  assert.equal(selected[0]?.path, "src/a.ts");
  assert.deepEqual(copied, []);
  const labels = sidebar.render(40).map(strip);
  assert.ok(labels.some((line) => line.includes("> M src/a.ts")));
  assert.ok(labels.some((line) => line.includes("Preview · src/a.ts") && line.includes("[clear]")));
});

test("two rapid clicks on the same file row open that path once", () => {
  const sidebar = attachSidebar();
  const selected: FileChange[] = [];
  const opened: string[] = [];
  sidebar.setActions({
    copy() {},
    openFile: (filePath) => opened.push(filePath),
    selectFile: (file) => {
      selected.push(file);
      sidebar.setSelectedPreview(new DiffWorkspaceView(file.path, "diff", "+ok", theme(), file.path, file.path));
    },
  });
  sidebar.setFiles([
    { index: " ", worktree: "M", path: "src/a.ts" },
    { index: "?", worktree: "?", path: "src/b.ts" },
  ]);
  sidebar.render(40);

  assert.deepEqual(sidebar.handleMouse(mouse({ type: "click", y: 3 })), { handled: true });
  assert.deepEqual(sidebar.handleMouse(mouse({ type: "click", y: 3 })), { handled: true });
  assert.equal(selected.length, 2);
  assert.equal(selected[0]?.path, "src/a.ts");
  assert.deepEqual(opened, ["src/a.ts"]);
});

test("a late second click on a file row selects it but does not open", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000 });
  const sidebar = attachSidebar();
  const selected: FileChange[] = [];
  const opened: string[] = [];
  sidebar.setActions({
    copy() {},
    openFile: (filePath) => opened.push(filePath),
    selectFile: (file) => selected.push(file),
  });
  sidebar.setFiles([
    { index: " ", worktree: "M", path: "src/a.ts" },
    { index: "?", worktree: "?", path: "src/b.ts" },
  ]);
  sidebar.render(40);

  assert.deepEqual(sidebar.handleMouse(mouse({ type: "click", y: 3 })), { handled: true });
  t.mock.timers.tick(DOUBLE_CLICK_MS + 1);
  assert.deepEqual(sidebar.handleMouse(mouse({ type: "click", y: 3 })), { handled: true });
  assert.equal(selected.length, 2);
  assert.deepEqual(opened, []);
});

test("double-clicking a preview with a real path opens that file", () => {
  const sidebar = attachSidebar();
  const opened: string[] = [];
  sidebar.setActions({
    copy() {},
    openFile: (filePath) => opened.push(filePath),
    selectFile() {},
  });
  sidebar.setFiles([{ index: " ", worktree: "M", path: "src/a.ts" }]);
  sidebar.setSelectedPreview(new DiffWorkspaceView("src/a.ts", "diff", "+ok", theme(), "src/a.ts", "src/a.ts"));
  const labels = sidebar.render(40).map(strip);
  const preview = labels.findIndex((line) => line.includes("Preview · src/a.ts"));
  assert.ok(preview >= 0);

  assert.equal(sidebar.handleMouse(mouse({ type: "click", y: preview + 1 })), undefined);
  assert.deepEqual(sidebar.handleMouse(mouse({ type: "click", y: preview + 1 })), { handled: true });
  assert.deepEqual(opened, ["src/a.ts"]);
});

test("TUI clickCount opens after the fallback timer would have expired", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000 });
  const sidebar = attachSidebar();
  const opened: string[] = [];
  sidebar.setActions({
    copy() {},
    openFile: (filePath) => opened.push(filePath),
    selectFile() {},
  });
  sidebar.setFiles([{ index: " ", worktree: "M", path: "src/a.ts" }]);
  sidebar.render(40);

  assert.deepEqual(sidebar.handleMouse(mouse({ type: "click", y: 3, clickCount: 1 })), { handled: true });
  t.mock.timers.tick(DOUBLE_CLICK_MS + 50);
  assert.deepEqual(sidebar.handleMouse(mouse({ type: "click", y: 3, clickCount: 2 })), { handled: true });
  assert.deepEqual(opened, ["src/a.ts"]);
});

test("TUI clickCount 1 twice does not open", () => {
  const sidebar = attachSidebar();
  const opened: string[] = [];
  sidebar.setActions({
    copy() {},
    openFile: (filePath) => opened.push(filePath),
    selectFile() {},
  });
  sidebar.setFiles([{ index: " ", worktree: "M", path: "src/a.ts" }]);
  sidebar.render(40);

  assert.deepEqual(sidebar.handleMouse(mouse({ type: "click", y: 3, clickCount: 1 })), { handled: true });
  assert.deepEqual(sidebar.handleMouse(mouse({ type: "click", y: 3, clickCount: 1 })), { handled: true });
  assert.deepEqual(opened, []);
});

test("summary leaves blank lines between its sections and shows a disjoint activity breakdown", () => {
  const sidebar = attachSidebar();
  sidebar.setFiles([
    { index: " ", worktree: "M", path: "src/a.ts" },
    { index: "?", worktree: "?", path: "src/b.ts" },
  ]);
  sidebar.setTurnImpact({
    revision: 1,
    toolsCalled: 6,
    events: [
      { id: "read", toolName: "read", title: "read a.ts", detail: "", isError: false, pending: false },
      ...Array.from({ length: 5 }, (_, index) => ({ id: `bash-${index}`, toolName: "bash", title: "bash test", detail: "", isError: false, pending: false })),
    ],
  });
  const labels = sidebar.render(40).map(strip);
  const summary = labels.indexOf("Summary");
  const files = labels.indexOf("Files Changed · 2");
  const lastTurn = labels.indexOf("Last Turn");
  assert.ok(summary >= 0 && files === summary + 2);
  assert.equal(labels[summary + 1], "");
  assert.ok(lastTurn > files);
  assert.equal(labels[lastTurn - 1], "");
  assert.equal(labels[lastTurn + 1], "  6 actions");
  assert.equal(labels[lastTurn + 2], "  1 inspected · 5 ran");
  assert.deepEqual(sidebar.handleMouse(mouse({ type: "click", y: lastTurn + 2 })), { handled: true, render: true });
  assert.equal(sidebar.currentViewId(), "turn:activity");
  const selected = sidebar.render(40).map(strip);
  assert.equal(selected[lastTurn + 1], "  6 actions");
  assert.equal(selected[lastTurn + 2], "> 1 inspected · 5 ran");
  assert.ok(selected.some((line) => line.includes("Preview · activity")));
});

test("empty activity is intentional, non-clickable, and narrow summaries stay within the sidebar", () => {
  const sidebar = attachSidebar();
  const empty = sidebar.render(40).map(strip);
  const lastTurn = empty.indexOf("Last Turn");
  assert.equal(empty[lastTurn + 1], "  No tool activity");
  assert.equal(sidebar.handleMouse(mouse({ type: "click", y: lastTurn + 1 })), undefined);
  assert.equal(sidebar.currentViewId(), undefined);

  sidebar.setTurnImpact({
    revision: 1, toolsCalled: 3,
    events: [
      { id: "read", toolName: "read", title: "read a.ts", detail: "", isError: false, pending: false },
      { id: "bash", toolName: "bash", title: "bash test", detail: "", isError: false, pending: false },
      { id: "powershell", toolName: "powershell", title: "powershell test", detail: "", isError: false, pending: false },
    ],
  });
  assert.ok(sidebar.render(8).every((line) => visibleWidth(strip(line)) <= 8));
});

test("a short sidebar keeps the visible total clickable when its breakdown is clipped", () => {
  const sidebar = attachSidebar(11);
  sidebar.setTurnImpact({
    revision: 1, toolsCalled: 2,
    events: [
      { id: "read", toolName: "read", title: "read a.ts", detail: "", isError: false, pending: false },
      { id: "bash", toolName: "bash", title: "bash test", detail: "", isError: false, pending: false },
    ],
  });
  const labels = sidebar.render(40).map(strip);
  const total = labels.indexOf("  2 actions");
  assert.ok(total >= 0);
  assert.equal(labels.length, 11);
  assert.deepEqual(sidebar.handleMouse(mouse({ type: "click", y: total })), { handled: true, render: true });
  assert.equal(sidebar.currentViewId(), "turn:activity");
});

test("context dock keeps the heading, rule, and spend", () => {
  const sidebar = attachSidebar();
  sidebar.setContext({ tokens: 18958, percent: 2.4, tokensPerSec: 42.4, spend: 1.234 });
  sidebar.setSkillsLoaded(12);
  sidebar.setMcpConnected(0);
  const dock = sidebar.render(80).slice(-4).map((line) => strip(line).replace(/^─+$/, "─"));
  assert.deepEqual(dock, [
    "Context",
    "18,958 tokens · 2% used · 42 tokens/sec",
    "$1.23 · 12 skills loaded · 0 MCPs enabled",
    "─",
  ]);
});

test("section titles follow the theme heading color", () => {
  const sidebar = attachSidebar();
  sidebar.setFiles([{ index: " ", worktree: "M", path: "src/a.ts" }]);
  const lines = sidebar.render(40);
  assert.ok(lines.some((line) => line.includes("[mdHeading]Summary")));
  assert.ok(lines.some((line) => line.includes("[mdHeading]Files Changed")));
  assert.ok(lines.some((line) => line.includes("[mdHeading]Last Turn")));
  assert.ok(lines.some((line) => line.includes("[mdHeading]Preview")));
  assert.ok(lines.some((line) => line.includes("[mdHeading]Context")));
});

test("context facts stay on consecutive rows when the composer grows", () => {
  const sidebar = attachSidebar(24);
  sidebar.splitActive = true;
  noteComposerFrameLines(6);
  sidebar.setContext({ tokens: 18958, percent: 2.4, tokensPerSec: 42.4, spend: 1.234 });
  sidebar.setSkillsLoaded(12);
  sidebar.setMcpConnected(0);
  const dock = sidebar.render(80).slice(-6).map((line) => strip(line).replace(/^─+$/, "─"));
  assert.deepEqual(dock, [
    "Context",
    "",
    "",
    "18,958 tokens · 2% used · 42 tokens/sec",
    "$1.23 · 12 skills loaded · 0 MCPs enabled",
    "─",
  ]);
});

test("clicking a last-turn fact opens that list in Preview", () => {
  const sidebar = attachSidebar();
  sidebar.setTurnImpact({
    revision: 1,
    toolsCalled: 1,
    events: [{ id: "r1", toolName: "read", title: "read a.ts", detail: "full read", isError: false, pending: false }],
  });
  const labels = sidebar.render(40).map(strip);
  const lastTurn = labels.indexOf("Last Turn");
  assert.equal(sidebar.handleMouse(mouse({ type: "move", y: lastTurn + 1 })), undefined);
  assert.equal(sidebar.currentViewId(), undefined);
  assert.deepEqual(sidebar.handleMouse(mouse({ type: "click", y: lastTurn + 1 })), { handled: true, render: true });
  assert.equal(sidebar.currentViewId(), "turn:activity");
  const preview = sidebar.render(40).map(strip);
  assert.ok(preview.some((line) => line.includes("Preview · activity") && line.includes("[clear]")));
  assert.ok(preview.some((line) => line.includes("> 1 action")));
  assert.ok(preview.some((line) => /▸ read a.ts/.test(line)));
  const heading = preview.findIndex((line) => line.includes("[clear]"));
  assert.deepEqual(sidebar.handleMouse(mouse({ type: "click", y: heading, x: 38 })), { handled: true, render: true });
  assert.equal(sidebar.currentViewId(), undefined);
});

test("clicking preview [copy] copies the file path and leaves [clear] working", () => {
  const sidebar = attachSidebar();
  const copied: string[] = [];
  sidebar.setActions({
    copy: (text) => copied.push(text),
    openFile() {},
    selectFile() {},
  });
  sidebar.setSelectedPreview(new DiffWorkspaceView("src/a.ts", "diff", "+ok", theme(), "src/a.ts", "src/a.ts"));
  const lines = sidebar.render(40);
  const heading = lines.findIndex((line) => strip(line).includes("[copy]") && strip(line).includes("[clear]"));
  assert.ok(heading >= 0);
  assert.ok(strip(lines[heading] ?? "").includes("Preview · src/a.ts"));

  assert.deepEqual(sidebar.handleMouse(mouse({ type: "click", y: heading, x: actionX(lines[heading] ?? "", "[copy]") })), {
    handled: true,
  });
  assert.deepEqual(copied, ["src/a.ts"]);
  assert.equal(sidebar.currentViewId(), "diff:src/a.ts:diff");

  assert.deepEqual(sidebar.handleMouse(mouse({ type: "click", y: heading, x: actionX(lines[heading] ?? "", "[clear]") })), {
    handled: true,
    render: true,
  });
  assert.equal(sidebar.currentViewId(), undefined);
});

test("clicking image [copy path] copies the real filepath, not the placeholder", () => {
  const sidebar = attachSidebar();
  const copied: string[] = [];
  sidebar.setActions({
    copy: (text) => copied.push(text),
    openFile() {},
    selectFile() {},
  });
  const filePath = "/tmp/pi-clipboard-f2634509-b0a8-489a-85f7-ce9dc69b976a.png";
  sidebar.setView({
    id: `image:1:${filePath}`,
    title: "shot.png",
    filePath,
    render: () => ["[image-1]"],
    invalidate() {},
  });
  const lines = sidebar.render(40);
  const heading = lines.findIndex((line) => strip(line).includes("[copy path]"));
  assert.ok(heading >= 0);
  assert.ok(strip(lines[heading] ?? "").includes("[clear]"));
  assert.ok(!strip(lines[heading] ?? "").includes("[image-1]"));

  assert.deepEqual(sidebar.handleMouse(mouse({
    type: "click",
    y: heading,
    x: actionX(lines[heading] ?? "", "[copy path]"),
  })), { handled: true });
  assert.deepEqual(copied, [filePath]);
});

test("clicking an activity item [copy] copies that item and does not expand it", () => {
  const sidebar = attachSidebar();
  const copied: string[] = [];
  sidebar.setActions({
    copy: (text) => copied.push(text),
    openFile() {},
    selectFile() {},
  });
  sidebar.setTurnImpact({
    revision: 1,
    toolsCalled: 1,
    events: [{ id: "r1", toolName: "read", title: "read a.ts", detail: "full read", isError: false, pending: false }],
  });
  const summary = sidebar.render(40).map(strip);
  const lastTurn = summary.indexOf("Last Turn");
  assert.deepEqual(sidebar.handleMouse(mouse({ type: "click", y: lastTurn + 1 })), { handled: true, render: true });

  const lines = sidebar.render(40);
  const labels = lines.map(strip);
  const heading = labels.findIndex((line) => line.includes("Preview · activity"));
  assert.ok(heading >= 0);
  assert.ok(labels[heading]?.includes("[clear]"));
  assert.ok(!labels[heading]?.includes("[copy]"));
  const row = labels.findIndex((line) => line.includes("▸ read a.ts") && line.includes("[copy]"));
  assert.ok(row >= 0);

  assert.deepEqual(sidebar.handleMouse(mouse({ type: "click", y: row, x: actionX(lines[row] ?? "", "[copy]") })), {
    handled: true,
  });
  assert.deepEqual(copied, ["read a.ts\nfull read"]);
  assert.match(strip(sidebar.render(40)[row] ?? ""), /▸ read a.ts/);
});
