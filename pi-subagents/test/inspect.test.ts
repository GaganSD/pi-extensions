import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { InspectView, type InspectActions } from "../src/inspect.ts";
import { RunManager } from "../src/runs.ts";
import { formatEntry, readTranscript } from "../src/transcript.ts";
import { PREVIEW_LINES, type RunRecord } from "../src/types.ts";
import { MemoryStore, plan, temp } from "./helpers.ts";

const entry = (text: string) => JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text }] } }) + "\n";

test("transcript fallback reads a bounded tail and discloses oversized entries", async t => {
  const root = await temp(t), file = path.join(root, "large.jsonl");
  await writeFile(file, entry("x".repeat(80000)));
  assert.match((await readTranscript(file)).join("\n"), /oversized entries omitted/);
  await appendFile(file, entry("Latest complete message"));
  const tail = await readTranscript(file);
  assert(tail.includes("child Latest complete message"));
  assert(tail.length <= PREVIEW_LINES);
  assert(tail.every(line => line.length <= 512));
  await appendFile(file, '{"type":"message",');
  assert((await readTranscript(file)).includes("child Latest complete message"));
  assert.deepEqual(await readTranscript(path.join(root, "missing.jsonl")), ["(transcript unavailable)"]);
});

test("transcript summaries remove terminal controls and bidi and bound text work", () => {
  const line = formatEntry(JSON.parse(entry("\u001b]52;c;clipboard\u0007\u202e\u061c\u200funsafe\n" + "x".repeat(80000))))!;
  assert(!/[\u0000-\u001f\u007f-\u009f\u061c\u200e-\u200f\u202a-\u202e\u2066-\u2069]/.test(line));
  assert(line.length <= 512);
  assert.match(line, /^child /);
  assert.equal(formatEntry({ type: "session" }), undefined);
});

test("manager previews are bounded event-fed copies, not persisted transcript duplicates", async () => {
  const store = new MemoryStore();
  const manager = new RunManager({ owner: "parent", store, config: { ...DEFAULT_CONFIG } });
  const [id] = await manager.launch([plan(async context => {
    for (let i = 0; i < 100; i++) context.preview(`child ${i} ${"x".repeat(1000)}`);
    return { report: "Final evidence", toolErrors: 0 };
  })]);
  await manager.settled(id!);
  const preview = manager.preview(id!);
  assert.equal(preview.length, PREVIEW_LINES);
  assert(preview[0]!.startsWith("child 76 "));
  assert(preview.at(-1)!.startsWith("child 99 "));
  assert(preview.every(line => line.length <= 512));
  preview.length = 0;
  assert.equal(manager.preview(id!).length, PREVIEW_LINES);
  assert(!("preview" in store.records.get(id!)!));
  await manager.shutdown();
});

test("inspector renders cached content at narrow widths and keeps input visible on short terminals", () => {
  let rows = 10, reads = 0, listener = () => {}, disposed = 0;
  let preview = ["child cached message\u001b]52;c;clipboard\u0007\u202e"];
  const record: RunRecord = {
    id: "aaaaaaaa-1111", owner: "p", agent: "worker", mode: "edit", task: "Inspect",
    cwd: "/repo/\u001b]52;bad\u0007", workspace: "/repo", model: "fixture/test", thinking: "off", state: "waiting_for_parent",
    startedAt: "t", elapsedMs: 1, metadataPath: "/run.json", question: { id: "q", message: "\u001b]52;bad\u0007Which API?\u202e" },
  };
  const actions: InspectActions = {
    status: () => record,
    preview: () => { reads++; return preview.slice(); },
    steer: async () => "queued", reply: async () => {}, stop: async () => {},
    live: () => [record],
    subscribe: fn => { listener = fn; return () => { disposed++; }; },
  };
  const tui = { terminal: { get rows() { return rows; } }, requestRender() {} } as unknown as TUI;
  const theme = { fg: (_color: string, text: string) => text } as unknown as Theme;
  const view = new InspectView(tui, theme, record.id, actions, () => {});
  for (const width of [1, 4, 10, 20, 80]) {
    const lines = view.render(width);
    assert(lines.length <= Math.floor(rows * 0.8));
    assert(lines.every(line => visibleWidth(line) <= width));
    assert(lines.every(line => !line.includes("\u001b]52") && !line.includes("\u202e")));
  }
  assert.equal(reads, 1, "rendering must not fetch transcript data");
  rows = 40;
  preview = ["child updated message"];
  listener();
  assert(view.render(80).some(line => line.includes("updated message")));
  rows = 4;
  const short = view.render(80);
  assert(short.length <= 3);
  assert(short.at(-1)!.includes(">"), "controls remain visible after body cropping");
  view.dispose();
  listener();
  assert.equal(disposed, 1);
  assert.equal(reads, 2, "disposed overlays do not process new events");
});
