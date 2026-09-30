import { homedir } from "node:os";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { compactPath, isBedrockProvider, modelLabel, PI_LOGO, PI_LOGO_ASCII, paintLogo } from "./layout.ts";
import { hairlineTextWidth, wrapHairlineText, symmetricHairline } from "./hairline.ts";
import { formatUpdateNotice, type UpdateNotice } from "./updates.ts";

const MASTHEAD_GAP = "  ";

export function renderMasthead(
  logo: readonly string[],
  lines: readonly [string, string, string],
  width: number,
  paintLogoLine: (text: string) => string,
  paintMuted: (text: string) => string,
  paintDim: (text: string) => string,
): string[] {
  const markWidth = visibleWidth(logo[0] ?? "");
  const textWidth = Math.max(0, width - markWidth - visibleWidth(MASTHEAD_GAP));
  const painted = [paintMuted(lines[0]), paintMuted(lines[1]), paintDim(lines[2])];
  return logo.map((mark, index) => {
    const logoLine = paintLogoLine(mark);
    const label = painted[index];
    if (!label || textWidth <= 0) return logoLine;
    return `${logoLine}${MASTHEAD_GAP}${truncateToWidth(label, textWidth, "…")}`;
  });
}

export function renderUpdateHairlines(
  notice: string,
  width: number,
  paintDash: (text: string) => string,
  paintText: (text: string) => string,
): string[] {
  return wrapHairlineText(notice, hairlineTextWidth(width)).map((line) => (
    symmetricHairline(paintText(line), width, paintDash)
  ));
}

export function renderSlateHeader(input: {
  width: number;
  version: string;
  model: string;
  path: string;
  notice?: string;
  ascii?: boolean;
  truecolor?: boolean;
  theme: Theme;
}): string[] {
  if (input.width < 20) return [];
  const logo = input.ascii ? PI_LOGO_ASCII : PI_LOGO;
  const paint = (token: "muted" | "dim" | "border" | "accent", text: string) => input.theme.fg(token, text);
  const rows = renderMasthead(
    logo,
    [`Pi Agent v${input.version}`, input.model, input.path],
    input.width,
    (text) => paintLogo(text, input.truecolor !== false),
    (text) => paint("muted", text),
    (text) => paint("dim", text),
  );
  if (!input.notice) return rows;
  return [
    ...rows,
    "",
    ...renderUpdateHairlines(
      input.notice,
      input.width,
      (text) => paint("border", text),
      (text) => paint("accent", text),
    ),
  ];
}

export class SlateHeader implements Component {
  private readonly theme: Theme;
  private readonly getContext: () => ExtensionContext;
  private readonly columnWidth: (width: number) => number;
  private readonly getNotice: () => UpdateNotice;
  private readonly version: string;

  constructor(
    theme: Theme,
    getContext: () => ExtensionContext,
    columnWidth: (width: number) => number,
    getNotice: () => UpdateNotice,
    version: string,
  ) {
    this.theme = theme;
    this.getContext = getContext;
    this.columnWidth = columnWidth;
    this.getNotice = getNotice;
    this.version = version;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const ctx = this.getContext();
    const notice = formatUpdateNotice(this.getNotice());
    const effort = ctx.thinkingLevel ? ` · ${ctx.thinkingLevel}` : "";
    return renderSlateHeader({
      width: this.columnWidth(width),
      version: this.version,
      model: `${ctx.model?.provider && !isBedrockProvider(ctx.model.provider) ? `${ctx.model.provider}/` : ""}${modelLabel(ctx.model)}${effort}`,
      path: compactPath(ctx.cwd, homedir()),
      ...(notice ? { notice } : {}),
      ascii: process.env.TERM === "dumb" || process.env.PI_SLATE_ASCII === "1",
      truecolor: this.theme.getColorMode() === "truecolor",
      theme: this.theme,
    });
  }
}
