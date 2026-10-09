import assert from "node:assert/strict";
import test from "node:test";
import { BackgroundTasks } from "../extensions/pi-slate/background-tasks.ts";

const task = { id: "run-1", label: "Review", kind: "subagent", state: "running", startedAt: 1000, pid: 42 };
const snapshot = (tasks: unknown[] = [task], extra: Record<string, unknown> = {}) => ({ version: 1, source: "subagents", sessionId: "owner", tasks, ...extra });
function fixture() { const registry = new BackgroundTasks(); registry.reset("owner"); return registry; }

test("versioned snapshots update by source, deduplicate repeats, and clear completed work", () => {
  const r = fixture(); assert(r.accept(snapshot())); assert.equal(r.snapshot().length, 1);
  assert.equal(r.accept(snapshot()), false);
  assert(r.accept(snapshot([{ ...task, state: "waiting" }]))); assert.equal(r.snapshot()[0]!.state, "waiting");
  assert(r.accept(snapshot([], { source: "subagents" }))); assert.deepEqual(r.snapshot(), []);
});

test("stale or foreign session/source payloads cannot overwrite current tasks", () => {
  const r = fixture(); r.accept(snapshot());
  for (const raw of [snapshot([], { sessionId: "foreign" }), snapshot([], { version: 2 }), snapshot([], { source: "invalid/source" }), null, []]) assert.equal(r.accept(raw), false);
  assert.equal(r.snapshot().length, 1);
  r.reset("next"); assert.equal(r.accept(snapshot()), false); assert.deepEqual(r.snapshot(), []);
});

test("malformed snapshots are rejected atomically, not partly applied", () => {
  const r = fixture(); r.accept(snapshot());
  for (const raw of [[{ ...task, state: "completed" }], [{ ...task, startedAt: NaN }], [{ ...task, kind: "unknown" }], [task, task], [task, { id: "bad" }], Array.from({ length: 65 }, (_, i) => ({ ...task, id: String(i) }))]) assert.equal(r.accept(snapshot(raw)), false);
  assert.equal(r.snapshot()[0]!.state, "running");
});

test("source isolation, bounds and sanitization prevent unbounded or terminal-controlled state", () => {
  const r = fixture();
  for (let i = 0; i < 16; i++) assert(r.accept(snapshot([{ ...task, label: "bad\x1b[2J\nlabel" }], { source: `s${i}` })));
  assert.equal(r.accept(snapshot([task], { source: "overflow" })), false);
  assert.equal(r.snapshot().length, 16);
  assert(r.snapshot().every(x => !x.label.includes("\x1b") && !x.label.includes("\n")));
  r.accept(snapshot([], { source: "s0" })); assert.equal(r.snapshot().length, 15);
  assert(r.accept(snapshot([task], { source: "replacement" })));
});

test("active agent shell calls are transient and detached process IDs are never guessed", () => {
  const r = fixture(); r.shellStart("shell-1", "bash", { command: "npm run dev" }, 1000);
  assert.equal(r.snapshot()[0]!.kind, "shell"); assert.equal(r.snapshot()[0]!.pid, undefined);
  assert.match(r.snapshot()[0]!.detail!, /No detached process/);
  r.shellStart("read-1", "read", { path: "README.md" }, 1000); assert.equal(r.snapshot().length, 1);
  r.shellEnd("shell-1"); assert.deepEqual(r.snapshot(), []);
  r.shellStart("shell-2", "powershell", { command: "Get-Item" }, 1000); r.clearShells(); assert.deepEqual(r.snapshot(), []);
});

test("a foreground call completing does not remove a source-owned detached job", () => {
  const r = fixture(); r.accept(snapshot([{ ...task, id: "shell-1", kind: "terminal" }]));
  r.shellStart("shell-1", "bash", { command: "start server" }, 1000); assert.equal(r.snapshot().length, 2);
  r.shellEnd("shell-1"); assert.equal(r.snapshot().length, 1);
  assert.equal(r.snapshot()[0]!.source, "subagents");
});

test("unknown cleanup stays first, live work precedes failed history", () => {
  const r = fixture(); r.accept(snapshot([task, { ...task, id: "bad", state: "failed", startedAt: 2000 }, { ...task, id: "uncertain", state: "cleanup_unknown" }]));
  assert.deepEqual(r.snapshot().map(row => row.state), ["cleanup_unknown", "running", "failed"]);
});
