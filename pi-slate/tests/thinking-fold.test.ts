import assert from "node:assert/strict";
import test from "node:test";
import { formatLiveThinking, ThinkingFoldTracker } from "../extensions/pi-slate/thinking-fold.ts";

const message = { content: [{ type: "thinking", thinking: "Native content stays untouched" }] };
const start = { type: "thinking_start", contentIndex: 0 };
const delta = { type: "thinking_delta", contentIndex: 0 };
const end = { type: "thinking_end", contentIndex: 0 };

function fixture() {
  let now = 0;
  let changes = 0;
  let schedules = 0;
  let cancellations = 0;
  let tick: (() => void) | undefined;
  const tracker = new ThinkingFoldTracker({
    now: () => now,
    onChange: () => { changes += 1; },
    schedule(callback) {
      schedules += 1;
      tick = callback;
      return () => { cancellations += 1; tick = undefined; };
    },
  });
  return {
    tracker,
    advance(ms: number) { now += ms; tick?.(); },
    counts: () => ({ changes, schedules, cancellations }),
    tick: () => tick,
  };
}

test("live thinking uses the Slate word, whole seconds and estimated rate", () => {
  assert.equal(formatLiveThinking("Pondering", 7000, 42), "Pondering · 7s · ↑↓42");
  assert.equal(formatLiveThinking("Crafting", 7999, 41.8), "Crafting · 7s · ↑↓42");
  assert.equal(formatLiveThinking("Pondering", 7000, null), "Pondering · 7s");
  assert.equal(formatLiveThinking("Pondering", 0, null), "Pondering");
  assert.equal(formatLiveThinking("Pondering", 999, 42), "Pondering · ↑↓42");
  assert.equal(formatLiveThinking("Pondering", 1000, null), "Pondering · 1s");
  assert.equal(formatLiveThinking("Pondering", null, null), "Pondering");
  assert.equal(formatLiveThinking("Pondering", NaN, Infinity), "Pondering");
  assert.equal(formatLiveThinking("Pondering", -1, -1), "Pondering");
  assert.equal(formatLiveThinking("Pondering", 1000, 0), "Pondering · 1s · ↑↓0");
});

test("thinking start opens one timer, end stops it and duplicate events are harmless", () => {
  const f = fixture();
  assert.equal(f.tracker.elapsedMs(), null);
  f.tracker.observe(start, message);
  assert.equal(f.tracker.elapsedMs(), 0);
  f.tracker.observe(start, message);
  f.tracker.observe(delta, message);
  f.advance(7000);
  assert.equal(f.tracker.elapsedMs(), 7000);
  assert.deepEqual(f.counts(), { changes: 2, schedules: 1, cancellations: 0 });
  f.tracker.observe(end, message);
  assert.equal(f.tracker.elapsedMs(), null);
  f.tracker.observe(end, message);
  f.tracker.stop();
  f.advance(1000);
  assert.deepEqual(f.counts(), { changes: 3, schedules: 1, cancellations: 1 });
  assert.equal(message.content[0]!.thinking, "Native content stays untouched");
});

test("new message or abort cleanup stops timing; subsequent thinking starts fresh", () => {
  const f = fixture();
  f.tracker.observe(start, message);
  f.advance(12000);
  f.tracker.stop(); // message_start, message_end, agent_end and session_tree use this boundary.
  f.tracker.observe(start, message);
  assert.equal(f.tracker.elapsedMs(), 0);
  f.advance(1000);
  assert.equal(f.tracker.elapsedMs(), 1000);
  f.tracker.stop();
  assert.deepEqual(f.counts(), { changes: 6, schedules: 2, cancellations: 2 });
});

test("shutdown is idempotent and a queued timer cannot repaint after disposal", () => {
  const f = fixture();
  f.tracker.observe(start, message);
  const queuedTick = f.tick();
  f.tracker.dispose();
  f.tracker.dispose();
  queuedTick?.();
  f.tracker.observe(start, message);
  assert.equal(f.tracker.elapsedMs(), null);
  assert.deepEqual(f.counts(), { changes: 1, schedules: 1, cancellations: 1 });
});

test("missing start or malformed thinking events fail open without a timer", () => {
  for (const event of [undefined, null, {}, delta, end, { type: "thinking_start" },
    { type: "thinking_start", contentIndex: -1 }, { type: "thinking_start", contentIndex: 0.5 },
    { type: "thinking_start", contentIndex: 1 }]) {
    const f = fixture();
    f.tracker.observe(event, message);
    assert.equal(f.tracker.elapsedMs(), null);
    assert.deepEqual(f.counts(), { changes: 0, schedules: 0, cancellations: 0 });
  }
  for (const content of [undefined, [], [{ type: "text", text: "answer" }]]) {
    const f = fixture();
    f.tracker.observe(start, { content });
    assert.equal(f.tracker.elapsedMs(), null);
    assert.equal(f.counts().schedules, 0);
  }
});

test("missing end and changed host event shapes stop live timing", () => {
  for (const event of [undefined, {}, { type: "future_thinking" },
    { type: "thinking_delta" }, { type: "text_start" }, { type: "text_delta" },
    { type: "toolcall_start" }, { type: "done" }, { type: "error" }]) {
    const f = fixture();
    f.tracker.observe(start, message);
    f.tracker.observe(event, message);
    assert.equal(f.tracker.elapsedMs(), null);
    assert.equal(f.counts().cancellations, 1);
  }
});

test("a new thinking block resets elapsed time and clock rollback never shows negative time", () => {
  const f = fixture();
  const blocks = { content: [...message.content, ...message.content] };
  f.tracker.observe(start, blocks);
  f.advance(3000);
  f.tracker.observe({ type: "thinking_start", contentIndex: 1 }, blocks);
  assert.equal(f.tracker.elapsedMs(), 0);
  f.advance(-1000);
  assert.equal(f.tracker.elapsedMs(), 0);
  f.tracker.observe({ type: "thinking_end", contentIndex: 1 }, blocks);
  assert.deepEqual(f.counts(), { changes: 6, schedules: 2, cancellations: 2 });
});
