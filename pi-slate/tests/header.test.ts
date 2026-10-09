import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { piLogoLines, piWordmark, renderSlateHeader, supportsPiLogo } from "../extensions/pi-slate/header.ts";

const theme = { fg: (_name: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;

test("header uses the stock Pi mark and the product stack, not a greeting", () => {
  const lines = renderSlateHeader({
    width: 72, path: "/Users/operator/GitHub/pi-extensions",
    identity: { version: "1.0.4", model: "grok-4.6 (bedrock)", thinking: "medium" },
    logo: true, theme,
  });
  const plain = lines.map(stripVTControlCharacters);
  assert.equal(plain.length, 4);
  assert.match(plain[0]!, /Pi Agent v1\.0\.4/);
  assert.match(plain[1]!, /grok-4\.6 \(bedrock\) · medium/);
  assert.match(plain[2]!, /\/Users\/operator\/GitHub\/pi-extensions/);
  assert.equal(plain[3], "─".repeat(72));
  assert.doesNotMatch(plain.join("\n"), /Ready when you are|slate \/ /);
  assert(plain[0]!.includes("▀"));
  assert(plain.every(line => visibleWidth(line) <= 72));
});

test("optional update hairline remains bounded and ready is a session chip", () => {
  const lines = renderSlateHeader({
    width: 72, path: "/tmp/project", notice: "update available · pi update --extensions",
    identity: { version: "1.1.0" }, ready: true, logo: false, theme,
  });
  const plain = lines.map(stripVTControlCharacters);
  assert.match(plain.join("\n"), /update available/);
  assert.match(plain.at(-1)!, /✓ New session started/);
  assert.doesNotMatch(plain.join("\n"), /Ask a question/);
  assert(plain.every(line => visibleWidth(line) <= 72));
});

test("wordmark fallback and missing ready stay compact", () => {
  const started = renderSlateHeader({ width: 40, path: "/tmp/project", identity: { version: "1.0.4" }, ready: false, logo: false, theme });
  assert.doesNotMatch(started.join("\n"), /New session started|Ready when/);
  assert.match(stripVTControlCharacters(started[0]!), /Agent v1\.0\.4/);
  assert(started.every(line => visibleWidth(line) <= 40));
});

test("identity truncates safely and strips untrusted terminal controls", () => {
  for (const width of [0, 1, 2, 8, 20, 40, 100]) {
    const lines = renderSlateHeader({
      width, path: "/tmp/verylong长工程名字🙂\n\x1b[2J",
      identity: { version: "1.0.4", model: "long\n\x1b[2Jmodel".repeat(3), thinking: "high" },
      logo: width >= 12, theme,
    });
    assert(lines.every(line => visibleWidth(line) <= width && !line.includes("\n") && !line.includes("\x1b[2J")));
  }
});

test("logo helpers keep the official bitmap and skip Apple Terminal", () => {
  const [top, bottom] = piLogoLines(theme);
  assert.equal(visibleWidth(top), 4);
  assert.equal(visibleWidth(bottom), 4);
  assert.match(piWordmark(theme), /P.*i/);
  assert.equal(supportsPiLogo({ TERM_PROGRAM: "Apple_Terminal" }), false);
  assert.equal(supportsPiLogo({ TERM_PROGRAM: "iTerm.app" }), true);
});
