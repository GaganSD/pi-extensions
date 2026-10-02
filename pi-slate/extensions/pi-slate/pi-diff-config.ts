import { bundledThemes, type BundledTheme } from "shiki";

export type DiffConfig = {
  enabled: boolean;
  theme: BundledTheme;
  splitMinWidth: number;
  colors: {
    fg: string;
    contextBg: string;
    addBg: string;
    removeBg: string;
    addWordBg: string;
    removeWordBg: string;
    lineNumberFg: string;
    borderFg: string;
    headerFg: string;
  };
};

export function readDiffConfig(env: NodeJS.ProcessEnv = process.env): DiffConfig {
  const color = (name: string, fallback: string): string => {
    const value = env[`PI_DIFF_${name}`]?.trim();
    if (!value || !/^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(value)) return fallback;
    return value.length === 4 ? `#${[...value.slice(1)].map((c) => c + c).join("")}` : value;
  };
  const theme = env.PI_DIFF_THEME ?? "github-dark";
  const width = Number(env.PI_DIFF_SPLIT_MIN_WIDTH ?? 100);
  return {
    enabled: !/^(0|false|off)$/i.test(env.PI_DIFF_ENABLED ?? ""),
    theme: Object.hasOwn(bundledThemes, theme) ? theme as BundledTheme : "github-dark",
    splitMinWidth: Number.isInteger(width) && width >= 60 && width <= 500 ? width : 100,
    colors: {
      fg: color("FG", "#c9d1d9"),
      contextBg: color("CONTEXT_BG", "#161b22"),
      addBg: color("ADD_BG", "#173526"),
      removeBg: color("REMOVE_BG", "#3d2027"),
      addWordBg: color("ADD_WORD_BG", "#286442"),
      removeWordBg: color("REMOVE_WORD_BG", "#85343e"),
      lineNumberFg: color("LINE_NUMBER_FG", "#8b949e"),
      borderFg: color("BORDER_FG", "#484f58"),
      headerFg: color("HEADER_FG", "#79c0ff"),
    },
  };
}

export function ansiColor(hex: string, background = false): string {
  const rgb = [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16));
  return `\x1b[${background ? 48 : 38};2;${rgb.join(";")}m`;
}

/** Never allow source text or paths to issue terminal control sequences. */
export function diffText(text: string): string {
  return text.replace(/\t/g, "    ").replace(/[\x00-\x1f\x7f-\x9f]/g,
    (char) => `\\x${char.charCodeAt(0).toString(16).padStart(2, "0")}`);
}

export const DIFF_MAX_BYTES = 256 * 1024;
export const DIFF_MAX_ROWS = 2000;
