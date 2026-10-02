import { diffChars, parsePatch } from "diff";
import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import type { ThemedToken } from "shiki";
import { ansiColor, DIFF_MAX_BYTES, DIFF_MAX_ROWS, diffText, type DiffConfig } from "./diff-config.ts";
import type { DiffHighlighter } from "./diff-highlight.ts";

export type DiffRow = {
  kind: "context" | "add" | "remove" | "meta";
  text: string;
  oldLine?: number;
  newLine?: number;
  emphasis?: [number, number][];
  tokens?: ThemedToken[];
  noNewline?: boolean;
};

export function patchRows(patch: string): DiffRow[] {
  if (Buffer.byteLength(patch) > DIFF_MAX_BYTES) return [{ kind: "meta", text: "Diff preview omitted: patch exceeds 256 KiB." }];
  const rows: DiffRow[] = [];
  try {
    for (const file of parsePatch(patch)) {
      for (const hunk of file.hunks) {
        rows.push({ kind: "meta", text: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@` });
        let oldLine = hunk.oldStart;
        let newLine = hunk.newStart;
        for (const line of hunk.lines) {
          if (rows.length >= DIFF_MAX_ROWS) return [...rows, { kind: "meta", text: "Remaining diff omitted: 2000-line preview limit." }];
          const text = diffText(line.slice(1));
          if (line.startsWith("+")) rows.push({ kind: "add", text, newLine: newLine++ });
          else if (line.startsWith("-")) rows.push({ kind: "remove", text, oldLine: oldLine++ });
          else if (line.startsWith(" ")) rows.push({ kind: "context", text, oldLine: oldLine++, newLine: newLine++ });
          else if (line.startsWith("\\") && rows.at(-1)?.kind !== "meta") rows.at(-1)!.noNewline = true;
          else rows.push({ kind: "meta", text: diffText(line) });
        }
      }
    }
  } catch {
    return [{ kind: "meta", text: "Diff preview unavailable: invalid patch." }];
  }
  return rows.length ? rows : [{ kind: "meta", text: "No content changes." }];
}

/** Pair adjacent removed/added lines, preserving order and unpaired insertions/deletions. */
export function pairRows(rows: DiffRow[]): Array<{ left?: DiffRow; right?: DiffRow; meta?: DiffRow }> {
  const pairs: ReturnType<typeof pairRows> = [];
  for (let i = 0; i < rows.length;) {
    const row = rows[i];
    if (row.kind === "meta") { pairs.push({ meta: row }); i++; }
    else if (row.kind === "context") { pairs.push({ left: row, right: row }); i++; }
    else {
      const removed: DiffRow[] = [];
      const added: DiffRow[] = [];
      while (rows[i]?.kind === "remove") removed.push(rows[i++]);
      while (rows[i]?.kind === "add") added.push(rows[i++]);
      for (let j = 0; j < Math.max(removed.length, added.length); j++) {
        pairs.push({ left: removed[j], right: added[j] });
      }
    }
  }
  return pairs;
}

export function emphasizeRows(rows: DiffRow[]): void {
  for (const { left, right } of pairRows(rows)) {
    if (left?.kind !== "remove" || right?.kind !== "add") continue;
    if (left.text.length + right.text.length > 4000) continue;
    const changes = diffChars(left.text, right.text, { timeout: 20, maxEditLength: 1000 });
    if (!changes) continue;
    left.emphasis = [];
    right.emphasis = [];
    let oldOffset = 0;
    let newOffset = 0;
    for (const change of changes) {
      if (change.removed) left.emphasis.push([oldOffset, oldOffset + change.value.length]);
      if (change.added) right.emphasis.push([newOffset, newOffset + change.value.length]);
      if (!change.added) oldOffset += change.value.length;
      if (!change.removed) newOffset += change.value.length;
    }
  }
}

const RESET = "\x1b[0m";

export class DiffView implements Component {
  readonly rows: DiffRow[];
  readonly ready: Promise<void>;
  private cache = new Map<number, string[]>();
  readonly patch: string;
  readonly path: string;
  readonly kind: "edit" | "write";
  readonly expanded: boolean;
  readonly themeName: string;
  private config: DiffConfig;
  private requestRender: () => void;

  constructor(
    patch: string,
    path: string,
    kind: "edit" | "write",
    expanded: boolean,
    config: DiffConfig,
    highlighter: DiffHighlighter,
    requestRender: () => void,
    themeName = "black-metal",
  ) {
    this.patch = patch;
    this.path = path;
    this.kind = kind;
    this.expanded = expanded;
    this.themeName = themeName;
    this.config = config;
    this.requestRender = requestRender;
    this.rows = patchRows(patch);
    emphasizeRows(this.rows);
    this.ready = this.highlight(highlighter);
  }

  private async highlight(highlighter: DiffHighlighter): Promise<void> {
    // Each hunk starts a fresh grammar state; gaps must not leak multiline syntax state.
    let start = 0;
    while (start < this.rows.length) {
      let end = start + 1;
      while (end < this.rows.length && this.rows[end].kind !== "meta") end++;
      const hunk = this.rows.slice(start, end).filter((row) => row.kind !== "meta");
      for (const excluded of ["add", "remove"] as const) {
        const side = hunk.filter((row) => row.kind !== excluded);
        if (!side.length) continue;
        const tokens = await highlighter.tokens(side.map((row) => row.text).join("\n"), this.path, this.config.theme);
        side.forEach((row, i) => { row.tokens = tokens?.[i]; });
      }
      start = end;
    }
    this.invalidate();
    this.requestRender();
  }

  invalidate(): void { this.cache.clear(); }

  private background(row?: DiffRow): string {
    const colors = this.config.colors;
    return row?.kind === "add" ? colors.addBg : row?.kind === "remove" ? colors.removeBg : colors.contextBg;
  }

  private fit(text: string, width: number, bg = this.config.colors.contextBg): string {
    const clipped = truncateToWidth(text, width, "…");
    return ansiColor(bg, true) + clipped + RESET + ansiColor(bg, true)
      + " ".repeat(Math.max(0, width - visibleWidth(clipped))) + RESET;
  }

  private code(row: DiffRow): string {
    const colors = this.config.colors;
    const baseBg = this.background(row);
    const wordBg = row.kind === "add" ? colors.addWordBg : colors.removeWordBg;
    const tokens = row.tokens ?? [{ content: row.text, offset: 0 }];
    let output = "";
    let offset = 0;
    for (const token of tokens) {
      const end = offset + token.content.length;
      const boundaries = new Set([offset, end]);
      for (const [from, to] of row.emphasis ?? []) {
        if (from > offset && from < end) boundaries.add(from);
        if (to > offset && to < end) boundaries.add(to);
      }
      const sorted = [...boundaries].sort((a, b) => a - b);
      for (let i = 0; i < sorted.length - 1; i++) {
        const from = sorted[i];
        const emphasized = row.emphasis?.some(([a, b]) => from >= a && from < b);
        const fg = token.color && /^#[\da-f]{6}$/i.test(token.color) ? token.color : colors.fg;
        const style = token.fontStyle ?? 0;
        output += RESET + ansiColor(emphasized ? wordBg : baseBg, true) + ansiColor(fg)
          + (style & 1 ? "\x1b[3m" : "") + (style & 2 ? "\x1b[1m" : "") + (style & 4 ? "\x1b[4m" : "")
          + token.content.slice(from - offset, sorted[i + 1] - offset);
      }
      offset = end;
    }
    return output;
  }

  private cell(row: DiffRow | undefined, width: number, digits: number, side?: "old" | "new"): string {
    if (!row) return this.fit("", width);
    const sign = row.kind === "add" ? "+" : row.kind === "remove" ? "-" : " ";
    const number = (value?: number) => String(value ?? "").padStart(digits);
    const gutter = side ? number(side === "old" ? row.oldLine : row.newLine)
      : `${number(row.oldLine)} ${number(row.newLine)}`;
    const newline = row.noNewline ? `${RESET}${ansiColor(this.background(row), true)}${ansiColor(this.config.colors.lineNumberFg)} ⏎ no newline` : "";
    return this.fit(`${ansiColor(this.config.colors.lineNumberFg)}${gutter} ${sign} ${this.code(row)}${newline}`,
      width, this.background(row));
  }

  render(width: number): string[] {
    width = Math.max(0, Math.floor(width));
    if (width === 0) return [];
    const cached = this.cache.get(width);
    if (cached) return cached;
    const split = this.kind === "edit" && width >= this.config.splitMinWidth;
    const additions = this.rows.filter((row) => row.kind === "add").length;
    const removals = this.rows.filter((row) => row.kind === "remove").length;
    const title = `diff · ${split ? "split" : "unified"} · +${additions} -${removals}`;
    const output = [this.fit(ansiColor(this.config.colors.headerFg) + title, width)];
    const digits = String(Math.max(1, ...this.rows.map((row) => Math.max(row.oldLine ?? 0, row.newLine ?? 0)))).length;
    const limit = this.expanded ? 400 : 16;
    const meta = (row: DiffRow) => this.fit(ansiColor(this.config.colors.headerFg) + row.text, width);
    let total: number;
    if (split) {
      const leftWidth = Math.floor((width - 3) / 2);
      const rightWidth = width - leftWidth - 3;
      const border = ansiColor(this.config.colors.borderFg) + " │ " + RESET;
      output.push(this.fit(ansiColor(this.config.colors.lineNumberFg) + "Before", leftWidth) + border
        + this.fit(ansiColor(this.config.colors.lineNumberFg) + "After", rightWidth));
      const pairs = pairRows(this.rows);
      total = pairs.length;
      for (const pair of pairs.slice(0, limit)) {
        output.push(pair.meta ? meta(pair.meta) : this.cell(pair.left, leftWidth, digits, "old")
          + border + this.cell(pair.right, rightWidth, digits, "new"));
      }
    } else {
      total = this.rows.length;
      for (const row of this.rows.slice(0, limit)) output.push(row.kind === "meta" ? meta(row) : this.cell(row, width, digits));
    }
    if (total > limit) output.push(meta({ kind: "meta", text: `… ${total - limit} more rows${this.expanded ? " (preview limit)" : " · expand tool output to show more"}` }));
    // Only retain the current layout; repeated resizes must not grow memory indefinitely.
    this.cache.clear();
    this.cache.set(width, output);
    return output;
  }
}
