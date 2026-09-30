import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export const HAIRLINE_MIN_DASH = 2;
export const HAIRLINE_GAP = 1;

const BREAKS = [" · ", ", ", " "];

export function hairlineTextWidth(width: number): number {
  return Math.max(1, width - 2 * HAIRLINE_MIN_DASH - 2 * HAIRLINE_GAP);
}

export function wrapHairlineText(text: string, maxWidth: number): string[] {
  const trimmed = text.trim();
  if (!trimmed || maxWidth <= 0) return [];
  if (visibleWidth(trimmed) <= maxWidth) return [trimmed];

  const lines: string[] = [];
  let rest = trimmed;
  while (rest) {
    if (visibleWidth(rest) <= maxWidth) {
      lines.push(rest);
      break;
    }
    const chunk = takeWrap(rest, maxWidth);
    if (!chunk.text) {
      lines.push(truncateToWidth(rest, maxWidth, "…"));
      break;
    }
    lines.push(chunk.text);
    rest = chunk.rest.trimStart();
  }
  return lines;
}

function takeWrap(text: string, maxWidth: number): { text: string; rest: string } {
  for (const sep of BREAKS) {
    let best = -1;
    let from = 0;
    while (from < text.length) {
      const idx = text.indexOf(sep, from);
      if (idx <= 0) break;
      if (visibleWidth(text.slice(0, idx)) > maxWidth) break;
      best = idx;
      from = idx + sep.length;
    }
    if (best > 0) {
      return { text: text.slice(0, best).trimEnd(), rest: text.slice(best + sep.length) };
    }
  }

  const cut = truncateToWidth(text, maxWidth, "");
  if (!cut) return { text: text.slice(0, 1), rest: text.slice(1) };
  return { text: cut, rest: text.slice(cut.length) };
}

export function dashCount(textWidth: number, width: number): number {
  const remaining = Math.max(0, width - textWidth - 2 * HAIRLINE_GAP);
  return Math.floor(remaining / 2);
}

export function symmetricHairline(
  text: string,
  width: number,
  paint: (dash: string) => string = (value) => value,
): string {
  if (width <= 0) return "";
  const maxText = hairlineTextWidth(width);
  const body = visibleWidth(text) > maxText ? truncateToWidth(text, maxText, "…") : text;
  const dashes = "─".repeat(dashCount(visibleWidth(body), width));
  const gap = " ".repeat(HAIRLINE_GAP);
  const core = `${paint(dashes)}${gap}${body}${gap}${paint(dashes)}`;
  const slack = Math.max(0, width - visibleWidth(core));
  const left = Math.floor(slack / 2);
  return `${" ".repeat(left)}${core}${" ".repeat(slack - left)}`;
}

export function centeredHairlines(
  text: string,
  width: number,
  paint: (dash: string) => string = (value) => value,
): string[] {
  return wrapHairlineText(text, hairlineTextWidth(width)).map((line) => symmetricHairline(line, width, paint));
}
