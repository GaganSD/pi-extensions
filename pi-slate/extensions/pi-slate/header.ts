import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  backgroundAnsi, foregroundAnsi, rgbColor, truncateToWidth, visibleWidth, type Component, type TerminalColorMode,
} from "@earendil-works/pi-tui";
import { hairlineTextWidth, wrapHairlineText, symmetricHairline } from "./hairline.ts";
import { sidebarText } from "./sidebar-data.ts";
import { formatUpdateNotice, type UpdateNotice } from "./updates.ts";

const CORAL = rgbColor(228, 138, 122);
const BLUE = rgbColor(79, 142, 179);
const YELLOW = rgbColor(234, 182, 93);
const RESET = "\x1b[0m";
const LOGO_CELLS = 4;

export function supportsPiLogo(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.TERM_PROGRAM !== "Apple_Terminal";
}

function colorMode(theme: Theme): TerminalColorMode {
  return typeof theme.getColorMode === "function" ? theme.getColorMode() : "truecolor";
}

/** Stock Pi mark: 4 cells × 2 rows of half-blocks. Brand colors stay fixed. */
export function piLogoLines(theme: Theme): [string, string] {
  const mode = colorMode(theme);
  const fg = (color: typeof CORAL) => foregroundAnsi(color, mode);
  return [
    `${fg(CORAL)}${backgroundAnsi(BLUE, mode)}▀${RESET}${fg(CORAL)}▀█${RESET} `,
    `${fg(BLUE)}█▀${RESET} ${fg(YELLOW)}█${RESET}`,
  ];
}

export function piWordmark(theme: Theme): string {
  const mode = colorMode(theme);
  return `${foregroundAnsi(CORAL, mode)}P${RESET}${foregroundAnsi(YELLOW, mode)}i${RESET}`;
}

export function renderUpdateHairlines(
  notice: string, width: number, paintDash: (text: string) => string, paintText: (text: string) => string,
): string[] {
  return wrapHairlineText(notice, hairlineTextWidth(width)).map(line => symmetricHairline(paintText(line), width, paintDash));
}

function padLine(text: string, width: number): string {
  const gap = Math.max(0, width - visibleWidth(text));
  return `${text}${" ".repeat(gap)}`;
}

function logoRow(mark: string, text: string, width: number): string {
  const rest = truncateToWidth(text, Math.max(0, width - LOGO_CELLS - 1), "…");
  return padLine(`${mark} ${rest}`, width);
}

export type HeaderIdentity = { version: string; model?: string; thinking?: string };

/** Official mark + product stack. Ready is a session chip, never greeting copy. */
export function renderSlateHeader(input: {
  width: number; path: string; identity?: HeaderIdentity; notice?: string; ready?: boolean;
  logo?: boolean; theme: Theme;
}): string[] {
  const width = Math.max(0, input.width);
  if (!width) return [];
  const version = sidebarText(input.identity?.version) || "0";
  const model = sidebarText(input.identity?.model);
  const thinking = sidebarText(input.identity?.thinking);
  const path = sidebarText(input.path);
  const showLogo = input.logo ?? supportsPiLogo();
  const modelLine = [model, thinking].filter(Boolean).join(" · ");
  const rows: string[] = [];
  if (showLogo && width >= 12) {
    const [top, bottom] = piLogoLines(input.theme);
    rows.push(
      logoRow(top, input.theme.fg("text", `Pi Agent v${version}`), width),
      logoRow(bottom, modelLine ? input.theme.fg("muted", modelLine) : "", width),
      padLine(`${" ".repeat(LOGO_CELLS + 1)}${truncateToWidth(input.theme.fg("dim", path), Math.max(0, width - LOGO_CELLS - 1), "…")}`, width),
    );
  } else {
    const mark = piWordmark(input.theme);
    rows.push(padLine(truncateToWidth(`${mark} ${input.theme.fg("text", `Agent v${version}`)}`, width, "…"), width));
    if (modelLine) rows.push(padLine(truncateToWidth(input.theme.fg("muted", modelLine), width, "…"), width));
    if (path) rows.push(padLine(truncateToWidth(input.theme.fg("dim", path), width, "…"), width));
  }
  if (input.notice) rows.push(...renderUpdateHairlines(input.notice, width,
    text => input.theme.fg("border", text), text => input.theme.fg("accent", text)));
  else rows.push(input.theme.fg("border", "─".repeat(width)));
  if (input.ready) rows.push(truncateToWidth(input.theme.fg("accent", "✓ New session started"), width, "…"));
  return rows;
}

export class SlateHeader implements Component {
  private readonly theme: Theme;
  private readonly getContext: () => ExtensionContext | undefined;
  private readonly columnWidth: (width: number) => number;
  private readonly getNotice: () => UpdateNotice;
  private readonly getIdentity: () => HeaderIdentity & { ready: boolean };
  constructor(theme: Theme, getContext: () => ExtensionContext | undefined,
    columnWidth: (width: number) => number, getNotice: () => UpdateNotice,
    getIdentity: () => HeaderIdentity & { ready: boolean }) {
    this.theme = theme; this.getContext = getContext; this.columnWidth = columnWidth;
    this.getNotice = getNotice; this.getIdentity = getIdentity;
  }
  invalidate(): void {}
  render(width: number): string[] {
    const ctx = this.getContext();
    if (!ctx) return [];
    const notice = formatUpdateNotice(this.getNotice());
    const identity = this.getIdentity();
    return renderSlateHeader({
      width: this.columnWidth(width), path: ctx.cwd, identity,
      ready: identity.ready, theme: ctx.ui.theme ?? this.theme,
      ...(notice ? { notice } : {}),
    });
  }
}
