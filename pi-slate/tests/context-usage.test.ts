import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  estimateContextTokensFromEntries,
  resolveContextTokens,
  sessionSpend,
} from "../extensions/pi-slate/context-usage.ts";

function user(id: string, text: string): SessionEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: "0",
    message: { role: "user", content: text },
  } as SessionEntry;
}

function assistant(id: string, text: string, cost: number): SessionEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: "0",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      usage: { cost: { total: cost } },
    },
  } as SessionEntry;
}

function compaction(id: string, summary: string, cost = 0): SessionEntry {
  return {
    type: "compaction",
    id,
    parentId: null,
    timestamp: "0",
    summary,
    firstKeptEntryId: "kept",
    tokensBefore: 239_671,
    usage: { cost: { total: cost } },
  } as SessionEntry;
}

test("estimates remaining context from compaction summary plus kept messages", () => {
  const summary = "a".repeat(40);
  const kept = "b".repeat(20);
  assert.equal(
    estimateContextTokensFromEntries([compaction("c1", summary), user("kept", kept)]),
    Math.ceil(summary.length / 4) + Math.ceil(kept.length / 4),
  );
});

test("after compact, null provider usage falls back to the remaining-context estimate", () => {
  const entries = [compaction("c1", "a".repeat(40)), user("kept", "b".repeat(20))];
  assert.deepEqual(
    resolveContextTokens({ tokens: null, percent: null, contextWindow: 200 }, entries),
    { tokens: 15, percent: 7.5 },
  );
  assert.deepEqual(
    resolveContextTokens({ tokens: 3485, percent: 2.4, contextWindow: 200_000 }, entries),
    { tokens: 3485, percent: 2.4 },
  );
});

test("session spend includes compacted history and the compact call", () => {
  assert.equal(
    sessionSpend([
      assistant("old", "pre", 1.2),
      compaction("c1", "summary", 0.05),
      assistant("new", "post", 0.3),
    ]),
    1.55,
  );
});
