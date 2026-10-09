import { basename } from "node:path";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { hairlineTextWidth, wrapHairlineText, symmetricHairline } from "./hairline.ts";
import { sidebarText } from "./sidebar-data.ts";
import { formatUpdateNotice, type UpdateNotice } from "./updates.ts";

export function renderUpdateHairlines(
  notice: string, width: number, paintDash: (text: string) => string, paintText: (text: string) => string,
): string[] {
  return wrapHairlineText(notice, hairlineTextWidth(width)).map(line => symmetricHairline(paintText(line), width, paintDash));
}

/** One identity line. Model, thinking and accounting belong in the rail or compact composer. */
export function renderSlateHeader(input: {
  width: number; path: string; branch?: string | null; notice?: string; ready?: boolean; theme: Theme;
}): string[] {
  const width = Math.max(0, input.width);
  if (!width) return [];
  const project = sidebarText(basename(input.path) || input.path);
  const identity = `slate / ${project}`;
  const branch = sidebarText(input.branch);
  const available = Math.max(0, width - visibleWidth(identity) - 3);
  const right = available >= 8 && branch ? truncateToWidth(branch, available, "…") : "";
  const left = truncateToWidth(identity, right ? width - visibleWidth(right) - 3 : width, "…");
  const line = input.theme.fg("accent", left) + (right
    ? " ".repeat(Math.max(3, width - visibleWidth(left) - visibleWidth(right))) + input.theme.fg("muted", right) : "");
  const rows = [line, input.theme.fg("border", "─".repeat(width))];
  if (input.notice) rows.push(...renderUpdateHairlines(input.notice, width,
    text => input.theme.fg("border", text), text => input.theme.fg("accent", text)));
  if (input.ready) rows.push("",
    truncateToWidth(input.theme.bold("Ready when you are."), width, "…"),
    truncateToWidth(input.theme.fg("muted", "Ask a question, explore the code, or start with /."), width, "…"));
  return rows;
}

export class SlateHeader implements Component {
  private readonly theme: Theme;
  private readonly getContext: () => ExtensionContext | undefined;
  private readonly columnWidth: (width: number) => number;
  private readonly getNotice: () => UpdateNotice;
  private readonly getBranch: () => string | null;
  private readonly getReady: () => boolean;
  constructor(theme: Theme, getContext: () => ExtensionContext | undefined,
    columnWidth: (width: number) => number, getNotice: () => UpdateNotice, getBranch: () => string | null = () => null, getReady: () => boolean = () => false) {
    this.theme = theme; this.getContext = getContext; this.columnWidth = columnWidth;
    this.getNotice = getNotice; this.getBranch = getBranch; this.getReady = getReady;
  }
  invalidate(): void {}
  render(width: number): string[] {
    const ctx = this.getContext();
    if (!ctx) return [];
    const notice = formatUpdateNotice(this.getNotice());
    return renderSlateHeader({ width: this.columnWidth(width), path: ctx.cwd,
      branch: this.getBranch(), ready: this.getReady(), ...(notice ? { notice } : {}), theme: ctx.ui.theme ?? this.theme });
  }
}
