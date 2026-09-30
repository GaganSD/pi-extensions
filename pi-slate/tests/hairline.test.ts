import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  centeredHairlines,
  dashCount,
  hairlineTextWidth,
  symmetricHairline,
  wrapHairlineText,
} from "../extensions/pi-slate/hairline.ts";

function sides(line: string): { left: number; right: number; text: string } {
  const plain = stripVTControlCharacters(line);
  const start = plain.search(/[^\s─]/);
  const end = [...plain].reduce((last, ch, i) => (ch !== " " && ch !== "─" ? i + 1 : last), start);
  return {
    left: [...plain.slice(0, start)].filter((ch) => ch === "─").length,
    right: [...plain.slice(end)].filter((ch) => ch === "─").length,
    text: plain.slice(start, end),
  };
}

test("hairline dashes stay equal on even and odd widths", () => {
  for (const width of [40, 41, 80, 81]) {
    const line = symmetricHairline("update available", width);
    assert.equal(visibleWidth(line), width);
    const { left, right, text } = sides(line);
    assert.equal(left, right);
    assert.equal(left, dashCount(visibleWidth(text), width));
    assert.equal(text, "update available");
  }
});

test("narrow hairlines stay symmetric after truncating", () => {
  const line = symmetricHairline("update available", 17);
  assert.equal(visibleWidth(line), 17);
  const { left, right } = sides(line);
  assert.equal(left, right);
});

test("painted hairline still measures to the requested width", () => {
  const line = symmetricHairline("\x1b[38;2;203;166;247mupdate available\x1b[39m", 48, (dash) => `\x1b[90m${dash}\x1b[39m`);
  assert.equal(visibleWidth(line), 48);
  const { left, right } = sides(line);
  assert.equal(left, right);
});

test("wraps on separators and keeps each line symmetric", () => {
  const notice = "3 updates available · pi-whiteboard, pi-ask, pi-subagents · pi update --extensions";
  const width = 42;
  const lines = centeredHairlines(notice, width);
  assert.ok(lines.length > 1);
  for (const line of lines) {
    assert.equal(visibleWidth(line), width);
    const { left, right } = sides(line);
    assert.equal(left, right);
  }
  assert.ok(wrapHairlineText(notice, hairlineTextWidth(width)).every((line) => (
    visibleWidth(line) <= hairlineTextWidth(width)
  )));
});
