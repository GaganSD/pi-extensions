import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { sidebarText } from "./sidebar-data.ts";
import { matchesKey, wrapTextWithAnsi, type Component, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { SIDEBAR_DIALOG_OPTIONS, sidebarDialogBudget, sidebarDialogRows } from "./sidebar-dialog.ts";

/** Read-only details, separate from the image shelf and from model-facing messages. */
export async function inspectSidebarText(ctx: ExtensionContext, title: string, text: string): Promise<void> {
  if (ctx.mode !== "tui") return;
  await ctx.ui.custom<void>((tui, theme, _keys, done) => {
    let offset = 0; let height = 1; let count = 0;
    const scroll = (delta: number) => {
      const next = Math.max(0, Math.min(offset + delta, Math.max(0, count - height)));
      if (next === offset) return false;
      offset = next; tui.requestRender(); return true;
    };
    return {
      render(width: number): string[] {
        const bodyWidth = Math.max(1, width - 4);
        const lines = text.split("\n").flatMap(line => wrapTextWithAnsi(sidebarText(line, 2000), bodyWidth));
        const budget = sidebarDialogBudget(tui.terminal.rows);
        height = budget.body; count = lines.length;
        offset = Math.min(offset, Math.max(0, count - height));
        const body = Array.from({ length: height }, (_, i) => ` ${lines[offset + i] ?? ""}`);
        return sidebarDialogRows(title, body, "↑↓ / wheel scroll · Esc closes · read-only", width, theme, budget);
      },
      handleInput(data: string): void {
        if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) done();
        else if (matchesKey(data, "up")) scroll(-1);
        else if (matchesKey(data, "down")) scroll(1);
        else if (matchesKey(data, "pageUp")) scroll(-height);
        else if (matchesKey(data, "pageDown")) scroll(height);
        else if (matchesKey(data, "home")) scroll(-count);
        else if (matchesKey(data, "end")) scroll(count);
      },
      handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
        if (event.type !== "wheel") return undefined;
        scroll(-(event.wheelDelta ?? 0)); return { handled: true, render: true };
      },
      invalidate() {},
    } satisfies Component;
  }, SIDEBAR_DIALOG_OPTIONS);
}
