import assert from "node:assert/strict";
import test from "node:test";
import {
  estimateAssistantTokens,
  TOKEN_RATE_WINDOW_MS,
  TokenRateTracker,
} from "../extensions/pi-slate/token-rate.ts";

test("estimates streamed text and thinking tokens without serializing tool arguments", () => {
  assert.equal(estimateAssistantTokens({}), 0);
  assert.equal(
    estimateAssistantTokens({
      content: [
        { type: "thinking", thinking: "abcd" },
        { type: "text", text: "efghijkl" },
        { type: "toolCall" },
      ],
    }),
    ("abcd".length + "efghijkl".length) / 4,
  );
});

test("averages tokens over the last 5 seconds of generation", () => {
  let now = 0;
  const tracker = new TokenRateTracker(() => now);

  tracker.startMessage();
  tracker.observePartial(50);
  now = 1_000;
  tracker.observePartial(100);
  assert.equal(tracker.rate(), 100);

  now = TOKEN_RATE_WINDOW_MS;
  tracker.observePartial(150);
  assert.equal(tracker.rate(), 30);

  now = TOKEN_RATE_WINDOW_MS + 1_000;
  tracker.observePartial(160);
  assert.equal(tracker.rate(), 22);
});

test("holds the last generation rate while idle", () => {
  let now = 0;
  const tracker = new TokenRateTracker(() => now);
  tracker.startMessage();
  tracker.observePartial(80);
  now = 2_000;
  tracker.endMessage();
  assert.equal(tracker.rate(), 40);

  now = 120_000;
  assert.equal(tracker.rate(), 40);
});

test("counts only new tokens across streaming updates", () => {
  let now = 0;
  const tracker = new TokenRateTracker(() => now);
  tracker.startMessage();
  tracker.observePartial(20);
  tracker.observePartial(20);
  tracker.observePartial(35);
  now = 1_000;
  assert.equal(tracker.rate(), 35);
});

test("starts a fresh window for the next generation", () => {
  let now = 0;
  const tracker = new TokenRateTracker(() => now);
  tracker.startMessage();
  tracker.observePartial(80);
  now = 2_000;
  tracker.endMessage();
  assert.equal(tracker.rate(), 40);

  now = 10_000;
  tracker.startMessage();
  tracker.observePartial(10);
  now = 11_000;
  tracker.endMessage();
  assert.equal(tracker.rate(), 10);
});
