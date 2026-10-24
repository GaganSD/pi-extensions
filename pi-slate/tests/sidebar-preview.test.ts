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
const plain = (lines: string[]) => lines.map(line => stripAnsi(line).replace(/^│ ?/, "").replace(/ ?│$/, "").trimEnd());
const session: SidebarSession = { id: "session-a", pid: 8421, cwd: "/tmp/project", model: "sonnet-4.6", thinking: "medium", tokens: 31600, percent: 16, contextWindow: 200000, estimated: false, rate: 82, startedAt: 1000, lastTurnMs: 5000, working: true, turns: 2, messages: 5, usage: { input: 61400, output: 876, total: 62276, cacheRead: 48000, cacheWrite: 6100, cost: 0.12 } };
const resources: SidebarResources = {
  mcp: Array.from({ length: 7 }, (_, i) => ({ name: `server-${i}`, enabled: i !== 2, source: "global" })),
  skills: Array.from({ length: 6 }, (_, i) => ({ name: `skill-${i}`, path: `/tmp/skills/${i}/SKILL.md`, loaded: i === 0, source: "project" })),
  commands: Array.from({ length: 6 }, (_, i) => ({ name: `run-${i}`, source: "extension" })),
  prompts: Array.from({ length: 6 }, (_, i) => ({ name: `prompt-${i}`, source: "prompt", description: `Prompt ${i} description` })),
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
  for (const label of ["Session session- · PID 8421", "sonnet-4.6", "16%", "31.6k / 200k · $0.12 · ~82/s", "61.4k In", "876 Out", "Cached 48k", "Uncached 7.3k", "MCP · 6 Enabled", "Skills · 1 Loaded", "Prompts · 6"])
    assert(lines.some(line => line.includes(label)), label);
  for (const label of ["Stats", "Tokens · branch", "Commands ·", "Tasks", "Preview", "no selection", "/run-0", "prompt-0"])
    assert(!lines.some(line => line.includes(label)), label);
  assert.match(sidebar.sessionDetails(), /Cache read: 48k/);
});

test("session identity keeps the ID while a separate title copies the full name", () => {
  const { sidebar } = fixture();
  const copied: string[] = [];
  const id = "01234567-89ab-cdef-0123-456789abcdef";
  const name = "Slate 的会话标题";
  sidebar.setSession({ ...session, id, name });
  sidebar.setActions({ copy: (value) => copied.push(value), openFile() {} });
  const lines = plain(sidebar.render(40));
  assert.equal(lines[1], name, "title is the first content row");
  assert.equal(lines[2], "Session 01234567 · PID 8421", "identity follows the title");
  sidebar.handleMouse(mouse(row(sidebar, "Session 01234567")));
  sidebar.handleMouse(mouse(row(sidebar, name)));
  assert.deepEqual(copied, [id, name]);
  assert.ok(sidebar.sessionDetails().startsWith(`Session ${id} · PID 8421\n`));
  assert.match(sidebar.sessionDetails(), /Title: Slate 的会话标题/);
  sidebar.setSession({ ...session, id: "" });
  assert.equal(plain(sidebar.render(40))[1], "", "unnamed sessions retain the title spacer");
  assert.equal(plain(sidebar.render(40))[2], "Session — · PID 8421");
  assert.match(sidebar.sessionDetails(), /Title: —/);
});

test("long titles stay bounded, copy without ellipsis, and refresh on same-session renames", () => {
  const { sidebar } = fixture();
  const copied: string[] = [];
  const name = "中文会话 👩‍💻 café —— ".repeat(10).trim();
  sidebar.setActions({ copy: value => copied.push(value), openFile() {} });
  sidebar.setSession({ ...session, name: `\x1b[31m${name}\x1b[0m\n` });
  const before = sidebar.render(28);
  const title = plain(before)[1]!;
  assert.match(title, /…$/);
  assert(before.every(line => visibleWidth(line) <= 28));
  assert(!before.some(line => line.includes("\x1b[31m") || line.includes("\n")), "untrusted title styling and line breaks are removed");
  sidebar.handleMouse(mouse(1, { width: 28 }));
  assert.deepEqual(copied, [name], "copy uses the complete sanitized title, not its painted ellipsis");
  assert(sidebar.sessionDetails().includes(`Title: ${name}\n`));
  sidebar.setSession({ ...session, name: "改名后的会话" });
  const after = sidebar.render(28);
  assert.notEqual(after, before, "renaming invalidates cached rows even with the same clock and ID");
  assert.equal(plain(after)[1], "改名后的会话");
  sidebar.setSession({ ...session, name: " \n\x1b[2J" });
  assert.equal(plain(sidebar.render(28))[1], "");
  assert.equal(sidebar.handleMouse(mouse(1, { width: 28 })), undefined, "an empty title has no stale copy hit");
  assert.deepEqual(copied, [name]);
});

test("top title uses bold theme accent and follows theme changes independently of the identity", () => {
  const { sidebar } = fixture();
  const name = "特别的标题 👩‍💻 café";
  const copied: string[] = [];
  const titleTheme = (accent: number) => ({
    fg: (tone: string, text: string) => `\x1b[${tone === "accent" ? accent : tone === "mdHeading" ? 33 : 37}m${text}\x1b[0m`,
    bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
  }) as Theme;
  let current = titleTheme(36);
  sidebar.setThemeProvider(() => current);
  sidebar.setSession({ ...session, name });
  sidebar.setActions({ copy: value => copied.push(value), openFile() {} });
  for (const width of [8, 28, 40, 80]) {
    const lines = sidebar.render(width);
    assert.match(lines[1]!, /\x1b\[36m/, "title uses accent rather than body text or heading color");
    assert.match(lines[1]!, /\x1b\[1m/, "title is bold");
    assert.match(lines[2]!, /\x1b\[33m/, "Session ID retains its heading color");
    assert(lines.every(line => visibleWidth(line) <= width));
  }
  const before = sidebar.render(40);
  current = titleTheme(35);
  const after = sidebar.render(40);
  assert.notEqual(after, before, "theme changes refresh the cached title");
  assert.match(after[1]!, /\x1b\[35m/);
  assert.doesNotMatch(after[1]!, /\x1b\[36m/);
  assert.match(after[1]!, /\x1b\[1m/);
  sidebar.handleMouse(mouse(1));
  assert.deepEqual(copied, [name], "copy contains no styling");
});

test("all sizes allocate exact bounded rows, including zero, Unicode, and tiny terminals", () => {
  const { sidebar, terminal } = fixture();
  sidebar.setSession({ ...session, id: "长会话 👩‍💻 café\n\x1b[2J", name: "标题 👩‍💻 café\n\x1b[2J".repeat(8), model: "非常长的模型名字".repeat(8) });
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
    assert(text.includes("PID 8421"));
    if (width >= 28) for (const value of ["61.4k", "876", "48k", "7.3k", "$0.12"]) assert(text.includes(value), value);
    if (width >= 40) assert(text.includes("~82/s")); // Narrow rails truncate the merged occupancy tail first.
  }
  assert.match(sidebar.sessionDetails(), /Cache read: 48k · Cache write: 6.1k/);
  assert.match(sidebar.sessionDetails(), /~82 tokens\/sec/);
});

test("title precedes the session identity and the 11-row header matches its slots", () => {
  const { sidebar } = fixture();
  sidebar.setSession({ ...session, name: "Slate session title" });
  assert.equal(sessionSidebarSlots(60, 0, false).header, 11);
  assert.equal(sessionSidebarSlots(30, 0, false).header, 11);
  assert.equal(sessionSidebarSlots(29, 0, false).header, 4, "compact header also releases the removed rows");
  const lines = plain(sidebar.render(40));
  assert.match(lines[0]!, /^┌─+┐$/, "top bar");
  assert.match(lines.at(-1)!, /^└─+┘$/, "bottom bar");
  const hairline = lines.findIndex((line, i) => i > 0 && i < lines.length - 1 && /^├─+┤$/.test(line));
  assert.equal(hairline, 11, "hairline closes an 11-row header under the top bar");
  assert.equal(lines[1], "Slate session title");
  assert.equal(lines[2], "Session session- · PID 8421");
  assert(/^Context [━─]+ │ 16%$/.test(lines[5]!), "single context meter row");
  assert(lines[6]!.includes("31.6k / 200k · $0.12 · ~82/s"), "merged occupancy line");
  assert(lines[8]!.includes("61.4k In") && lines[8]!.includes("Cached 48k"));
  assert(lines[8]!.indexOf("Cached 48k") < lines[8]!.indexOf("61.4k In"), "Cached lanes left, In right with value first");
  assert(lines[9]!.includes("876 Out") && lines[9]!.includes("Uncached 7.3k"));
  assert(lines[9]!.indexOf("Uncached 7.3k") < lines[9]!.indexOf("876 Out"), "Uncached lanes left, Out right with value first");
});

test("context meter fills the rail with a thin track and degrades gracefully when narrow", () => {
  const { sidebar } = fixture();
  const meter = (width: number) => {
    const line = plain(sidebar.render(width)).find(line => line.startsWith("Context") || line.endsWith("%"));
    assert(line, `meter at width ${width}`); assert.doesNotMatch(line, /[█░]/, "meter avoids block glyphs"); return line;
  };
  assert.equal(meter(80), `Context ${"━".repeat(10)}${"─".repeat(52)} │ 16%`);
  assert.equal(meter(40), `Context ${"━".repeat(4)}${"─".repeat(18)} │ 16%`);
  assert.equal(meter(28), `Context ${"━".repeat(2)}${"─".repeat(8)} │ 16%`);
  sidebar.setSession({ ...session, percent: null });
  assert.equal(meter(40), `Context ${"─".repeat(23)} │ —%`, "null percent is an empty track");
  sidebar.setSession({ ...session, percent: 0 });
  assert.equal(meter(40), `Context ${"─".repeat(23)} │ 0%`);
  sidebar.setSession({ ...session, percent: 100 });
  assert.equal(meter(40), `Context ${"━".repeat(21)} │ 100%`);
  sidebar.setSession(session);
  for (const width of [8, 12, 20]) {
    const line = meter(width);
    assert(visibleWidth(line) <= width - 4, `bounded at ${width}`);
    assert(line.includes("16%"), `percent survives at ${width}`);
    if (width < 16) assert(!line.includes("Context"), `label yields before the percent at ${width}`);
  }
  for (const line of sidebar.render(3)) assert(visibleWidth(line) <= 3, "degenerate rail stays bounded");
});

test("context meter fill follows the theme accent and shifts to the warning tone at 80% and above", () => {
  const codes: Record<string, number> = { muted: 90, dim: 2, accent: 36, warning: 33, text: 37 };
  const toneTheme = { fg: (tone: string, text: string) => `\x1b[${codes[tone] ?? 0}m${text}\x1b[0m`, bold: (text: string) => text } as Theme;
  const { sidebar } = fixture();
  sidebar.setThemeProvider(() => toneTheme); sidebar.invalidate();
  const meterLine = () => sidebar.render(40).find(line => stripAnsi(line).includes("Context"))!;
  for (const [percent, code] of [[0, 36], [79, 36], [80, 33], [100, 33]] as const) {
    sidebar.setSession({ ...session, percent }); sidebar.invalidate();
    const line = meterLine();
    const fill = line.match(/━+/)?.[0] ?? "";
    if (fill) assert(line.includes(`\x1b[${code}m${fill}\x1b[0m`), `${percent}% fills with code ${code}`);
    assert(line.includes("\x1b[2m"), "track and separator stay dim");
  }
  sidebar.setSession({ ...session, percent: null }); sidebar.invalidate();
  assert(!/━/.test(stripAnsi(meterLine())), "null percent fills nothing");
});

test("occupancy and stat rows keep the branch usage inspect action; nulls render as dashes", () => {
  const { sidebar } = fixture(); const inspected: string[] = [];
  sidebar.setActions({ copy() {}, openFile() {}, inspect: title => inspected.push(title) });
  sidebar.setSession({ ...session, estimated: true, usage: { input: null, output: null, total: null, cacheRead: null, cacheWrite: null, cost: null } });
  sidebar.handleMouse(mouse(row(sidebar, "~31.6k / 200k · — · ~82/s")));
  sidebar.handleMouse(mouse(row(sidebar, "— In")));
  sidebar.handleMouse(mouse(row(sidebar, "Uncached —")));
  assert.deepEqual(inspected, ["Branch usage", "Branch usage", "Branch usage"]);
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
  assert.deepEqual(saved, [{ mcp: true, skills: false, prompts: false }, { mcp: true, skills: true, prompts: false }]);
  sidebar.handleMouse(mouse(row(sidebar, "MCP")));
  assert(!plain(sidebar.render(40)).some(line => line.includes("server-0")));
  assert(plain(sidebar.render(40)).some(line => line.includes("6 Enabled")));
});

test("prompts section folds, scrolls, inspects and shows none when empty", () => {
  const { sidebar } = fixture(); const inspected: string[] = []; const texts: string[] = [];
  sidebar.setActions({ copy() {}, openFile() {}, inspect: (title, text) => { inspected.push(title); texts.push(text); } });
  const collapsed = plain(sidebar.render(40));
  assert(collapsed.some(line => line.includes("› Prompts · 6")), "collapsed heading keeps the count");
  assert(!collapsed.some(line => line.includes("prompt-0")));
  sidebar.handleMouse(mouse(row(sidebar, "Prompts")));
  assert.equal(sidebar.getFolds().prompts, true);
  const expanded = plain(sidebar.render(40));
  assert(expanded.some(line => line.includes("⌄ Prompts · 6")));
  assert(expanded.some(line => line.includes("prompt-0")) && expanded.some(line => line.includes("prompt-2")));
  const promptRow = expanded.find(line => line.includes("prompt-0"))!;
  assert.equal(promptRow.trim(), "prompt-0", "prompt rows carry no redundant right-aligned source column");
  assert(!expanded.some(line => line.includes("prompt-3")), "only three visible");
  assert(!expanded.some(line => line.includes("1–3 / 6")), "scroll range indicator removed");
  sidebar.handleMouse(mouse(row(sidebar, "prompt-0")));
  assert.deepEqual(inspected, ["prompt-0"]);
  assert(texts[0]!.includes("Prompt 0 description") && texts[0]!.includes("Source: prompt"));
  sidebar.handleMouse(mouse(row(sidebar, "prompt-0"), { type: "wheel", wheelDelta: -2 }));
  const scrolled = plain(sidebar.render(40));
  assert(scrolled.some(line => line.includes("prompt-3")));
  assert(!scrolled.some(line => line.includes("prompt-0")));
  sidebar.setResources({ ...resources, prompts: [] });
  assert(plain(sidebar.render(40)).some(line => line.trim() === "none"));
});

test("a failed preference save cannot change the visible fold state", () => {
  const { sidebar } = fixture();
  sidebar.setActions({ copy() {}, openFile() {}, persistFold: () => undefined });
  sidebar.toggleSection("skills");
  assert.equal(sidebar.getFolds().skills, false);
});

test("resource status glyphs distinguish unknown MCP state without color or redundant labels", () => {
  const { sidebar } = fixture(); const details: string[] = [];
  sidebar.setActions({ copy() {}, openFile() {}, inspect: (_title, text) => details.push(text) });
  sidebar.setResources({ ...resources, mcp: [
    { name: "enabled-server", enabled: true, source: "global" },
    { name: "disabled-server", enabled: false, source: "global" },
    { name: "unknown-server", enabled: null, source: "extension" },
  ] });
  sidebar.setFolds({ mcp: true, skills: true, prompts: false });
  const lines = plain(sidebar.render(80));
  for (const expected of ["● enabled-server", "○ disabled-server", "— unknown-server", "● skill-0", "○ skill-1"])
    assert(lines.some(line => line.trim() === expected), expected);
  sidebar.handleMouse(mouse(row(sidebar, "unknown-server")));
  assert.match(details[0]!, /^— \(configuration, not connection status\)/);
});

test("MCP is limited to five rows; list wheel scroll does not move the session header", () => {
  const { sidebar } = fixture(); sidebar.setFolds({ mcp: true, skills: true, prompts: false });
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
  const { sidebar } = fixture(); sidebar.setFolds({ mcp: false, skills: true, prompts: false });
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

test("copy/open image hit regions align with painted controls", () => {
  const { sidebar } = fixture(); const copied: string[] = []; const opened: string[] = [];
  sidebar.setActions({ copy: x => copied.push(x), openFile: x => opened.push(x) }); sidebar.setView(image());
  const painted = plain(sidebar.render(80)).join("\n");
  assert(!/caret|\[pin\]|\[clear\]|a\.png/.test(painted), "preview chrome is title plus open/copy");
  const click = (label: string) => { const lines = plain(sidebar.render(80)); const y = lines.findIndex(line => line.includes(label)); assert(y >= 0); return sidebar.handleMouse(mouse(y, { width: 80, x: lines[y]!.indexOf(label) + 2 })); };
  click("[copy]"); assert.deepEqual(copied, ["/tmp/a.png"]);
  click("[open]"); assert.deepEqual(opened, ["/tmp/a.png"]);
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
  sidebar.setFolds({ mcp: true, skills: true, prompts: false });
  const lines = plain(sidebar.render(40));
  assert.equal(sidebar.imagePath(), "/tmp/a.png");
  assert(!lines.some(line => line.includes("IMAGE")));
  assert(lines.some(line => line.includes("Tasks")));
  sidebar.handleMouse(mouse(6, { type: "wheel", wheelDelta: -40 }));
  const scrolled = plain(sidebar.render(40));
  assert(scrolled.some(line => /Skills|Prompts|server-\d|skill-\d|prompt-\d/.test(line)));
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
  assert(lines.some(line => line.includes("MCP · 6 Enabled · 1 Error")));
  assert(!lines.some(line => line.includes("MCP config unreadable") || line.includes("config error")));
  sidebar.setThemeProvider(() => ({ fg: (tone: string, text: string) => tone === "error" ? `\x1b[31m${text}\x1b[0m` : text, bold: (text: string) => text }) as Theme);
  assert(sidebar.render(80).some(line => line.includes("\x1b[31m · 1 Error\x1b[0m")));
  assert(!lines.some(line => line.includes("$0.00")));
});

test("rejected MCP entries count as Errors without dumping the reason", () => {
  const { sidebar } = fixture();
  sidebar.setResources({
    ...resources,
    mcp: [
      { name: "ok", enabled: true, source: "global" },
      { name: "ok2", enabled: true, source: "global" },
      { name: "bad", enabled: null, source: "project" },
    ],
    mcpError: "MCP configuration has rejected entries",
  });
  const lines = plain(sidebar.render(80));
  assert(lines.some(line => line.includes("MCP · 2 Enabled · 1 Error")), "enabled count stays numeric next to the error count");
  assert(!lines.some(line => line.includes("rejected entries") || line.includes("config error")));
});

test("reset discards old titles, images, task rows and hit targets without changing fold preference", () => {
  const { sidebar } = fixture();
  const copied: string[] = [];
  sidebar.setActions({ copy: value => copied.push(value), openFile() {} });
  sidebar.setSession({ ...session, name: "Old title" });
  sidebar.setFolds({ mcp: true, skills: false, prompts: true }); sidebar.setView(image()); sidebar.setTasks([task(0)]);
  const titleRow = row(sidebar, "Old title");
  sidebar.reset();
  assert.equal(sidebar.handleMouse(mouse(titleRow)), undefined, "reset clears the old title hit before another paint");
  assert.deepEqual(copied, []);
  assert.equal(sidebar.currentViewId(), undefined); assert.deepEqual(sidebar.getFolds(), { mcp: true, skills: false, prompts: true });
  assert(!plain(sidebar.render(40)).some(line => line.includes("Old title") || line.includes("job-0") || line.includes("server-0")));
  sidebar.dispose(); sidebar.dispose();
});

test("DiffWorkspaceView remains independently usable for transcript diffs", () => {
  const preview = new DiffWorkspaceView("a.ts", "diff", " context\n-removed\n+added", theme());
  const lines = preview.render(80, 3);
  assert.deepEqual(lines.map(stripAnsi), [" context", "-removed", "+added"]);
  assert.equal(preview.handleWheel(1), false);
});

test("sidebar closes both rails and joins every horizontal divider at the right edge", () => {
  const { sidebar } = fixture();
  for (const width of [4, 8, 28, 40, 80]) {
    const lines = sidebar.render(width).map(stripAnsi);
    assert.equal(lines[0], "┌" + "─".repeat(width - 2) + "┐");
    assert.equal(lines.at(-1), "└" + "─".repeat(width - 2) + "┘");
    assert.equal(lines[11], "├" + "─".repeat(width - 2) + "┤");
    for (const line of lines) {
      assert.equal(visibleWidth(line), width);
      assert.match(line, /^[│┌├└]/);
      assert.match(line, /[│┐┤┘]$/);
    }
  }
  sidebar.setView(image());
  for (const line of sidebar.render(40).map(stripAnsi)) assert.match(line, /[│┐┤┘]$/, "preview rows keep the right border");
});
