import { stripVTControlCharacters } from "node:util";
import { CustomEditor, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import {
  truncateToWidth,
  visibleWidth,
  type EditorTheme,
  type TUI,
} from "@earendil-works/pi-tui";
import { footerVisibility, modelLabel } from "./layout.ts";

export function composerPaddingX(density: "comfortable" | "compact"): number {
  return density === "compact" ? 2 : 4;
}

export function chromePaint(theme: Theme): (text: string) => string {
  return (text) => theme.fg("border", text);
}

export const COMPOSER_SHELF_LINES = 4;

let lastComposerFrameLines = COMPOSER_SHELF_LINES;

export function composerFrameLineCount(): number {
  return lastComposerFrameLines;
}

export function noteComposerFrameLines(count: number): void {
  lastComposerFrameLines = Math.max(COMPOSER_SHELF_LINES, Math.floor(count));
}

export function padComposerFrame(
  lines: string[],
  width: number,
  paint: (text: string) => string,
  min = COMPOSER_SHELF_LINES,
): string[] {
  if (lines.length >= min || lines.length < 2) return lines;
  const out = lines.slice();
  let bottom = out.length - 1;
  for (let i = out.length - 1; i >= 1; i--) {
    if (stripVTControlCharacters(out[i] ?? "").includes("╰")) {
      bottom = i;
      break;
    }
  }
  while (out.length < min) {
    out.splice(bottom, 0, frameRow("", width, paint));
    bottom += 1;
  }
  return out;
}

export function frameRow(body: string, width: number, paint: (text: string) => string): string {
  if (width <= 0) return "";
  if (width === 1) return paint("│");
  const inner = Math.max(0, width - 2);
  const text = visibleWidth(body) > inner ? truncateToWidth(body, inner, "") : body;
  const gap = Math.max(0, inner - visibleWidth(text));
  return `${paint("│")}${text}${" ".repeat(gap)}${paint("│")}`;
}

export function inscribedTitle(
  title: string,
  width: number,
  paint: (text: string) => string,
  kind: "top" | "mid" | "bottom",
  right = "",
): string {
  const ends = { top: ["╭", "╮"], mid: ["├", "┤"], bottom: ["╰", "╯"] }[kind];
  const left = title ? `─ ${title} ` : "";
  const tail = right ? ` ${right} ` : "";
  return inscribedBorder(left, tail, width, paint, ends[0]!, ends[1]!);
}

export function inscribedBorder(
  left: string,
  right: string,
  width: number,
  paint: (text: string) => string,
  open: string,
  close: string,
): string {
  if (width <= 0) return "";
  if (width === 1) return paint(open);
  if (width === 2) return paint(open + close);

  let leftText = left;
  let rightText = right;
  const corners = 2;
  const minFill = 1;
  while (
    corners + visibleWidth(leftText) + visibleWidth(rightText) + minFill > width &&
    visibleWidth(rightText) > 0
  ) {
    rightText = truncateToWidth(rightText, Math.max(0, visibleWidth(rightText) - 1), "");
  }
  while (
    corners + visibleWidth(leftText) + visibleWidth(rightText) + minFill > width &&
    visibleWidth(leftText) > 0
  ) {
    leftText = truncateToWidth(leftText, Math.max(0, visibleWidth(leftText) - 1), "");
  }
  const fill = Math.max(minFill, width - corners - visibleWidth(leftText) - visibleWidth(rightText));
  return `${paint(open)}${leftText}${paint("─".repeat(fill))}${rightText}${paint(close)}`;
}

export function composerLabels(
  input: {
    project: string;
    branch: string | null;
    model: string;
    thinking?: string;
    tokens?: string;
    footer: "standard" | "minimal";
  },
  theme: Theme,
  width: number,
): { left: string; right: string } {
  const visible = footerVisibility(width);
  const project = theme.fg("accent", input.project);
  const branch = visible.showBranch && input.branch ? theme.fg("muted", ` / ${input.branch}`) : "";
  const projectLabel = ` ${project}${branch} `;
  if (input.footer === "minimal") return { left: projectLabel, right: "" };

  const parts: string[] = [];
  if (visible.showTokens && input.tokens) parts.push(theme.fg("muted", input.tokens));
  if (visible.showModel) parts.push(theme.fg("muted", input.model));
  if (visible.showThinking && input.thinking) parts.push(theme.fg("dim", input.thinking));
  const modelLabelText = parts.length ? ` ${parts.join(theme.fg("borderMuted", " · "))} ` : "";
  return { left: projectLabel, right: modelLabelText };
}

export function frameComposerLines(
  lines: string[],
  opts: {
    width: number;
    empty: boolean;
    paddingX: number;
    paint: (text: string) => string;
    theme?: Theme;
  },
): string[] {
  if (lines.length < 2) return lines;
  let bottom = -1;
  for (let i = lines.length - 1; i >= 1; i--) {
    if (stripVTControlCharacters(lines[i] ?? "").includes("╰")) {
      bottom = i;
      break;
    }
  }
  if (bottom < 1) bottom = lines.length - 1;

  const out = lines.slice();
  const prompt = opts.empty && opts.paddingX >= 4;
  for (let i = 1; i < bottom; i++) {
    out[i] = sideBorder(out[i] ?? "", opts.width, opts.paint, prompt && i === 1, opts.theme);
  }
  return out;
}

function sideBorder(line: string, width: number, paint: (text: string) => string, prompt: boolean, theme?: Theme): string {
  const leftCols = prompt ? 4 : 1;
  const prefix = " ".repeat(leftCols);
  let body = line.startsWith(prefix) ? line.slice(leftCols) : line;
  if (body.endsWith(" ")) body = body.slice(0, -1);
  const left = prompt ? `${paint("│")} › ` : paint("│");
  const inner = Math.max(0, width - leftCols - 1);
  if (visibleWidth(body) > inner) body = truncateToWidth(body, inner, "");
  const gap = Math.max(0, inner - visibleWidth(body));
  return `${left}${body}${" ".repeat(gap)}${paint("│")}`;
}

export type ComposerSource = {
  project: string;
  branch: string | null;
  model: { id?: string; name?: string } | undefined;
  thinking?: string;
  footer: "standard" | "minimal";
  theme: Theme;
  context?: { tokens: string; resources: string };
};

export function composerContextEdge(
  resources: string,
  width: number,
  paint: (text: string) => string,
  hiddenLineCount = 0,
): string {
  const more = hiddenLineCount > 0 ? ` ↑ ${hiddenLineCount} more ` : "";
  return inscribedBorder(more, ` ${resources} `, width, paint, "╭", "╮");
}

export class ComposerEditor extends CustomEditor {
  private readonly source: () => ComposerSource;

  constructor(
    tui: TUI,
    theme: EditorTheme,
    keybindings: KeybindingsManager,
    source: () => ComposerSource,
    options?: ConstructorParameters<typeof CustomEditor>[3],
  ) {
    super(tui, theme, keybindings, options);
    this.source = source;
    // Pi assigns thinking-level colors onto editor.borderColor. Ignore those writes.
    const paint = (text: string) => chromePaint(this.source().theme)(text);
    Object.defineProperty(this, "borderColor", {
      configurable: true,
      enumerable: true,
      get: () => paint,
      set: () => undefined,
    });
  }

  protected renderTopBorder(width: number, hiddenLineCount: number): string {
    if (width <= 2) return super.renderTopBorder(width, hiddenLineCount);
    const src = this.source();
    if (src.context) {
      return composerContextEdge(
        src.theme.fg("dim", src.context.resources),
        width,
        (text) => this.borderColor(text),
        hiddenLineCount,
      );
    }
    return this.borderColor("╭") + super.renderTopBorder(width - 2, hiddenLineCount) + this.borderColor("╮");
  }

  protected renderBottomBorder(width: number, hiddenLineCount: number): string {
    const src = this.source();
    const more = hiddenLineCount > 0 ? this.borderColor(` ↓ ${hiddenLineCount} more `) : "";
    const { left, right } = composerLabels(
      {
        project: src.project,
        branch: src.branch,
        model: modelLabel(src.model),
        thinking: src.thinking,
        tokens: src.context?.tokens,
        footer: src.footer,
      },
      src.theme,
      width,
    );
    return inscribedBorder(`${more}${left}`, right, width, (text) => this.borderColor(text), "╰", "╯");
  }

  render(width: number): string[] {
    const paint = (text: string) => this.borderColor(text);
    const lines = padComposerFrame(
      frameComposerLines(super.render(width), {
        width,
        empty: this.getText().length === 0,
        paddingX: this.getPaddingX(),
        paint,
        theme: this.source().theme,
      }),
      width,
      paint,
    );
    noteComposerFrameLines(lines.length);
    return lines;
  }
}
