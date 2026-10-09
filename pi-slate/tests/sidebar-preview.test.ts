import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { Sidebar, DOUBLE_CLICK_MS } from "../extensions/pi-slate/sidebar.ts";
import type { SidebarResources, SidebarSession } from "../extensions/pi-slate/sidebar-data.ts";
import { sessionSidebarSlots } from "../extensions/pi-slate/sidebar-layout.ts";
import { DiffWorkspaceView, type WorkspaceView } from "../extensions/pi-slate/workspace.ts";
import type { BackgroundTask } from "../extensions/pi-slate/background-tasks.ts";

const theme = (code = 32) => ({ fg: (_tone: string, text: string) => `\x1b[${code}m${text}\x1b[0m`, bold: (text: string) => text }) as Theme;
const stripAnsi = (text: string) => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
const plain = (lines: string[]) => lines.map(line => stripAnsi(line).replace(/^│ ?/, "").trimEnd());
const session: SidebarSession = { id: "session-a", name: "Sidebar redesign", pid: 8421, cwd: "/tmp/project", model: "sonnet-4.6", thinking: "medium", tokens: 31600, percent: 16, contextWindow: 200000, estimated: false, rate: 82, startedAt: 1000, lastTurnMs: 5000, working: true, turns: 2, messages: 5, usage: { input: 61400, output: 876, total: 62276, cacheRead: 48000, cacheWrite: 6100, cost: 0.12 } };
const resources: SidebarResources = {
  mcp: Array.from({ length: 7 }, (_, i) => ({ name: `server-${i}`, enabled: i !== 2, source: "global" })),
  skills: Array.from({ length: 6 }, (_, i) => ({ name: `skill-${i}`, path: `/tmp/skills/${i}/SKILL.md`, loaded: i === 0, source: "project" })),
  commands: Array.from({ length: 6 }, (_, i) => ({ name: `run-${i}`, source: "extension" })),
};
function fixture(rows = 60) {
  let clock = 4000; let renders = 0;
  const sidebar = new Sidebar(() => clock);
  const terminal = { rows, columns: 140 };
  sidebar.attach({ terminal, requestRender() { renders++; }, showOverlay() { return { hide() {} }; } } as unknown as TUI, theme());
  sidebar.setSession(session); sidebar.setResources(resources);
  return { sidebar, terminal, advance: (ms: number) => { clock += ms; }, renders: () => renders };
}
function mouse(y: number, extra: Partial<TuiMouseEvent> = {}): TuiMouseEvent {
  return { type: "click", button: "left", x: 2, y, screenX: 112, screenY: y, width: 40, height: 60, shift: false, alt: false, ctrl: false, ...extra };
}
function row(sidebar: Sidebar, text: string, width = 40): number {
  const index = plain(sidebar.render(width)).findIndex(line => line.includes(text));
  assert(index >= 0, `missing ${text}`); return index;
}
function image(id = "a"): WorkspaceView {
  return { id: `image:${id}`, title: `${id}.png`, filePath: `/tmp/${id}.png`, render: (w, h) => Array.from({ length: h }, () => "IMAGE".slice(0, w)), invalidate() {} };
}
function task(i: number): BackgroundTask {
  return { id: `task-${i}`, source: "sample", label: `job-${i}`, kind: "subagent", state: i === 1 ? "waiting" : "running", startedAt: 1000, detail: "No control action is performed" };
}

test("quiet session rail merges usage into context and hides empty shelves", () => {
  const { sidebar } = fixture();
  const lines = plain(sidebar.render(80));
  for (const label of ["SESSION", "Sidebar redesign", "pid 8421", "sonnet-4.6", "16%", "31.6k / 200k", "Input", "Output", "Cache", "Uncached", "Cost", "Rate", "MCP · 6 enabled", "Skills · 1 loaded"])
    assert(lines.some(line => line.includes(label)), label);
  for (const label of ["Stats", "Tokens · branch", "Commands ·", "Tasks", "Preview", "no selection", "/run-0"])
    assert(!lines.some(line => line.includes(label)), label);
  assert.match(sidebar.sessionDetails(), /Cache read: 48k/);
});

test("all sizes allocate exact bounded rows, including zero, Unicode, and tiny terminals", () => {
  const { sidebar, terminal } = fixture();
  sidebar.setSession({ ...session, name: "长会话 👩‍💻 café\n\x1b[2J", model: "非常长的模型名字".repeat(8) });
  sidebar.setView(image()); sidebar.setTasks([task(0), task(1), task(2), task(3)]);
  for (let height = 0; height <= 60; height++) {
    terminal.rows = height;
    for (const width of [0, 1, 2, 3, 8, 20, 28, 40, 80]) {
      const lines = sidebar.render(width);
      assert.equal(lines.length, height);
      assert(lines.every(line => visibleWidth(line) <= width), `${width}×${height}`);
      assert(lines.every(line => !line.includes("\x1b[2J") && !line.includes("\n")));
      const slots = sessionSidebarSlots(height, 4, true);
      assert.equal(Object.values(slots).reduce((a, b) => a + b, 0), height);
      assert(Object.values(slots).every(x => x >= 0));
    }
  }
});

test("usage is a single stable label/value lane; full accounting stays in details", () => {
  const { sidebar } = fixture();
  for (const width of [18, 28, 40, 80]) {
    const text = plain(sidebar.render(width)).join("\n");
    for (const value of ["pid 8421", "Input", "61.4k", "Output", "876", "Cache", "48k", "Uncached", "7.3k", "$0.12", "~82/s"]) assert(text.includes(value), value);
  }
  assert.match(sidebar.sessionDetails(), /Cache read: 48k · Cache write: 6.1k/);
  assert.match(sidebar.sessionDetails(), /~82 tokens\/sec/);
});

test("a 24-row terminal still renders an image body; a very short one prioritizes tasks", () => {
  const { sidebar, terminal } = fixture(24); sidebar.setView(image()); sidebar.setTasks([task(0)]);
  assert(plain(sidebar.render(40)).some(line => line.includes("IMAGE")), "normal-height thumbnails must not disappear");
  terminal.rows = 14;
  const text = plain(sidebar.render(40)).join("\n");
  assert(text.includes("Tasks")); assert(!text.includes("IMAGE"));
});

test("foldable MCP and Skills sections persist independently and keep counts visible", () => {
  const { sidebar } = fixture(); const saved: unknown[] = [];
  sidebar.setActions({ copy() {}, openFile() {}, persistFold: (section, expanded) => { const folds = { ...sidebar.getFolds(), [section]: expanded }; saved.push(folds); return folds; } });
  assert(!plain(sidebar.render(40)).some(line => line.includes("server-0")));
  const mcp = row(sidebar, "MCP"); sidebar.handleMouse(mouse(mcp));
  assert.equal(sidebar.getFolds().mcp, true);
  assert.equal(sidebar.getFolds().skills, false);
  assert(plain(sidebar.render(40)).some(line => line.includes("server-0")));
  sidebar.handleMouse(mouse(row(sidebar, "Skills")));
  assert.equal(sidebar.getFolds().skills, true);
  assert.deepEqual(saved, [{ mcp: true, skills: false }, { mcp: true, skills: true }]);
  sidebar.handleMouse(mouse(row(sidebar, "MCP")));
  assert(!plain(sidebar.render(40)).some(line => line.includes("server-0")));
  assert(plain(sidebar.render(40)).some(line => line.includes("6 enabled")));
});

test("a failed preference save cannot change the visible fold state", () => {
  const { sidebar } = fixture();
  sidebar.setActions({ copy() {}, openFile() {}, persistFold: () => undefined });
  sidebar.toggleSection("skills");
  assert.equal(sidebar.getFolds().skills, false);
});

test("MCP is limited to five rows; list wheel scroll does not move the session header", () => {
  const { sidebar } = fixture(); sidebar.setFolds({ mcp: true, skills: true });
  const before = plain(sidebar.render(40));
  assert.equal(before.filter(line => /server-\d/.test(line)).length, 5);
  assert(!before.some(line => line.includes("server-5")));
  sidebar.handleMouse(mouse(row(sidebar, "server-0"), { type: "wheel", wheelDelta: -1 }));
  const after = plain(sidebar.render(40));
  assert(after.some(line => line.includes("server-5")));
  assert(!after.some(line => line.includes("server-0")));
  assert.equal(after[0], before[0]);
  assert(after.some(line => line.includes("skill-0")), "other list unchanged");
});

test("skill lists scroll and clamp; the rail does not list commands", () => {
  const { sidebar } = fixture(); sidebar.setFolds({ mcp: false, skills: true });
  sidebar.handleMouse(mouse(row(sidebar, "skill-0"), { type: "wheel", wheelDelta: -2 }));
  assert(plain(sidebar.render(40)).some(line => line.includes("skill-4")));
  assert(!plain(sidebar.render(40)).some(line => line.includes("/run-0")));
  sidebar.setResources({ ...resources, skills: resources.skills.slice(0, 1), commands: resources.commands.slice(0, 1) });
  assert(plain(sidebar.render(40)).some(line => line.includes("skill-0")));
  assert(!plain(sidebar.render(40)).some(line => line.includes("Commands")));
});

test("read-only task actions preserve the pinned image", () => {
  const { sidebar } = fixture(); const inspected: string[] = [], opened: string[] = [];
  sidebar.setActions({ copy() {}, openFile: x => opened.push(x), inspect: title => inspected.push(title) });
  sidebar.setView(image()); sidebar.pinImage(); sidebar.setTasks([task(0)]);
  sidebar.handleMouse(mouse(row(sidebar, "job-0")));
  assert.deepEqual(inspected, ["job-0"]);
  assert.equal(sidebar.currentViewId(), "image:a");
  assert.equal(sidebar.isImagePinned(), true); assert.deepEqual(opened, []);
});

test("image pin prevents caret replacement; clear only removes selection until caret leaves", () => {
  const { sidebar } = fixture(); sidebar.setView(image("a")); sidebar.pinImage();
  sidebar.setView(image("b")); assert.equal(sidebar.currentViewId(), "image:a");
  sidebar.setView(undefined); assert.equal(sidebar.currentViewId(), "image:a");
  sidebar.pinImage(); sidebar.setView(image("b")); assert.equal(sidebar.currentViewId(), "image:b");
  sidebar.clearImage(); sidebar.setView(image("b")); assert.equal(sidebar.currentViewId(), undefined);
  sidebar.setView(undefined); sidebar.setView(image("b")); assert.equal(sidebar.currentViewId(), "image:b");
  sidebar.setView({ ...image(), id: "diff:file.ts" }); assert.equal(sidebar.currentViewId(), "image:b");
});

test("unpinned image preview hides when the caret leaves and recovers on the next peek", () => {
  const { sidebar } = fixture(); sidebar.setView(image("a"));
  assert.equal(sidebar.currentViewId(), "image:a");
  assert(plain(sidebar.render(40)).some(line => line.includes("Preview")));
  sidebar.setView(undefined);
  assert.equal(sidebar.currentViewId(), undefined);
  const hidden = plain(sidebar.render(40));
  assert(!hidden.some(line => line.includes("Preview") || line.includes("caret")), "hide leaves no preview shelf");
  sidebar.setView(image("b")); assert.equal(sidebar.currentViewId(), "image:b");
  assert(plain(sidebar.render(40)).some(line => line.includes("Preview")));
});

test("copy/open/clear image hit regions align with painted controls", () => {
  const { sidebar } = fixture(); const copied: string[] = []; const opened: string[] = [];
  sidebar.setActions({ copy: x => copied.push(x), openFile: x => opened.push(x) }); sidebar.setView(image());
  const click = (label: string) => { const lines = plain(sidebar.render(80)); const y = lines.findIndex(line => line.includes(label)); assert(y >= 0); return sidebar.handleMouse(mouse(y, { width: 80, x: lines[y]!.indexOf(label) + 2 })); };
  click("[copy]"); assert.deepEqual(copied, ["/tmp/a.png"]);
  click("[open]"); assert.deepEqual(opened, ["/tmp/a.png"]);
  click("[pin]"); assert(sidebar.isImagePinned());
  click("[clear]"); assert.equal(sidebar.currentViewId(), undefined); assert.equal(sidebar.isImagePinned(), false);
});

test("image double-click uses native clickCount or the fallback timer", () => {
  const { sidebar, advance } = fixture(); const opened: string[] = [];
  sidebar.setActions({ copy() {}, openFile: x => opened.push(x) }); sidebar.setView(image());
  const y = row(sidebar, "IMAGE");
  sidebar.handleMouse(mouse(y)); advance(DOUBLE_CLICK_MS + 1); sidebar.handleMouse(mouse(y));
  assert.deepEqual(opened, []); sidebar.handleMouse(mouse(y, { clickCount: 2 }));
  assert.deepEqual(opened, ["/tmp/a.png"]);
});

test("short terminals collapse the image body, keep tasks visible, and scroll middle overflow", () => {
  const { sidebar } = fixture(18); sidebar.setView(image()); sidebar.setTasks([task(0), task(1), task(2)]);
  sidebar.setFolds({ mcp: true, skills: true });
  const lines = plain(sidebar.render(40));
  assert.equal(sidebar.imagePath(), "/tmp/a.png");
  assert(!lines.some(line => line.includes("IMAGE")));
  assert(lines.some(line => line.includes("Tasks")));
  sidebar.handleMouse(mouse(6, { type: "wheel", wheelDelta: -40 }));
  const scrolled = plain(sidebar.render(40));
  assert(scrolled.some(line => line.includes("Skills") || /server-\d/.test(scrolled.join("\n"))));
  assert.equal(scrolled[0], lines[0]);
  assert.equal(sidebar.imagePath(), "/tmp/a.png");
});

test("task shelf scrolls and is not changed by composer height", () => {
  const { sidebar } = fixture(); sidebar.setTasks(Array.from({ length: 7 }, (_, i) => task(i)));
  const initial = plain(sidebar.render(40)); assert.equal(initial.filter(line => /job-\d/.test(line)).length, 3);
  sidebar.handleMouse(mouse(row(sidebar, "job-0"), { type: "wheel", wheelDelta: -2 }));
  assert(plain(sidebar.render(40)).some(line => line.includes("job-4")));
});

test("clock and theme changes invalidate cached output; pure repeated render is reused", () => {
  const { sidebar, advance } = fixture();
  const first = sidebar.render(80); assert.equal(sidebar.render(80), first);
  assert.match(sidebar.sessionDetails(), /Wall time \(this runtime\): 3s/);
  advance(2000); assert.notEqual(sidebar.render(80), first);
  assert.match(sidebar.sessionDetails(), /Wall time \(this runtime\): 5s/);
  let current = theme(31); sidebar.setThemeProvider(() => current);
  assert(sidebar.render(80).some(line => line.includes("\x1b[31m")));
  current = theme(34); sidebar.invalidate();
  assert(sidebar.render(80).some(line => line.includes("\x1b[34m")));
});

test("unknown values and invalid MCP config remain explicit even when folded", () => {
  const { sidebar } = fixture();
  sidebar.setSession({ ...session, percent: null, tokens: null, contextWindow: null, usage: { input: null, output: null, total: null, cacheRead: null, cacheWrite: null, cost: null } });
  sidebar.setResources({ ...resources, mcpError: "MCP config unreadable" });
  const lines = plain(sidebar.render(80));
  assert(lines.some(line => line.includes("—%")));
  assert.match(sidebar.sessionDetails(), /Cache read: —/);
  assert(lines.some(line => line.includes("config error")));
  assert(!lines.some(line => line.includes("$0.00")));
});

test("reset discards old images, task rows and hit targets without changing fold preference", () => {
  const { sidebar } = fixture(); sidebar.setFolds({ mcp: true, skills: false }); sidebar.setView(image()); sidebar.setTasks([task(0)]);
  sidebar.render(40); sidebar.reset();
  assert.equal(sidebar.currentViewId(), undefined); assert.deepEqual(sidebar.getFolds(), { mcp: true, skills: false });
  assert(!plain(sidebar.render(40)).some(line => line.includes("job-0") || line.includes("server-0")));
  sidebar.dispose(); sidebar.dispose();
});

test("DiffWorkspaceView remains independently usable for transcript diffs", () => {
  const preview = new DiffWorkspaceView("a.ts", "diff", " context\n-removed\n+added", theme());
  const lines = preview.render(80, 3);
  assert.deepEqual(lines.map(stripAnsi), [" context", "-removed", "+added"]);
  assert.equal(preview.handleWheel(1), false);
});
