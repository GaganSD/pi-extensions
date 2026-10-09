import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { renderSlateHeader } from "../extensions/pi-slate/header.ts";

const theme = { fg: (_name: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;

test("header has one identity line and a rule, not a logo/model/version masthead", () => {
  const lines = renderSlateHeader({ width: 72, path: "/Users/operator/GitHub/pi-extensions", branch: "feat/slate-surfaces", theme });
  assert.equal(lines.length, 2);
  assert.match(lines[0]!, /^slate \/ pi-extensions/);
  assert.match(lines[0]!, /feat\/slate-surfaces$/);
  assert.equal(visibleWidth(lines[0]!), 72);
  assert.equal(lines[1], "─".repeat(72));
  assert.doesNotMatch(lines.join("\n"), /Pi Agent|model|PID/);
});

test("optional update hairline remains bounded", () => {
  const lines = renderSlateHeader({ width: 72, path: "/tmp/project", notice: "update available · pi update --extensions", theme });
  assert.equal(lines.length, 3);
  assert.match(stripVTControlCharacters(lines[2]!), /update available/);
  assert(lines.every(line => visibleWidth(line) <= 72));
});

test("ready cue is optional, bounded, and never adds model-facing entries", () => {
  const ready = renderSlateHeader({ width: 40, path: "/tmp/project", ready: true, theme });
  assert.equal(ready.length, 5); assert.match(ready[3]!, /Ready when you are/);
  assert(ready.every(line => visibleWidth(line) <= 40));
  const started = renderSlateHeader({ width: 40, path: "/tmp/project", ready: false, theme });
  assert.equal(started.length, 2); assert.doesNotMatch(started.join("\n"), /Ready when/);
});

test("identity truncates safely and strips untrusted terminal controls", () => {
  for (const width of [0, 1, 2, 8, 20, 40, 100]) {
    const lines = renderSlateHeader({ width, path: "/tmp/verylong长工程名字🙂\n\x1b[2J", branch: "long\n\x1b[2Jbranch".repeat(5), theme });
    assert(lines.every(line => visibleWidth(line) <= width && !line.includes("\n") && !line.includes("\x1b[2J")));
  }
});
