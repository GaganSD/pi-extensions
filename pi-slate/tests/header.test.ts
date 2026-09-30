import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { PI_LOGO_ASCII } from "../extensions/pi-slate/layout.ts";
import { renderSlateHeader } from "../extensions/pi-slate/header.ts";

const theme = {
  fg: (_name: string, text: string) => text,
  getColorMode: () => "ansi",
} as unknown as Theme;

test("header is left-leaning and inserts a blank line above a centered hairline", () => {
  const lines = renderSlateHeader({
    width: 72,
    version: "0.99.1",
    model: "bedrock/xai.grok-4.6 · medium",
    path: "~/GitHub/pi-extensions",
    notice: "update available · @dev.fast/pi-whiteboard · pi update --extensions",
    ascii: true,
    truecolor: false,
    theme,
  });
  const plain = lines.map((line) => stripVTControlCharacters(line));
  assert.equal(plain[0]?.startsWith(PI_LOGO_ASCII[0] ?? ""), true);
  assert.match(plain[0] ?? "", /Pi Agent v0\.99\.1/);
  assert.match(plain[1] ?? "", /bedrock\/xai\.grok-4\.6/);
  assert.match(plain[2] ?? "", /pi-extensions/);
  assert.equal(plain[3], PI_LOGO_ASCII[3]);
  assert.equal(plain[4], "");
  const hair = plain[5] ?? "";
  assert.match(hair, /update available/);
  const start = hair.search(/[^\s─]/);
  const end = [...hair].reduce((last, ch, i) => (ch !== " " && ch !== "─" ? i + 1 : last), start);
  const left = [...hair.slice(0, start)].filter((ch) => ch === "─").length;
  const right = [...hair.slice(end)].filter((ch) => ch === "─").length;
  assert.equal(left, right);
  assert.equal(visibleWidth(hair), 72);
});

test("header omits the hairline when there is no update", () => {
  const lines = renderSlateHeader({
    width: 72,
    version: "0.99.1",
    model: "bedrock/xai.grok-4.6 · medium",
    path: "~/GitHub/pi-extensions",
    ascii: true,
    truecolor: false,
    theme,
  });
  assert.equal(lines.length, 4);
  assert.ok(!lines.some((line) => line.includes("update available")));
});
