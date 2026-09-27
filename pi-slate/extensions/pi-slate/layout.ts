import { readFileSync } from "node:fs";
import { parseFlavor, parseStyle, type Flavor, type Style } from "./catppuccin.ts";

// The source SVG is a 4×4 square grid. Terminal cells are approximately twice
// as tall as they are wide, so every source square occupies two columns.
// Keep the empty fourth column on the first two rows. The header centers this
// fixed-width canvas as a whole; trimming those spaces distorts the mark.
export const PI_LOGO = ["██████  ", "██  ██  ", "████  ██", "██    ██"];
export const PI_LOGO_ASCII = ["######  ", "##  ##  ", "####  ##", "##    ##"];

/** Logo mark stays white in every theme. */
export function paintLogo(text: string, truecolor = true): string {
  if (!text) return text;
  return truecolor ? `\x1b[38;2;255;255;255m${text}\x1b[39m` : `\x1b[97m${text}\x1b[39m`;
}

export function compactPath(cwd: string | undefined, home?: string): string {
  if (!cwd) return "";
  if (home && (cwd === home || cwd.startsWith(`${home}/`))) {
    return `~${cwd.slice(home.length)}`;
  }
  return cwd;
}

export function compactDisplayText(text: string, cwd?: string, home?: string): string {
  let out = text;
  if (cwd && cwd.length > 1) {
    out = out.replaceAll(`${cwd}/`, "").replaceAll(cwd, compactPath(cwd, home));
  }
  if (home && home.length > 1) out = out.replaceAll(home, "~");
  return out;
}

export function modelLabel(model: { id?: string; name?: string } | undefined): string {
  if (!model) return "no model";
  return model.id || model.name || "unknown model";
}

const INTEGERS = new Intl.NumberFormat("en");

export function formatInteger(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return INTEGERS.format(Math.round(value));
}

export function formatTokenCount(tokens: number | null | undefined): string {
  if (tokens === null || tokens === undefined || !Number.isFinite(tokens)) return "— tokens";
  return `${formatInteger(tokens)} tokens`;
}

export function formatTokenRate(rate: number | null | undefined): string {
  if (rate === null || rate === undefined || !Number.isFinite(rate)) return "— tokens/sec";
  return `${formatInteger(Math.max(0, rate))} tokens/sec`;
}

export function formatPercent(percent: number | null | undefined): string {
  if (percent === null || percent === undefined || !Number.isFinite(percent)) return "—%";
  return `${Math.round(percent)}%`;
}

export function formatSpend(cost: number | null | undefined): string {
  if (cost === null || cost === undefined || !Number.isFinite(cost)) return "$0.00";
  return `$${Math.max(0, cost).toFixed(2)}`;
}

export function formatContextTokens(
  tokens: number | null | undefined,
  percent: number | null | undefined,
  rate: number | null | undefined,
): string {
  return `${formatTokenCount(tokens)} · ${formatPercent(percent)} used · ${formatTokenRate(rate)}`;
}

export const MCP_STATUS_EVENT = "pi-mcp-adapter/status/v1";

export function formatMcpEnabled(count: number): string {
  const servers = Math.max(0, Math.round(count));
  return `${servers} MCPs enabled`;
}

export function formatSkillsLoaded(count: number): string {
  const skills = Math.max(0, Math.round(count));
  return `${skills} skills loaded`;
}

export function formatContextResources(
  spend: number | null | undefined,
  skills: number,
  mcpCount: number | null,
): string {
  return `${formatSpend(spend)} · ${formatSkillsLoaded(skills)} · ${formatMcpEnabled(mcpCount ?? 0)}`;
}

export function countSkillCommands(commands: readonly { source?: string; sourceInfo?: { path?: string }; name?: string }[]): number {
  const seen = new Set<string>();
  for (const command of commands) {
    if (command.source !== "skill") continue;
    seen.add(command.sourceInfo?.path || command.name || "skill");
  }
  return seen.size;
}

export function parseMcpEnabledCount(data: unknown): number | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const servers = (data as { servers?: unknown }).servers;
  if (!Array.isArray(servers)) return null;
  return servers.filter(isEnabledMcpServer).length;
}

function isEnabledMcpServer(server: unknown): boolean {
  return !!server && typeof server === "object" && !Array.isArray(server) && (server as { disabled?: unknown }).disabled !== true;
}

export function footerVisibility(width: number): {
  showBranch: boolean;
  showModel: boolean;
  showThinking: boolean;
} {
  return {
    showBranch: width >= 42,
    showModel: width >= 66,
    showThinking: width >= 80,
  };
}

export function centerOffset(viewportWidth: number, contentWidth: number): number {
  return Math.max(0, Math.floor((viewportWidth - contentWidth) / 2));
}

export const SIDEBAR_MIN_TERMINAL_WIDTH = 60;
export const SIDEBAR_MIN_WIDTH = 28;
export const SIDEBAR_EDITOR_RESERVE = 5;
export const SIDEBAR_DEFAULT_RATIO = 0.2;
export const SIDEBAR_PERCENT_DEFAULT = Math.round(SIDEBAR_DEFAULT_RATIO * 100);
export const SIDEBAR_MAIN_MIN_WIDTH = SIDEBAR_MIN_TERMINAL_WIDTH - SIDEBAR_MIN_WIDTH;
export const SIDEBAR_HANDLE_MAX_X = 1;

export function maxSidebarWidth(totalWidth: number): number {
  return Math.max(0, totalWidth - SIDEBAR_MAIN_MIN_WIDTH);
}

export const SIDEBAR_PERCENT_MAX = 80;
export const SIDEBAR_PERCENT_NARROW = 0;
export const SIDEBAR_PERCENT_MEDIUM = 30;
export const SIDEBAR_PERCENT_WIDE = 40;

export function parseSidebarPercent(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const percent = Math.round(value);
  if (percent < 0 || percent > SIDEBAR_PERCENT_MAX) return undefined;
  return percent;
}

export function parseSidebarWidthArg(raw: string): { ok: true; percent?: number } | { ok: false } {
  const value = raw.trim().toLowerCase().replace(/%$/, "");
  if (value === "default") return { ok: true };
  if (value === "narrow") return { ok: true, percent: SIDEBAR_PERCENT_NARROW };
  if (value === "medium") return { ok: true, percent: SIDEBAR_PERCENT_MEDIUM };
  if (value === "wide") return { ok: true, percent: SIDEBAR_PERCENT_WIDE };
  if (!/^\d+$/.test(value)) return { ok: false };
  return parseSidebarPercent(Number(value)) === undefined
    ? { ok: false }
    : { ok: true, percent: Number(value) };
}

export const MESSAGE_LENGTH_DEFAULT = 100;
export const MESSAGE_LENGTH_MIN = 1;
export const MESSAGE_LENGTH_MAX = 2000;
export const MESSAGE_LENGTH_SHORT = 50;
export const MESSAGE_LENGTH_LONG = 200;

export function parseMessageLength(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const length = Math.round(value);
  if (length < MESSAGE_LENGTH_MIN || length > MESSAGE_LENGTH_MAX) return undefined;
  return length;
}

export function parseMessageLengthArg(raw: string): { ok: true; value?: number | "all" } | { ok: false } {
  const value = raw.trim().toLowerCase();
  if (value === "default") return { ok: true };
  if (value === "all" || value === "unlimited") return { ok: true, value: "all" };
  if (!/^\d+$/.test(value)) return { ok: false };
  const parsed = parseMessageLength(Number(value));
  return parsed === undefined ? { ok: false } : { ok: true, value: parsed };
}

export function resolveMessageLength(value: number | "all" | undefined): number {
  if (value === "all") return Number.POSITIVE_INFINITY;
  return value ?? MESSAGE_LENGTH_DEFAULT;
}

export function messageLengthMessage(value: number | "all" | undefined): string {
  if (value === "all") return "Message length set to all";
  if (value === undefined) return "Message length reset to default";
  return `Message length set to ${value}`;
}

export const SLATE_ISSUES_URL = "https://www.npmjs.com/package/pi-slate";
export const SLATE_VERSION = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
).version as string;

export const SLATE_USAGE =
  "Usage: /slate density [comfortable|compact] | footer [standard|minimal] | width [default|narrow|medium|wide|<percent>] | message-length [default|all|<count>] | theme [canonical|quiet|mauve|sapphire|peach|teal] | style [canonical|quiet|mauve|sapphire|peach|teal] | bug [file|open]";

export function withCurrent(label: string, current: boolean): string {
  return current ? `${label} (current)` : label;
}

export function withoutCurrent(label: string): string {
  return label.endsWith(" (current)") ? label.slice(0, -" (current)".length) : label;
}

const THEME_STYLES = ["canonical", "quiet", "mauve", "sapphire", "peach", "teal"] as const;
const SLATE_COMPLETIONS = [
  "density",
  "density comfortable",
  "density compact",
  "footer",
  "footer standard",
  "footer minimal",
  "width",
  "width default",
  "width narrow",
  "width medium",
  "width wide",
  "message-length",
  "message-length default",
  "message-length all",
  "theme",
  ...THEME_STYLES.map((style) => `theme ${style}`),
  "style",
  ...THEME_STYLES.map((style) => `style ${style}`),
  "bug",
  "bug file",
  "bug open",
];

export type SlateArgs =
  | { ok: true; kind: "menu" }
  | { ok: true; kind: "density"; value?: "comfortable" | "compact" }
  | { ok: true; kind: "footer"; value?: "standard" | "minimal" }
  | { ok: true; kind: "width-menu" }
  | { ok: true; kind: "width"; width?: number }
  | { ok: true; kind: "message-length-menu" }
  | { ok: true; kind: "message-length"; value?: number | "all" }
  | { ok: true; kind: "theme-menu" }
  | { ok: true; kind: "theme"; flavor?: Flavor; style?: Style }
  | { ok: true; kind: "style"; value?: Style }
  | { ok: true; kind: "bug-menu" }
  | { ok: true; kind: "bug"; action: "file" | "open" }
  | { ok: false };

export function parseSlateArgs(raw: string): SlateArgs {
  const words = raw.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return { ok: true, kind: "menu" };
  const [head, tail, extra] = words;
  if (head === "theme") {
    if (words.length > 3) return { ok: false };
    if (!tail) return { ok: true, kind: "theme-menu" };
    const flavor = parseFlavor(tail);
    if (flavor) {
      if (!extra) return { ok: true, kind: "theme", flavor };
      const style = parseStyle(extra);
      return style ? { ok: true, kind: "theme", flavor, style } : { ok: false };
    }
    const style = parseStyle(tail);
    if (style && !extra) return { ok: true, kind: "theme", style };
    return { ok: false };
  }
  if (words.length > 2) return { ok: false };
  if (head === "style") {
    if (!tail) return { ok: true, kind: "style" };
    const style = parseStyle(tail);
    return style ? { ok: true, kind: "style", value: style } : { ok: false };
  }
  if (head === "density") {
    if (!tail) return { ok: true, kind: "density" };
    if (tail === "comfortable" || tail === "compact") return { ok: true, kind: "density", value: tail };
    return { ok: false };
  }
  if (head === "footer") {
    if (!tail) return { ok: true, kind: "footer" };
    if (tail === "standard" || tail === "minimal") return { ok: true, kind: "footer", value: tail };
    return { ok: false };
  }
  if (head === "width") {
    if (!tail) return { ok: true, kind: "width-menu" };
    const parsed = parseSidebarWidthArg(tail);
    if (!parsed.ok) return { ok: false };
    return parsed.percent === undefined
      ? { ok: true, kind: "width" }
      : { ok: true, kind: "width", width: parsed.percent };
  }
  if (head === "message-length") {
    if (!tail) return { ok: true, kind: "message-length-menu" };
    const parsed = parseMessageLengthArg(tail);
    if (!parsed.ok) return { ok: false };
    return parsed.value === undefined
      ? { ok: true, kind: "message-length" }
      : { ok: true, kind: "message-length", value: parsed.value };
  }
  if (head === "bug") {
    if (!tail) return { ok: true, kind: "bug-menu" };
    if (tail === "file" || tail === "open") return { ok: true, kind: "bug", action: tail };
    return { ok: false };
  }
  return { ok: false };
}

export function slateArgumentCompletions(prefix: string): { value: string; label: string }[] | null {
  const normalized = prefix.trimStart().toLowerCase();
  const matches = SLATE_COMPLETIONS.filter((value) => value.startsWith(normalized))
    .map((value) => ({ value, label: value }));
  return matches.length ? matches : null;
}

export function clampSidebarColumns(totalWidth: number, columns: number): number {
  if (totalWidth < SIDEBAR_MIN_TERMINAL_WIDTH) return 0;
  return Math.max(SIDEBAR_MIN_WIDTH, Math.min(maxSidebarWidth(totalWidth), columns));
}

export function workspaceColumnWidth(totalWidth: number, preferredPercent?: number): number {
  if (preferredPercent === SIDEBAR_PERCENT_NARROW) return clampSidebarColumns(totalWidth, SIDEBAR_MIN_WIDTH);
  const ratio = preferredPercent === undefined ? SIDEBAR_DEFAULT_RATIO : preferredPercent / 100;
  return clampSidebarColumns(totalWidth, Math.floor(totalWidth * ratio));
}

export function percentFromColumns(totalWidth: number, columns: number): number {
  if (totalWidth < 1) return Math.round(SIDEBAR_DEFAULT_RATIO * 100);
  return Math.max(1, Math.min(SIDEBAR_PERCENT_MAX, Math.round((columns / totalWidth) * 100)));
}

/** Persist a drag as the same value `/slate width` understands. */
export function sidebarPercentFromColumns(totalWidth: number, columns: number): number | undefined {
  const fallback = workspaceColumnWidth(totalWidth);
  if (columns <= SIDEBAR_MIN_WIDTH && fallback > SIDEBAR_MIN_WIDTH) return SIDEBAR_PERCENT_NARROW;
  const percent = percentFromColumns(totalWidth, columns);
  if (percent === SIDEBAR_PERCENT_DEFAULT) return undefined;
  if (percent === SIDEBAR_PERCENT_MEDIUM || percent === SIDEBAR_PERCENT_WIDE) return percent;
  return percent;
}

export function mainColumnWidth(totalWidth: number, preferred?: number): number {
  return Math.max(1, totalWidth - workspaceColumnWidth(totalWidth, preferred));
}

export function sidebarWidthFromScreenX(totalWidth: number, screenX: number): number {
  return clampSidebarColumns(totalWidth, totalWidth - screenX);
}

export function sidebarHandleColumn(totalWidth: number, sidebarWidth: number): number {
  return Math.max(0, totalWidth - sidebarWidth);
}

export function isSidebarResizeHandle(event: { button: string; x: number }): boolean {
  return event.button === "left" && event.x <= SIDEBAR_HANDLE_MAX_X;
}
