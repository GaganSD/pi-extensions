import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  eventTitle,
  formatDetail,
  formatResult,
  formatTurnImpact,
  TurnImpactTracker,
} from "../extensions/pi-slate/turn-impact.ts";

test("turn impact retains every tool event", () => {
  const impact = new TurnImpactTracker();
  impact.toolCall({ toolCallId: "r1", toolName: "read", input: { path: "a.ts" } });
  impact.toolCall({ toolCallId: "r2", toolName: "read", input: { path: "a.ts" } });
  impact.toolCall({ toolCallId: "s1", toolName: "bash", input: { command: "ls" } });
  impact.toolCall({ toolCallId: "a1", toolName: "subagent", input: { agent: "reviewer", task: "check" } });
  assert.equal(impact.snapshot().toolsCalled, 4);

  impact.toolEnd({ toolCallId: "r1", isError: false, result: "ok" });
  impact.toolEnd({ toolCallId: "r2", isError: true, result: "nope" });
  impact.toolEnd({ toolCallId: "s1", isError: false, result: "files" });
  impact.toolEnd({ toolCallId: "a1", isError: false, result: "done" });
  assert.equal(impact.snapshot().events.length, 4);
});

test("later LLM rounds keep last-prompt impact until reset", () => {
  const impact = new TurnImpactTracker();
  impact.toolCall({ toolCallId: "s1", toolName: "bash", input: { command: "rm gone.ts" } });
  impact.toolEnd({ toolCallId: "s1", isError: false, result: "" });
  impact.toolCall({ toolCallId: "r1", toolName: "read", input: { path: "a.ts" } });
  impact.toolEnd({ toolCallId: "r1", isError: false, result: "src" });
  assert.equal(impact.snapshot().toolsCalled, 2);
});

test("reset clears the current turn and keeps moving the revision", () => {
  const impact = new TurnImpactTracker();
  impact.toolCall({ toolCallId: "r1", toolName: "read", input: { path: "a.ts" } });
  impact.toolEnd({ toolCallId: "r1", isError: false });
  const afterReset = impact.reset();
  assert.equal(afterReset.toolsCalled, 0);
  assert.equal(afterReset.events.length, 0);
  assert.ok(afterReset.revision > 0);
});

test("restore rebuilds the latest user turn from session history", () => {
  const message = (value: object) => ({ type: "message", message: value });
  const entries = [
    message({ role: "user", content: "old" }),
    message({ role: "assistant", content: [{ type: "toolCall", id: "old", name: "write", arguments: { path: "old.ts" } }] }),
    message({ role: "toolResult", toolCallId: "old", toolName: "write", content: [{ type: "text", text: "done" }], isError: false }),
    message({ role: "user", content: "latest" }),
    message({ role: "assistant", content: [{ type: "toolCall", id: "read", name: "read", arguments: { path: "a.ts" } }] }),
    message({ role: "toolResult", toolCallId: "read", toolName: "read", content: [{ type: "text", text: "source" }], isError: true }),
    message({ role: "assistant", content: [{ type: "toolCall", id: "shell", name: "bash", arguments: { command: "npm test" } }] }),
  ] as unknown as SessionEntry[];

  const restored = new TurnImpactTracker().restore(entries);
  assert.equal(restored.toolsCalled, 2);
  assert.deepEqual(restored.events.map(({ id, pending, isError }) => ({ id, pending, isError })), [
    { id: "read", pending: false, isError: true },
    { id: "shell", pending: true, isError: false },
  ]);
  assert.match(restored.events[0]?.detail ?? "", /^error\na\.ts\nsource$/);
});

test("formatTurnImpact uses a total and disjoint activity categories", () => {
  const event = (toolName: string) => ({ id: toolName, toolName, title: toolName, detail: "", isError: false, pending: false });
  const base = { revision: 1 };
  assert.deepEqual(formatTurnImpact({ ...base, toolsCalled: 0, events: [] }), ["No tool activity"]);
  assert.deepEqual(formatTurnImpact({ ...base, toolsCalled: 1, events: [event("bash")] }), ["1 action", "1 ran"]);
  assert.deepEqual(formatTurnImpact({
    ...base,
    toolsCalled: 7,
    events: [event("read"), event("grep"), event("edit"), event("write"), event("bash"), event("powershell"), event("subagent")],
  }), ["7 actions", "2 inspected · 2 edited · 2 ran · 1 delegated"]);
});

test("formatTurnImpact keeps custom tools in the total without an other category", () => {
  const custom = { id: "1", toolName: "deploy", title: "deploy", detail: "", isError: false, pending: false };
  assert.deepEqual(formatTurnImpact({
    revision: 1, toolsCalled: 1, events: [custom],
  }), ["1 action"]);
});

test("event titles and details stay auditable", () => {
  assert.equal(eventTitle("bash", { command: "ls -la" }), "bash ls -la");
  assert.equal(eventTitle("subagent", { agent: "reviewer", task: "check" }), "reviewer · check");
  assert.equal(formatResult([{ type: "text", text: "hello" }]), "hello");
  assert.match(formatDetail("read", { path: "a.ts" }, "src", false, false), /^ok\na\.ts\nsrc$/);
});
