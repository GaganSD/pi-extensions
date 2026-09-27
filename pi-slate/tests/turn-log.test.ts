import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { eventTone, TurnLogView, wrapLines } from "../extensions/pi-slate/turn-log.ts";
import type { TurnEvent } from "../extensions/pi-slate/turn-impact.ts";

function theme(): Theme {
  return {
    fg: (_color, text) => text,
    bold: (text) => text,
  } as Theme;
}

function event(id: string, toolName: string, title = toolName): TurnEvent {
  return { id, toolName, title, detail: `full ${id}\nmore`, isError: false, pending: false };
}

test("eventTone marks read, edit, and subagent rows", () => {
  const base = { id: "1", title: "x", detail: "", isError: false, pending: false };
  assert.equal(eventTone({ ...base, toolName: "read" }), "accent");
  assert.equal(eventTone({ ...base, toolName: "edit" }), "warning");
  assert.equal(eventTone({ ...base, toolName: "write" }), "warning");
  assert.equal(eventTone({ ...base, toolName: "subagent" }), "success");
  assert.equal(eventTone({ ...base, toolName: "bash" }), "muted");
  assert.equal(eventTone({ ...base, toolName: "read", isError: true }), "error");
});

test("wrapLines splits on width and keeps blank lines", () => {
  assert.deepEqual(wrapLines("abcdef", 3), ["abc", "def"]);
  assert.deepEqual(wrapLines("a\n\nb", 8), ["a", "", "b"]);
});

test("turn log compacts home and workspace paths", () => {
  const view = new TurnLogView(
    [event("1", "read", "read /Users/gagan/proj/src/a.ts")],
    theme(),
    undefined,
    "/Users/gagan/proj",
    "/Users/gagan",
  );
  assert.match(view.render(40, 1)[0] ?? "", /▸ read src\/a\.ts/);
});

test("turn log lists unified activity and expands the full message on click", () => {
  const view = new TurnLogView([event("1", "read", "read a.ts"), event("2", "bash", "bash ls")], theme());
  assert.equal(view.title, "activity");
  const collapsed = view.render(40, 4);
  assert.match(collapsed[0] ?? "", /▸ read a.ts \[copy\]/);
  assert.equal(view.handleClick(0, 0), true);
  const expanded = view.render(40, 6);
  assert.match(expanded[0] ?? "", /▾ read a.ts \[copy\]/);
  assert.match(expanded[1] ?? "", /full 1/);
  assert.match(expanded[2] ?? "", /more/);
});

test("turn log [copy] copies title and detail without expanding", () => {
  const view = new TurnLogView([event("1", "read", "read a.ts")], theme());
  const line = view.render(40, 2)[0] ?? "";
  const x = line.indexOf("[copy]");
  assert.ok(x >= 0);
  assert.equal(view.copyTextAt(x, 0), "read a.ts\nfull 1\nmore");
  assert.equal(view.handleClick(x, 0), false);
  assert.match(view.render(40, 2)[0] ?? "", /▸ read a.ts/);
});

test("unified activity log keeps pending and failed calls auditable", () => {
  const view = new TurnLogView([
    { id: "pending", toolName: "bash", title: "bash npm test", detail: "pending\nnpm test", isError: false, pending: true },
    { id: "failed", toolName: "deploy", title: "deploy", detail: "error\nfailed", isError: true, pending: false },
  ], theme());
  assert.match(view.render(40, 2)[0] ?? "", /▸ bash npm test/);
  assert.equal(view.handleClick(0, 0), true);
  assert.match(view.render(40, 4)[1] ?? "", /pending/);
  assert.match(view.render(40, 4)[2] ?? "", /npm test/);
  assert.match(view.render(40, 4)[3] ?? "", /▸ deploy/);
});

test("turn log wheel scrolls the flattened list", () => {
  const events = ["a", "b", "c", "d"].map((id) => event(id, "bash", `bash ${id}`));
  const view = new TurnLogView(events, theme());
  view.render(20, 2);
  assert.equal(view.handleWheel(1), true);
  const lines = view.render(20, 2);
  assert.match(lines[0] ?? "", /▸ bash b/);
});
