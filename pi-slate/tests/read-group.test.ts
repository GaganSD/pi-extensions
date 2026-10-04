import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  formatReadRange,
  isHiddenRead,
  readCallText,
  readItemFromArgs,
  ReadGrouper,
  readResultLines,
  replaySessionReads,
} from "../extensions/pi-slate/read-group.ts";

const item = (id: string, path: string, range = ""): { id: string; path: string; range: string } => ({ id, path, range });

test("a single read stays a path line", () => {
  const grouper = new ReadGrouper();
  const group = grouper.seeRead(item("a", "x.md"));
  assert.equal(readCallText(group, item("a", "x.md")), "read x.md");
  assert.equal(isHiddenRead(group, "a"), false);
  assert.deepEqual(readResultLines(group, true), []);
});

test("a second consecutive read joins the first card", () => {
  const grouper = new ReadGrouper();
  grouper.seeRead(item("a", "x.md"));
  const group = grouper.seeRead(item("b", "y.ts", ":1-80"));
  assert.equal(group.items.length, 2);
  assert.equal(readCallText(group, item("a", "x.md")), "read 2 files");
  assert.equal(isHiddenRead(group, "a"), false);
  assert.equal(isHiddenRead(grouper.groupFor("b"), "b"), true);
  assert.deepEqual(readResultLines(group, false), []);
  assert.deepEqual(readResultLines(group, true), ["  x.md", "  y.ts:1-80"]);
});

test("a non-read tool starts a new streak", () => {
  const grouper = new ReadGrouper();
  grouper.seeRead(item("a", "x.md"));
  grouper.seeOther();
  const next = grouper.seeRead(item("b", "y.ts"));
  assert.equal(next.leadId, "b");
  assert.equal(next.items.length, 1);
  assert.equal(grouper.groupFor("a")?.items.length, 1);
});

test("text from a later assistant message breaks the streak", () => {
  const grouper = new ReadGrouper();
  grouper.seeRead(item("a", "x.md"), "m1");
  grouper.seeRead(item("b", "y.ts"), "m1");
  grouper.seeText("m2");
  const next = grouper.seeRead(item("c", "z.ts"), "m2");
  assert.equal(next.leadId, "c");
  assert.equal(grouper.groupFor("a")?.items.length, 2);
});

test("text from the same assistant message does not break the streak", () => {
  const grouper = new ReadGrouper();
  grouper.seeText("m1");
  grouper.seeRead(item("a", "x.md"), "m1");
  grouper.seeText("m1");
  const group = grouper.seeRead(item("b", "y.ts"), "m1");
  assert.equal(group.items.length, 2);
});

test("seeRead is idempotent for the same id", () => {
  const grouper = new ReadGrouper();
  grouper.seeRead(item("a", "x.md"));
  grouper.seeRead(item("a", "x.md"));
  assert.equal(grouper.groupFor("a")?.items.length, 1);
});

test("joining a streak invalidates only the lead and the new card", () => {
  const grouper = new ReadGrouper();
  const hits = new Map<string, number>();
  const bind = (id: string) => grouper.bind(id, () => hits.set(id, (hits.get(id) ?? 0) + 1));
  bind("r0");
  grouper.seeRead(item("r0", "a.ts"));
  for (let i = 1; i < 2000; i++) {
    bind(`r${i}`);
    grouper.seeRead(item(`r${i}`, `f${i}.ts`));
  }
  let total = 0;
  for (const count of hits.values()) total += count;
  assert.equal(hits.get("r0"), 1999);
  assert.equal(total, 3998);
  assert.equal(grouper.groupFor("r0")?.items.length, 2000);
});

test("replay walks session entries once and groups consecutive reads", () => {
  const message = (value: object) => ({ type: "message", message: value });
  const entries = [
    message({ role: "user", content: "old" }),
    message({
      role: "assistant", timestamp: 1,
      content: [
        { type: "text", text: "looking" },
        { type: "toolCall", id: "a", name: "read", arguments: { path: "a.ts", offset: 1, limit: 10 } },
        { type: "toolCall", id: "b", name: "read", arguments: { path: "b.ts" } },
      ],
    }),
    message({
      role: "assistant", timestamp: 2,
      content: [
        { type: "text", text: "next" },
        { type: "toolCall", id: "c", name: "read", arguments: { path: "c.ts" } },
      ],
    }),
    message({ role: "user", content: "again" }),
    message({
      role: "assistant", timestamp: 3,
      content: [
        { type: "toolCall", id: "d", name: "read", arguments: { path: "d.ts" } },
        { type: "toolCall", id: "e", name: "bash", arguments: { command: "ls" } },
        { type: "toolCall", id: "f", name: "read", arguments: { path: "f.ts" } },
      ],
    }),
  ] as unknown as SessionEntry[];

  const grouper = new ReadGrouper();
  replaySessionReads(grouper, entries);
  assert.equal(grouper.groupFor("a")?.items.length, 2);
  assert.equal(isHiddenRead(grouper.groupFor("b"), "b"), true);
  assert.equal(grouper.groupFor("c")?.items.length, 1);
  assert.equal(grouper.groupFor("d")?.items.length, 1);
  assert.equal(grouper.groupFor("f")?.items.length, 1);
});

test("format helpers keep ranges and strip control characters", () => {
  assert.equal(formatReadRange(undefined, undefined), "");
  assert.equal(formatReadRange(10, 5), ":10-14");
  assert.equal(formatReadRange(3, undefined), ":3");
  assert.equal(readItemFromArgs("id", { path: "evil\x1b[2J.ts", offset: 1, limit: 2 }).path, "evil\\x1b[2J.ts");
  assert.equal(readItemFromArgs("id", { file_path: "legacy.md" }).path, "legacy.md");
});
