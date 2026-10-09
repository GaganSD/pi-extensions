import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth, type EditorTheme, type TUI } from "@earendil-works/pi-tui";
import { KeybindingsManager } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import { loadThemeFromPath } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { ComposerEditor, type ComposerSource } from "../extensions/pi-slate/composer.ts";
import { dashboardColumnWidth, formatCompactTokenCount, parseSlateArgs } from "../extensions/pi-slate/layout.ts";
import { SLATE_THEME } from "../extensions/pi-slate/install-defaults.ts";
import { sessionSidebarSlots, sidebarCost } from "../extensions/pi-slate/sidebar-layout.ts";
import { Sidebar } from "../extensions/pi-slate/sidebar.ts";
import type { SidebarSession } from "../extensions/pi-slate/sidebar-data.ts";

const theme = loadThemeFromPath(new URL("../themes/tokyo-night.json", import.meta.url).pathname, "truecolor");
const session: SidebarSession = { id: "example-session", name: "Quiet workbench", pid: 8421, cwd: "/tmp/project",
  model: "sample-model", thinking: "medium", tokens: 55000, percent: 11, contextWindow: 500000,
  estimated: false, rate: 82, startedAt: 1000, lastTurnMs: 14000, working: true, turns: 4, messages: 8,
  usage: { input: 128400, output: 6800, total: 135200, cacheRead: 94000, cacheWrite: 22000, cost: 1.24 } };

test("bundled default Tokyo Night loads with the native validator and restrained backgrounds", () => {
  assert.equal(SLATE_THEME, "tokyo-night"); assert.equal(theme.name, SLATE_THEME);
  assert.match(theme.fg("accent", "x"), /38;2;122;162;247/);
  assert.match(theme.fg("text", "x"), /38;2;192;202;245/);
  assert.equal(theme.getBgAnsi("toolPendingBg"), theme.getBgAnsi("userMessageBg"));
  assert.equal(theme.getBgAnsi("toolSuccessBg"), theme.getBgAnsi("userMessageBg"));
  assert.notEqual(theme.getBgAnsi("customMessageBg"), theme.getBgAnsi("userMessageBg"));
});

test("default command selects Tokyo Night while explicit Catppuccin default remains available", () => {
  for (const name of ["default", "tokyo-night", "tokyonight"])
    assert.deepEqual(parseSlateArgs("theme " + name), { ok: true, kind: "named-theme", name: "tokyo-night" });
  assert.deepEqual(parseSlateArgs("theme mocha default"), { ok: true, kind: "theme", flavor: "mocha", style: "default" });
  assert.deepEqual(parseSlateArgs("style default"), { ok: true, kind: "style", value: "default" });
  assert.deepEqual(parseSlateArgs("theme tokyo-night extra"), { ok: false });
});

test("compact viewport hides the rail without changing stored width or focus", () => {
  assert.equal(dashboardColumnWidth(140, 40), 28);
  assert.equal(dashboardColumnWidth(140, 29, 40), 0);
  assert.equal(dashboardColumnWidth(99, 40, 40), 0);
  assert.equal(dashboardColumnWidth(100, 30, 40), 40);
  assert.equal(dashboardColumnWidth(140, 40, -1), 0);
});

test("empty shelves allocate zero rows and all allocations remain bounded", () => {
  for (let height = 0; height < 80; height++) {
    const empty = sessionSidebarSlots(height, 0, false);
    assert.equal(empty.tasks, 0); assert.equal(empty.image, 0);
    for (const tasks of [0, 1, 10]) for (const image of [false, true]) {
      const values = Object.values(sessionSidebarSlots(height, tasks, image));
      assert.equal(values.reduce((a, b) => a + b, 0), height);
      assert(values.every(n => n >= 0));
    }
  }
});

test("growing usage and money keep a stable label lane and value edge with the real theme", () => {
  const sidebar = new Sidebar(() => 10000);
  sidebar.attach({ terminal: { rows: 50, columns: 140 }, requestRender() {} } as unknown as TUI, theme);
  for (const width of [28, 40, 80]) {
    for (const value of [0, 999, 128400, 999900000, 1e12, 1e20, 1e308, null]) {
      sidebar.setSession({ ...session, usage: { ...session.usage, input: value, output: value, cost: value } });
      const rows = sidebar.render(width).map(stripVTControlCharacters);
      for (const label of ["Input", "Output", "Cost"]) {
        const line = rows.find(row => row.startsWith("│ " + label + " "))!;
        assert(line, label); assert.equal(visibleWidth(line), width);
        assert.equal(visibleWidth(line.trimEnd()), width, "right edge must not move");
        assert.doesNotMatch(line, /…/, "values must not consume the label lane");
      }
    }
  }
  assert.equal(formatCompactTokenCount(1e9), "1B"); assert.equal(formatCompactTokenCount(1e12), "1T");
  assert.equal(sidebarCost(null), "—"); assert.equal(sidebarCost(Number.NaN), "—");
  assert.equal(sidebarCost(-1), "—"); assert.equal(sidebarCost(1.24), "$1.24");
  assert.equal(sidebarCost(1e308), "$1.0e+308");
  sidebar.dispose();
});

test("quiet editor avoids duplicate identity/model and restores compact facts without losing its draft", () => {
  const source: ComposerSource = { project: "project", branch: "feat/workbench", model: { id: "sample-model", provider: "sample" },
    thinking: "medium", footer: "standard", theme, paddingX: 4, workspaceHeader: true, dashboardVisible: true,
    context: { tokens: "11%/500k tokens", resources: "", summary: "ctx 11% · $1.24" } };
  const editor = new ComposerEditor({ terminal: { rows: 40, columns: 140 }, requestRender() {} } as unknown as TUI,
    { borderColor: text => text } as EditorTheme, new KeybindingsManager(), () => source, { paddingX: 4 });
  editor.setPaddingX(0); // Native host copies its own padding after the factory returns.
  editor.setText("Preserve this draft");
  let text = editor.render(100).map(stripVTControlCharacters).join("\n");
  assert.match(text, /› Preserve this draft/);
  assert.equal(editor.getPaddingX(), 4, "density must restore native cursor and mouse geometry");
  assert.doesNotMatch(text, /project|feat\/workbench|sample-model|ctx/);
  assert.match(text, /enter send/);
  source.working = true; assert.match(editor.render(100).map(stripVTControlCharacters).join("\n"), /enter steer/);
  source.dashboardVisible = false;
  for (const width of [38, 80, 100]) {
    const lines = editor.render(width);
    assert(lines.every(line => visibleWidth(line) <= width));
    text = lines.map(stripVTControlCharacters).join("\n");
    assert.match(text, /ctx 11% · \$1\.24/);
    assert.doesNotMatch(text, /feat\/workbench/);
  }
  assert.equal(editor.getText(), "Preserve this draft");
  assert.match(editor.render(100).map(stripVTControlCharacters).join("\n"), /sample-model/);
});
