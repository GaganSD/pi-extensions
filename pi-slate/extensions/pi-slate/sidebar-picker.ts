import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, type Component, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { sidebarText } from "./sidebar-data.ts";
import { SIDEBAR_DIALOG_OPTIONS, sidebarDialogBudget, sidebarDialogRows } from "./sidebar-dialog.ts";

/** Bounded keyboard/mouse picker. Return original snapshot values, never display text. */
export async function pickSidebarItem(ctx: ExtensionContext, title: string, options: readonly string[]): Promise<string | undefined> {
  if (ctx.mode !== "tui" || !options.length) return undefined;
  const items = [...options];
  return ctx.ui.custom<string | undefined>((tui, theme, _keys, done) => {
    let selected = 0, offset = 0, height = 1, bodyStart = 0;
    const move = (delta: number) => { selected = Math.max(0, Math.min(items.length - 1, selected + delta)); tui.requestRender(); };
    return {
      render(width: number): string[] {
        const budget = sidebarDialogBudget(tui.terminal.rows);
        height = Math.min(budget.body, items.length);
        bodyStart = Number(budget.heading) + Number(budget.rule);
        offset = Math.max(0, Math.min(offset, selected, items.length - height));
        if (selected >= offset + height) offset = selected - height + 1;
        const body = items.slice(offset, offset + height).map((item, i) => {
          const label = `${offset + i === selected ? " › " : "   "}${sidebarText(item)}`;
          return offset + i === selected ? theme.fg("accent", label) : label;
        });
        return sidebarDialogRows(title, body, `${selected + 1}/${items.length} · ↑↓ / wheel · Enter selects · Esc cancels`, width, theme, budget);
      },
      handleInput(data: string): void {
        if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) done(undefined);
        else if (matchesKey(data, "enter")) done(items[selected]);
        else if (matchesKey(data, "up")) move(-1);
        else if (matchesKey(data, "down")) move(1);
        else if (matchesKey(data, "pageUp")) move(-height);
        else if (matchesKey(data, "pageDown")) move(height);
        else if (matchesKey(data, "home")) move(-items.length);
        else if (matchesKey(data, "end")) move(items.length);
      },
      handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
        if (event.type === "wheel") { move(-(event.wheelDelta ?? 0)); return { handled: true, render: true }; }
        const row = event.y - bodyStart;
        if (event.type === "click" && event.button === "left" && row >= 0 && row < height) {
          selected = offset + row; done(items[selected]); return { handled: true };
        }
        return undefined;
      },
      invalidate() {},
    } satisfies Component;
  }, SIDEBAR_DIALOG_OPTIONS);
}
