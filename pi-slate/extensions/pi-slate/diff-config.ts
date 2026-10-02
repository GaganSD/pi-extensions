import { bundledThemes, type BundledTheme } from "shiki";

export type DiffColors = {
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

export type DiffConfig = {
  enabled: boolean;
  theme: BundledTheme;
  splitMinWidth: number;
  colors: DiffColors;
};

export type DiffPreferences = {
  enabled?: boolean;
  theme?: string;
  splitMinWidth?: number;
  colors?: Partial<DiffColors>;
};

const COLOR_ENV = {
  fg: "FG", contextBg: "CONTEXT_BG", addBg: "ADD_BG", removeBg: "REMOVE_BG",
  addWordBg: "ADD_WORD_BG", removeWordBg: "REMOVE_WORD_BG",
  lineNumberFg: "LINE_NUMBER_FG", borderFg: "BORDER_FG", headerFg: "HEADER_FG",
} as const;

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[`SLATE_DIFF_${name}`]?.trim() || env[`PI_DIFF_${name}`]?.trim();
  return value || undefined;
}

function parseColor(value: string | undefined, fallback: string): string {
  if (!value || !/^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(value)) return fallback;
  return value.length === 4 ? `#${[...value.slice(1)].map((c) => c + c).join("")}` : value;
}

export function loadDiffPreferences(value: unknown): DiffPreferences | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  const colors: Partial<DiffColors> = {};
  if (typeof raw.colors === "object" && raw.colors !== null) {
    for (const key of Object.keys(COLOR_ENV) as (keyof DiffColors)[]) {
      const color = (raw.colors as Record<string, unknown>)[key];
      if (typeof color === "string" && color) colors[key] = color;
    }
  }
  const preferences: DiffPreferences = {
    ...(typeof raw.enabled === "boolean" ? { enabled: raw.enabled } : {}),
    ...(typeof raw.theme === "string" && raw.theme ? { theme: raw.theme } : {}),
    ...(Number.isInteger(raw.splitMinWidth) ? { splitMinWidth: raw.splitMinWidth as number } : {}),
    ...(Object.keys(colors).length ? { colors } : {}),
  };
  return Object.keys(preferences).length ? preferences : undefined;
}

export function readDiffConfig(env: NodeJS.ProcessEnv = process.env, preferences?: DiffPreferences): DiffConfig {
  const defaults: DiffColors = {
    fg: "#c9d1d9", contextBg: "#161b22", addBg: "#173526", removeBg: "#3d2027",
    addWordBg: "#286442", removeWordBg: "#85343e", lineNumberFg: "#8b949e",
    borderFg: "#484f58", headerFg: "#79c0ff",
  };
  const theme = envValue(env, "THEME") ?? preferences?.theme ?? "github-dark";
  const width = Number(envValue(env, "SPLIT_MIN_WIDTH") ?? preferences?.splitMinWidth ?? 100);
  const enabledValue = envValue(env, "ENABLED");
  return {
    enabled: enabledValue !== undefined ? !/^(0|false|off)$/i.test(enabledValue) : preferences?.enabled !== false,
    theme: Object.hasOwn(bundledThemes, theme) ? theme as BundledTheme : "github-dark",
    splitMinWidth: Number.isInteger(width) && width >= 60 && width <= 500 ? width : 100,
    colors: Object.fromEntries(
      (Object.keys(COLOR_ENV) as (keyof DiffColors)[]).map((key) => [
        key, parseColor(envValue(env, COLOR_ENV[key]) ?? preferences?.colors?.[key], defaults[key]),
      ]),
    ) as DiffColors,
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
