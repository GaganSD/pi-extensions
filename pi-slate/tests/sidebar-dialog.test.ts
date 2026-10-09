import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { TuiAltScreen, type Component, type OverlayOptions, type Terminal, visibleWidth } from "@earendil-works/pi-tui";
import { inspectSidebarText } from "../extensions/pi-slate/sidebar-inspector.ts";
import { pickSidebarItem } from "../extensions/pi-slate/sidebar-picker.ts";

class NullTerminal implements Terminal {
  columns = 100; rows: number; kittyProtocolActive = false;
  constructor(rows: number) { this.rows = rows; }
  start() {} stop() {} async drainInput() {} write() {} moveBy() {} hideCursor() {} showCursor() {}
  clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {} setProgress() {}
}
function overlay(rows: number) {
  const tui = new TuiAltScreen(new NullTerminal(rows));
  const theme = { fg: (_color: string, text: string) => text } as Theme;
  let component!: Component;
  const ctx = { mode: "tui", ui: { custom: (factory: (tui: TuiAltScreen, theme: Theme, keys: unknown, done: (value: unknown) => void) => Component, options: { overlayOptions: OverlayOptions }) => new Promise(resolve => {
    component = factory(tui, theme, {}, resolve); tui.showOverlay(component, options.overlayOptions);
  }) } } as unknown as ExtensionContext;
  const frame = () => (Reflect.get(tui, "compositeOverlays") as (lines: string[], width: number, height: number) => string[]).call(tui, Array.from({ length: rows }, () => ""), 100, rows).join("\n");
  return { ctx, tui, frame, input: (key: string) => component.handleInput?.(key), render: () => component.render(80) };
}
for (const rows of [2, 3, 5, 24, 27, 28, 29, 30, 40]) {
  test(`inspector final detail line stays reachable through real compositor at ${rows} rows`, async () => {
    const f = overlay(rows);
    const pending = inspectSidebarText(f.ctx, "Details", Array.from({ length: 60 }, (_, i) => `detail-${i}`).join("\n"));
    f.frame(); f.input("\x1b[F");
    assert.match(f.frame(), /detail-59/);
    assert(f.render().length <= Math.max(1, Math.floor(rows * .85)));
    f.input("\x1b"); await pending;
  });
}
test("oversized picker keeps final selection visible through real fullscreen compositor and returns the original snapshot value", async () => {
  const f = overlay(24);
  const items = Array.from({ length: 64 }, (_, i) => `/command-${i}`); items[63] += "\x1b[2J";
  const expected = items[63];
  const pending = pickSidebarItem(f.ctx, "Commands", items);
  items[63] = "changed";
  f.frame(); f.input("\x1b[F");
  assert.match(f.frame(), /› \/command-63/); assert.match(f.frame(), /64\/64/);
  assert(f.render().every(row => visibleWidth(row) <= 80));
  f.input("\r"); assert.equal(await pending, expected);
});
