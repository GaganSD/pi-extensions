import type { BundledTheme } from "shiki";
import { catppuccinChrome } from "./catppuccin.ts";

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
};

const BLACK_METAL: DiffColors = {
  fg: "#c1c1c1",
  contextBg: "#0d0d0d",
  addBg: "#132020",
  removeBg: "#1a0d0d",
  addWordBg: "#2a4445",
  removeWordBg: "#6b3d3d",
  lineNumberFg: "#888888",
  borderFg: "#404040",
  headerFg: "#dd9999",
};

const MOCHA: Omit<DiffColors, "borderFg" | "headerFg"> = {
  fg: "#cdd6f4",
  contextBg: "#181825",
  addBg: "#1e3128",
  removeBg: "#351c24",
  addWordBg: "#2d4f3a",
  removeWordBg: "#6b2e3a",
  lineNumberFg: "#7f849c",
};

export function diffAppearance(themeName?: string): Pick<DiffConfig, "theme" | "colors"> {
  const chrome = catppuccinChrome(themeName);
  if (!chrome) return { theme: "github-dark", colors: BLACK_METAL };
  return {
    theme: "catppuccin-mocha",
    colors: { ...MOCHA, borderFg: chrome.border, headerFg: chrome.accent, fg: chrome.text, contextBg: chrome.mantle },
  };
}

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[`SLATE_DIFF_${name}`]?.trim() || env[`PI_DIFF_${name}`]?.trim();
  return value || undefined;
}

export function loadDiffPreferences(value: unknown): DiffPreferences | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  return typeof raw.enabled === "boolean" ? { enabled: raw.enabled } : undefined;
}

export function readDiffConfig(
  env: NodeJS.ProcessEnv = process.env,
  preferences?: DiffPreferences,
  themeName?: string,
): DiffConfig {
  const width = Number(envValue(env, "SPLIT_MIN_WIDTH") ?? 100);
  const enabledValue = envValue(env, "ENABLED");
  return {
    enabled: enabledValue !== undefined ? !/^(0|false|off)$/i.test(enabledValue) : preferences?.enabled !== false,
    splitMinWidth: Number.isInteger(width) && width >= 60 && width <= 500 ? width : 100,
    ...diffAppearance(themeName),
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
