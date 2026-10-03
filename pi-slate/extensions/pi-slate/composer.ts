import { stripVTControlCharacters } from "node:util";
import { CustomEditor, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import {
  truncateToWidth,
  visibleWidth,
  type EditorTheme,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { footerVisibility, modelStatusLabel, type ModelDisplay } from "./layout.ts";

export function composerPaddingX(density: "comfortable" | "compact"): number {
  return density === "compact" ? 2 : 4;
}

export function chromePaint(theme: Theme): (text: string) => string {
  return (text) => theme.fg("border", text);
}

const ESCAPE_SEQUENCE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|_[^\x07]*(?:\x07|$)|\][^\x07]*(?:\x07|\x1b\\|$))/y;
const REVERSE_ON = "\x1b[7m";
const REVERSE_OFF = "\x1b[27m";
const RESET = "\x1b[0m";
const FRAME_CHROME = /[│╭╮╰╯├┤─›]/u;

/** Invert prompt text only. Leading/trailing space and box chrome stay unselected. */
export function paintSelectedContent(line: string): string {
  const cells: Array<{ start: number; end: number; char: string }> = [];

  for (let index = 0; index < line.length;) {
    ESCAPE_SEQUENCE.lastIndex = index;
    const escape = ESCAPE_SEQUENCE.exec(line);
    if (escape) {
      index += escape[0].length;
      continue;
    }

    const codePoint = line.codePointAt(index);
    if (codePoint === undefined) break;
    const character = String.fromCodePoint(codePoint);
    cells.push({ start: index, end: index + character.length, char: character });
    index += character.length;
  }

  let from = 0;
  let to = cells.length;
  while (from < to && (/\s/u.test(cells[from]!.char) || FRAME_CHROME.test(cells[from]!.char))) from += 1;
  while (to > from && (/\s/u.test(cells[to - 1]!.char) || FRAME_CHROME.test(cells[to - 1]!.char))) to -= 1;
  if (from >= to) return line;

  const firstText = cells[from]!.start;
  const lastTextEnd = cells[to - 1]!.end;
  const before = line.slice(0, firstText);
  const text = line.slice(firstText, lastTextEnd).replaceAll(RESET, `${RESET}${REVERSE_ON}`);
  const after = line.slice(lastTextEnd);
  return `${before}${REVERSE_ON}${text}${REVERSE_OFF}${after}`;
}

export type ComposerCursor = { line: number; col: number };

export type ComposerSelectionRange = {
  start: ComposerCursor;
  end: ComposerCursor;
};

export function compareComposerCursor(a: ComposerCursor, b: ComposerCursor): number {
  return a.line === b.line ? a.col - b.col : a.line - b.line;
}

export function orderComposerRange(range: ComposerSelectionRange): ComposerSelectionRange {
  return compareComposerCursor(range.start, range.end) <= 0 ? range : { start: range.end, end: range.start };
}

export function sliceComposerText(text: string, range: ComposerSelectionRange): string {
  const { start, end } = orderComposerRange(range);
  const lines = text.split("\n");
  if (start.line === end.line) return (lines[start.line] ?? "").slice(start.col, end.col);
  const parts = [(lines[start.line] ?? "").slice(start.col)];
  for (let index = start.line + 1; index < end.line; index++) parts.push(lines[index] ?? "");
  parts.push((lines[end.line] ?? "").slice(0, end.col));
  return parts.join("\n");
}

/** Invert visible columns in [startCol, endCol). Box rails stay unselected. */
export function paintSelectedSpan(line: string, startCol: number, endCol: number): string {
  if (endCol <= startCol) return line;
  const cells: Array<{ start: number; end: number; char: string; col: number; width: number }> = [];
  let col = 0;

  for (let index = 0; index < line.length;) {
    ESCAPE_SEQUENCE.lastIndex = index;
    const escape = ESCAPE_SEQUENCE.exec(line);
    if (escape) {
      index += escape[0].length;
      continue;
    }

    const codePoint = line.codePointAt(index);
    if (codePoint === undefined) break;
    const character = String.fromCodePoint(codePoint);
    const width = visibleWidth(character);
    cells.push({ start: index, end: index + character.length, char: character, col, width });
    col += width;
    index += character.length;
  }

  let from = -1;
  let to = -1;
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i]!;
    if (FRAME_CHROME.test(cell.char)) continue;
    if (cell.col + cell.width <= startCol || cell.col >= endCol) continue;
    if (from < 0) from = i;
    to = i;
  }
  if (from < 0 || to < 0) return line;

  const firstText = cells[from]!.start;
  const lastTextEnd = cells[to]!.end;
  const before = line.slice(0, firstText);
  const text = line.slice(firstText, lastTextEnd).replaceAll(RESET, `${RESET}${REVERSE_ON}`);
  const after = line.slice(lastTextEnd);
  return `${before}${REVERSE_ON}${text}${REVERSE_OFF}${after}`;
}

export function composerRangeColumns(
  visual: { logicalLine: number; startCol: number; length: number },
  range: ComposerSelectionRange,
  paddingX: number,
): { from: number; to: number } | undefined {
  const { start, end } = orderComposerRange(range);
  if (visual.logicalLine < start.line || visual.logicalLine > end.line) return undefined;
  const visualStart = visual.startCol;
  const visualEnd = visual.startCol + visual.length;
  const selectedStart = visual.logicalLine === start.line ? start.col : 0;
  const selectedEnd = visual.logicalLine === end.line ? end.col : Number.POSITIVE_INFINITY;
  const from = Math.max(visualStart, selectedStart);
  const to = Math.min(visualEnd, selectedEnd);
  if (to <= from) return undefined;
  return { from: paddingX + (from - visual.startCol), to: paddingX + (to - visual.startCol) };
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
  model: { id?: string; name?: string; provider?: string } | undefined;
  modelDisplay?: ModelDisplay;
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
  return inscribedBorder(more, resources ? ` ${resources} ` : "", width, paint, "╭", "╮");
}

export type ComposerStatusIndicator = {
  kind?: string;
  renderInBorder(width: number): string;
};

/** Pi paints working status with editor.borderColor. Slate chrome is the frame, so restyle that kind only. */
export function composerStatusLabel(
  indicator: ComposerStatusIndicator | undefined,
  theme: Theme,
  width = 240,
): string {
  if (!indicator || width <= 0) return "";
  const raw = indicator.renderInBorder(width);
  if (indicator.kind !== undefined && indicator.kind !== "working") return raw.trimEnd();
  const text = stripVTControlCharacters(raw).trim();
  return text ? theme.italic(theme.fg("accent", text)) : "";
}

/** Live status first, then overflow, then static right decorations. */
export function composerStatusContextEdge(
  resources: string,
  width: number,
  paint: (text: string) => string,
  hiddenLineCount = 0,
  status = "",
  renderStatus?: (width: number) => string,
): string {
  if (width <= 0) return "";
  if (width === 1) return paint("╭");
  if (width === 2) return paint("╭╮");

  const innerWidth = width - 2;
  const more = hiddenLineCount > 0 ? paint(` ↑ ${hiddenLineCount} more `) : "";
  let right = resources ? ` ${resources} ` : "";
  const minFill = 1;
  const prefix = paint("── ");
  const statusAt = (budget: number): string => {
    const body = renderStatus ? renderStatus(Math.max(0, budget)) : status;
    return body ? `${prefix}${body} ` : "";
  };

  let left = statusAt(innerWidth - minFill);
  while (visibleWidth(left) + visibleWidth(right) + minFill > innerWidth && visibleWidth(right) > 0) {
    right = truncateToWidth(right, Math.max(0, visibleWidth(right) - 1), "");
  }
  const remaining = innerWidth - visibleWidth(right) - minFill;
  left = statusAt(remaining);
  if (!left && more) left = more;
  else if (left && more && visibleWidth(left) + visibleWidth(more) + visibleWidth(right) + minFill <= innerWidth) {
    left = `${left}${more}`;
  }
  while (visibleWidth(left) + visibleWidth(right) + minFill > innerWidth && visibleWidth(left) > 0) {
    left = truncateToWidth(left, Math.max(0, visibleWidth(left) - 1), "");
  }
  const fill = Math.max(minFill, innerWidth - visibleWidth(left) - visibleWidth(right));
  return `${paint("╭")}${left}${paint("─".repeat(fill))}${right}${paint("╮")}`;
}

type WorkingStatusIndicatorParameter = Parameters<CustomEditor["setWorkingStatusIndicator"]>[0];

type ComposerVisualLine = {
  logicalLine: number;
  startCol: number;
  length: number;
};

type ComposerScrollInternals = {
  lastWidth?: number;
  scrollOffset?: number;
  renderedVisibleLineCount?: number;
  buildVisualLineMap?: (width: number) => ComposerVisualLine[];
  findCurrentVisualLine?: (lines: ComposerVisualLine[]) => number;
  moveToVisualLine?: (lines: ComposerVisualLine[], from: number, to: number) => void;
};

/** Scroll hidden prompt lines. Returns false when the whole prompt is already visible. */
export function scrollComposerByLines(editor: object, delta: number): boolean {
  if (!Number.isFinite(delta) || delta === 0) return false;
  const internals = editor as ComposerScrollInternals;
  const width = internals.lastWidth;
  if (!width || typeof internals.buildVisualLineMap !== "function" || typeof internals.moveToVisualLine !== "function") {
    return false;
  }

  const visualLines = internals.buildVisualLineMap(width);
  if (!Array.isArray(visualLines) || visualLines.length === 0) return false;

  const maxVisible = Math.max(1, internals.renderedVisibleLineCount || visualLines.length);
  const maxOffset = Math.max(0, visualLines.length - maxVisible);
  if (maxOffset === 0) return false;

  const currentOffset = Math.max(0, Math.min(internals.scrollOffset ?? 0, maxOffset));
  const direction = delta < 0 ? -1 : 1;
  const steps = Math.max(1, Math.round(Math.abs(delta)));
  const desiredOffset = Math.max(0, Math.min(maxOffset, currentOffset + direction * steps));
  if (desiredOffset === currentOffset) return false;

  const currentLine = typeof internals.findCurrentVisualLine === "function"
    ? internals.findCurrentVisualLine(visualLines)
    : currentOffset;
  const rel = Math.max(0, Math.min(maxVisible - 1, currentLine - currentOffset));
  internals.moveToVisualLine(visualLines, currentLine, desiredOffset + rel);
  internals.scrollOffset = desiredOffset;
  return true;
}

export class ComposerEditor extends CustomEditor {
  selectionActive = false;
  selectionRange?: ComposerSelectionRange;
  private readonly source: () => ComposerSource;
  private statusIndicator: WorkingStatusIndicatorParameter;

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

  override setWorkingStatusIndicator(indicator: WorkingStatusIndicatorParameter): void {
    this.statusIndicator = indicator;
    super.setWorkingStatusIndicator(indicator);
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type === "wheel") {
      if (scrollComposerByLines(this, event.wheelDelta ?? 0)) return { handled: true, focus: true };
      return undefined;
    }
    return super.handleMouse(event);
  }

  protected renderTopBorder(width: number, hiddenLineCount: number): string {
    if (width <= 2) return super.renderTopBorder(width, hiddenLineCount);
    const src = this.source();
    const paint = (text: string) => this.borderColor(text);
    const renderStatus = this.embedWorkingStatus
      ? (statusWidth: number) => composerStatusLabel(this.statusIndicator, src.theme, statusWidth)
      : undefined;
    if (src.context || this.statusIndicator) {
      return composerStatusContextEdge(
        src.context ? src.theme.fg("dim", src.context.resources) : "",
        width,
        paint,
        hiddenLineCount,
        "",
        renderStatus,
      );
    }
    return paint("╭") + super.renderTopBorder(width - 2, hiddenLineCount) + paint("╮");
  }

  protected renderBottomBorder(width: number, hiddenLineCount: number): string {
    const src = this.source();
    const more = hiddenLineCount > 0 ? this.borderColor(` ↓ ${hiddenLineCount} more `) : "";
    const { left, right } = composerLabels(
      {
        project: src.project,
        branch: src.branch,
        model: modelStatusLabel(src.model, src.modelDisplay),
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
    const raw = super.render(width);
    const selected = this.selectionActive && !this.isShowingAutocomplete()
      ? raw.map((line, index) => index === 0 || index === raw.length - 1 ? line : paintSelectedContent(line))
      : raw;
    const lines = padComposerFrame(
      frameComposerLines(selected, {
        width,
        empty: this.getText().length === 0,
        paddingX: this.getPaddingX(),
        paint,
        theme: this.source().theme,
      }),
      width,
      paint,
    );
    const ranged = !this.selectionActive && this.selectionRange && !this.isShowingAutocomplete()
      ? paintComposerRange(lines, this, this.selectionRange, this.getPaddingX())
      : lines;
    noteComposerFrameLines(ranged.length);
    return ranged;
  }
}

function paintComposerRange(
  lines: string[],
  editor: object,
  range: ComposerSelectionRange,
  paddingX: number,
): string[] {
  const internals = editor as ComposerScrollInternals;
  const width = internals.lastWidth;
  if (!width || typeof internals.buildVisualLineMap !== "function" || lines.length < 3) return lines;
  const visualLines = internals.buildVisualLineMap(width);
  const visible = Math.max(0, internals.renderedVisibleLineCount ?? 0);
  const offset = Math.max(0, internals.scrollOffset ?? 0);
  if (visible === 0 || !Array.isArray(visualLines)) return lines;
  return lines.map((line, index) => {
    if (index === 0 || index === lines.length - 1 || index > visible) return line;
    const visual = visualLines[offset + index - 1];
    if (!visual) return line;
    const columns = composerRangeColumns(visual, range, paddingX);
    return columns ? paintSelectedSpan(line, columns.from, columns.to) : line;
  });
}
