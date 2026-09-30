import type { Theme } from "@earendil-works/pi-coding-agent";

export const CHARMTONE_PANTERA = "charmtone-pantera";
export const CHARMTONE_LABEL = "Charmtone Pantera";
export const CHARMTONE_FROM = "#ff60ff";
export const CHARMTONE_TO = "#6b50ff";

const ALIASES = new Set(["pantera", "charmtone", CHARMTONE_PANTERA]);

export function isCharmtonePantera(theme?: { name?: string } | string): boolean {
  const name = typeof theme === "string" ? theme : theme?.name;
  return name === CHARMTONE_PANTERA;
}

export function parseCharmtoneTheme(raw: string): string | undefined {
  const value = raw.trim().toLowerCase();
  return ALIASES.has(value) ? CHARMTONE_PANTERA : undefined;
}

export function paintForegroundGrad(text: string, from: string, to: string, truecolor: boolean): string {
  if (!text || !truecolor) return text;
  const start = hexRgb(from);
  const end = hexRgb(to);
  if (!start || !end) return text;
  const chars = [...text];
  if (chars.length === 1) return rgb(start, chars[0] ?? "");
  return chars
    .map((char, i) => {
      const t = i / (chars.length - 1);
      return rgb(
        [
          Math.round(start[0] + (end[0] - start[0]) * t),
          Math.round(start[1] + (end[1] - start[1]) * t),
          Math.round(start[2] + (end[2] - start[2]) * t),
        ],
        char,
      );
    })
    .join("");
}

export function paintContextResources(theme: Theme, resources: string): string {
  if (!isCharmtonePantera(theme)) return theme.fg("dim", resources);
  const cut = resources.indexOf(" · ");
  if (cut < 0) return theme.fg("dim", resources);
  return theme.fg("success", resources.slice(0, cut)) + theme.fg("dim", resources.slice(cut));
}

export function workingFrames(theme: Theme): string[] {
  if (!isCharmtonePantera(theme)) {
    return [
      theme.fg("dim", "·"),
      theme.fg("muted", "•"),
      theme.fg("accent", "●"),
      theme.fg("muted", "•"),
    ];
  }
  return [
    theme.fg("borderAccent", "#"),
    theme.fg("accent", "*"),
    theme.fg("success", "~"),
    theme.fg("warning", "+"),
    theme.fg("accent", "e"),
    theme.fg("borderAccent", "a"),
  ];
}

function hexRgb(hex: string): [number, number, number] | undefined {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return undefined;
  const value = match[1] ?? "";
  return [
    Number.parseInt(value.slice(0, 2), 16),
    Number.parseInt(value.slice(2, 4), 16),
    Number.parseInt(value.slice(4, 6), 16),
  ];
}

function rgb(color: [number, number, number], text: string): string {
  return `\x1b[38;2;${color[0]};${color[1]};${color[2]}m${text}\x1b[39m`;
}
