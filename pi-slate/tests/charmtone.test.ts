import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  CHARMTONE_FROM,
  CHARMTONE_PANTERA,
  CHARMTONE_TO,
  isCharmtonePantera,
  paintContextResources,
  paintForegroundGrad,
  parseCharmtoneTheme,
  workingFrames,
} from "../extensions/pi-slate/charmtone.ts";
import { chromePaint, frameComposerLines } from "../extensions/pi-slate/composer.ts";

const THEME_PATH = join(dirname(fileURLToPath(import.meta.url)), "../themes/charmtone-pantera.json");

test("charmtone aliases resolve to the builtin theme name", () => {
  assert.equal(parseCharmtoneTheme("Pantera"), CHARMTONE_PANTERA);
  assert.equal(parseCharmtoneTheme("charmtone"), CHARMTONE_PANTERA);
  assert.equal(parseCharmtoneTheme("charmtone-pantera"), CHARMTONE_PANTERA);
  assert.equal(parseCharmtoneTheme("mauve"), undefined);
  assert.equal(isCharmtonePantera({ name: CHARMTONE_PANTERA }), true);
  assert.equal(isCharmtonePantera({ name: "catppuccin-mocha-mauve" }), false);
});

test("charmtone-pantera is a valid Pi theme file", () => {
  const theme = JSON.parse(readFileSync(THEME_PATH, "utf8")) as {
    name: string;
    vars: Record<string, string>;
    colors: Record<string, string>;
    export: { pageBg: string };
  };
  assert.equal(theme.name, CHARMTONE_PANTERA);
  assert.equal(theme.vars.borderAccent, "#6b50ff");
  assert.equal(theme.vars.accent, "#ff60ff");
  assert.equal(theme.export.pageBg, "#201f26");
  assert.equal(theme.colors.mdCode, "coral");
  assert.equal(theme.colors.bashMode, "hazy");
});

test("foreground gradient keeps visible width and ramps Dolly to Charple", () => {
  const painted = paintForegroundGrad("crush", CHARMTONE_FROM, CHARMTONE_TO, true);
  assert.equal(stripVTControlCharacters(painted), "crush");
  assert.match(painted, /\x1b\[38;2;255;96;255m/);
  assert.match(painted, /\x1b\[38;2;107;80;255m/);
  assert.equal(paintForegroundGrad("crush", CHARMTONE_FROM, CHARMTONE_TO, false), "crush");
});

test("pantera chrome uses the primary border and heats the empty prompt", () => {
  const tokens: string[] = [];
  const theme = {
    name: CHARMTONE_PANTERA,
    fg: (name: string, text: string) => {
      tokens.push(name);
      return text;
    },
  } as Theme;
  chromePaint(theme)("─");
  assert.deepEqual(tokens, ["borderAccent"]);

  const width = 24;
  const lines = frameComposerLines(
    ["╭" + "─".repeat(width - 2) + "╮", " ".repeat(width), "╰" + "─".repeat(width - 2) + "╯"],
    { width, empty: true, paddingX: 4, paint: (text) => text, theme },
  );
  assert.match(stripVTControlCharacters(lines[1] ?? ""), /^│ › ::: /);
});

test("pantera paints spend in success and uses glyph working frames", () => {
  const painted: Array<[string, string]> = [];
  const theme = {
    name: CHARMTONE_PANTERA,
    fg: (name: string, text: string) => {
      painted.push([name, text]);
      return text;
    },
  } as Theme;
  paintContextResources(theme, "$0.00 · 8 skills loaded · 2 MCPs enabled");
  assert.deepEqual(painted, [
    ["success", "$0.00"],
    ["dim", " · 8 skills loaded · 2 MCPs enabled"],
  ]);
  assert.deepEqual(workingFrames(theme), ["#", "*", "~", "+", "e", "a"]);
});
