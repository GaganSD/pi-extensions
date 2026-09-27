import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  DEFAULT_FLAVOR,
  DEFAULT_STYLE,
  FLAVORS,
  STYLES,
  allCatppuccinThemes,
  buildCatppuccinTheme,
  catppuccinThemeName,
  parseCatppuccinTheme,
  parseFlavor,
  parseStyle,
  resolveCatppuccinTheme,
  themeMessage,
} from "../extensions/pi-slate/catppuccin.ts";

const THEMES_DIR = join(dirname(fileURLToPath(import.meta.url)), "../themes");
const REQUIRED_COLORS = [
  "accent", "border", "borderAccent", "borderMuted", "success", "error", "warning",
  "muted", "dim", "text", "thinkingText", "selectedBg", "userMessageBg", "userMessageText",
  "customMessageBg", "customMessageText", "customMessageLabel", "toolPendingBg",
  "toolSuccessBg", "toolErrorBg", "toolTitle", "toolOutput", "mdHeading", "mdLink",
  "mdLinkUrl", "mdCode", "mdCodeBlock", "mdCodeBlockBorder", "mdQuote", "mdQuoteBorder",
  "mdHr", "mdListBullet", "toolDiffAdded", "toolDiffRemoved", "toolDiffContext",
  "syntaxComment", "syntaxKeyword", "syntaxFunction", "syntaxVariable", "syntaxString",
  "syntaxNumber", "syntaxType", "syntaxOperator", "syntaxPunctuation", "thinkingOff",
  "thinkingMinimal", "thinkingLow", "thinkingMedium", "thinkingHigh", "thinkingXhigh",
  "bashMode",
];

test("flavor and style names stay official", () => {
  assert.equal(parseFlavor("Mocha"), "mocha");
  assert.equal(parseFlavor("latte"), undefined);
  assert.equal(parseFlavor("frappe"), undefined);
  assert.equal(parseStyle("Mauve"), "mauve");
  assert.equal(parseFlavor("ink"), undefined);
  assert.equal(parseStyle("ember"), undefined);
});

test("theme names encode flavor and style", () => {
  assert.equal(catppuccinThemeName("mocha", "mauve"), "catppuccin-mocha-mauve");
  assert.deepEqual(parseCatppuccinTheme("catppuccin-mocha-quiet"), {
    flavor: "mocha",
    style: "quiet",
  });
  assert.equal(parseCatppuccinTheme("catppuccin-latte-quiet"), undefined);
  assert.equal(parseCatppuccinTheme("pi-slate"), undefined);
  assert.deepEqual(resolveCatppuccinTheme("pi-slate"), {
    flavor: DEFAULT_FLAVOR,
    style: DEFAULT_STYLE,
    name: "catppuccin-mocha-mauve",
  });
  assert.deepEqual(resolveCatppuccinTheme("catppuccin-mocha-teal", undefined, "peach"), {
    flavor: "mocha",
    style: "peach",
    name: "catppuccin-mocha-peach",
  });
  assert.equal(themeMessage("mocha", "mauve"), "Theme set to Mocha · Mauve");
});

test("every flavor and style is a valid theme file of palette tokens", () => {
  const built = allCatppuccinThemes();
  assert.equal(built.length, FLAVORS.length * STYLES.length);
  for (const theme of built) {
    const path = join(THEMES_DIR, `${theme.name}.json`);
    const disk = JSON.parse(readFileSync(path, "utf8")) as typeof theme;
    assert.deepEqual(disk, theme);
    assert.equal(disk.name, theme.name);
    for (const color of REQUIRED_COLORS) assert.ok(color in disk.colors, color);
    const hex = /^#[0-9a-f]{6}$/;
    for (const value of Object.values(disk.vars)) assert.match(value, hex);
    assert.match(disk.export.pageBg, hex);
    const mocha = buildCatppuccinTheme("mocha", "mauve");
    assert.equal(mocha.vars.mauve, "#cba6f7");
    assert.equal(mocha.vars.accent, "#cba6f7");
    assert.equal(mocha.export.pageBg, "#1e1e2e");
  }
  const catppuccinFiles = readdirSync(THEMES_DIR).filter((name) => name.startsWith("catppuccin-"));
  assert.equal(catppuccinFiles.length, built.length);
});
