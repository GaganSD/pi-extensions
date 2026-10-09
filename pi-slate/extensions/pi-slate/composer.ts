import { stripVTControlCharacters } from "node:util";
import { CustomEditor, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import {
  truncateToWidth,
  visibleWidth,
  getKeybindings,
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

/** Pi agent process id, read once: it never changes during the session. */
const AGENT_PID = process.pid;

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

function sideBorder(line: string, width: number, paint: (text: string) => string, prompt: boolean, _theme?: Theme): string {
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
  showPid?: boolean;
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
  rightSuffix = "",
): string {
  if (width <= 0) return "";
  if (width === 1) return paint("╭");
  if (width === 2) return paint("╭╮");

  const innerWidth = width - 2;
  const more = hiddenLineCount > 0 ? paint(` ↑ ${hiddenLineCount} more `) : "";
  const minFill = 1;
  const prefix = paint("── ");
  let suffix = rightSuffix ? ` ${rightSuffix} ` : "";
  // Omit the optional PID rather than overflow the frame or leave no room for status.
  if (visibleWidth(suffix) + minFill + (status || renderStatus ? 5 : 0) > innerWidth) suffix = "";
  const suffixWidth = visibleWidth(suffix);
  const leftBudget = innerWidth - minFill - suffixWidth;
  const bodyBudget = Math.max(0, leftBudget - visibleWidth(prefix) - 1);
  const body = renderStatus ? renderStatus(bodyBudget) : status;
  let left = truncateToWidth(body ? `${prefix}${body} ` : more, leftBudget, "");
  if (body && more && visibleWidth(left) + visibleWidth(more) <= leftBudget) left += more;
  const right = truncateToWidth(resources ? ` ${resources} ` : "", leftBudget - visibleWidth(left), "");
  const fill = innerWidth - visibleWidth(left) - visibleWidth(right) - suffixWidth;
  return `${paint("╭")}${left}${paint("─".repeat(fill))}${right}${suffix}${paint("╮")}`;
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

/** Handle wheel input for an overflowing prompt, including at its scroll boundaries. */
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
  if (desiredOffset === currentOffset) return true;

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
  /** Cooperative navigation: invoked only after normal editor navigation reaches its boundary. */
  onDownBoundary?: () => void;
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

  override handleInput(data: string): void {
    const canLeave = getKeybindings().matches(data, "tui.editor.cursorDown")
      && this.focused && !this.selectionActive && !this.isShowingAutocomplete();
    const before = canLeave ? this.getCursor() : undefined;
    const text = canLeave ? this.getText() : undefined;
    super.handleInput(data); // Wrapped lines, history and autocomplete get first refusal.
    if (before && !this.isShowingAutocomplete() && this.focused) {
      const after = this.getCursor();
      if (after.line === before.line && after.col === before.col && this.getText() === text) this.onDownBoundary?.();
    }
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
    const pidLabel = src.showPid === true ? src.theme.fg("dim", `PID-${AGENT_PID}`) : "";
    return composerStatusContextEdge(
      src.context ? src.theme.fg("dim", src.context.resources) : "",
      width,
      paint,
      hiddenLineCount,
      "",
      renderStatus,
      pidLabel,
    );
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
    noteComposerFrameLines(lines.length);
    return lines;
  }
}
